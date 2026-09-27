import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyRoutePreference,
  buildProbeBody,
  buildRouteFields,
  buildRouteLines,
  capabilityHint,
  formatChannelList,
  judgeCapability,
  mergeChannelLists,
  orderChannels,
  parseRoutingFacts,
  pickProbeChannel,
  servedLatencyMs,
  summarizeRoute,
  type RoutePanelInput,
  type RoutingFacts,
} from "../src/routes.ts";

// ─── Fixtures (shapes taken from live responses) ───────────────────────────

const ROUTING = {
  affinity: { displacedProvider: "baseten", outcome: "promoted", pinnedProvider: "alibaba" },
  canonicalSlug: "zai/glm-5.3",
  fallbacksAvailable: ["alibaba", "baseten", "fireworks"],
  finalProvider: "baseten",
  modelAttempts: [
    {
      canonicalSlug: "zai/glm-5.3",
      providerAttempts: [
        { provider: "baseten", statusCode: 200, success: true, startTime: 1_000, endTime: 1_240 },
      ],
    },
  ],
};

function facts(patch: Partial<RoutingFacts> = {}): RoutingFacts {
  return {
    finalProvider: "baseten",
    fallbacksAvailable: ["alibaba", "baseten", "fireworks"],
    affinityOutcome: "promoted",
    affinityProvider: "alibaba",
    canonicalSlug: "zai/glm-5.3",
    attempts: [{ provider: "baseten", statusCode: 200, latencyMs: 240 }],
    ...patch,
  };
}

// ─── Parsing ───────────────────────────────────────────────────────────────

test("parseRoutingFacts reads the envelope and non-streaming shape", () => {
  const parsed = parseRoutingFacts({
    data: { choices: [{ message: { content: "ok", provider_metadata: { gateway: { routing: ROUTING } } } }] },
    success: true,
  });
  assert.equal(parsed?.finalProvider, "baseten");
  assert.deepEqual(parsed?.fallbacksAvailable, ["alibaba", "baseten", "fireworks"]);
  assert.equal(parsed?.affinityOutcome, "promoted");
  assert.equal(parsed?.affinityProvider, "alibaba");
  assert.equal(parsed?.canonicalSlug, "zai/glm-5.3");
  assert.deepEqual(parsed?.attempts, [{ provider: "baseten", statusCode: 200, latencyMs: 240 }]);
});

test("parseRoutingFacts reads the streaming shape and a bare payload", () => {
  const streaming = parseRoutingFacts({
    choices: [{ delta: { provider_metadata: { gateway: { routing: ROUTING } } } }],
  });
  assert.equal(streaming?.finalProvider, "baseten");
  assert.equal(parseRoutingFacts({ data: { choices: [{ message: {} }] } }), undefined);
});

test("parseRoutingFacts tolerates unexpected shapes", () => {
  assert.equal(parseRoutingFacts(undefined), undefined);
  assert.equal(parseRoutingFacts(null), undefined);
  assert.equal(parseRoutingFacts("nope"), undefined);
  assert.equal(parseRoutingFacts({ data: null }), undefined);
  assert.equal(parseRoutingFacts({ data: { choices: [] } }), undefined);
  assert.equal(parseRoutingFacts({ data: { choices: [{ message: { provider_metadata: {} } }] } }), undefined);
  // Routing without a serving channel is useless.
  assert.equal(
    parseRoutingFacts({ data: { choices: [{ message: { provider_metadata: { gateway: { routing: { finalProvider: "" } } } } }] } }),
    undefined,
  );
});

test("parseRoutingFacts ignores malformed attempts", () => {
  const parsed = parseRoutingFacts({
    data: {
      choices: [
        {
          message: {
            provider_metadata: {
              gateway: {
                routing: {
                  finalProvider: "baseten",
                  fallbacksAvailable: ["baseten", 42, null],
                  modelAttempts: [
                    { providerAttempts: [{ provider: "baseten", startTime: 100, endTime: 90 }] },
                    { providerAttempts: [{ statusCode: 200 }] },
                    "junk",
                  ],
                },
              },
            },
          },
        },
      ],
    },
  });
  assert.deepEqual(parsed?.fallbacksAvailable, ["baseten"]);
  assert.deepEqual(parsed?.attempts, [{ provider: "baseten", statusCode: undefined, latencyMs: undefined }]);
});

