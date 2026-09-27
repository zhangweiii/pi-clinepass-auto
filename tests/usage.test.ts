import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportLines,
  collectTurnRecords,
  formatMeter,
  formatUsd,
  formatUsdCompact,
  parsePlanLimits,
  parseUsageRecords,
  parseUserId,
  sumSessionCosts,
  type SearchWindow,
  type UsageRecord,
} from "../src/usage.ts";

// ─── User id / usage records ───────────────────────────────────────────────

test("parseUserId handles both envelope shapes", () => {
  assert.equal(parseUserId({ data: { id: "u1" } }), "u1");
  assert.equal(parseUserId({ id: "u2" }), "u2");
  assert.equal(parseUserId({ data: {} }), undefined);
});

test("parseUsageRecords converts micro-USD and falls back to raw_model", () => {
  const records = parseUsageRecords({
    data: {
      items: [
        {
          id: "rec1",
          aiModelName: "cline-pass/glm-5.3",
          promptTokens: 100,
          cachedTokens: 20,
          completionTokens: 50,
          costUsd: 12_000_000,
          createdAt: "2026-09-27T01:00:00Z",
        },
        {
          id: "rec2",
          metadata: { raw_model: "xiaomi/mimo-v2.5-pro" },
          operation: "web_search",
          costUsd: 50_000_000,
          createdAt: "2026-09-27T00:59:00Z",
        },
        { id: "rec3" },
      ],
    },
  });
  assert.equal(records?.length, 3);
  assert.equal(records?.[0]?.costUsd, 0.12);
  assert.equal(records?.[1]?.model, "xiaomi/mimo-v2.5-pro");
  assert.equal(records?.[1]?.operation, "web_search");
  assert.equal(records?.[1]?.costUsd, 0.5);
  assert.equal(records?.[2]?.costUsd, 0);
  assert.equal(records?.[0]?.operation, undefined);
  assert.equal(parseUsageRecords({}), undefined);
});

// ─── Plan limits ───────────────────────────────────────────────────────────

test("parsePlanLimits maps windows and decodes cap thresholds", () => {
  const limits = parsePlanLimits(
    {
      data: {
        limits: [
          { type: "five_hour", percentUsed: 12.5, resetsAt: "2026-09-27T03:00:00Z" },
          { type: "weekly", percentUsed: 34 },
          { type: "monthly", percentUsed: 5 },
        ],
      },
    },
    {
      data: {
        plan: {
          displayName: "ClinePass Pro",
          entitlements: {
            cline_pass: {
              inferenceCapThreshold: {
                last5HoursUsageCostUSDPerUser: 1_000_000_000,
                last7daysUsageCostUSDPerUser: 5_000_000_000,
                last30daysUsageCostUSDPerUser: 20_000_000_000,
              },
            },
          },
        },
      },
    },
  );
  assert.equal(limits?.planName, "ClinePass Pro");
  assert.equal(limits?.fiveHour.usedPercent, 12.5);
  assert.equal(limits?.fiveHour.limitUsd, 10);
  assert.equal(limits?.sevenDay.limitUsd, 50);
  assert.equal(limits?.thirtyDay.limitUsd, 200);
  assert.equal(limits?.fiveHour.resetsAt, "2026-09-27T03:00:00Z");
});

test("parsePlanLimits returns undefined without a limits payload", () => {
  assert.equal(parsePlanLimits(undefined, undefined), undefined);
  assert.equal(parsePlanLimits({ data: {} }, {}), undefined);
});

// ─── Turn adoption ─────────────────────────────────────────────────────────

function record(id: string, createdAt: string, model = "cline-pass/glm-5.3", costUsd = 0.01): UsageRecord {
  return {
    id,
    model,
    operation: "chat_completion",
    promptTokens: 1,
    cachedTokens: 0,
    completionTokens: 1,
    costUsd,
    createdAt,
  };
}

