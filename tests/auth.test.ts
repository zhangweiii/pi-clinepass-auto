import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isRefreshable,
  login,
  parseRefreshResponse,
  persistRotatedCredential,
  readClineCliCredential,
  refreshCredential,
  type ResolvedCredential,
} from "../src/auth.ts";

// ─── Refresh response ──────────────────────────────────────────────────────

test("parseRefreshResponse accepts envelope and flat shapes", () => {
  assert.deepEqual(parseRefreshResponse({ data: { accessToken: "a", refreshToken: "r" } }), {
    accessToken: "a",
    refreshToken: "r",
  });
  assert.deepEqual(parseRefreshResponse({ accessToken: "a", refreshToken: "r" }), {
    accessToken: "a",
    refreshToken: "r",
  });
  assert.equal(parseRefreshResponse({ data: { accessToken: "a" } }), undefined);
  assert.equal(parseRefreshResponse(null), undefined);
});

// ─── Refreshability ────────────────────────────────────────────────────────

test("isRefreshable requires a WorkOS access token plus a refresh token", () => {
  const base: ResolvedCredential = {
    access: "workos:jwt",
    refresh: "rt",
    expires: Date.now() + 60_000,
    source: "pi-store",
  };
  assert.equal(isRefreshable(base), true);
  assert.equal(isRefreshable({ ...base, access: "static-key", refresh: "" }), false);
  assert.equal(isRefreshable({ ...base, refresh: undefined }), false);
  assert.equal(isRefreshable({ ...base, expires: Number.MAX_SAFE_INTEGER }), false);
});

// ─── Cline CLI credential file ─────────────────────────────────────────────

