/**
 * pi-clinepass-auto — upstream channel ("route") inspection and preference.
 *
 * Cline's gateway serves each ClinePass model from one of several upstream
 * channels (baseten, fireworks, deepinfra, …) and reports what it did in the
 * response under `provider_metadata.gateway.routing`. This module parses those
 * facts, builds the tiny probe requests used to inspect them, decides whether a
 * model accepts a client-side channel preference at all, and turns a stored
 * preference into the request fields the gateway understands.
 *
 * Pure logic only; network access lives in `index.ts`.
 */

/** Request fields the gateway accepts for channel selection (two spellings). */
export interface RoutePreference {
  /** Channels to use, most preferred first. */
  only: string[];
  /**
   * `strict` sends `only` (the gateway must use one of them), `preferred`
   * sends `order` so it may fall back to another channel.
   */
  mode?: "strict" | "preferred";
}

export interface RouteAttempt {
  provider: string;
  statusCode?: number;
  latencyMs?: number;
}

export interface RoutingFacts {
  /** The channel that actually served the request. */
  finalProvider: string;
  /** Channels the gateway reported as available for this model. */
  fallbacksAvailable: string[];
  /** Affinity verdict reported by the gateway (`promoted`, `confirmed`, `skipped_not_in_plan`, …). */
  affinityOutcome?: string;
  /** The channel the gateway's per-account affinity is currently attached to. */
  affinityProvider?: string;
  /** Underlying catalog model, e.g. `zai/glm-5.3`. */
  canonicalSlug?: string;
  /** Per-channel attempts the gateway made, in order. */
  attempts: RouteAttempt[];
}

/**
 * Whether a client-side channel preference takes effect right now.
 *
 * - `pinnable`     — a pinned probe came back on the requested channel.
 * - `not-pinnable` — it did not; the gateway kept its own channel. This can be
 *   a temporary affinity lock or a channel the gateway will not hand over, so
 *   the panel reports the evidence instead of guessing which one it is.
 */
export type RouteCapability = "pinnable" | "not-pinnable";

// ─── Parsing helpers ───────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

// ─── Routing facts ─────────────────────────────────────────────────────────

function parseAttempts(routing: Record<string, unknown>): RouteAttempt[] {
  const attempts: RouteAttempt[] = [];
  for (const model of Array.isArray(routing.modelAttempts) ? routing.modelAttempts : []) {
    const providerAttempts = asRecord(model)?.providerAttempts;
    if (!Array.isArray(providerAttempts)) continue;
    for (const entry of providerAttempts) {
      const attempt = asRecord(entry);
      const provider = asString(attempt?.provider);
      if (!attempt || !provider) continue;
      const start = asFiniteNumber(attempt.startTime);
      const end = asFiniteNumber(attempt.endTime);
      attempts.push({
        provider,
        statusCode: asFiniteNumber(attempt.statusCode),
        latencyMs: start !== undefined && end !== undefined && end >= start ? end - start : undefined,
      });
    }
  }
  return attempts;
}

/**
 * Read the gateway's routing facts out of a completed chat-completion response.
 *
 * Accepts the `{data:{…}}` envelope or a bare payload, and both shapes the API
 * uses: non-streaming responses carry the metadata on `choices[0].message`,
 * streaming chunks on `choices[0].delta`.
 */
export function parseRoutingFacts(json: unknown): RoutingFacts | undefined {
  const envelope = asRecord(json);
  const payload = asRecord(envelope?.data) ?? envelope;
  if (!payload) return undefined;

  const choice = Array.isArray(payload.choices) ? asRecord(payload.choices[0]) : undefined;
  const metadata =
    asRecord(asRecord(choice?.message)?.provider_metadata) ??
    asRecord(asRecord(choice?.delta)?.provider_metadata);
  const routing = asRecord(asRecord(metadata?.gateway)?.routing);
  if (!routing) return undefined;

  const finalProvider = asString(routing.finalProvider);
  if (!finalProvider) return undefined;

  const affinity = asRecord(routing.affinity);
  return {
    finalProvider,
    fallbacksAvailable: asStringArray(routing.fallbacksAvailable),
    affinityOutcome: asString(affinity?.outcome),
    affinityProvider: asString(affinity?.pinnedProvider),
    canonicalSlug: asString(routing.canonicalSlug),
    attempts: parseAttempts(routing),
  };
}

