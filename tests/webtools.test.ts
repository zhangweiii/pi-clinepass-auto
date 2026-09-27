import { test } from "node:test";
import assert from "node:assert/strict";
import { applyWebToolActivation, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "../src/webtools.ts";

const ALL_ACTIVE = ["read", "bash", WEB_SEARCH_TOOL, WEB_FETCH_TOOL];

function activate(input: {
  active?: readonly string[];
  removedByExtension?: readonly string[];
  webToolsHidden?: boolean;
  hasCredential?: boolean;
} = {}) {
  return applyWebToolActivation({
    active: input.active ?? ALL_ACTIVE,
    removedByExtension: new Set(input.removedByExtension ?? []),
    webToolsHidden: input.webToolsHidden ?? false,
    hasCredential: input.hasCredential ?? true,
  });
}

// ─── Credential gate ───────────────────────────────────────────────────────

test("with a credential both web tools stay active", () => {
  const result = activate();
  assert.ok(result.active.includes(WEB_SEARCH_TOOL));
  assert.ok(result.active.includes(WEB_FETCH_TOOL));
  assert.deepEqual(result.removedByExtension, []);
});

test("without a credential web_search is disabled and remembered", () => {
  const result = activate({ hasCredential: false });
  assert.ok(!result.active.includes(WEB_SEARCH_TOOL));
  assert.ok(result.active.includes(WEB_FETCH_TOOL));
  assert.deepEqual(result.removedByExtension, [WEB_SEARCH_TOOL]);
});

test("web_search returns once a credential appears", () => {
  const offline = activate({ hasCredential: false });
  const online = activate({
    active: offline.active,
    removedByExtension: offline.removedByExtension,
    hasCredential: true,
  });
  assert.ok(online.active.includes(WEB_SEARCH_TOOL));
  assert.deepEqual(online.removedByExtension, []);
});

// ─── Preference gate ───────────────────────────────────────────────────────

test("hiding the web tools disables both", () => {
  const result = activate({ webToolsHidden: true });
  assert.ok(!result.active.includes(WEB_SEARCH_TOOL));
  assert.ok(!result.active.includes(WEB_FETCH_TOOL));
  assert.deepEqual(result.removedByExtension.sort(), [WEB_FETCH_TOOL, WEB_SEARCH_TOOL].sort());
});

test("showing the web tools restores what was hidden", () => {
  const hidden = activate({ webToolsHidden: true });
  const shown = activate({
    active: hidden.active,
    removedByExtension: hidden.removedByExtension,
  });
  assert.ok(shown.active.includes(WEB_SEARCH_TOOL));
  assert.ok(shown.active.includes(WEB_FETCH_TOOL));
  assert.deepEqual(shown.removedByExtension, []);
});

test("a hidden web_search stays off when shown without a credential", () => {
  const hidden = activate({ webToolsHidden: true });
  const shown = activate({
    active: hidden.active,
    removedByExtension: hidden.removedByExtension,
    hasCredential: false,
  });
  assert.ok(shown.active.includes(WEB_FETCH_TOOL));
  assert.ok(!shown.active.includes(WEB_SEARCH_TOOL));
  assert.deepEqual(shown.removedByExtension, [WEB_SEARCH_TOOL]);
});

// ─── Respect explicit tool selection ───────────────────────────────────────

test("never re-enables a tool excluded outside this extension", () => {
  const excluded = ["read", "bash", WEB_FETCH_TOOL];
  const offline = activate({ active: excluded, hasCredential: false });
  assert.deepEqual(offline.removedByExtension, []);

  const online = activate({
    active: offline.active,
    removedByExtension: offline.removedByExtension,
    hasCredential: true,
  });
  assert.ok(!online.active.includes(WEB_SEARCH_TOOL));
  assert.deepEqual(online.removedByExtension, []);
});

test("hiding does not claim a tool that was excluded elsewhere", () => {
  const result = activate({
    active: ["read", WEB_SEARCH_TOOL],
    webToolsHidden: true,
  });
  assert.deepEqual(result.removedByExtension, [WEB_SEARCH_TOOL]);
});

test("unrelated tools are left untouched", () => {
  const result = activate({ active: ["read", "bash", WEB_FETCH_TOOL], hasCredential: false });
  assert.deepEqual(result.active, ["read", "bash", WEB_FETCH_TOOL]);
});