function searchRecord(id: string, createdAt: string, costUsd = 0.007): UsageRecord {
  return {
    id,
    model: "",
    operation: "web_search",
    promptTokens: 0,
    cachedTokens: 0,
    completionTokens: 0,
    costUsd,
    createdAt,
  };
}

const NO_WINDOWS: readonly SearchWindow[] = [];

test("collectTurnRecords picks the newest matching record after the turn start", () => {
  const turnStartedAt = Date.parse("2026-09-27T01:00:00Z");
  const records = [
    record("new", "2026-09-27T01:00:05Z"),
    record("old", "2026-09-27T00:59:00Z"),
  ];
  const collected = collectTurnRecords(records, { model: "cline-pass/glm-5.3", turnStartedAt });
  assert.equal(collected.chat?.id, "new");
  assert.deepEqual(collected.searches, []);
});

test("collectTurnRecords skips other models and stops at the adoption cursor", () => {
  const turnStartedAt = Date.parse("2026-09-27T01:00:00Z");
  const records = [
    record("other", "2026-09-27T01:00:06Z", "cline-pass/kimi-k3"),
    record("mine", "2026-09-27T01:00:05Z"),
    record("already-adopted", "2026-09-27T00:59:00Z"),
  ];
  assert.equal(
    collectTurnRecords(records, { model: "cline-pass/glm-5.3", turnStartedAt }).chat?.id,
    "mine",
  );
  assert.equal(
    collectTurnRecords(records, {
      model: "cline-pass/glm-5.3",
      turnStartedAt,
      lastAdoptedId: "already-adopted",
      lastAdoptedCreatedAt: Date.parse("2026-09-27T00:59:00Z"),
    }).chat?.id,
    "mine",
  );
});

test("collectTurnRecords does not adopt records older than the turn", () => {
  const turnStartedAt = Date.parse("2026-09-27T01:00:00Z");
  const records = [record("old", "2026-09-27T00:50:00Z")];
  assert.equal(
    collectTurnRecords(records, { model: "cline-pass/glm-5.3", turnStartedAt }).chat,
    undefined,
  );
});

test("collectTurnRecords adopts searches inside one of our windows", () => {
  const turnStartedAt = Date.parse("2026-09-27T01:00:00Z");
  const records = [
    record("chat", "2026-09-27T01:00:09Z"),
    searchRecord("search", "2026-09-27T01:00:05Z"),
    record("before", "2026-09-27T00:59:50Z"),
  ];
  const window: SearchWindow = [Date.parse("2026-09-27T01:00:04Z"), Date.parse("2026-09-27T01:00:06Z")];
  const collected = collectTurnRecords(records, {
    model: "cline-pass/glm-5.3",
    turnStartedAt,
    searchWindows: [window],
  });
  assert.equal(collected.chat?.id, "chat");
  assert.deepEqual(
    collected.searches.map((item) => item.id),
    ["search"],
  );
});

test("collectTurnRecords ignores searches outside our windows or earlier turns", () => {
  const turnStartedAt = Date.parse("2026-09-27T01:00:00Z");
  const records = [
    searchRecord("foreign", "2026-09-27T01:02:00Z"),
    searchRecord("ours", "2026-09-27T01:00:05Z"),
    searchRecord("stale", "2026-09-27T00:40:00Z"),
  ];
  const window: SearchWindow = [Date.parse("2026-09-27T01:00:04Z"), Date.parse("2026-09-27T01:00:06Z")];
  const collected = collectTurnRecords(records, {
    model: "cline-pass/glm-5.3",
    turnStartedAt,
    searchWindows: [window],
  });
  assert.deepEqual(
    collected.searches.map((item) => item.id),
    ["ours"],
  );

  const withoutWindows = collectTurnRecords(records, {
    model: "cline-pass/glm-5.3",
    turnStartedAt,
    searchWindows: NO_WINDOWS,
  });
  assert.deepEqual(withoutWindows.searches, []);
});

// ─── Session totals and formatting ─────────────────────────────────────────

