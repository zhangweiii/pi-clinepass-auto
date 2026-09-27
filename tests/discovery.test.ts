import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalog,
  buildCatalogEntry,
  DEFAULT_THINKING_LEVEL_MAP,
  deriveThinkingLevelMap,
  discoverCatalog,
  explainFreeModelError,
  isFreeModelId,
  parseCatalogCache,
  parseModelsDev,
  parseRecommendedModels,
  type DevModel,
} from "../src/discovery.ts";

// ─── Free-tier models ──────────────────────────────────────────────────────

test("isFreeModelId recognises the free-tier prefixes", () => {
  assert.equal(isFreeModelId("cline-free/mimo-v2.6-flash"), true);
  assert.equal(isFreeModelId("stealth/pixel-canary"), true);
  assert.equal(isFreeModelId("cline-pass/glm-5.3"), false);
  assert.equal(isFreeModelId("z-ai/glm-5.3"), false);
});

test("explainFreeModelError rewrites Cline's product-surface 403", () => {
  const raw =
    '403: {"code":"API_REQUEST_ERROR_CODE","message":"Error 403: cline-free/mimo-v2.6-flash is only available via Cline product surfaces. If you are using an old version of Cline, please update to the latest version"}';
  const explained = explainFreeModelError(raw);
  assert.ok(explained?.includes("only work in Cline's own IDE extension and CLI"));
  assert.ok(explained?.includes("cline-pass/*"));
  assert.equal(explainFreeModelError("Some unrelated failure"), undefined);
  assert.equal(explainFreeModelError(""), undefined);
});

// ─── Recommended models ────────────────────────────────────────────────────

test("parseRecommendedModels keeps cline-pass and free ids, deduped, in order", () => {
  const live = parseRecommendedModels({
    clinePass: [
      { id: "cline-pass/glm-5.3", name: "GLM-5.3" },
      { id: "cline-pass/glm-5.3", name: "dup" },
      { id: "cline-pass/kimi-k3", name: "kimi-k3" },
      { id: "cline-cloud/glm-5.3", name: "cloud" },
      { name: "no id" },
    ],
    free: [
      { id: "cline-free/mimo-v2.6-flash", name: "free" },
      { id: "stealth/pixel-canary", name: "stealth" },
      { id: "openai/gpt-6-astra", name: "byok" },
      "nope",
    ],
  });
  assert.deepEqual(
    live.map((m) => m.id),
    [
      "cline-pass/glm-5.3",
      "cline-pass/kimi-k3",
      "cline-free/mimo-v2.6-flash",
      "stealth/pixel-canary",
    ],
  );
});

test("parseRecommendedModels tolerates unexpected shapes", () => {
  assert.deepEqual(parseRecommendedModels(undefined), []);
  assert.deepEqual(parseRecommendedModels({}), []);
  assert.deepEqual(parseRecommendedModels({ clinePass: "nope", free: 42 }), []);
});

// ─── models.dev ────────────────────────────────────────────────────────────

const MODELS_DEV_FIXTURE = {
  "cline-pass": {
    models: {
      "cline-pass/glm-5.3": {
        name: "GLM-5.3",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
        modalities: { input: ["text"] },
        limit: { context: 1_000_000, output: 131_072 },
        cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
      },
      "cline-pass/mimo-v2.6-flash": {
        name: "MiMo-V2.6-Flash",
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }],
        modalities: { input: ["text", "image", "audio"] },
        limit: { context: 1_048_576, output: 131_072 },
        cost: { input: 0.14, output: 0.28, cache_read: 0.0028 },
      },
      "cline-pass/retired": { name: "retired" },
    },
  },
};

test("parseModelsDev extracts normalized metadata", () => {
  const dev = parseModelsDev(MODELS_DEV_FIXTURE);
  assert.equal(dev.size, 3);
  const glm = dev.get("cline-pass/glm-5.3");
  assert.equal(glm?.name, "GLM-5.3");
  assert.equal(glm?.context, 1_000_000);
  assert.equal(glm?.output, 131_072);
  assert.equal(glm?.cost?.cacheRead, 0.26);
  assert.deepEqual(glm?.reasoningOptions, [{ type: "effort", values: ["low", "high", "max"] }]);
});

