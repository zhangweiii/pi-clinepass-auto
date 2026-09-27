/**
 * ClinePass live model catalog.
 *
 * Availability comes from Cline's own recommended-models endpoint
 * (`clinePass` + `free` arrays) — the authoritative list of what the
 * subscription currently serves. Metadata (pricing, limits, reasoning
 * options, input modalities) comes from the models.dev `cline-pass`
 * provider entry; the free-tier models have no models.dev entry and use
 * conservative defaults.
 *
 * The merged catalog is cached on disk so offline startup still shows
 * models, and a bundled seed covers the first run without network.
 *
 * Both sources are deliberately kept optional and independent:
 *   - live IDs but no models.dev metadata  -> models still register with
 *     conservative defaults;
 *   - models.dev metadata but no live IDs  -> stale models are NOT shown
 *     (the live endpoint decides availability).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { SEED_CATALOG } from "./seed.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

/** pi thinking levels, including the always-off level. */
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ThinkingLevelMap = Partial<Record<PiThinkingLevel, string | null>>;

export interface CatalogCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * ClinePass rejects the `developer` role (so system prompts must use
 * `system`) and is verified to accept Anthropic-style `cache_control`
 * markers; long-retention TTLs are not supported.
 */
export interface CatalogCompat {
  supportsDeveloperRole: false;
  cacheControlFormat: "anthropic";
  supportsLongCacheRetention: false;
}

export interface CatalogEntry {
  id: string;
  name: string;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: CatalogCost;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: ThinkingLevelMap;
  compat: CatalogCompat;
}

/** Minimal live model shape parsed from Cline's recommended-models response. */
export interface LiveModel {
  id: string;
  name?: string;
}

/** Normalized models.dev metadata for one model. */
export interface DevModel {
  name?: string;
  reasoning?: boolean;
  reasoningOptions?: { type: string; values?: string[] }[];
  inputModalities?: string[];
  context?: number;
  output?: number;
  cost?: { input?: number; output?: number; cacheRead?: number };
  releaseDate?: string;
}

// ─── Constants ─────────────────────────────────────────────────────────────

/** Default API base; override with CLINE_API_BASE. */
export const DEFAULT_API_BASE = "https://api.cline.bot";

/** Cline endpoint that lists the models the client currently recommends. */
export const RECOMMENDED_MODELS_ENDPOINT = "/api/v1/ai/cline/recommended-models";

/** Paid ClinePass model id prefix. */
export const CLINE_PASS_PREFIX = "cline-pass/";

/** Free-tier model id prefixes (the `free` array of recommended-models). */
export const FREE_MODEL_PREFIXES = ["cline-free/", "stealth/"] as const;

export function isFreeModelId(id: string): boolean {
  return FREE_MODEL_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** True for every id this provider registers (paid or free tier). */
export function isRegisteredModelId(id: string): boolean {
  return id.startsWith(CLINE_PASS_PREFIX) || isFreeModelId(id);
}

/** models.dev full catalog (contains a `cline-pass` provider entry). */
export const MODELS_DEV_URL = "https://models.dev/api.json";

/** How long a cached catalog is considered fresh (6 hours). */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** Per-request timeout for catalog fetches. */
export const FETCH_TIMEOUT_MS = 20_000;

/**
 * Fallback thinking map for models without usable reasoning metadata:
 * off maps to "none"; minimal/xhigh/max are left unsupported rather than
 * guessing provider-specific values.
 */
export const DEFAULT_THINKING_LEVEL_MAP: Record<PiThinkingLevel, string | null> = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

const COMPAT: CatalogCompat = {
  supportsDeveloperRole: false,
  cacheControlFormat: "anthropic",
  supportsLongCacheRetention: false,
};

const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS = 64_000;

// ─── Parsing helpers ───────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function collectLiveModels(raw: unknown, models: LiveModel[], seen: Set<string>): void {
  if (!Array.isArray(raw)) return;
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    if (!id || !isRegisteredModelId(id) || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: stringValue(item.name) });
  }
}

/**
 * Parse the `clinePass` and `free` arrays from Cline's recommended-models
 * response. Paid models come first, then the free-tier lineup.
 */
export function parseRecommendedModels(json: unknown): LiveModel[] {
  if (!isRecord(json)) return [];
  const seen = new Set<string>();
  const models: LiveModel[] = [];
  collectLiveModels(json.clinePass, models, seen);
  collectLiveModels(json.free, models, seen);
  return models;
}

