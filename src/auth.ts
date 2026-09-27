/**
 * ClinePass credential resolution and WorkOS token refresh.
 *
 * Credential sources, in priority order:
 *   1. CLINE_API_KEY environment variable (static key)
 *   2. pi's credential store (`~/.pi/agent/auth.json` -> "clinepass")
 *   3. The Cline CLI's own login (`~/.cline/data/settings/providers.json`)
 *
 * OAuth access tokens are short-lived WorkOS JWTs (`workos:` prefix).
 * They are refreshed through Cline's server-side endpoint; when the token
 * came from pi's store, rotated refresh tokens are written back with a
 * compare-and-swap so a stale write can never clobber pi's newer value.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./discovery.ts";

// ─── Constants ─────────────────────────────────────────────────────────────

export const PROVIDER_NAME = "clinepass";
export const DEFAULT_API_BASE = "https://api.cline.bot";
export const CLINE_REFRESH_ENDPOINT = "/api/v1/auth/refresh";
export const WORKOS_TOKEN_PREFIX = "workos:";

/** Refresh this long before the recorded expiry. */
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** Conservative token lifetime when the server does not disclose one. */
const ASSUMED_TOKEN_LIFETIME_MS = 55 * 60 * 1000;

const REFRESH_TIMEOUT_MS = 15_000;
const FOREVER = Number.MAX_SAFE_INTEGER;

/**
 * OAuth credential shape pi persists (`auth.json`). Structurally identical
 * to pi-ai's `OAuthCredentials`, declared locally so this module stays
 * import-light and unit-testable.
 */
export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export type CredentialSource = "env" | "pi-store" | "cline-cli";

export interface ResolvedCredential {
  access: string;
  refresh?: string;
  /** Epoch ms; Number.MAX_SAFE_INTEGER for non-expiring static keys. */
  expires: number;
  source: CredentialSource;
}

export interface AuthOptions {
  fetch?: typeof globalThis.fetch;
  apiBase?: string;
  signal?: AbortSignal;
  /** Injectable clock (tests). */
  now?: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Parse an expiry that may be epoch ms or an ISO timestamp. */
function parseExpiresAt(value: unknown): number {
  const numeric = numberValue(value);
  if (numeric !== undefined) return numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return 0;
}

export function isRefreshable(credential: ResolvedCredential): boolean {
  return (
    Boolean(credential.refresh) &&
    credential.access.startsWith(WORKOS_TOKEN_PREFIX) &&
    credential.expires !== FOREVER
  );
}

export function apiBase(): string {
  return process.env.CLINE_API_BASE?.trim() || DEFAULT_API_BASE;
}

// ─── Credential resolution ─────────────────────────────────────────────────

function clineProvidersPath(): string {
  const override = process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH?.trim();
  if (override) return override;
  return join(homedir(), ".cline", "data", "settings", "providers.json");
}

/** Read the `cline-pass` entry from the Cline CLI's providers.json. */
export function readClineCliCredential(path = clineProvidersPath()): ResolvedCredential | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.providers)) return undefined;
    const entry = parsed.providers["cline-pass"];
    if (!isRecord(entry) || !isRecord(entry.settings)) return undefined;
    const settings = entry.settings;

    const apiKey = stringValue(settings.apiKey);
    if (apiKey) return { access: apiKey, expires: FOREVER, source: "cline-cli" };

    const auth = isRecord(settings.auth) ? settings.auth : undefined;
    const access = stringValue(auth?.accessToken);
    if (!access) return undefined;
    const refresh = stringValue(auth?.refreshToken);
    return {
      access,
      refresh,
      expires: parseExpiresAt(auth?.expiresAt),
      source: "cline-cli",
    };
  } catch {
    return undefined;
  }
}

/** Resolve the best available credential without any network access. */
export function resolveCredential(): ResolvedCredential | undefined {
  const envKey = process.env.CLINE_API_KEY?.trim();
  if (envKey) return { access: envKey, expires: FOREVER, source: "env" };

  try {
    const stored = readStoredCredential(PROVIDER_NAME);
    if (stored) {
      if (stored.type === "oauth") {
        const access = stringValue(stored.access);
        if (access) {
          return {
            access,
            refresh: stringValue(stored.refresh),
            expires: parseExpiresAt(stored.expires),
            source: "pi-store",
          };
        }
      } else {
        const key = stringValue(stored.key);
        if (key) return { access: key, expires: FOREVER, source: "pi-store" };
      }
    }
  } catch {
    // Malformed auth.json: fall through to the Cline CLI login.
  }

  return readClineCliCredential();
}