test("parseModelsDev tolerates missing provider", () => {
  assert.equal(parseModelsDev({ openai: {} }).size, 0);
  assert.equal(parseModelsDev(null).size, 0);
});

// ─── Thinking maps ─────────────────────────────────────────────────────────

test("effort models map pi levels exactly and off only when none is advertised", () => {
  const map = deriveThinkingLevelMap({
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["low", "high", "max"] }],
  });
  assert.deepEqual(map, {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
});

test("effort models with none enable off", () => {
  const map = deriveThinkingLevelMap({
    reasoning: true,
    reasoningOptions: [{ type: "effort", values: ["none", "low", "high", "max"] }],
  });
  assert.equal(map?.off, "none");
  assert.equal(map?.low, "low");
  assert.equal(map?.max, "max");
  assert.equal(map?.xhigh, null);
});

test("toggle and metadata-less models use the conservative default map", () => {
  assert.deepEqual(
    deriveThinkingLevelMap({ reasoning: true, reasoningOptions: [{ type: "toggle" }] }),
    DEFAULT_THINKING_LEVEL_MAP,
  );
  assert.deepEqual(deriveThinkingLevelMap(undefined), DEFAULT_THINKING_LEVEL_MAP);
});

test("reasoning false removes the thinking map", () => {
  assert.equal(deriveThinkingLevelMap({ reasoning: false }), undefined);
});

// ─── Catalog merge ─────────────────────────────────────────────────────────

test("buildCatalogEntry merges live ids with models.dev metadata", () => {
  const dev = parseModelsDev(MODELS_DEV_FIXTURE);
  const entry = buildCatalogEntry({ id: "cline-pass/mimo-v2.6-flash", name: "Mimo V2.6 Flash" }, dev.get("cline-pass/mimo-v2.6-flash"));
  assert.equal(entry.name, "MiMo-V2.6-Flash");
  assert.deepEqual(entry.input, ["text", "image"]);
  assert.equal(entry.cost.input, 0.14);
  assert.equal(entry.thinkingLevelMap?.off, "none");
  assert.equal(entry.compat.supportsDeveloperRole, false);
});

