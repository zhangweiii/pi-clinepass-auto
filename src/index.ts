/**
 * pi-clinepass-auto — ClinePass provider for pi.
 *
 * Registers the `clinepass` provider with a live model catalog:
 *   - availability from Cline's recommended-models endpoint;
 *   - pricing/limits/reasoning metadata from models.dev;
 *   - on-disk cache + bundled seed for offline startup.
 *
 * Adds a server-truth usage meter fed by Cline's usage/plan APIs:
 *   - message_end -> adopt the billed record, update the footer meter;
 *   - web search records are folded into the session total as well;
 *   - /clinepass -> report (plan windows, session cost, catalog status),
 *     manual catalog refresh.
 *
 * Model catalog refresh runs through pi's own `refreshModels` (startup and
 * the model selector's refresh), so new ClinePass models appear without a
 * package update.
 *
 * Also registers `web_search` (Cline's Exa-backed search endpoint) and
 * `web_fetch` (local HTTP fetch plus HTML-to-text). `web_search` is only
 * activated while a Cline credential is available, so accounts without one
 * never see a tool that cannot work.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { apiBase, getActiveToken, getApiKey, invalidateTokenCache, login, PROVIDER_NAME, refreshToken, resolveCredential } from "./auth.ts";
import { discoverCatalog, explainFreeModelError, isFreeModelId, loadInitialCatalog, requestSignal, type CatalogEntry } from "./discovery.ts";
import { DEFAULT_PREFS, readPrefs, writePrefs, type Prefs } from "./prefs.ts";
import {
  applyRoutePreference,
  buildProbeBody,
  buildRouteLines,
  capabilityHint,
  judgeCapability,
  mergeChannelLists,
  orderChannels,
  parseRoutingFacts,
  summarizeRoute,
  type RouteCapability,
  type RoutePreference,
  type RoutingFacts,
} from "./routes.ts";
import {
  buildReportLines,
  collectTurnRecords,
  COST_ENTRY_TYPE,
  fetchPlanLimits,
  fetchUsageRecords,
  formatMeter,
  SEARCH_ENTRY_TYPE,
  sumSessionCosts,
  type PlanLimits,
  type SearchWindow,
  type UsageRecord,
} from "./usage.ts";
import { applyWebToolActivation, registerWebTools } from "./webtools.ts";

const STATUS_KEY = "clinepass-usage";
const REPORT_KEY = "clinepass-report";
const ROUTE_KEY = "clinepass-route";
const FREE_ALIAS = "cline-pass";

/** Catalog prefix of the subscription models. */
const PAID_PREFIX = "cline-pass/";

/** Upstream-channel inspection. */
const ROUTE_CHAT_PATH = "/api/v1/chat/completions";
const ROUTE_PROBE_TIMEOUT_MS = 30_000;
const ROUTE_PROBE_ATTEMPTS = 3;
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
const ROUTE_PROBE_COST_LABEL = "$0.0001";

/** Poll attempts while Cline's billing pipeline flushes the turn record. */
const TRACK_ATTEMPTS = 5;
const TRACK_INTERVAL_MS = 2_500;
/** Refresh plan limits every N adopted turns. */
const LIMITS_REFRESH_EVERY = 5;

interface CatalogState {
  size: number;
  source: string;
  fetchedAt?: number;
  warnings: string[];
}

interface SessionState {
  turnUsd: number;
  sessionUsd: number;
  /** Web search cost included in `sessionUsd`. */
  searchUsd: number;
  turns: number;
  searches: number;
  lastAdoptedId?: string;
  lastAdoptedCreatedAt?: number;
  limits?: PlanLimits;
  catalog: CatalogState;
}

const state: SessionState = {
  turnUsd: 0,
  sessionUsd: 0,
  searchUsd: 0,
  turns: 0,
  searches: 0,
  catalog: { size: 0, source: "seed", warnings: [] },
};

/** Models the last catalog refresh registered, for the channel model picker. */
let catalogModels: CatalogEntry[] = [];

