/**
 * pi-clinepass-auto — local display preferences.
 *
 * The footer meter and the web tools can be hidden here. Reads and writes are
 * best-effort: a missing or unreadable file means "show everything".
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDir } from "./discovery.ts";
import type { RoutePreference } from "./routes.ts";

export interface Prefs {
  /** Hide the footer usage meter even while a ClinePass model is active. */
  meterHidden: boolean;
  /** Hide the web_search / web_fetch tools. */
  webToolsHidden: boolean;
  /** Upstream channel preference per model id. */
  routes: Record<string, RoutePreference>;
}

export const DEFAULT_PREFS: Prefs = { meterHidden: false, webToolsHidden: false, routes: {} };

export function prefsPath(): string {
  return join(agentDir(), "clinepass-auto-prefs.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only well-formed channel preferences. */
export function parseRoutes(value: unknown): Record<string, RoutePreference> {
  const routes: Record<string, RoutePreference> = {};
  if (!isRecord(value)) return routes;
  for (const [model, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const only = Array.isArray(raw.only)
      ? raw.only
          .filter((name): name is string => typeof name === "string")
          .map((name) => name.trim())
          .filter(Boolean)
      : [];
    if (!model.trim() || only.length === 0) continue;
    routes[model] = raw.mode === "preferred" ? { only, mode: "preferred" } : { only };
  }
  return routes;
}

export function parsePrefs(text: string): Prefs {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) return { ...DEFAULT_PREFS };
    return {
      meterHidden: parsed.meterHidden === true,
      webToolsHidden: parsed.webToolsHidden === true,
      routes: parseRoutes(parsed.routes),
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
