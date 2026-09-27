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
import { apiBase, getActiveToken, getApiKey, login, PROVIDER_NAME, refreshToken, resolveCredential } from "./auth.ts";
import { discoverCatalog, isFreeModelId, loadInitialCatalog, type CatalogEntry } from "./discovery.ts";
import { DEFAULT_PREFS, readPrefs, writePrefs, type Prefs } from "./prefs.ts";
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
const FREE_ALIAS = "cline-pass";

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

function toProviderModels(models: CatalogEntry[]): ProviderModelConfig[] {
  return models.map((model) => ({
    id: model.id,
    name: `${model.name}${isFreeModelId(model.id) ? " (Cline Free)" : " (ClinePass)"}`,
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
        size: result.models.length,
        source: result.source,
        fetchedAt: result.fetchedAt,
        warnings: result.warnings,
      };
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
  const lines = buildReportLines({
    limits,
    sessionUsd: state.sessionUsd,
    turns: state.turns,
    searches: state.searches,
    searchUsd: state.searchUsd,
    catalogSize: state.catalog.size,
    catalogFetchedAt: state.catalog.fetchedAt,
    catalogSource: state.catalog.source,
    warnings: state.catalog.warnings,
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
    size: initial.models.length,
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
  pi.registerProvider(PROVIDER_NAME, providerConfig(initial.models, onLoginSuccess));

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
    if (message.errorMessage || message.stopReason === "error" || message.stopReason === "aborted") return;
    const modelId = message.model;
    const turnStartedAt = message.timestamp || Date.now();
    enqueueTracking(() => trackTurn(pi, ctx, modelId, turnStartedAt));
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionReady = false;
    webToolsRemovedByExtension.clear();
    searchWindows.length = 0;
    ctx.ui?.setStatus?.(STATUS_KEY, undefined);
    ctx.ui?.setWidget?.(REPORT_KEY, undefined);
  });

  pi.registerCommand("clinepass", {
    description: "ClinePass report, plan limits, and model catalog refresh",
    handler: async (_args, ctx) => {
      const hasUi = Boolean(ctx.hasUI && ctx.ui?.select);
      const choices = [
        "Report — usage, limits, catalog",
        "Refresh model catalog",
        "Hide report",
        prefs.meterHidden ? "Show footer meter" : "Hide footer meter",
        prefs.webToolsHidden ? "Show web tools" : "Hide web tools",
      ];
      const choice = hasUi ? await ctx.ui.select("ClinePass", choices) : choices[0];
      if (!choice) return;

      if (choice.startsWith("Report")) {
        await showReport(ctx, hasUi);
        return;
      }

      if (choice.startsWith("Refresh")) {
        const result = await discoverCatalog({ allowNetwork: true, force: true, signal: ctx.signal });
        state.catalog = {
          size: result.models.length,
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