test("servedLatencyMs reports the latency of the serving channel", () => {
  assert.equal(servedLatencyMs(facts()), 240);
  assert.equal(
    servedLatencyMs(facts({ attempts: [{ provider: "alibaba", latencyMs: 900 }] })),
    undefined,
  );
});

// ─── Channel list and capability ───────────────────────────────────────────

test("orderChannels puts the serving channel first without duplicating it", () => {
  assert.deepEqual(orderChannels(facts()), ["baseten", "alibaba", "fireworks"]);
  assert.deepEqual(
    orderChannels(facts({ finalProvider: "deepseek", fallbacksAvailable: ["a", "b"] })),
    ["deepseek", "a", "b"],
  );
});

test("pickProbeChannel chooses an available channel that is not the serving one", () => {
  assert.equal(pickProbeChannel(facts()), "alibaba");
  assert.equal(pickProbeChannel(facts({ fallbacksAvailable: [] })), undefined);
  assert.equal(pickProbeChannel(facts({ fallbacksAvailable: ["baseten"] })), undefined);
});

test("mergeChannelLists keeps every channel ever seen and puts the serving one first", () => {
  const unpinned = facts({ finalProvider: "minimax", fallbacksAvailable: ["minimax", "nebius", "gmicloud"] });
  const pinned = facts({ finalProvider: "nebius", fallbacksAvailable: ["nebius"] });
  assert.deepEqual(mergeChannelLists(pinned, unpinned), ["nebius", "minimax", "gmicloud"]);
  assert.deepEqual(mergeChannelLists(unpinned), ["minimax", "nebius", "gmicloud"]);
  assert.deepEqual(mergeChannelLists(), []);
});

test("judgeCapability says pinnable when a preference or a pin took effect", () => {
  assert.equal(judgeCapability({ preferenceActive: true }), "pinnable");
  assert.equal(judgeCapability({ preferenceActive: false, honoredPin: true }), "pinnable");
  assert.equal(judgeCapability({ preferenceActive: false, honoredPin: false }), "not-pinnable");
  assert.equal(judgeCapability({ preferenceActive: false }), "not-pinnable");
});

test("capabilityHint explains the observed evidence without guessing", () => {
  assert.match(capabilityHint(facts({ finalProvider: "baseten" })), /kept baseten while 2 other channel/);
  assert.match(
    capabilityHint(facts({ finalProvider: "deepseek", fallbacksAvailable: ["alibaba", "baseten"] })),
    /kept deepseek, which is not in the model's current fallback list/,
  );
  assert.match(capabilityHint(facts({ fallbacksAvailable: [] })), /reported no fallback channels/);
});

// ─── Request fields ────────────────────────────────────────────────────────

test("buildRouteFields writes both spellings for strict and preferred modes", () => {
  assert.deepEqual(buildRouteFields({ only: ["nebius"] }), {
    providerOptions: { gateway: { only: ["nebius"] } },
    provider: { only: ["nebius"] },
  });
  assert.deepEqual(buildRouteFields({ only: ["nebius", "minimax"], mode: "preferred" }), {
    providerOptions: { gateway: { order: ["nebius", "minimax"] } },
    provider: { order: ["nebius", "minimax"] },
  });
  assert.deepEqual(buildRouteFields({ only: ["  ", ""] }), {
    providerOptions: { gateway: {} },
    provider: {},
  });
});

test("applyRoutePreference merges into the payload and keeps unrelated fields", () => {
  const payload = {
    model: "cline-pass/minimax-m3",
    messages: [{ role: "user", content: "hi" }],
    providerOptions: { gateway: { sort: "price" }, other: true },
    provider: { allow_fallbacks: true },
  };
  const patched = applyRoutePreference(payload, { only: ["nebius"] }) as Record<string, any>;
  assert.equal(patched.model, "cline-pass/minimax-m3");
  assert.deepEqual(patched.providerOptions.gateway, { sort: "price", only: ["nebius"] });
  assert.equal(patched.providerOptions.other, true);
  assert.deepEqual(patched.provider, { allow_fallbacks: true, only: ["nebius"] });
  // The original payload must not be mutated.
  assert.deepEqual(payload.providerOptions.gateway, { sort: "price" });
  assert.deepEqual(payload.provider, { allow_fallbacks: true });
});