/** Parse the models.dev catalog and keep the `cline-pass` provider's models. */
export function parseModelsDev(json: unknown): Map<string, DevModel> {
  const result = new Map<string, DevModel>();
  if (!isRecord(json)) return result;
  const provider = json["cline-pass"];
  if (!isRecord(provider) || !isRecord(provider.models)) return result;
  for (const [id, raw] of Object.entries(provider.models)) {
    if (!isRecord(raw)) continue;
    const limit = isRecord(raw.limit) ? raw.limit : undefined;
    const cost = isRecord(raw.cost) ? raw.cost : undefined;
    const modalities = isRecord(raw.modalities) ? raw.modalities : undefined;
    const reasoningOptions = Array.isArray(raw.reasoning_options)
      ? raw.reasoning_options.filter(isRecord).map((option) => ({
          type: stringValue(option.type) ?? "",
          values: Array.isArray(option.values)
            ? option.values.filter((v): v is string => typeof v === "string")
            : undefined,
        }))
      : undefined;
    result.set(id, {
      name: stringValue(raw.name),
      reasoning: typeof raw.reasoning === "boolean" ? raw.reasoning : undefined,
      reasoningOptions,
      inputModalities: Array.isArray(modalities?.input)
        ? modalities.input.filter((v): v is string => typeof v === "string")
        : undefined,
      context: numberValue(limit?.context),
      output: numberValue(limit?.output),
      cost: cost
        ? {
            input: numberValue(cost.input),
            output: numberValue(cost.output),
            cacheRead: numberValue(cost.cache_read),
          }
        : undefined,
      releaseDate: stringValue(raw.release_date),
    });
  }
  return result;
}

/**
 * Derive pi's thinking-level map from models.dev reasoning options.
 *
 * - `effort` options map pi levels 1:1 to the advertised effort values;
 *   `off` maps to "none" only when the provider advertises it.
 * - `toggle` options (and missing options) fall back to the conservative
 *   default map, which both known ClinePass clients have used successfully.
 * - `reasoning: false` returns undefined — pi then hides thinking levels.
 */
export function deriveThinkingLevelMap(dev: DevModel | undefined): ThinkingLevelMap | undefined {
  if (dev?.reasoning === false) return undefined;
  const effort = dev?.reasoningOptions?.find(
    (option) => option.type === "effort" && option.values && option.values.length > 0,
  );
  if (!effort?.values) return { ...DEFAULT_THINKING_LEVEL_MAP };

  const values = new Set(effort.values);
  const map: Record<PiThinkingLevel, string | null> = {
    off: values.has("none") ? "none" : null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  };
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    if (values.has(level)) map[level] = level;
  }
  return map;
}

/** Merge one live model with its models.dev metadata. */
export function buildCatalogEntry(live: LiveModel, dev: DevModel | undefined): CatalogEntry {
  const inputs = (dev?.inputModalities ?? ["text"]).filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  const reasoning = dev?.reasoning !== false;
  return {
    id: live.id,
    name: dev?.name ?? live.name ?? live.id,
    reasoning,
    input: inputs.length > 0 ? inputs : ["text"],
    cost: {
      input: dev?.cost?.input ?? 0,
      output: dev?.cost?.output ?? 0,
      cacheRead: dev?.cost?.cacheRead ?? 0,
      cacheWrite: 0,
    },
    contextWindow: dev?.context ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: dev?.output ?? FALLBACK_MAX_TOKENS,
    ...(reasoning ? { thinkingLevelMap: deriveThinkingLevelMap(dev) } : {}),
    compat: { ...COMPAT },
  };
}

/** Build the full catalog: live availability wins, models.dev enriches. */
export function buildCatalog(live: LiveModel[], dev: Map<string, DevModel>): CatalogEntry[] {
  return live.map((model) => buildCatalogEntry(model, dev.get(model.id)));
}

// ─── Cache ─────────────────────────────────────────────────────────────────

export interface CatalogCache {
  version: 1;
  fetchedAt: number;
  models: CatalogEntry[];
}

/** Resolve pi's agent dir the same way pi does (PI_CODING_AGENT_DIR aware). */
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  if (env) return env.startsWith("~") ? join(homedir(), env.slice(1)) : env;
  return join(homedir(), ".pi", "agent");
}

export function catalogCachePath(): string {
  return join(agentDir(), "clinepass-auto-catalog.json");
}

function isCatalogEntry(value: unknown): value is CatalogEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    isRegisteredModelId(value.id) &&
    typeof value.name === "string" &&
    typeof value.reasoning === "boolean" &&
    Array.isArray(value.input) &&
    isRecord(value.cost) &&
    typeof value.contextWindow === "number" &&
    typeof value.maxTokens === "number"
  );
}