/** Latency of the attempt that served the request, when reported. */
export function servedLatencyMs(facts: RoutingFacts): number | undefined {
  return facts.attempts.find((attempt) => attempt.provider === facts.finalProvider && attempt.latencyMs !== undefined)?.latencyMs;
}

/** Channel list for the picker: the serving channel first, then the rest. */
export function orderChannels(facts: RoutingFacts): string[] {
  return [facts.finalProvider, ...facts.fallbacksAvailable.filter((name) => name !== facts.finalProvider)];
}

/**
 * Union of every channel named by the given observations, serving channel
 * first. A pinned request reports a narrower fallback list than an unpinned
 * one, so the picker needs the union to keep offering all known channels.
 */
export function mergeChannelLists(...observations: RoutingFacts[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const facts of observations) {
    for (const name of [facts.finalProvider, ...facts.fallbacksAvailable]) {
      if (seen.has(name)) continue;
      seen.add(name);
      merged.push(name);
    }
  }
  const serving = observations[0]?.finalProvider;
  if (serving === undefined) return merged;
  return [serving, ...merged.filter((name) => name !== serving)];
}

/** A channel that is available but different from the serving one, if any. */
export function pickProbeChannel(facts: RoutingFacts): string | undefined {
  return facts.fallbacksAvailable.find((name) => name !== facts.finalProvider);
}

/**
 * Decide whether a channel preference takes effect right now.
 *
 * A pinned request that came back on the requested channel is the only
 * positive proof; everything else is "not right now". The panel explains the
 * evidence instead of guessing whether the gateway forbids it or is merely
 * holding on to its current channel.
 */
export function judgeCapability(input: {
  /** True when the gateway already serves the channel the user chose. */
  preferenceActive: boolean;
  /** True when a probe pinned to another channel came back on that channel. */
  honoredPin?: boolean;
}): RouteCapability {
  return input.preferenceActive || input.honoredPin === true ? "pinnable" : "not-pinnable";
}

// ─── Presentation ──────────────────────────────────────────────────────────

const LABEL_WIDTH = 10;
const MAX_LISTED_CHANNELS = 6;

function label(name: string): string {
  return name.padEnd(LABEL_WIDTH);
}

/** One-line channel list, capped so the panel stays readable. */
export function formatChannelList(facts: RoutingFacts): string {
  const channels = orderChannels(facts);
  const shown = channels.slice(0, MAX_LISTED_CHANNELS);
  const suffix = channels.length > shown.length ? ` … (${channels.length} total)` : "";
  return `${shown.join(" · ")}${suffix}`;
}

function capabilitySentence(input: RoutePanelInput): string {
  if (input.capability === "pinnable") {
    return input.active ? "yes — your channel is being used" : "yes — verified with a pinned probe";
  }
  return "no right now — a pinned probe was not honored";
}

/** Explain why a preference is not taking effect, using only observed facts. */
export function capabilityHint(facts: RoutingFacts): string {
  const serving = facts.finalProvider;
  if (facts.fallbacksAvailable.length === 0) {
    return `The gateway kept ${serving} and reported no fallback channels.`;
  }
  if (!facts.fallbacksAvailable.includes(serving)) {
    return `The gateway kept ${serving}, which is not in the model's current fallback list (${facts.fallbacksAvailable.length} other channels were). Try again later.`;
  }
  return `The gateway kept ${serving} while ${facts.fallbacksAvailable.length - 1} other channel(s) were listed. Its affinity may free up; try again later.`;
}