test("sumSessionCosts separates turns from web searches", () => {
  const totals = sumSessionCosts([
    { type: "custom", customType: "clinepass-cost", data: { costUsd: 0.1 } },
    { type: "custom", customType: "other", data: { costUsd: 99 } },
    { type: "message" },
    { type: "custom", customType: "clinepass-search", data: { costUsd: 0.007 } },
    { type: "custom", customType: "clinepass-cost", data: { costUsd: 0.25 } },
    { type: "custom", customType: "clinepass-search", data: { costUsd: 0.007 } },
    null,
  ]);
  assert.equal(Math.round(totals.sessionUsd * 1000), 364);
  assert.equal(Math.round(totals.searchUsd * 1000), 14);
  assert.equal(totals.turns, 2);
  assert.equal(totals.searches, 2);
});

test("formatUsd keeps meaningful precision", () => {
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(0.0004), "$0.0004");
  assert.equal(formatUsd(1.4), "$1.4");
  assert.equal(formatUsd(12.345678), "$12.3457");
});

test("formatUsdCompact keeps cents readable and sub-cent precision available", () => {
  assert.equal(formatUsdCompact(0), "$0.00");
  assert.equal(formatUsdCompact(0.1049), "$0.10");
  assert.equal(formatUsdCompact(0.5), "$0.50");
  assert.equal(formatUsdCompact(12.345), "$12.35");
  assert.equal(formatUsdCompact(0.0123), "$0.01");
  assert.equal(formatUsdCompact(0.006), "$0.006");
  assert.equal(formatUsdCompact(0.0004), "$0.0004");
  assert.equal(formatUsdCompact(Number.NaN), "$0.00");
});

test("formatMeter renders one compact, unboxed line with plan windows", () => {
  const meter = formatMeter({
    turnUsd: 0.0123,
    sessionUsd: 0.5,
    limits: {
      planName: "ClinePass",
      fiveHour: { usedPercent: 12.4 },
      sevenDay: { usedPercent: 3.2 },
      thirtyDay: { usedPercent: 0.5 },
    },
  });
  assert.equal(meter, "Cline: $0.01 turn · $0.50 session · 5h 12% · 7d 3%");
  assert.ok(!meter.includes("│"), "meter must not be boxed in box-drawing bars");
});

test("formatMeter omits plan windows until limits are known", () => {
  assert.equal(formatMeter({ turnUsd: 0, sessionUsd: 0 }), "Cline: $0.00 turn · $0.00 session");
});

test("formatMeter shows the web search share of the session", () => {
  assert.equal(
    formatMeter({ turnUsd: 0.0012, sessionUsd: 0.2, searchUsd: 0.049 }),
    "Cline: $0.0012 turn · $0.20 session ($0.05 search)",
  );
  assert.equal(
    formatMeter({ turnUsd: 0, sessionUsd: 0.2, searchUsd: 0 }),
    "Cline: $0.00 turn · $0.20 session",
  );
});

test("buildReportLines renders a readable report", () => {
  const lines = buildReportLines({
    limits: {
      planName: "ClinePass",
      fiveHour: { usedPercent: 12, limitUsd: 10, resetsAt: "2026-09-27T03:00:00Z" },
      sevenDay: { usedPercent: 34 },
      thirtyDay: { usedPercent: 5 },
    },
    sessionUsd: 0.1234,
    turns: 3,
    searches: 2,
    searchUsd: 0.014,
    catalogSize: 14,
    catalogFetchedAt: Date.parse("2026-09-27T01:00:00Z"),
    catalogSource: "network",
    warnings: ["models.dev fetch failed: timeout"],
  });
  const text = lines.join("\n");
  assert.match(text, /ClinePass — ClinePass/);
  assert.match(text, /5h/);
  assert.match(text, /\$0\.1234 across 3 adopted turns/);
  assert.match(text, /Search {3}2 web searches \(\$0\.014, included above\)/);
  assert.match(text, /Catalog {2}14 models/);
  assert.match(text, /models\.dev fetch failed/);
});