// ─── Token refresh ─────────────────────────────────────────────────────────

interface RefreshResponse {
  accessToken: string;
  refreshToken: string;
}

/** Parse the refresh response, tolerating `{data:{...}}` and flat shapes. */
export function parseRefreshResponse(json: unknown): RefreshResponse | undefined {
  if (!isRecord(json)) return undefined;
  const data = isRecord(json.data) ? json.data : json;
  const accessToken = stringValue(data.accessToken);
  const refreshToken = stringValue(data.refreshToken);
  if (!accessToken || !refreshToken) return undefined;
  return { accessToken, refreshToken };
}

export async function refreshCredential(
  credential: ResolvedCredential,
  options: AuthOptions = {},
): Promise<ResolvedCredential> {
  if (!isRefreshable(credential)) return credential;

  const fetchFn = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), REFRESH_TIMEOUT_MS);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchFn(`${options.apiBase ?? apiBase()}${CLINE_REFRESH_ENDPOINT}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ granttype: "refresh_token", refreshToken: credential.refresh }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `ClinePass token refresh failed (HTTP ${response.status}) — run \`pi /login\` (ClinePass) or \`cline auth\` again.`,
      );
    }
    const parsed = parseRefreshResponse(await response.json());
    if (!parsed) throw new Error("ClinePass token refresh returned an unexpected response.");

    const access = parsed.accessToken.startsWith(WORKOS_TOKEN_PREFIX)
      ? parsed.accessToken
      : `${WORKOS_TOKEN_PREFIX}${parsed.accessToken}`;
    const now = options.now ?? Date.now();
    return {
      access,
      refresh: parsed.refreshToken,
      expires: now + ASSUMED_TOKEN_LIFETIME_MS,
      source: credential.source,
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Persist rotated OAuth tokens back to the store the credential came from.
 * The write is skipped when the stored refresh token no longer matches the
 * one we used (pi or the Cline CLI refreshed it in the meantime), so a
 * stale write can never clobber a newer credential.
 */
export function persistRotatedCredential(
  original: ResolvedCredential,
  next: ResolvedCredential,
  paths: { authPath?: string; providersPath?: string } = {},
): void {
  try {
    if (original.source === "pi-store") {
      const authPath = paths.authPath ?? join(agentDir(), "auth.json");
      const parsed: unknown = JSON.parse(readFileSync(authPath, "utf8"));
      if (!isRecord(parsed)) return;
      const entry = parsed[PROVIDER_NAME];
      if (!isRecord(entry) || entry.type !== "oauth" || entry.refresh !== original.refresh) return;
      parsed[PROVIDER_NAME] = { ...entry, access: next.access, refresh: next.refresh, expires: next.expires };
      writeJsonAtomically(authPath, parsed);
      return;
    }
    if (original.source === "cline-cli") {
      const providersPath = paths.providersPath ?? clineProvidersPath();
      const parsed: unknown = JSON.parse(readFileSync(providersPath, "utf8"));
      if (!isRecord(parsed) || !isRecord(parsed.providers)) return;
      const entry = parsed.providers["cline-pass"];
      if (!isRecord(entry) || !isRecord(entry.settings) || !isRecord(entry.settings.auth)) return;
      const auth = entry.settings.auth;
      if (auth.refreshToken !== original.refresh) return;
      entry.settings.auth = {
        ...auth,
        accessToken: next.access,
        refreshToken: next.refresh,
        expiresAt: next.expires,
      };
      writeJsonAtomically(providersPath, parsed);
    }
  } catch {
    // Best effort only: the in-memory token is still usable, and the next
    // login re-imports whatever is on disk.
  }
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tmp = join(dirname(path), `.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

// ─── Active token (for API calls made by this extension) ───────────────────

let tokenCache: { identity: string; token: string; expiresAt: number } | undefined;

/**
 * Return a usable bearer token for Cline API calls (usage meter, plan
 * limits), refreshing shortly before expiry. Returns undefined when no
 * credential is configured.
 */
export async function getActiveToken(options: AuthOptions = {}): Promise<string | undefined> {
  const credential = resolveCredential();
  if (!credential) {
    tokenCache = undefined;
    return undefined;
  }
  const identity = `${credential.source}:${credential.access}:${credential.refresh ?? ""}`;
  const now = options.now ?? Date.now();

  if (tokenCache?.identity === identity && tokenCache.expiresAt > now) {
    return tokenCache.token;
  }

  const usableUntil = credential.expires - REFRESH_MARGIN_MS;
  if (credential.expires === FOREVER || usableUntil > now) {
    tokenCache = {
      identity,
      token: credential.access,
      expiresAt: Math.max(now + 30_000, usableUntil),
    };
    return credential.access;
  }

  const refreshed = await refreshCredential(credential, options);
  persistRotatedCredential(credential, refreshed);
  tokenCache = {
    identity: `${refreshed.source}:${refreshed.access}:${refreshed.refresh ?? ""}`,
    token: refreshed.access,
    expiresAt: refreshed.expires - REFRESH_MARGIN_MS,
  };
  return refreshed.access;
}

/** Drop the in-memory token cache (after 401s or account switches). */
export function invalidateTokenCache(): void {
  tokenCache = undefined;
}

// ─── pi OAuth provider surface (/login) ────────────────────────────────────

function toOAuthCredentials(credential: ResolvedCredential): OAuthCredentials {
  return {
    access: credential.access,
    refresh: credential.refresh ?? "",
    expires: credential.expires,
  };
}

function apiKeyCredentials(key: string): OAuthCredentials {
  return { access: key, refresh: "", expires: FOREVER };
}

/**
 * Login flow: reuse the Cline CLI login when present (recommended), else
 * let the user paste a static API key. A full browser OAuth flow is
 * intentionally not reimplemented here; `cline auth` covers that, and
 * ClinePass API keys cover the rest.
 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const envKey = process.env.CLINE_API_KEY?.trim();
  if (envKey) {
    callbacks.onProgress?.("Using CLINE_API_KEY from the environment");
    return apiKeyCredentials(envKey);
  }

  const cli = readClineCliCredential();
  if (cli) {
    callbacks.onProgress?.("Reusing the existing Cline CLI login");
    return toOAuthCredentials(cli);
  }

  const choice = await callbacks.onSelect({
    message: "ClinePass sign-in",
    options: [
      { id: "key", label: "Paste a ClinePass API key" },
      { id: "cli", label: "Read the Cline CLI login again" },
    ],
  });

  if (choice === "cli") {
    const retried = readClineCliCredential();
    if (!retried) {
      throw new Error(
        "No Cline CLI login found. Run `cline auth` first, or choose the API key option.",
      );
    }
    return toOAuthCredentials(retried);
  }
  if (choice === "key") {
    const key = (
      await callbacks.onPrompt({
        message: "ClinePass API key",
        placeholder: "app.cline.bot → Settings → API Keys",
      })
    ).trim();
    if (!key) throw new Error("No API key provided.");
    return apiKeyCredentials(key);
  }
  throw new Error("Login cancelled.");
}

/** Convert stored credentials to the bearer token for provider requests. */
export function getApiKey(credentials: OAuthCredentials): string {
  return stringValue(credentials.access) ?? "";
}

/** pi-facing refresh hook: rotates WorkOS tokens, passes static keys through. */
export async function refreshToken(
  credentials: OAuthCredentials,
  signal: AbortSignal,
): Promise<OAuthCredentials> {
  const resolved: ResolvedCredential = {
    access: stringValue(credentials.access) ?? "",
    refresh: stringValue(credentials.refresh),
    expires: parseExpiresAt(credentials.expires),
    source: "pi-store",
  };
  if (!isRefreshable(resolved)) return credentials;
  const next = await refreshCredential(resolved, { signal });
  return { ...credentials, access: next.access, refresh: next.refresh ?? "", expires: next.expires };
}
