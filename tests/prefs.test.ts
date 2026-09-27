import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFS, parsePrefs, prefsPath, readPrefs, writePrefs } from "../src/prefs.ts";

// ─── Parsing ───────────────────────────────────────────────────────────────

test("parsePrefs tolerates malformed input", () => {
  const empty = { meterHidden: false, webToolsHidden: false, showFreeModels: false, routes: {} };
  assert.deepEqual(parsePrefs("not json"), empty);
  assert.deepEqual(parsePrefs("[]"), empty);
  assert.deepEqual(parsePrefs("null"), empty);
  assert.deepEqual(parsePrefs("{}"), empty);
});

test("parsePrefs only accepts a literal true for meterHidden", () => {
  assert.deepEqual(parsePrefs('{"meterHidden":true}'), {
    meterHidden: true,
    webToolsHidden: false,
    showFreeModels: false,
    routes: {},
  });
  assert.deepEqual(parsePrefs('{"meterHidden":"true"}'), {
    meterHidden: false,
    webToolsHidden: false,
    showFreeModels: false,
    routes: {},
  });
  assert.deepEqual(parsePrefs('{"meterHidden":1}'), {
    meterHidden: false,
    webToolsHidden: false,
    showFreeModels: false,
    routes: {},
  });
});

test("parsePrefs only accepts a literal true for webToolsHidden", () => {
  assert.deepEqual(parsePrefs('{"webToolsHidden":true}'), {
    meterHidden: false,
    webToolsHidden: true,
    showFreeModels: false,
    routes: {},
  });
  assert.deepEqual(parsePrefs('{"webToolsHidden":"yes"}'), {
    meterHidden: false,
    webToolsHidden: false,
    showFreeModels: false,
    routes: {},
  });
  assert.deepEqual(parsePrefs('{"webToolsHidden":0}'), {
    meterHidden: false,
    webToolsHidden: false,
    showFreeModels: false,
    routes: {},
  });
});

test("parsePrefs only accepts a literal true for showFreeModels", () => {
  assert.deepEqual(parsePrefs('{"showFreeModels":true}'), {
    meterHidden: false,
    webToolsHidden: false,
    showFreeModels: true,
    routes: {},
  });
  assert.deepEqual(parsePrefs('{"showFreeModels":"yes"}'), {
    meterHidden: false,
    webToolsHidden: false,
    showFreeModels: false,
    routes: {},
  });
});

test("parseRoutes keeps only well-formed channel preferences", () => {
  assert.deepEqual(parsePrefs('{"routes":{"cline-pass/minimax-m3":{"only":[" nebius ","",42]}}}').routes, {
    "cline-pass/minimax-m3": { only: ["nebius"] },
  });
  assert.deepEqual(
    parsePrefs('{"routes":{"m":{"only":["a"],"mode":"preferred"}}}').routes,
    { m: { only: ["a"], mode: "preferred" } },
  );
  assert.deepEqual(parsePrefs('{"routes":{"m":{"only":["a"],"mode":"nonsense"}}}').routes, { m: { only: ["a"] } });
  assert.deepEqual(parsePrefs('{"routes":{"m":{"only":[]}}}').routes, {});
  assert.deepEqual(parsePrefs('{"routes":{"m":"nebius"}}').routes, {});
  assert.deepEqual(parsePrefs('{"routes":"nope"}').routes, {});
});

// ─── Disk round-trip ───────────────────────────────────────────────────────

test("readPrefs returns defaults when the file is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-prefs-"));
  try {
    assert.deepEqual(readPrefs(join(dir, "missing.json")), { ...DEFAULT_PREFS });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePrefs round-trips through readPrefs", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-prefs-"));
  try {
    const path = join(dir, "nested", "prefs.json");
    writePrefs({ meterHidden: true, webToolsHidden: false, showFreeModels: false, routes: {} }, path);
    assert.deepEqual(readPrefs(path), {
      meterHidden: true,
      webToolsHidden: false,
      showFreeModels: false,
      routes: {},
    });
    writePrefs(
      { meterHidden: false, webToolsHidden: true, showFreeModels: true, routes: { m: { only: ["nebius"] } } },
      path,
    );
    assert.deepEqual(readPrefs(path), {
      meterHidden: false,
      webToolsHidden: true,
      showFreeModels: true,
      routes: { m: { only: ["nebius"] } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prefsPath lives next to the catalog cache in the agent dir", () => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = "/tmp/clinepass-agent-dir";
  try {
    assert.equal(prefsPath(), "/tmp/clinepass-agent-dir/clinepass-auto-prefs.json");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