test("applyRoutePreference leaves the payload alone when there is nothing to apply", () => {
  const payload = { model: "m", messages: [] };
  assert.equal(applyRoutePreference(payload, { only: [] }), payload);
  assert.equal(applyRoutePreference(undefined, { only: ["a"] }), undefined);
  assert.equal(applyRoutePreference("nope", { only: ["a"] }), "nope");
});

test("buildProbeBody is a cheap non-streaming request with reasoning off", () => {
  const plain = buildProbeBody("cline-pass/minimax-m3");
  assert.deepEqual(plain, {
    model: "cline-pass/minimax-m3",
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 64,
    reasoning: { enabled: false },
    stream: false,
  });

  const pinned = buildProbeBody("cline-pass/minimax-m3", "nebius") as Record<string, any>;
  assert.deepEqual(pinned.providerOptions, { gateway: { only: ["nebius"] } });
  assert.deepEqual(pinned.provider, { only: ["nebius"] });
  assert.equal(pinned.stream, false);
});

// ─── Presentation ──────────────────────────────────────────────────────────

function panel(patch: Partial<RoutePanelInput> = {}): RoutePanelInput {
  return {
    model: "cline-pass/minimax-m3",
    facts: facts(),
    capability: "pinnable",
    active: false,
    checkedLabel: "12:41",
    costLabel: "$0.0001",
    ...patch,
  };
}

test("formatChannelList lists the serving channel first and caps the list", () => {
  assert.equal(formatChannelList(facts()), "baseten · alibaba · fireworks");
  const many = facts({
    finalProvider: "deepseek",
    fallbacksAvailable: ["a", "b", "c", "d", "e", "f", "g", "h"],
  });
  assert.equal(formatChannelList(many), "deepseek · a · b · c · d · e … (9 total)");
});

test("buildRouteLines describes a pinnable model with an active preference", () => {
  const lines = buildRouteLines(
    panel({ preference: { only: ["baseten"] }, active: true }),
  );
  assert.deepEqual(lines, [
    "Upstream  cline-pass/minimax-m3",
    "Can set   yes — your channel is being used",
    "Serving   baseten  0.2s  ← your channel",
    "Pin       baseten (strict)",
    "Channels  baseten · alibaba · fireworks",
    "Checked   12:41 · 2 probes ≈ $0.0001",
  ]);
});

test("buildRouteLines explains why a model cannot be set right now", () => {
  const lines = buildRouteLines(panel({ capability: "not-pinnable" }));
  assert.equal(lines[1], "Can set   no right now — a pinned probe was not honored");
  assert.equal(lines[2], "Serving   baseten  0.2s");
  assert.match(lines.at(-1) ?? "", /^Why {7}The gateway kept baseten while 2 other channel/);
});

test("buildRouteLines appends a warning for a stale result", () => {
  const lines = buildRouteLines(
    panel({ capability: "not-pinnable", warning: "Re-check failed — showing the previous result." }),
  );
  assert.equal(lines.at(-1), "Note      Re-check failed — showing the previous result.");
});

test("buildRouteLines prefers an explicit hint over the computed one", () => {
  const lines = buildRouteLines(
    panel({ capability: "not-pinnable", hint: "The gateway kept deepseek (not in the reported list)." }),
  );
  assert.equal(lines.at(-1), "Why       The gateway kept deepseek (not in the reported list).");
});

test("summarizeRoute is a compact report line", () => {
  assert.equal(
    summarizeRoute({ model: "m", facts: facts(), capability: "pinnable", active: true, preference: { only: ["baseten"] } }),
    "m → baseten (your channel)",
  );
  assert.equal(summarizeRoute({ model: "m", facts: facts(), capability: "pinnable", active: false }), "m · can set · serving baseten");
  assert.equal(
    summarizeRoute({ model: "m", facts: facts(), capability: "not-pinnable", active: false }),
    "m · cannot set right now · serving baseten",
  );
});