/** Result of one upstream-channel inspection, cached per model. */
interface RouteInspection {
  model: string;
  /** Routing facts observed while the stored preference was in effect. */
  facts: RoutingFacts;
  capability: RouteCapability;
  /** True when the serving channel is the preferred one. */
  active: boolean;
  /** Why a preference is not taking effect, from the unpinned observation. */
  hint?: string;
  preference?: RoutePreference;
  at: number;
}

const routeCache = new Map<string, RouteInspection>();

/** 跨会话保留的显示偏好；默认显示 meter。 */
let prefs: Prefs = { ...DEFAULT_PREFS };

/**
 * Web tool availability.
 *
 * Both tools stay registered so that `-t` / `-xt` and the /clinepass menu can
 * refer to them, but `web_search` is activated only while a Cline credential
 * exists. Deactivated tools are sent neither to the provider nor to the
 * system prompt, so the model does not see them at all.
 *
 * Only tools this extension deactivated itself are re-enabled: an explicit
 * `-xt web_search` (or a `-t` allowlist) is never overridden.
 */
const webToolsRemovedByExtension = new Set<string>();
/** True while the extension runtime is attached to a live session. */
let sessionReady = false;
/** Set once /login succeeds, so the tools appear without a restart. */
let loginGranted = false;

/**
 * Local windows in which this extension ran a `web_search`. They are matched
 * against the billed records so that a search made by another Cline client on
 * the same account is never counted as this session's spending.
 */
const searchWindows: SearchWindow[] = [];
const SEARCH_WINDOW_LIMIT = 50;

function recordSearchWindow(window: { startedAt: number; finishedAt: number }): void {
  searchWindows.push([window.startedAt, window.finishedAt]);
  if (searchWindows.length > SEARCH_WINDOW_LIMIT) {
    searchWindows.splice(0, searchWindows.length - SEARCH_WINDOW_LIMIT);
  }
}

function hasClineCredential(): boolean {
  if (loginGranted) return true;
  try {
    return resolveCredential() !== undefined;
  } catch {
    return false;
  }
}

function syncWebToolActivation(pi: ExtensionAPI): void {
  if (!sessionReady) return;
  try {
    const next = applyWebToolActivation({
      active: pi.getActiveTools(),
      removedByExtension: webToolsRemovedByExtension,
      webToolsHidden: prefs.webToolsHidden,
      hasCredential: hasClineCredential(),
    });
    webToolsRemovedByExtension.clear();
    for (const name of next.removedByExtension) webToolsRemovedByExtension.add(name);
    pi.setActiveTools(next.active);
  } catch {
    // The session was replaced or shut down mid-flight; the next
    // session_start re-syncs the tool set.
  }
}

function isClinePassModel(model: { provider?: string } | undefined): boolean {
  return model?.provider === PROVIDER_NAME || model?.provider === FREE_ALIAS;
}

/**
 * Free-tier models are registered only when the user asks for them: Cline's
 * API rejects them ("only available via Cline product surfaces"), so listing
 * them by default only produces confusing 403s.
 */
function visibleModels(models: CatalogEntry[]): CatalogEntry[] {
  return prefs.showFreeModels ? [...models] : models.filter((model) => !isFreeModelId(model.id));
}

/** Report note about free models the catalog lists but Cline's API refuses. */
function hiddenFreeNote(): string | undefined {
  const hidden = catalogModels.filter((model) => isFreeModelId(model.id)).length;
  if (hidden === 0) return undefined;
  return `${hidden} free model(s) hidden — Cline serves them only to its IDE and CLI; /clinepass can list them`;
}

function toProviderModels(models: CatalogEntry[]): ProviderModelConfig[] {
  return visibleModels(models).map((model) => ({
    id: model.id,
    name: `${model.name}${isFreeModelId(model.id) ? " (Cline Free, IDE/CLI only)" : " (ClinePass)"}`,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    input: [...model.input],
    cost: { ...model.cost },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat: { ...model.compat },
  }));
}

