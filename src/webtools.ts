/**
 * `web_search` and `web_fetch` tools for pi.
 *
 * `web_search` calls Cline's Exa-backed search endpoint with the same account
 * credential the provider uses. It returns titles and URLs only (the endpoint
 * exposes no snippets) and is billed at roughly $0.007 per request.
 *
 * `web_fetch` is local-only: a plain HTTP GET plus the dependency-free
 * HTML-to-text extractor Cline uses for `fetch_web_content`. It never touches
 * Cline's API and costs nothing.
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { apiBase, getActiveToken, invalidateTokenCache } from "./auth.ts";
import { requestSignal } from "./discovery.ts";
import {
  buildSearchBody,
  decodeBody,
  formatPageText,
  formatSearchResults,
  parseSearchResponse,
  readServerError,
  SEARCH_PATH,
  validateHttpUrl,
  type SearchResult,
} from "./web.ts";

export const WEB_SEARCH_TOOL = "web_search";
export const WEB_FETCH_TOOL = "web_fetch";

const SEARCH_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 30_000;
/** Mirror Cline's fetch tool: 5 MB response cap, browser-ish user agent. */
const FETCH_MAX_BYTES = 5_000_000;
const FETCH_USER_AGENT = "Mozilla/5.0 (compatible; AgentBot/1.0)";
/** Upper bound for `web_search.fetch_top`; three pages fill the result budget. */
const MAX_FETCH_TOP = 3;

const NO_CREDENTIAL_MESSAGE =
  "Cline web search needs a ClinePass login — run /login (ClinePass) in pi, or set CLINE_API_KEY.";

// ─── Tool schemas ──────────────────────────────────────────────────────────

const SearchParams = Type.Object({
  query: Type.String({ description: "Search query. Be specific." }),
  allowed_domains: Type.Optional(
    Type.Array(Type.String({ description: "Domain to restrict results to." }), {
      description: "Only return results from these domains. Mutually exclusive with blocked_domains.",
    }),
  ),
  blocked_domains: Type.Optional(
    Type.Array(Type.String({ description: "Domain to exclude." }), {
      description: "Exclude results from these domains. Mutually exclusive with allowed_domains.",
    }),
  ),
  fetch_top: Type.Optional(
    Type.Number({
      description: `Also fetch and append the full text of the top N results (0-${MAX_FETCH_TOP}, default 0). Free but adds latency and context; use it only when you need content in one step.`,
    }),
  ),
});

const FetchParams = Type.Object({
  url: Type.String({ description: "Absolute http(s) URL to fetch." }),
  prompt: Type.Optional(
    Type.String({ description: "Optional note describing what to extract; appended to the returned text." }),
  ),
});

type SearchParamsType = Static<typeof SearchParams>;
type FetchParamsType = Static<typeof FetchParams>;

// ─── Search ────────────────────────────────────────────────────────────────

/**
 * POST the search request, retrying once with a refreshed token on 401
 * (ClinePass access tokens are short-lived WorkOS JWTs).
 */
async function requestSearch(
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  let token = await getActiveToken({ signal });
  if (!token) throw new Error(NO_CREDENTIAL_MESSAGE);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { signal: requestAbort, cleanup } = requestSignal(signal, SEARCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${apiBase()}${SEARCH_PATH}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "pi-clinepass-auto",
        },
        body: JSON.stringify(body),
        signal: requestAbort,
      });
      const text = await response.text();
      if (response.status === 401 && attempt === 0) {
        invalidateTokenCache();
        token = await getActiveToken({ signal });
        if (!token) throw new Error(NO_CREDENTIAL_MESSAGE);
        continue;
      }
      if (!response.ok) {
        const detail = readServerError(text);
        throw new Error(
          `Cline web search failed (HTTP ${response.status})${detail ? `: ${detail}` : "."}`,
        );
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error("Cline web search returned a non-JSON response.");
      }
    } finally {
      cleanup();
    }
  }
  throw new Error("Cline web search failed after re-authenticating.");
}

function clampFetchTop(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(MAX_FETCH_TOP, Math.floor(value)));
}

interface FetchedPageSummary {
  url: string;
  ok: boolean;
  bytes?: number;
  chars?: number;
  truncated?: boolean;
  error?: string;
}

/**
 * Fetch the top results for `fetch_top`. Each page is truncated to a share of
 * the total result budget so that every page survives the output cap.
 */
