/**
 * pi-clinepass-auto — web search and page fetching helpers.
 *
 * Pure logic behind the `web_search` and `web_fetch` tools:
 *   - request/response handling for Cline's Exa-backed
 *     `POST /api/v1/search/websearch` endpoint (titles and URLs only);
 *   - a dependency-free HTML-to-text extractor equivalent to the one Cline
 *     uses for its `fetch_web_content` tool;
 *   - model-facing formatting.
 *
 * Network access lives in `webtools.ts` so this module stays unit-testable.
 */

/** Cline web search path, appended to the API base. */
export const SEARCH_PATH = "/api/v1/search/websearch";

export interface SearchResult {
  title: string;
  url: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query?: string;
  durationMs?: number;
  /** Server-reported error; HTTP failures are surfaced by the caller. */
  error?: string;
}

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

// ─── Search request ────────────────────────────────────────────────────────

function normalizeDomains(domains: readonly string[] | undefined): string[] {
  if (!domains) return [];
  const seen = new Set<string>();
  for (const domain of domains) {
    const trimmed = domain.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Build the search request body. Cline rejects a request that carries both
 * `allowed_domains` and `blocked_domains`, so that is validated up front.
 */
export function buildSearchBody(
  query: string,
  allowedDomains?: readonly string[],
  blockedDomains?: readonly string[],
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const trimmed = query.trim();
  if (!trimmed) return { ok: false, error: "query is required" };
  const allowed = normalizeDomains(allowedDomains);
  const blocked = normalizeDomains(blockedDomains);
  if (allowed.length > 0 && blocked.length > 0) {
    return {
      ok: false,
      error: "web_search accepts allowed_domains or blocked_domains, but not both.",
    };
  }
  const body: Record<string, unknown> = { query: trimmed };
  if (allowed.length > 0) body.allowed_domains = allowed;
  if (blocked.length > 0) body.blocked_domains = blocked;
  return { ok: true, body };
}

/** Parse `{data:{query,results,durationMs},success}` tolerating broken shapes. */
export function parseSearchResponse(json: unknown): SearchResponse {
  if (!isRecord(json)) return { results: [], error: "unexpected response body" };
  const data = isRecord(json.data) ? json.data : undefined;
  const results: SearchResult[] = [];
  const raw = data && Array.isArray(data.results) ? data.results : [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const url = stringValue(item.url);
    if (!url) continue;
    results.push({ title: stringValue(item.title) ?? "", url });
  }
  return {
    results,
    query: data ? stringValue(data.query) : undefined,
    durationMs: data ? numberValue(data.durationMs) : undefined,
    error: json.success === false ? (stringValue(json.error) ?? "search failed") : undefined,
  };
}

/** Extract a human-readable message from a non-OK search response body. */
export function readServerError(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const json: unknown = JSON.parse(trimmed);
    if (isRecord(json)) {
      const error = stringValue(json.error);
      if (error) return error;
    }
  } catch {
    // Not JSON: fall through to the raw snippet.
  }
  return trimmed.slice(0, 300);
}

// ─── Model-facing formatting ───────────────────────────────────────────────

/**
 * Render search results for the model. The endpoint returns titles and URLs
 * only, so the trailing note nudges the model to open a page before it
 * answers from a headline.
 */
export function formatSearchResults(
  query: string,
  results: readonly SearchResult[],
  options: { fetchedCount?: number } = {},
): string {
  if (results.length === 0) return `No web results for "${query}".`;
  const lines = results.map(
    (result, index) => `${index + 1}. ${result.title ? `${result.title} — ` : ""}${result.url}`,
  );
  const fetched = options.fetchedCount ?? 0;
  const note =
    fetched > 0
      ? `(${results.length} results; full text of the top ${fetched} below.)`
      : `(${results.length} results, titles and URLs only. Fetch promising pages with web_fetch before answering factual questions.)`;
  lines.push("", note);
  return lines.join("\n");
}

/** Render a fetched page in the shape Cline's fetch tool uses. */
export function formatPageText(input: {
  url: string;
  contentType: string;
  bytes: number;
  text: string;
  prompt?: string;
}): string {
  const lines = [
    `URL: ${input.url}`,
    `Content-Type: ${input.contentType || "unknown"}`,
    `Size: ${input.bytes} bytes`,
    "",
    "--- Content ---",
    input.text,
  ];
  if (input.prompt) lines.push("", `Extract focus: ${input.prompt}`);
  return lines.join("\n");
}

// ─── URL handling ──────────────────────────────────────────────────────────

export function validateHttpUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const url = raw.trim();
  if (!url) return { ok: false, error: "url is required" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      error: `Unsupported URL protocol "${parsed.protocol}" — only http and https are supported.`,
    };
  }
  return { ok: true, url };
}

// ─── HTML to text ──────────────────────────────────────────────────────────

/** Decode a numeric HTML entity without throwing on out-of-range values. */
function decodeCodePoint(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return "";
  if (value >= 0xd800 && value <= 0xdfff) return "";
  return String.fromCodePoint(value);
}

/**
 * Convert an HTML document to plain text.
 *
 * Mirrors Cline's dependency-free `fetch_web_content` extractor (strip
 * scripts, styles and comments; turn block tags into line breaks; drop the
 * remaining tags; decode common entities), with one deliberate fix: Cline
 * collapses the line breaks it just inserted, so its output is a single very
 * long line. Here the line structure survives, which reads better and lets
 * byte/line truncation behave normally.
 */
export function extractHtmlText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(p|div|br|hr|h[1-6]|li|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => decodeCodePoint(Number.parseInt(dec, 10)))
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isHtmlContentType(contentType: string): boolean {
  return /text\/html|application\/xhtml/i.test(contentType);
}

/** Decode a response body according to its content type. */
export function decodeBody(raw: string, contentType: string): string {
  if (isHtmlContentType(contentType)) return extractHtmlText(raw);
  if (/json/i.test(contentType)) {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}