function providerConfig(models: CatalogEntry[], onLogin: () => void): ProviderConfig {
  const envKey = process.env.CLINE_API_KEY?.trim();
  return {
    name: "ClinePass",
    baseUrl: `${apiBase()}/api/v1`,
    ...(envKey ? { apiKey: "$CLINE_API_KEY" } : {}),
    authHeader: true,
    api: "openai-completions",
    oauth: {
      name: "ClinePass",
      isSubscription: true,
      login: async (callbacks) => {
        const credentials = await login(callbacks);
        onLogin();
        return credentials;
      },
      refreshToken,
      getApiKey,
    },
    models: toProviderModels(models),
    refreshModels: async (context) => {
      const result = await discoverCatalog({
        allowNetwork: context.allowNetwork,
        force: context.force,
        signal: context.signal,
      });
      state.catalog = {
        size: visibleModels(result.models).length,
        source: result.source,
        fetchedAt: result.fetchedAt,
        warnings: result.warnings,
      };
      catalogModels = result.models;
      return toProviderModels(result.models);
    },
  };
}

function renderMeter(ctx: ExtensionContext): void {
  // Background work (usage polling, plan refresh) can outlive the session
  // that started it, and a stale ctx throws on any property access.
  try {
    if (!ctx.ui?.setStatus) return;
    if (prefs.meterHidden || !isClinePassModel(ctx.model)) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }
    ctx.ui.setStatus(
      STATUS_KEY,
      formatMeter({
        turnUsd: state.turnUsd,
        sessionUsd: state.sessionUsd,
        searchUsd: state.searchUsd,
        limits: state.limits,
      }),
    );
  } catch {
    // Session replaced, reloaded, or shut down with the work still in flight.
  }
}

async function refreshLimits(ctx: ExtensionContext): Promise<void> {
  // No ctx.signal here: this runs in the background after the turn's abort
  // signal may already be gone. Each request has its own timeout.
  const limits = await fetchPlanLimits().catch(() => undefined);
  if (limits) state.limits = limits;
  renderMeter(ctx);
}

// ─── Upstream channels ─────────────────────────────────────────────────────

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui?.notify?.(message, level);
  } catch {
    // Session replaced or shut down.
  }
}

/**
 * Send one cheap probe and read the gateway's routing facts. Retries because
 * the gateway occasionally answers a tiny completion with an empty body.
 */
async function probeModelRoute(
  model: string,
  pin: string | undefined,
  signal: AbortSignal | undefined,
): Promise<RoutingFacts | undefined> {
  const token = await getActiveToken({ signal }).catch(() => undefined);
  if (!token) return undefined;

  for (let attempt = 0; attempt < ROUTE_PROBE_ATTEMPTS; attempt += 1) {
    const { signal: requestAbort, cleanup } = requestSignal(signal, ROUTE_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase()}${ROUTE_CHAT_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "pi-clinepass-auto",
        },
        body: JSON.stringify(buildProbeBody(model, pin)),
        signal: requestAbort,
      });
      const text = await response.text();
      if (response.status === 401) {
        invalidateTokenCache();
        return undefined;
      }
      const facts = parseRoutingFacts(parseJsonText(text));
      if (facts) return facts;
    } catch {
      // Transient network or timeout: try again.
    } finally {
      cleanup();
    }
  }
  return undefined;
}

/**
 * Inspect one model: probe with the stored preference (if any), then probe a
 * different available channel to learn whether a preference can take effect.
 */
async function inspectModelRoute(
  model: string,
  signal?: AbortSignal,
): Promise<RouteInspection | undefined> {
  const preference = prefs.routes[model];
  const preferred = preference?.only[0];

  // Unpinned first: it reports the widest channel list, which the picker needs
  // even when a preference narrows the gateway's answer down to one channel.
  const defaultFacts = await probeModelRoute(model, undefined, signal);
  if (!defaultFacts) return undefined;

  let serving = defaultFacts;
  if (preferred !== undefined && preferred !== defaultFacts.finalProvider) {
    const pinnedFacts = await probeModelRoute(model, preferred, signal);
    if (pinnedFacts) serving = pinnedFacts;
  }
  const active = preferred !== undefined && serving.finalProvider === preferred;

  let capability: RouteCapability = judgeCapability({ preferenceActive: active });
  if (!active) {
    const channels = mergeChannelLists(defaultFacts, serving);
    const candidate = channels.find((name) => name !== preferred && name !== serving.finalProvider);
    if (candidate) {
      const facts = await probeModelRoute(model, candidate, signal);
      if (facts?.finalProvider === candidate) {
        capability = judgeCapability({ preferenceActive: false, honoredPin: true });
      }
    }
  }

  const inspection: RouteInspection = {
    model,
    facts: { ...serving, fallbacksAvailable: mergeChannelLists(defaultFacts, serving) },
    capability,
    active,
    ...(capability === "not-pinnable" ? { hint: capabilityHint(serving) } : {}),
    ...(preference ? { preference } : {}),
    at: Date.now(),
  };
  routeCache.set(model, inspection);
  return inspection;
}

