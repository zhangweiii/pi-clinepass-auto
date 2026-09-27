/**
 * pi-clinepass-auto — local display preferences.
 *
 * The footer meter and the web tools can be hidden here. Reads and writes are
 * best-effort: a missing or unreadable file means "show everything".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./discovery.ts";

export interface Prefs {
  /** Hide the footer usage meter even while a ClinePass model is active. */
  meterHidden: boolean;
  /** Hide the web_search / web_fetch tools. */
  webToolsHidden: boolean;
}

export const DEFAULT_PREFS: Prefs = { meterHidden: false, webToolsHidden: false };

export function prefsPath(): string {
  return join(agentDir(), "clinepass-auto-prefs.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePrefs(text: string): Prefs {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { ...DEFAULT_PREFS };
    return {
      meterHidden: parsed.meterHidden === true,
      webToolsHidden: parsed.webToolsHidden === true,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function readPrefs(path = prefsPath()): Prefs {
  try {
    if (!existsSync(path)) return { ...DEFAULT_PREFS };
    return parsePrefs(readFileSync(path, "utf8"));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function writePrefs(prefs: Prefs, path = prefsPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(prefs, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // Preference writes are best effort; the in-memory value stays valid.
  }
}