test("readClineCliCredential parses the cline-pass WorkOS login", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const path = join(dir, "providers.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({
        providers: {
          "cline-pass": {
            settings: {
              auth: {
                accessToken: "workos:jwt",
                refreshToken: "rt",
                expiresAt: 12345,
              },
            },
          },
        },
      }),
    );
    const credential = readClineCliCredential(path);
    assert.equal(credential?.access, "workos:jwt");
    assert.equal(credential?.refresh, "rt");
    assert.equal(credential?.expires, 12345);
    assert.equal(credential?.source, "cline-cli");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readClineCliCredential prefers a static apiKey when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const path = join(dir, "providers.json");
  try {
    writeFileSync(
      path,
      JSON.stringify({ providers: { "cline-pass": { settings: { apiKey: "static-key" } } } }),
    );
    const credential = readClineCliCredential(path);
    assert.equal(credential?.access, "static-key");
    assert.equal(credential?.expires, Number.MAX_SAFE_INTEGER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readClineCliCredential tolerates missing or malformed files", () => {
  assert.equal(readClineCliCredential("/nonexistent/providers.json"), undefined);
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const path = join(dir, "providers.json");
  try {
    writeFileSync(path, "{not json");
    assert.equal(readClineCliCredential(path), undefined);
    writeFileSync(path, JSON.stringify({ providers: {} }));
    assert.equal(readClineCliCredential(path), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Token refresh ─────────────────────────────────────────────────────────

const WORKOS_CREDENTIAL: ResolvedCredential = {
  access: "workos:old-jwt",
  refresh: "old-refresh",
  expires: 1_000,
  source: "pi-store",
};

test("refreshCredential posts the refresh grant and prefixes the new token", async () => {
  let body: unknown;
  const fetchMock: typeof globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({ data: { accessToken: "new-jwt", refreshToken: "new-refresh" } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  const refreshed = await refreshCredential(WORKOS_CREDENTIAL, { fetch: fetchMock, now: 5_000 });
  assert.deepEqual(body, { granttype: "refresh_token", refreshToken: "old-refresh" });
  assert.equal(refreshed.access, "workos:new-jwt");
  assert.equal(refreshed.refresh, "new-refresh");
  assert.ok(refreshed.expires > 5_000);
});

test("refreshCredential passes static credentials through without network", async () => {
  let fetched = 0;
  const fetchMock: typeof globalThis.fetch = async () => {
    fetched += 1;
    return new Response("{}", { status: 200 });
  };
  const staticCredential: ResolvedCredential = {
    access: "static-key",
    expires: Number.MAX_SAFE_INTEGER,
    source: "env",
  };
  const result = await refreshCredential(staticCredential, { fetch: fetchMock });
  assert.deepEqual(result, staticCredential);
  assert.equal(fetched, 0);
});

test("refreshCredential surfaces server failures as actionable errors", async () => {
  const fetchMock: typeof globalThis.fetch = async () => new Response("nope", { status: 401 });
  await assert.rejects(
    () => refreshCredential(WORKOS_CREDENTIAL, { fetch: fetchMock }),
    /HTTP 401/,
  );
});

// ─── Rotated credential persistence (compare-and-swap) ─────────────────────

test("persistRotatedCredential updates pi's auth.json when the refresh token matches", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const authPath = join(dir, "auth.json");
  try {
    writeFileSync(
      authPath,
      JSON.stringify({
        clinepass: { type: "oauth", access: "workos:old", refresh: "old-refresh", expires: 1 },
        zai: { type: "api_key", key: "keep-me" },
      }),
    );
    persistRotatedCredential(
      WORKOS_CREDENTIAL,
      { access: "workos:new", refresh: "new-refresh", expires: 999, source: "pi-store" },
      { authPath },
    );
    const stored = JSON.parse(readFileSync(authPath, "utf8"));
    assert.equal(stored.clinepass.access, "workos:new");
    assert.equal(stored.clinepass.refresh, "new-refresh");
    assert.equal(stored.zai.key, "keep-me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistRotatedCredential skips the write when the store moved on", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const authPath = join(dir, "auth.json");
  try {
    const original = JSON.stringify({
      clinepass: { type: "oauth", access: "workos:newer", refresh: "newer-refresh", expires: 1 },
    });
    writeFileSync(authPath, original);
    persistRotatedCredential(
      WORKOS_CREDENTIAL,
      { access: "workos:new", refresh: "new-refresh", expires: 999, source: "pi-store" },
      { authPath },
    );
    assert.equal(readFileSync(authPath, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persistRotatedCredential round-trips the Cline CLI providers.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const providersPath = join(dir, "providers.json");
  try {
    writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          "cline-pass": {
            settings: {
              model: "glm-5.3",
              auth: { accessToken: "workos:old-jwt", refreshToken: "old-refresh", expiresAt: 1 },
            },
          },
        },
      }),
    );
    persistRotatedCredential(
      { ...WORKOS_CREDENTIAL, source: "cline-cli" },
      { access: "workos:new", refresh: "new-refresh", expires: 999, source: "cline-cli" },
      { providersPath },
    );
    const stored = JSON.parse(readFileSync(providersPath, "utf8"));
    const auth = stored.providers["cline-pass"].settings.auth;
    assert.equal(auth.accessToken, "workos:new");
    assert.equal(auth.refreshToken, "new-refresh");
    assert.equal(auth.expiresAt, 999);
    assert.equal(stored.providers["cline-pass"].settings.model, "glm-5.3");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Login ─────────────────────────────────────────────────────────────────

test("login reuses the Cline CLI login when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "clinepass-auto-auth-"));
  const providersPath = join(dir, "providers.json");
  const previousPath = process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH;
  const previousKey = process.env.CLINE_API_KEY;
  try {
    writeFileSync(
      providersPath,
      JSON.stringify({
        providers: {
          "cline-pass": {
            settings: { auth: { accessToken: "workos:jwt", refreshToken: "rt", expiresAt: 42 } },
          },
        },
      }),
    );
    process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH = providersPath;
    delete process.env.CLINE_API_KEY;
    const progress: string[] = [];
    const credentials = await login({
      onAuth: () => {},
      onDeviceCode: () => {},
      onPrompt: async () => {
        throw new Error("should not prompt");
      },
      onSelect: async () => {
        throw new Error("should not select");
      },
      onProgress: (message) => progress.push(message),
    });
    assert.equal(credentials.access, "workos:jwt");
    assert.equal(credentials.refresh, "rt");
    assert.ok(progress.length > 0);
  } finally {
    if (previousPath === undefined) delete process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH;
    else process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.CLINE_API_KEY;
    else process.env.CLINE_API_KEY = previousKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login prompts for an API key when no Cline CLI login exists", async () => {
  const previousPath = process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH;
  const previousKey = process.env.CLINE_API_KEY;
  try {
    process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH = "/nonexistent/providers.json";
    delete process.env.CLINE_API_KEY;
    const credentials = await login({
      onAuth: () => {},
      onDeviceCode: () => {},
      onPrompt: async () => "pasted-key",
      onSelect: async () => "key",
    });
    assert.equal(credentials.access, "pasted-key");
    assert.equal(credentials.expires, Number.MAX_SAFE_INTEGER);
  } finally {
    if (previousPath === undefined) delete process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH;
    else process.env.CLINEPASS_AUTO_CLINE_PROVIDERS_PATH = previousPath;
    if (previousKey === undefined) delete process.env.CLINE_API_KEY;
    else process.env.CLINE_API_KEY = previousKey;
  }
});