function clockLabel(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderRouteWidget(ctx: ExtensionContext, inspection: RouteInspection, warning?: string): void {
  const lines = buildRouteLines({
    model: inspection.model,
    facts: inspection.facts,
    capability: inspection.capability,
    ...(inspection.preference ? { preference: inspection.preference } : {}),
    active: inspection.active,
    checkedLabel: clockLabel(inspection.at),
    costLabel: ROUTE_PROBE_COST_LABEL,
    ...(inspection.hint ? { hint: inspection.hint } : {}),
    ...(warning ? { warning } : {}),
  });
  if (!ctx.hasUI) {
    console.log(`\n${lines.join("\n")}\n`);
    return;
  }
  try {
    ctx.ui?.setWidget?.(ROUTE_KEY, lines);
  } catch {
    // Session replaced or shut down while probing.
  }
}

function showRouteNotice(ctx: ExtensionContext, lines: string[]): void {
  if (!ctx.hasUI) {
    console.log(`\n${lines.join("\n")}\n`);
    return;
  }
  try {
    ctx.ui?.setWidget?.(ROUTE_KEY, lines);
  } catch {
    // Session replaced or shut down.
  }
}

/** Inspect a model and render the panel, reusing the cache while it is fresh. */
async function showRoutePanel(
  ctx: ExtensionCommandContext,
  model: string,
  options: { force?: boolean } = {},
): Promise<RouteInspection | undefined> {
  const cached = routeCache.get(model);
  const fresh = cached !== undefined && Date.now() - cached.at < ROUTE_CACHE_TTL_MS;
  if (fresh && !options.force) {
    renderRouteWidget(ctx, cached);
    return cached;
  }

  if (ctx.hasUI) {
    showRouteNotice(ctx, [
      `Upstream  ${model}`,
      `Can set   checking… (2 probes ≈ ${ROUTE_PROBE_COST_LABEL})`,
    ]);
  }
  const inspection = await inspectModelRoute(model, ctx.signal);
  if (!inspection) {
    if (cached) {
      renderRouteWidget(ctx, cached, "Re-check failed — showing the previous result.");
    } else {
      showRouteNotice(ctx, [
        `Upstream  ${model}`,
        "Can set   unknown — the probe failed (network or gateway error)",
        "Note      Retry with /cline-route, or check the connection.",
      ]);
    }
    return undefined;
  }
  renderRouteWidget(ctx, inspection);
  return inspection;
}

/** Subscription models only: free-tier ids are rejected on the API path. */
function routeModels(): CatalogEntry[] {
  return catalogModels.filter((entry) => entry.id.startsWith(PAID_PREFIX));
}

/** Ask which ClinePass model to inspect (the active one first). */
async function pickRouteModel(ctx: ExtensionCommandContext): Promise<string | undefined> {
  const ids = routeModels().map((entry) => entry.id);
  if (ids.length === 0) return undefined;
  const activeId = ctx.model?.id;
  const ordered = activeId && ids.includes(activeId) ? [activeId, ...ids.filter((id) => id !== activeId)] : ids;
  const options = ordered.map((id) => (id === activeId ? `${id}  (active)` : id));
  const pick = await ctx.ui.select("ClinePass model", [...options, "Cancel"]);
  if (!pick || pick === "Cancel") return undefined;
  return pick.replace(/\s+\(active\)$/, "");
}

/** Save, clear, or re-check one model's channel preference. */
async function routeMenu(ctx: ExtensionCommandContext, model: string): Promise<void> {
  const inspection = await showRoutePanel(ctx, model);
  if (!inspection) return;

  const actions = [
    "Set channel…",
    ...(inspection.preference ? ["Clear preference"] : []),
    "Check again",
    "Close",
  ];
  const action = await ctx.ui.select(`Upstream — ${model}`, actions);
  if (!action || action === "Close") return;

  if (action === "Check again") {
    await showRoutePanel(ctx, model, { force: true });
    return;
  }

  if (action === "Clear preference") {
    const routes = { ...prefs.routes };
    delete routes[model];
    prefs = { ...prefs, routes };
    writePrefs(prefs);
    routeCache.delete(model);
    const cleared = await showRoutePanel(ctx, model, { force: true });
    notify(ctx, `Upstream for ${model} back to automatic (${cleared?.facts.finalProvider ?? "unknown"}).`, "info");
    return;
  }

  const channels = orderChannels(inspection.facts);
  const options = channels.map((name) =>
    name === inspection.facts.finalProvider ? `${name}  (serving now)` : name,
  );
  const pick = await ctx.ui.select(`Upstream channel for ${model}`, [...options, "Cancel"]);
  if (!pick || pick === "Cancel") return;
  const channel = pick.replace(/\s+\(serving now\)$/, "");

  if (inspection.capability !== "pinnable") {
    const proceed = await ctx.ui.confirm(
      "The gateway may ignore this",
      `This model does not accept a client-side channel right now. ${capabilityHint(inspection.facts)}\n\nSave "${channel}" anyway? It is sent with every request and applies as soon as the gateway allows it.`,
    );
    if (!proceed) return;
  }

  prefs = { ...prefs, routes: { ...prefs.routes, [model]: { only: [channel] } } };
  writePrefs(prefs);

  const verified = await inspectModelRoute(model, ctx.signal);
  if (verified) renderRouteWidget(ctx, verified);
  const serving = verified?.facts.finalProvider ?? "unknown";
  notify(
    ctx,
    verified?.active
      ? `Upstream for ${model} pinned to ${channel} (verified).`
      : `Saved ${channel} for ${model}; the gateway still serves ${serving} — it will apply once the gateway allows it.`,
    verified?.active ? "info" : "warning",
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Turn tracking is serialized: an agent turn can finalize several assistant
 * messages (tool loops), and concurrent usage polls could otherwise adopt
 * the same billing record twice or skip one.
 */
let trackChain: Promise<void> = Promise.resolve();

function enqueueTracking(task: () => Promise<void>): void {
  trackChain = trackChain.then(task, task).catch(() => {});
}

/**
 * Wait for the billed record of a finished turn and adopt it into the
 * session meter. Runs in the background: message_end handlers are awaited
 * inline, and usage polling must never gate the agent loop.
 */
async function trackTurn(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  modelId: string,
  turnStartedAt: number,
): Promise<void> {
  const token = await getActiveToken().catch(() => undefined);
  if (!token) return;

  for (let attempt = 0; attempt < TRACK_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await delay(TRACK_INTERVAL_MS);
    const records = await fetchUsageRecords(token).catch(() => undefined);
    if (!records) continue;
    const collected = collectTurnRecords(records, {
      model: modelId,
      turnStartedAt,
      lastAdoptedId: state.lastAdoptedId,
      lastAdoptedCreatedAt: state.lastAdoptedCreatedAt,
      searchWindows,
    });
    if (collected.searches.length > 0) adoptSearches(pi, ctx, collected.searches);
    if (!collected.chat) continue;
    adoptRecord(pi, ctx, collected.chat);
    return;
  }
}

/**
 * Adopt web search billing records. They are part of the session total but
 * deliberately not of the `turn` figure, which keeps pi's own meaning of the
 * last model request.
 */
function adoptSearches(pi: ExtensionAPI, ctx: ExtensionContext, records: UsageRecord[]): void {
  for (const record of records) {
    const createdAt = Date.parse(record.createdAt);
    state.lastAdoptedId = record.id;
    if (!Number.isNaN(createdAt)) state.lastAdoptedCreatedAt = createdAt;
    state.sessionUsd += record.costUsd;
    state.searchUsd += record.costUsd;
    state.searches += 1;
    pi.appendEntry(SEARCH_ENTRY_TYPE, {
      usageId: record.id,
      costUsd: record.costUsd,
      operation: record.operation ?? "web_search",
      createdAt: record.createdAt,
    });
  }
  renderMeter(ctx);
}

function adoptRecord(pi: ExtensionAPI, ctx: ExtensionContext, record: UsageRecord): void {
  state.lastAdoptedId = record.id;
  state.lastAdoptedCreatedAt = Date.parse(record.createdAt) || undefined;
  state.turnUsd = record.costUsd;
  state.sessionUsd += record.costUsd;
  state.turns += 1;
  pi.appendEntry(COST_ENTRY_TYPE, {
    usageId: record.id,
    costUsd: record.costUsd,
    model: record.model,
    createdAt: record.createdAt,
  });
  renderMeter(ctx);
  if (state.turns % LIMITS_REFRESH_EVERY === 0) void refreshLimits(ctx);
}

/**
 * Render the usage/limits report: plan windows from the server plus local
 * session and catalog state. Shared by `/clinepass → Report` and the
 * `/cline-usage` / `/usage` commands.
 */
async function showReport(
  ctx: ExtensionCommandContext,
  hasUi: boolean,
): Promise<void> {
  const token = await getActiveToken({ signal: ctx.signal }).catch(() => undefined);
  const [limits, records] = await Promise.all([
    fetchPlanLimits({ signal: ctx.signal }).catch(() => undefined),
    token
      ? fetchUsageRecords(token, { signal: ctx.signal }).catch(() => undefined)
      : Promise.resolve(undefined),
  ]);
  if (limits) state.limits = limits;
  const activeModel = ctx.model?.id;
  const inspection = activeModel ? routeCache.get(activeModel) : undefined;
  const route = inspection
    ? summarizeRoute({
        model: inspection.model,
        facts: inspection.facts,
        capability: inspection.capability,
        active: inspection.active,
        ...(inspection.preference ? { preference: inspection.preference } : {}),
      })
    : undefined;
  const lines = buildReportLines({
    limits,
    sessionUsd: state.sessionUsd,
    turns: state.turns,
    searches: state.searches,
    searchUsd: state.searchUsd,
    ...(route ? { route } : {}),
    catalogSize: state.catalog.size,
    catalogFetchedAt: state.catalog.fetchedAt,
    catalogSource: state.catalog.source,
    warnings: [
      ...state.catalog.warnings,
      ...(prefs.showFreeModels ? [] : [hiddenFreeNote()]),
    ].filter((warning): warning is string => warning !== undefined),
  });
  if (ctx.hasUI && ctx.ui?.setWidget) {
    ctx.ui.setWidget(REPORT_KEY, lines);
    renderMeter(ctx);
  } else {
    console.log(`\n${lines.join("\n")}\n`);
  }
  if (records === undefined && limits === undefined && hasUi) {
    ctx.ui.notify("ClinePass usage API unavailable — sign in with `pi /login` (ClinePass).", "warning");
  }
}

export default function (pi: ExtensionAPI): void {
  prefs = readPrefs();
  const initial = loadInitialCatalog();
  state.catalog = {
    size: visibleModels(initial.models).length,
    source: initial.fetchedAt ? "cache" : "seed",
    fetchedAt: initial.fetchedAt,
    warnings: [],
  };

  // /login succeeds inside a running session: expose web_search immediately
  // instead of waiting for the next session_start.
  const onLoginSuccess = (): void => {
    loginGranted = true;
    syncWebToolActivation(pi);
  };

  registerWebTools(pi, { onSearchRequest: recordSearchWindow });
  catalogModels = initial.models;
  pi.registerProvider(PROVIDER_NAME, providerConfig(initial.models, onLoginSuccess));

  // Channel preferences ride on every provider request, so a pin keeps
  // applying even after the gateway's affinity drifts away from it.
  pi.on("before_provider_request", (event) => {
    const payload = event.payload;
    const model =
      typeof payload === "object" && payload !== null ? (payload as { model?: unknown }).model : undefined;
    if (typeof model !== "string") return;
    const preference = prefs.routes[model];
    if (!preference) return;
    return applyRoutePreference(payload, preference);
  });

  pi.registerCommand("cline-route", {
    description: "Show which upstream channel serves a ClinePass model, and whether it can be pinned",
    handler: async (args, ctx) => {
      const requested = args.trim();
      const model = requested || ctx.model?.id;
      if (!model) {
        notify(ctx, "No model selected — pass a model id, e.g. /cline-route cline-pass/glm-5.3", "warning");
        return;
      }
      if (!routeModels().some((entry) => entry.id === model)) {
        const hint = requested
          ? `Unknown subscription model "${model}".`
          : `The active model (${model}) is not a ClinePass subscription model.`;
        notify(ctx, `${hint} Try: /cline-route cline-pass/glm-5.3`, "warning");
        showRouteNotice(ctx, [
          `Upstream  ${model}`,
          "Can set   unknown — not a ClinePass subscription model",
          "Note      Use /cline-route cline-pass/… or switch models.",
        ]);
        return;
      }
      await showRoutePanel(ctx, model);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const entries = ctx.sessionManager?.getEntries?.() ?? [];
    const totals = sumSessionCosts(entries);
    state.turnUsd = 0;
    state.sessionUsd = totals.sessionUsd;
    state.searchUsd = totals.searchUsd;
    state.turns = totals.turns;
    state.searches = totals.searches;
    state.lastAdoptedId = undefined;
    state.lastAdoptedCreatedAt = undefined;
    searchWindows.length = 0;

    sessionReady = true;
    loginGranted = false;
    webToolsRemovedByExtension.clear();
    syncWebToolActivation(pi);

    // A saved channel preference may start working once the gateway's
    // affinity frees up; re-check the active model quietly and tell the user
    // only when it starts taking effect.
    const pinnedModel = ctx.model?.id;
    if (pinnedModel && prefs.routes[pinnedModel]) {
      const before = routeCache.get(pinnedModel);
      void (async () => {
        const inspection = await inspectModelRoute(pinnedModel, ctx.signal).catch(() => undefined);
        if (!inspection?.active || before?.active) return;
        notify(ctx, `Upstream for ${pinnedModel} is now ${inspection.facts.finalProvider} — your channel preference is taking effect.`, "info");
      })();
    }

    // Seed the adoption cursor with the newest existing record so turns
    // from previous sessions (already summed from entries) are not re-billed.
    void (async () => {
      const token = await getActiveToken({ signal: ctx.signal }).catch(() => undefined);
      if (token) {
        const records = await fetchUsageRecords(token, { signal: ctx.signal }).catch(() => undefined);
        const newest = records?.[0];
        if (newest) {
          state.lastAdoptedId = newest.id;
          state.lastAdoptedCreatedAt = Date.parse(newest.createdAt) || undefined;
        }
      }
      renderMeter(ctx);
      await refreshLimits(ctx);
    })();
  });

  pi.on("model_select", (_event, ctx) => {
    renderMeter(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant") return;
    if (!isClinePassModel({ provider: message.provider })) return;
    if (message.errorMessage) {
      // Cline answers free models with a 403 that reads like a client bug;
      // explain what it actually means.
      const explanation = explainFreeModelError(message.errorMessage);
      return explanation ? { message: { ...message, errorMessage: explanation } } : undefined;
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") return;
    const modelId = message.model;
    const turnStartedAt = message.timestamp || Date.now();
    enqueueTracking(() => trackTurn(pi, ctx, modelId, turnStartedAt));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionReady = false;
    webToolsRemovedByExtension.clear();
    searchWindows.length = 0;
    routeCache.clear();
    ctx.ui?.setStatus?.(STATUS_KEY, undefined);
    ctx.ui?.setWidget?.(ROUTE_KEY, undefined);
    ctx.ui?.setWidget?.(REPORT_KEY, undefined);
  });

  pi.registerCommand("clinepass", {
    description: "ClinePass report, plan limits, and model catalog refresh",
    handler: async (_args, ctx) => {
      const hasUi = Boolean(ctx.hasUI && ctx.ui?.select);
      const choices = [
        "Report — usage, limits, catalog",
        "Upstream channel…",
        "Refresh model catalog",
        "Hide report",
        prefs.meterHidden ? "Show footer meter" : "Hide footer meter",
        prefs.webToolsHidden ? "Show web tools" : "Hide web tools",
        prefs.showFreeModels ? "Hide free models" : "Show free models",
      ];
      const choice = hasUi ? await ctx.ui.select("ClinePass", choices) : choices[0];
      if (!choice) return;

      if (choice.startsWith("Report")) {
        await showReport(ctx, hasUi);
        return;
      }

      if (choice.startsWith("Upstream channel")) {
        if (!hasUi) {
          const model = ctx.model?.id;
          if (model) await showRoutePanel(ctx, model);
          return;
        }
        const model = await pickRouteModel(ctx);
        if (!model) return;
        await routeMenu(ctx, model);
        return;
      }

      if (choice.startsWith("Refresh")) {
        const result = await discoverCatalog({ allowNetwork: true, force: true, signal: ctx.signal });
        catalogModels = result.models;
        state.catalog = {
          size: visibleModels(result.models).length,
          source: result.source,
          fetchedAt: result.fetchedAt,
          warnings: result.warnings,
        };
        pi.registerProvider(PROVIDER_NAME, providerConfig(result.models, onLoginSuccess));
        if (hasUi) {
          const suffix = result.warnings.length > 0 ? ` — ${result.warnings.join("; ")}` : "";
          ctx.ui.notify(`ClinePass catalog: ${result.models.length} models (${result.source})${suffix}`, "info");
        } else {
          console.log(`ClinePass catalog: ${result.models.length} models (${result.source})`);
        }
        return;
      }

      if (choice.startsWith("Hide footer meter") || choice.startsWith("Show footer meter")) {
        prefs = { ...prefs, meterHidden: !prefs.meterHidden };
        writePrefs(prefs);
        renderMeter(ctx);
        if (hasUi) {
          ctx.ui.notify(`ClinePass footer meter ${prefs.meterHidden ? "hidden" : "shown"}.`, "info");
        }
        return;
      }

      if (choice.startsWith("Hide web tools") || choice.startsWith("Show web tools")) {
        prefs = { ...prefs, webToolsHidden: !prefs.webToolsHidden };
        writePrefs(prefs);
        syncWebToolActivation(pi);
        if (hasUi) {
          const message = prefs.webToolsHidden
            ? "Web tools hidden."
            : hasClineCredential()
              ? "Web tools shown."
              : "Web tools shown; web_search stays off until you sign in with /login (ClinePass).";
          ctx.ui.notify(message, "info");
        }
        return;
      }

      if (choice.startsWith("Hide free models") || choice.startsWith("Show free models")) {
        prefs = { ...prefs, showFreeModels: !prefs.showFreeModels };
        writePrefs(prefs);
        pi.registerProvider(PROVIDER_NAME, providerConfig(catalogModels, onLoginSuccess));
        const freeCount = catalogModels.filter((model) => isFreeModelId(model.id)).length;
        const message = prefs.showFreeModels
          ? `Free models listed (${freeCount}). Cline's API only serves them to its IDE and CLI, so calls will explain the 403.`
          : `Free models hidden (${freeCount} of ${catalogModels.length} catalog models).`;
        notify(ctx, message, "info");
        if (!prefs.showFreeModels && isFreeModelId(ctx.model?.id ?? "")) {
          notify(
            ctx,
            `The active model ${ctx.model?.id} is no longer registered — pick another with /model.`,
            "warning",
          );
        }
        return;
      }

      ctx.ui?.setWidget?.(REPORT_KEY, undefined);
    },
  });

  const usageCommand = {
    description: "ClinePass usage: plan windows (5h / 7d / 30d) and session cost",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      await showReport(ctx, Boolean(ctx.hasUI && ctx.ui?.select));
    },
  };
  pi.registerCommand("cline-usage", usageCommand);
  pi.registerCommand("usage", usageCommand);
}