async function fetchTopResults(
  results: readonly SearchResult[],
  count: number,
  signal: AbortSignal | undefined,
): Promise<{ blocks: string[]; summary: FetchedPageSummary[] }> {
  const blocks: string[] = [];
  const summary: FetchedPageSummary[] = [];
  if (count <= 0 || results.length === 0) return { blocks, summary };

  const top = results.slice(0, Math.min(count, results.length));
  const budgetBytes = Math.max(2_000, Math.floor((DEFAULT_MAX_BYTES - 3_000) / top.length));
  const budgetLines = Math.max(40, Math.floor(DEFAULT_MAX_LINES / top.length));
  const pages = await Promise.all(top.map((result) => fetchPage(result.url, signal)));

  pages.forEach((page, index) => {
    const result = top[index];
    if (!result) return;
    const label = `${index + 1}. ${result.title ? `${result.title} — ` : ""}${page.url}`;
    if (!page.ok) {
      summary.push({ url: page.url, ok: false, error: page.error });
      blocks.push(`=== ${label} ===\nFetch failed: ${page.error ?? "unknown error"}`);
      return;
    }
    const block = `=== ${label} ===\n${formatPageText({
      url: page.url,
      contentType: page.contentType,
      bytes: page.bytes,
      text: page.text,
    })}`;
    const truncation = truncateHead(block, { maxLines: budgetLines, maxBytes: budgetBytes });
    summary.push({
      url: page.url,
      ok: true,
      bytes: page.bytes,
      chars: page.text.length,
      truncated: truncation.truncated,
    });
    blocks.push(
      truncation.truncated
        ? `${truncation.content}\n\n[trimmed to fit multiple results — call web_fetch on this URL for the full page]`
        : truncation.content,
    );
  });

  return { blocks, summary };
}

async function executeSearch(
  params: SearchParamsType,
  signal: AbortSignal | undefined,
  onRequestFinished?: (window: { startedAt: number; finishedAt: number }) => void,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const built = buildSearchBody(params.query, params.allowed_domains, params.blocked_domains);
  if (!built.ok) throw new Error(built.error);

  const startedAt = Date.now();
  const json = await requestSearch(built.body, signal);
  onRequestFinished?.({ startedAt, finishedAt: Date.now() });

  const parsed = parseSearchResponse(json);
  if (parsed.error) throw new Error(`Cline web search failed: ${parsed.error}`);

  const { blocks, summary } = await fetchTopResults(
    parsed.results,
    clampFetchTop(params.fetch_top),
    signal,
  );
  const text = [
    formatSearchResults(params.query, parsed.results, {
      fetchedCount: summary.filter((page) => page.ok).length,
    }),
    ...blocks,
  ].join("\n\n");

  return {
    text,
    details: {
      query: params.query,
      allowedDomains: params.allowed_domains,
      blockedDomains: params.blocked_domains,
      count: parsed.results.length,
      durationMs: parsed.durationMs,
      results: parsed.results,
      fetched: summary,
    },
  };
}

// ─── Fetch ─────────────────────────────────────────────────────────────────

interface PageResult {
  url: string;
  ok: boolean;
  contentType: string;
  bytes: number;
  text: string;
  error?: string;
}

function describeFetchError(error: unknown): string {
  if (error instanceof Error) {
    if (error.message === "timeout") return `timed out after ${FETCH_TIMEOUT_MS / 1000}s`;
    if (error.name === "AbortError") return "aborted";
    return error.message;
  }
  return String(error);
}