test("buildCatalogEntry falls back when models.dev has no entry", () => {
  const entry = buildCatalogEntry({ id: "cline-pass/new-model", name: "new-model" }, undefined);
  assert.equal(entry.name, "new-model");
  assert.equal(entry.contextWindow, 200_000);
  assert.equal(entry.maxTokens, 64_000);
  assert.deepEqual(entry.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(entry.thinkingLevelMap, DEFAULT_THINKING_LEVEL_MAP);
});

test("buildCatalog excludes models that are no longer live, even if models.dev lists them", () => {
  const dev = parseModelsDev(MODELS_DEV_FIXTURE);
  const catalog = buildCatalog([{ id: "cline-pass/glm-5.3" }], dev);
  assert.deepEqual(catalog.map((m) => m.id), ["cline-pass/glm-5.3"]);
});

// ─── Cache ─────────────────────────────────────────────────────────────────

test("parseCatalogCache roundtrips a valid cache and rejects malformed input", () => {
  const models = buildCatalog([{ id: "cline-pass/glm-5.3", name: "GLM-5.3" }], parseModelsDev(MODELS_DEV_FIXTURE));
  const cache = { version: 1, fetchedAt: 42, models } as const;
  const parsed = parseCatalogCache(JSON.stringify(cache));
  assert.equal(parsed?.fetchedAt, 42);
  assert.equal(parsed?.models[0]?.id, "cline-pass/glm-5.3");
  assert.equal(parseCatalogCache("{}"), undefined);
  assert.equal(parseCatalogCache("not json"), undefined);
});

test("parseCatalogCache accepts free-tier ids and rejects unregistered prefixes", () => {
  const freeModels = buildCatalog(
    [
      { id: "cline-free/mimo-v2.6-flash", name: "free" },
      { id: "stealth/pixel-canary", name: "stealth" },
    ],
    new Map(),
  );
  const parsed = parseCatalogCache(JSON.stringify({ version: 1, fetchedAt: 7, models: freeModels }));
  assert.deepEqual(
    parsed?.models.map((m) => m.id),
    ["cline-free/mimo-v2.6-flash", "stealth/pixel-canary"],
  );
  const cloud = buildCatalog([{ id: "cline-cloud/glm-5.3", name: "cloud" }], new Map());
  assert.equal(parseCatalogCache(JSON.stringify({ version: 1, fetchedAt: 1, models: cloud })), undefined);
});

// ─── Discovery orchestration ───────────────────────────────────────────────

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("discoverCatalog fetches both sources and writes the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-"));
  const cachePath = join(dir, "catalog.json");
  try {
    const fetchMock: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("recommended-models")) {
        return jsonResponse({
          clinePass: [
            { id: "cline-pass/glm-5.3", name: "GLM-5.3" },
            { id: "cline-pass/brand-new", name: "Brand New" },
          ],
          free: [{ id: "stealth/pixel-canary", name: "Pixel Canary" }],
        });
      }
      return jsonResponse(MODELS_DEV_FIXTURE);
    };

    const result = await discoverCatalog({ fetch: fetchMock, cachePath, now: 1000 });
    assert.equal(result.source, "network");
    assert.equal(result.models.length, 3);
    assert.equal(result.models[1]?.id, "cline-pass/brand-new");
    assert.equal(result.models[0]?.cost.input, 1.4);
    assert.equal(result.models[2]?.id, "stealth/pixel-canary");
    assert.equal(result.models[2]?.cost.input, 0);

    const onDisk = JSON.parse(readFileSync(cachePath, "utf8"));
    assert.equal(onDisk.models.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCatalog serves a fresh cache without touching the network", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-"));
  const cachePath = join(dir, "catalog.json");
  try {
    let fetched = 0;
    const fetchMock: typeof globalThis.fetch = async () => {
      fetched += 1;
      return jsonResponse({ clinePass: [{ id: "cline-pass/glm-5.3" }] });
    };
    await discoverCatalog({ fetch: fetchMock, cachePath, now: 1000 });
    assert.equal(fetched, 2);
    const again = await discoverCatalog({ fetch: fetchMock, cachePath, now: 2000 });
    assert.equal(again.source, "cache");
    assert.equal(fetched, 2);
    const forced = await discoverCatalog({ fetch: fetchMock, cachePath, now: 2000, force: true });
    assert.equal(forced.source, "network");
    assert.equal(fetched, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCatalog falls back to a stale cache when the live source fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-"));
  const cachePath = join(dir, "catalog.json");
  try {
    const okFetch: typeof globalThis.fetch = async (input) =>
      String(input).includes("recommended-models")
        ? jsonResponse({ clinePass: [{ id: "cline-pass/glm-5.3" }] })
        : jsonResponse(MODELS_DEV_FIXTURE);
    await discoverCatalog({ fetch: okFetch, cachePath, now: 1000 });

    const failingFetch: typeof globalThis.fetch = async () => {
      throw new Error("offline");
    };
    const result = await discoverCatalog({
      fetch: failingFetch,
      cachePath,
      now: 1000 + 24 * 60 * 60 * 1000,
      ttlMs: 60_000,
    });
    assert.equal(result.source, "cache");
    assert.equal(result.models.length, 1);
    assert.ok(result.warnings.some((warning) => warning.includes("recommended-models fetch failed")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCatalog falls back to the bundled seed when everything is unavailable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-"));
  const cachePath = join(dir, "catalog.json");
  const failingFetch: typeof globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    const result = await discoverCatalog({ fetch: failingFetch, cachePath });
    assert.equal(result.source, "seed");
    assert.ok(result.models.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("discoverCatalog with allowNetwork false never fetches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-"));
  const cachePath = join(dir, "catalog.json");
  try {
    let fetched = 0;
    const fetchMock: typeof globalThis.fetch = async () => {
      fetched += 1;
      return jsonResponse({});
    };
    const result = await discoverCatalog({ fetch: fetchMock, cachePath, allowNetwork: false });
    assert.equal(fetched, 0);
    assert.equal(result.source, "seed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Keep the unused type import meaningful for future fixtures.
const _devTypeCheck: DevModel = { name: "x" };
void _devTypeCheck;
