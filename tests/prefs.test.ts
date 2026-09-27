import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFS, parsePrefs, prefsPath, readPrefs, writePrefs } from "../src/prefs.ts";

// ─── Parsing ───────────────────────────────────────────────────────────────

test("parsePrefs tolerates malformed input", () => {
  assert.deepEqual(parsePrefs("not json"), { meterHidden: false, webToolsHidden: false });
  assert.deepEqual(parsePrefs("[]"), { meterHidden: false, webToolsHidden: false });
  assert.deepEqual(parsePrefs("null"), { meterHidden: false, webToolsHidden: false });
  assert.deepEqual(parsePrefs("{}"), { meterHidden: false, webToolsHidden: false });
});

test("parsePrefs only accepts a literal true for meterHidden", () => {
  assert.deepEqual(parsePrefs('{"meterHidden":true}'), { meterHidden: true, webToolsHidden: false });
  assert.deepEqual(parsePrefs('{"meterHidden":"true"}'), { meterHidden: false, webToolsHidden: false });
  assert.deepEqual(parsePrefs('{"meterHidden":1}'), { meterHidden: false, webToolsHidden: false });
});

test("parsePrefs only accepts a literal true for webToolsHidden", () => {
  assert.deepEqual(parsePrefs('{"webToolsHidden":true}'), { meterHidden: false, webToolsHidden: true });
  assert.deepEqual(parsePrefs('{"webToolsHidden":"yes"}'), { meterHidden: false, webToolsHidden: false });
  assert.deepEqual(parsePrefs('{"webToolsHidden":0}'), { meterHidden: false, webToolsHidden: false });
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
    writePrefs({ meterHidden: true, webToolsHidden: false }, path);
    assert.deepEqual(readPrefs(path), { meterHidden: true, webToolsHidden: false });
    writePrefs({ meterHidden: false, webToolsHidden: true }, path);
    assert.deepEqual(readPrefs(path), { meterHidden: false, webToolsHidden: true });
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