export function parseCatalogCache(text: string): CatalogCache | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.fetchedAt !== "number") return undefined;
    if (!Array.isArray(parsed.models) || !parsed.models.every(isCatalogEntry)) return undefined;
    return { version: 1, fetchedAt: parsed.fetchedAt, models: parsed.models };
  } catch {
    return undefined;
  }
}

export function readCatalogCache(path = catalogCachePath()): CatalogCache | undefined {
  try {
    if (!existsSync(path)) return undefined;
    return parseCatalogCache(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function writeCatalogCache(cache: CatalogCache, path = catalogCachePath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Cache writes are best effort; the in-memory catalog stays valid.
  }
}

// ─── Discovery ─────────────────────────────────────────────────────────────

export interface DiscoverOptions {
  /** False during offline startup. Defaults to true. */
  allowNetwork?: boolean;
  /** Bypass the freshness window and fetch even when a fresh cache exists. */
  force?: boolean;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  cachePath?: string;
  /** Injectable clock (tests). */
  now?: number;
  /** Injectable TTL override (tests). */
  ttlMs?: number;
}

export interface DiscoverResult {
  models: CatalogEntry[];
  source: "network" | "cache" | "seed";
  fetchedAt?: number;
  /** Populated when a network source failed, for /clinepass diagnostics. */
  warnings: string[];
}

function resolveApiBase(): string {
  return process.env.CLINE_API_BASE?.trim() || DEFAULT_API_BASE;
}

export function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

async function fetchJson(url: string, fetchFn: typeof globalThis.fetch, signal?: AbortSignal): Promise<unknown> {
  const { signal: requestAbort, cleanup } = requestSignal(signal, FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { signal: requestAbort, headers: { "User-Agent": "pi-clinepass-auto" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    cleanup();
  }
}

/**
 * Resolve the catalog.
 *
 * Order of preference: fresh cache -> (network: live IDs + models.dev) ->
 * stale cache -> bundled seed. Network failures never throw; they degrade
 * to the best locally known catalog.
 */
export async function discoverCatalog(options: DiscoverOptions = {}): Promise<DiscoverResult> {
  const now = options.now ?? Date.now();
  const ttl = options.ttlMs ?? CATALOG_TTL_MS;
  const cache = readCatalogCache(options.cachePath);
  const fresh = cache !== undefined && now - cache.fetchedAt < ttl;

  if (cache && fresh && !options.force) {
    return { models: cache.models, source: "cache", fetchedAt: cache.fetchedAt, warnings: [] };
  }
  if (options.allowNetwork === false) {
    return cache
      ? { models: cache.models, source: "cache", fetchedAt: cache.fetchedAt, warnings: [] }
      : { models: SEED_CATALOG, source: "seed", warnings: ["offline: using bundled seed catalog"] };
  }

  const warnings: string[] = [];
  const fetchFn = options.fetch ?? globalThis.fetch;
  const apiBase = resolveApiBase();
  const liveUrl = `${apiBase}${RECOMMENDED_MODELS_ENDPOINT}`;

  const [liveSettled, devSettled] = await Promise.allSettled([
    fetchJson(liveUrl, fetchFn, options.signal),
    fetchJson(MODELS_DEV_URL, fetchFn, options.signal),
  ]);

  let live: LiveModel[] | undefined;
  if (liveSettled.status === "fulfilled") {
    live = parseRecommendedModels(liveSettled.value);
    if (live.length === 0) {
      warnings.push("recommended-models returned no models");
      live = undefined;
    }
  } else {
    warnings.push(`recommended-models fetch failed: ${errorMessage(liveSettled.reason)}`);
  }

  let dev: Map<string, DevModel> | undefined;
  if (devSettled.status === "fulfilled") {
    dev = parseModelsDev(devSettled.value);
    if (dev.size === 0) warnings.push("models.dev has no cline-pass models");
  } else {
    warnings.push(`models.dev fetch failed: ${errorMessage(devSettled.reason)}`);
  }

  if (live) {
    const models = buildCatalog(live, dev ?? new Map());
    if (models.length > 0) {
      writeCatalogCache({ version: 1, fetchedAt: now, models }, options.cachePath);
      return { models, source: "network", fetchedAt: now, warnings };
    }
  }

  if (cache) return { models: cache.models, source: "cache", fetchedAt: cache.fetchedAt, warnings };
  return { models: SEED_CATALOG, source: "seed", warnings };
}

/** Synchronous catalog for extension registration: cache first, seed last. */
export function loadInitialCatalog(): { models: CatalogEntry[]; fetchedAt?: number } {
  const cache = readCatalogCache();
  return cache ? { models: cache.models, fetchedAt: cache.fetchedAt } : { models: SEED_CATALOG };
}

function errorMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.name === "AbortError" ? "aborted or timed out" : reason.message;
  return String(reason);
}