/** Read the body with a hard byte cap so a huge response cannot blow up memory. */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ raw: string; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const raw = await response.text();
    return { raw, bytes: raw.length };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response exceeded ${formatSize(maxBytes)}`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { raw: new TextDecoder("utf-8").decode(merged), bytes: total };
}

async function fetchPage(url: string, signal: AbortSignal | undefined): Promise<PageResult> {
  const target = validateHttpUrl(url);
  if (!target.ok) {
    return { url, ok: false, contentType: "", bytes: 0, text: "", error: target.error };
  }

  const { signal: requestAbort, cleanup } = requestSignal(signal, FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(target.url, {
      headers: {
        "User-Agent": FETCH_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: requestAbort,
    });
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok) {
      return {
        url: target.url,
        ok: false,
        contentType,
        bytes: 0,
        text: "",
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }
    const { raw, bytes } = await readBodyWithLimit(response, FETCH_MAX_BYTES);
    return { url: target.url, ok: true, contentType, bytes, text: decodeBody(raw, contentType) };
  } catch (error) {
    return {
      url: target.url,
      ok: false,
      contentType: "",
      bytes: 0,
      text: "",
      error: describeFetchError(error),
    };
  } finally {
    cleanup();
  }
}

/** Write the untruncated text to a temp file so the model can `read` it later. */
async function spillToTempFile(text: string): Promise<string | undefined> {
  try {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-fetch-"));
    const path = join(dir, "page.txt");
    await writeFile(path, text, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

async function executeFetch(
  params: FetchParamsType,
  signal: AbortSignal | undefined,
): Promise<{ text: string; details: Record<string, unknown> }> {
  const page = await fetchPage(params.url, signal);
  if (!page.ok) throw new Error(`Failed to fetch ${page.url}: ${page.error}`);

  const body = formatPageText({
    url: page.url,
    contentType: page.contentType,
    bytes: page.bytes,
    text: page.text,
    ...(params.prompt ? { prompt: params.prompt } : {}),
  });
  const truncation = truncateHead(body, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let text = truncation.content;
  let fullOutputPath: string | undefined;
  if (truncation.truncated) {
    fullOutputPath = await spillToTempFile(body);
    const saved = fullOutputPath ? ` Full text saved to: ${fullOutputPath}` : "";
    text += `\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).${saved}]`;
  }

  return {
    text,
    details: {
      url: page.url,
      contentType: page.contentType,
      bytes: page.bytes,
      chars: page.text.length,
      truncated: truncation.truncated,
      truncatedBy: truncation.truncatedBy,
      fullOutputPath,
    },
  };
}

// ─── Activation ────────────────────────────────────────────────────────────

/**
 * Compute the next active tool set for the web tools.
 *
 * `web_search` needs a Cline credential; `web_fetch` does not. A tool removed
 * here is remembered so it can be restored later, but tools deactivated by
 * other means (`-t` / `-xt`) are never enabled by this function: it only
 * re-adds names present in `removedByExtension`.
 */
export function applyWebToolActivation(input: {
  active: readonly string[];
  removedByExtension: ReadonlySet<string>;
  webToolsHidden: boolean;
  hasCredential: boolean;
}): { active: string[]; removedByExtension: string[] } {
  const active = new Set(input.active);
  const removed = new Set(input.removedByExtension);

  const disable = (name: string): void => {
    if (active.delete(name)) removed.add(name);
  };
  const reenable = (name: string): void => {
    if (removed.delete(name)) active.add(name);
  };

  if (input.webToolsHidden) {
    disable(WEB_FETCH_TOOL);
    disable(WEB_SEARCH_TOOL);
  } else {
    reenable(WEB_FETCH_TOOL);
    if (input.hasCredential) reenable(WEB_SEARCH_TOOL);
    else disable(WEB_SEARCH_TOOL);
  }

  return { active: [...active], removedByExtension: [...removed] };
}

// ─── Registration ──────────────────────────────────────────────────────────

export interface WebToolHooks {
  /**
   * Called after a `web_search` request finished, with the local time window
   * it occupied. The usage meter uses these windows to attribute Cline's
   * billing records to this extension's own searches.
   */
  onSearchRequest?: (window: { startedAt: number; finishedAt: number }) => void;
}

export function registerWebTools(pi: ExtensionAPI, hooks: WebToolHooks = {}): void {
  pi.registerTool({
    name: WEB_SEARCH_TOOL,
    label: "Web search (Cline)",
    description: `Search the public web through the ClinePass account (Exa-backed). Returns titles and URLs only — the endpoint exposes no snippets. Each call costs about $0.007 of ClinePass quota. Set fetch_top to also pull the full text of the top results in one step.`,
    promptSnippet: "Search the web via ClinePass (titles and URLs only)",
    promptGuidelines: [
      "web_search returns titles and URLs only; open at least one promising result with web_fetch (parallel calls are fine) before answering factual questions.",
      "Each web_search costs roughly $0.007 of ClinePass quota — do not repeat the same search; web_fetch is free.",
    ],
    parameters: SearchParams,
    async execute(_toolCallId, params, signal) {
      const { text, details } = await executeSearch(params, signal, hooks.onSearchRequest);
      return { content: [{ type: "text" as const, text }], details };
    },
  });

  pi.registerTool({
    name: WEB_FETCH_TOOL,
    label: "Web fetch",
    description: `Fetch a URL over plain HTTP and return its text content (HTML is converted to text, JSON is pretty-printed). Local and free — no ClinePass quota is used. Output is truncated to ${formatSize(DEFAULT_MAX_BYTES)}; the full text is saved to a temp file when truncated.`,
    promptSnippet: "Fetch a URL and return its text content",
    parameters: FetchParams,
    async execute(_toolCallId, params, signal) {
      const { text, details } = await executeFetch(params, signal);
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}
