/**
 * Server-truth usage accounting for ClinePass.
 *
 * Chat turns are billed by Cline's gateway; after a turn completes the
 * matching record appears in the account's `/usages` feed. The footer meter
 * is fed from those records (not from local token estimates), so it shows
 * what the subscription was actually charged. Plan utilization
 * (5-hour/weekly/monthly windows) comes from the plan endpoints.
 */

import { apiBase, getActiveToken, invalidateTokenCache } from "./auth.ts";

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UsageRecord {
  id: string;
  /** Catalog-form model id (e.g. "cline-pass/glm-5.3"); empty for non-chat records. */
  model: string;
  /** Server-reported operation, e.g. "chat_completion" or "web_search". */
  operation?: string;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  costUsd: number;
  createdAt: string;
}

export interface LimitWindow {
  usedPercent: number;
  limitUsd?: number;
  resetsAt?: string;
}

export interface PlanLimits {
  planName: string;
  fiveHour: LimitWindow;
  sevenDay: LimitWindow;
  thirtyDay: LimitWindow;
}

export interface UsageOptions {
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  signal?: AbortSignal;
}

/** Cline reports money in 1e-8 USD units. */
export const COST_UNITS_PER_USD = 100_000_000;

const FETCH_TIMEOUT_MS = 15_000;
const USAGE_PAGE_SIZE = 20;

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

/** Parse `{data:{id}}` / `{id}` from GET /users/me. */
export function parseUserId(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  const data = isRecord(json.data) ? json.data : undefined;
  return stringValue(data?.id) ?? stringValue(json.id);
}

/** Parse the newest-first items from GET /users/{id}/usages. */
export function parseUsageRecords(json: unknown): UsageRecord[] | undefined {
  const items =
    isRecord(json) && isRecord(json.data) && Array.isArray(json.data.items)
      ? json.data.items
      : undefined;
  if (!items) return undefined;
  const records: UsageRecord[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    if (!id) continue;
    const promptTokens = numberValue(item.promptTokens) ?? 0;
    const completionTokens = numberValue(item.completionTokens) ?? 0;
    const metadata = isRecord(item.metadata) ? item.metadata : undefined;
    records.push({
      id,
      model: stringValue(item.aiModelName) ?? stringValue(metadata?.raw_model) ?? "",
      operation: stringValue(item.operation),
      promptTokens,
      cachedTokens: numberValue(item.cachedTokens) ?? 0,
      completionTokens,
      costUsd: (numberValue(item.costUsd) ?? 0) / COST_UNITS_PER_USD,
      createdAt: stringValue(item.createdAt) ?? "",
    });
  }
  return records;
}

function parseLimitWindow(
  limitsByType: Map<string, { usedPercent?: number; resetsAt?: string }>,
  type: string,
  limitUsd: number | undefined,
): LimitWindow {
  const entry = limitsByType.get(type);
  return {
    usedPercent: entry?.usedPercent ?? 0,
    limitUsd,
    resetsAt: entry?.resetsAt,
  };
}

/**
 * Parse plan utilization from GET /users/me/plan/usage-limits plus the cap
 * thresholds from GET /users/me/plan.
 */
export function parsePlanLimits(limitsJson: unknown, planJson: unknown): PlanLimits | undefined {
  if (!isRecord(limitsJson)) return undefined;
  const data = isRecord(limitsJson.data) ? limitsJson.data : limitsJson;
  const rawLimits = Array.isArray(data.limits) ? data.limits : undefined;
  if (!rawLimits) return undefined;

  const byType = new Map<string, { usedPercent?: number; resetsAt?: string }>();
  for (const item of rawLimits) {
    if (!isRecord(item)) continue;
    const type = stringValue(item.type);
    if (!type) continue;
    byType.set(type, {
      usedPercent: numberValue(item.percentUsed),
      resetsAt: stringValue(item.resetsAt),
    });
  }

  const planRoot = isRecord(planJson) && isRecord(planJson.data) ? planJson.data : planJson;
  const plan = isRecord(planRoot) && isRecord(planRoot.plan) ? planRoot.plan : undefined;
  const entitlements = isRecord(plan?.entitlements) ? plan.entitlements : undefined;
  const clinePass = isRecord(entitlements?.cline_pass) ? entitlements.cline_pass : undefined;
  const cap = isRecord(clinePass?.inferenceCapThreshold) ? clinePass.inferenceCapThreshold : undefined;
  const capUsd = (value: unknown): number | undefined => {
    const micro = numberValue(value);
    return micro === undefined ? undefined : micro / COST_UNITS_PER_USD;
  };

  return {
    planName: stringValue(plan?.displayName) ?? "ClinePass",
    fiveHour: parseLimitWindow(byType, "five_hour", capUsd(cap?.last5HoursUsageCostUSDPerUser)),
    sevenDay: parseLimitWindow(byType, "weekly", capUsd(cap?.last7daysUsageCostUSDPerUser)),
    thirtyDay: parseLimitWindow(byType, "monthly", capUsd(cap?.last30daysUsageCostUSDPerUser)),
  };
}