export interface RoutePanelInput {
  model: string;
  facts: RoutingFacts;
  capability: RouteCapability;
  /** Stored preference, when one exists. */
  preference?: RoutePreference;
  /** True when the serving channel is the preferred one. */
  active: boolean;
  /** Preformatted local check time, e.g. `12:41`. */
  checkedLabel: string;
  /** Preformatted probe cost, e.g. `$0.0001`. */
  costLabel: string;
  /** Explanation shown when the model cannot be set; computed from raw facts. */
  hint?: string;
  /** Optional trailing note (stale result, failed re-check, …). */
  warning?: string;
}

/** Multi-line panel shown by `/cline-route` and the `/clinepass` menu. */
export function buildRouteLines(input: RoutePanelInput): string[] {
  const latency = servedLatencyMs(input.facts);
  const serving = `${input.facts.finalProvider}${latency !== undefined ? `  ${(latency / 1000).toFixed(1)}s` : ""}`;
  const lines = [
    `Upstream  ${input.model}`,
    `${label("Can set")}${capabilitySentence(input)}`,
    `${label("Serving")}${serving}${input.active ? "  ← your channel" : ""}`,
  ];
  if (input.preference) {
    lines.push(`${label("Pin")}${input.preference.only.join(" → ")} (${input.preference.mode ?? "strict"})`);
  }
  lines.push(`${label("Channels")}${formatChannelList(input.facts)}`);
  lines.push(`${label("Checked")}${input.checkedLabel} · 2 probes ≈ ${input.costLabel}`);
  if (input.capability === "not-pinnable") lines.push(`${label("Why")}${input.hint ?? capabilityHint(input.facts)}`);
  if (input.warning) lines.push(`${label("Note")}${input.warning}`);
  return lines;
}

/** One-line summary for the `/cline-usage` report. */
export function summarizeRoute(input: Omit<RoutePanelInput, "checkedLabel" | "costLabel" | "warning">): string {
  const serving = `serving ${input.facts.finalProvider}`;
  if (input.preference && input.active) return `${input.model} → ${input.facts.finalProvider} (your channel)`;
  if (input.capability === "pinnable") return `${input.model} · can set · ${serving}`;
  return `${input.model} · cannot set right now · ${serving}`;
}

// ─── Request fields ────────────────────────────────────────────────────────

/**
 * Translate a preference into the request fields the gateway accepts.
 *
 * Both spellings are written because a request can land on either routing
 * pipeline (`providerOptions.gateway` for the gateway planner, top-level
 * `provider` for the OpenRouter-backed direct path), and an unknown channel
 * name is refused rather than ignored on the direct path.
 */
export function buildRouteFields(preference: RoutePreference): {
  providerOptions: { gateway: Record<string, unknown> };
  provider: Record<string, unknown>;
} {
  const names = preference.only.map((name) => name.trim()).filter(Boolean);
  const gateway: Record<string, unknown> = {};
  const provider: Record<string, unknown> = {};
  if (names.length > 0) {
    if (preference.mode === "preferred") {
      gateway.order = [...names];
      provider.order = [...names];
    } else {
      gateway.only = [...names];
      provider.only = [...names];
    }
  }
  return { providerOptions: { gateway }, provider };
}

/** Merge a channel preference into an outgoing provider request body. */
export function applyRoutePreference(payload: unknown, preference: RoutePreference): unknown {
  const base = asRecord(payload);
  if (!base) return payload;
  const { providerOptions, provider } = buildRouteFields(preference);
  if (Object.keys(providerOptions.gateway).length === 0) return payload;
  const existingGateway = asRecord(asRecord(base.providerOptions)?.gateway) ?? {};
  return {
    ...base,
    providerOptions: {
      ...(asRecord(base.providerOptions) ?? {}),
      gateway: { ...existingGateway, ...providerOptions.gateway },
    },
    provider: { ...(asRecord(base.provider) ?? {}), ...provider },
  };
}

/**
 * Body of the tiny request used to inspect a model's routing: a single cheap
 * completion with reasoning disabled so the gateway answers with content and
 * routing metadata in under a second.
 */
export function buildProbeBody(model: string, pin?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 64,
    reasoning: { enabled: false },
    stream: false,
  };
  if (pin) Object.assign(body, buildRouteFields({ only: [pin] }));
  return body;
}