// ─── API fetchers ──────────────────────────────────────────────────────────

let userIdCache: { token: string; userId: string } | undefined;

async function getJson(
  path: string,
  token: string,
  options: UsageOptions,
): Promise<Record<string, unknown> | undefined> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), FETCH_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await fetchFn(`${options.apiBase ?? apiBase()}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 401) {
      invalidateTokenCache();
      userIdCache = undefined;
      return undefined;
    }
    if (!response.ok) return undefined;
    const body: unknown = await response.json().catch(() => undefined);
    return isRecord(body) ? body : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

async function getUserId(token: string, options: UsageOptions): Promise<string | undefined> {
  if (userIdCache?.token === token) return userIdCache.userId;
  const json = await getJson("/api/v1/users/me", token, options);
  const id = parseUserId(json);
  if (id) userIdCache = { token, userId: id };
  return id;
}

/** Fetch recent usage records, newest first. */
export async function fetchUsageRecords(
  token: string,
  options: UsageOptions = {},
): Promise<UsageRecord[] | undefined> {
  const userId = await getUserId(token, options);
  if (!userId) return undefined;
  const json = await getJson(
    `/api/v1/users/${encodeURIComponent(userId)}/usages?limit=${USAGE_PAGE_SIZE}`,
    token,
    options,
  );
  return parseUsageRecords(json);
}

/** Fetch rolling plan utilization and cap thresholds. */
export async function fetchPlanLimits(options: UsageOptions = {}): Promise<PlanLimits | undefined> {
  const token = await getActiveToken(options);
  if (!token) return undefined;
  const [limitsJson, planJson] = await Promise.all([
    getJson("/api/v1/users/me/plan/usage-limits", token, options),
    getJson("/api/v1/users/me/plan", token, options),
  ]);
  if (!limitsJson) return undefined;
  return parsePlanLimits(limitsJson, planJson);
}

// ─── Turn adoption ─────────────────────────────────────────────────────────

/** Local `[startedAt, finishedAt]` epoch-ms window of one web_search request. */
export type SearchWindow = readonly [number, number];

/**
 * Records can be flushed slightly after the request finished, and the two
 * clocks are not guaranteed to tick identically, so a search window is
 * matched with slack on both sides.
 */
const SEARCH_WINDOW_SLACK_MS = 60_000;

function matchesSearchWindow(
  createdAt: number,
  windows: readonly SearchWindow[] | undefined,
): boolean {
  if (!windows || windows.length === 0) return false;
  return windows.some(
    ([startedAt, finishedAt]) =>
      createdAt >= startedAt - SEARCH_WINDOW_SLACK_MS &&
      createdAt <= finishedAt + SEARCH_WINDOW_SLACK_MS,
  );
}

/**
 * Pick the records that belong to a finished turn.
 *
 * `records` is newest-first. A chat record qualifies when it is newer than the
 * adoption cursor, matches the model, and was created after the turn started
 * (with a small clock-skew allowance). Web search records are adopted only
 * when they fall inside a window in which this extension actually ran a
 * search, so searches made by another Cline client on the same account are
 * never attributed to this session.
 */
export function collectTurnRecords(
  records: UsageRecord[],
  input: {
    model: string;
    turnStartedAt: number;
    lastAdoptedId?: string;
    lastAdoptedCreatedAt?: number;
    searchWindows?: readonly SearchWindow[];
  },
): { chat?: UsageRecord; searches: UsageRecord[] } {
  const skewMs = 2 * 60 * 1000;
  const searches: UsageRecord[] = [];
  let chat: UsageRecord | undefined;

  for (const record of records) {
    if (record.id === input.lastAdoptedId) break;
    const createdAt = Date.parse(record.createdAt);
    if (Number.isNaN(createdAt)) continue;
    if (input.lastAdoptedCreatedAt !== undefined && createdAt <= input.lastAdoptedCreatedAt) break;
    if (createdAt < input.turnStartedAt - skewMs) break;

    if (record.operation === "web_search") {
      if (matchesSearchWindow(createdAt, input.searchWindows)) searches.push(record);
      continue;
    }
    if (record.model !== input.model) continue;
    if (!chat) chat = record;
  }

  return { chat, searches };
}

// ─── Session totals ────────────────────────────────────────────────────────

/** Session entry types written by this extension. */
export const COST_ENTRY_TYPE = "clinepass-cost";
export const SEARCH_ENTRY_TYPE = "clinepass-search";

export interface SessionCostTotals {
  /** All adopted cost, including web searches. */
  sessionUsd: number;
  /** The web search share of `sessionUsd`. */
  searchUsd: number;
  /** Adopted model turns (chat completions). */
  turns: number;
  /** Adopted web searches. */
  searches: number;
}

/** Sum the cost entries this extension persisted for the current session. */
export function sumSessionCosts(entries: readonly unknown[]): SessionCostTotals {
  const totals: SessionCostTotals = { sessionUsd: 0, searchUsd: 0, turns: 0, searches: 0 };
  for (const entry of entries) {
    if (!isRecord(entry) || entry.type !== "custom") continue;
    const customType = entry.customType;
    if (customType !== COST_ENTRY_TYPE && customType !== SEARCH_ENTRY_TYPE) continue;
    const costUsd = numberValue(isRecord(entry.data) ? entry.data.costUsd : undefined) ?? 0;
    totals.sessionUsd += costUsd;
    if (customType === SEARCH_ENTRY_TYPE) {
      totals.searchUsd += costUsd;
      totals.searches += 1;
    } else {
      totals.turns += 1;
    }
  }
  return totals;
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatUsd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) {
    return `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
  }
  return `$${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/**
 * Compact USD for the one-line footer meter: two decimals from one cent up,
 * more precision below so a sub-cent turn cost does not collapse to $0.00.
 */
export function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value === 0) return "$0.00";
  if (Math.abs(value) >= 0.01) return `$${value.toFixed(2)}`;
  const precise = value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return `$${precise === "0" ? "0.00" : precise}`;
}

export function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export interface MeterState {
  turnUsd: number;
  sessionUsd: number;
  /** The web search share of `sessionUsd`; shown only when greater than zero. */
  searchUsd?: number;
  limits?: PlanLimits;
}

/** One-line footer meter, e.g. `Cline: $0.01 turn · $0.18 session · 5h 12% · 7d 34% · 30d 13% of $50`. */
export function formatMeter(state: MeterState): string {
  let session = `${formatUsdCompact(state.sessionUsd)} session`;
  if (state.searchUsd !== undefined && state.searchUsd > 0) {
    session += ` (${formatUsdCompact(state.searchUsd)} search)`;
  }
  const segments = [`${formatUsdCompact(state.turnUsd)} turn`, session];
  if (state.limits) {
    segments.push(`5h ${Math.round(state.limits.fiveHour.usedPercent)}%`);
    segments.push(`7d ${Math.round(state.limits.sevenDay.usedPercent)}%`);
    const month = state.limits.thirtyDay;
    const cap = month.limitUsd !== undefined ? ` of ${formatUsd(month.limitUsd)}` : "";
    segments.push(`30d ${Math.round(month.usedPercent)}%${cap}`);
  }
  return `Cline: ${segments.join(" · ")}`;
}

function progressBar(percent: number, width = 12): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

function limitLine(label: string, window: LimitWindow): string {
  const cap = window.limitUsd !== undefined ? ` of ${formatUsd(window.limitUsd)}` : "";
  const reset = window.resetsAt ? `  resets ${formatTime(window.resetsAt)}` : "";
  return `${label.padEnd(4)} ${progressBar(window.usedPercent)} ${String(Math.round(window.usedPercent)).padStart(3)}%${cap}${reset}`;
}

export interface ReportInput {
  limits?: PlanLimits;
  sessionUsd: number;
  turns: number;
  searches: number;
  searchUsd: number;
  /** One-line upstream-channel summary, shown when an inspection is cached. */
  route?: string;
  catalogSize: number;
  catalogFetchedAt?: number;
  catalogSource: string;
  warnings: string[];
}

/** Multi-line report for the /clinepass widget. */
export function buildReportLines(input: ReportInput): string[] {
  const lines: string[] = [];
  lines.push(`ClinePass — ${input.limits?.planName ?? "not signed in"}`);
  lines.push("");
  if (input.limits) {
    lines.push(limitLine("5h", input.limits.fiveHour));
    lines.push(limitLine("7d", input.limits.sevenDay));
    lines.push(limitLine("30d", input.limits.thirtyDay));
  } else {
    lines.push("Plan limits unavailable (login required or request failed).");
  }
  lines.push("");
  lines.push(`Session  ${formatUsd(input.sessionUsd)} across ${input.turns} adopted turn${input.turns === 1 ? "" : "s"}`);
  if (input.searches > 0) {
    lines.push(
      `Search   ${input.searches} web search${input.searches === 1 ? "" : "es"} (${formatUsd(input.searchUsd)}, included above)`,
    );
  }
  if (input.route) lines.push(`Route    ${input.route}`);
  const updated = input.catalogFetchedAt
    ? new Date(input.catalogFetchedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
    : "bundled seed";
  lines.push(`Catalog  ${input.catalogSize} models (${input.catalogSource}, updated ${updated})`);
  for (const warning of input.warnings) lines.push(`Note     ${warning}`);
  return lines;
}
