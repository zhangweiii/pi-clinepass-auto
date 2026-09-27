import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchBody,
  decodeBody,
  extractHtmlText,
  formatPageText,
  formatSearchResults,
  isHtmlContentType,
  parseSearchResponse,
  readServerError,
  SEARCH_PATH,
  validateHttpUrl,
} from "../src/web.ts";

// ─── Search request ────────────────────────────────────────────────────────

test("buildSearchBody trims the query and omits empty domain lists", () => {
  assert.deepEqual(buildSearchBody("  durable objects  "), {
    ok: true,
    body: { query: "durable objects" },
  });
  assert.deepEqual(buildSearchBody("q", [], []), { ok: true, body: { query: "q" } });
});

test("buildSearchBody rejects an empty query", () => {
  const result = buildSearchBody("   ");
  assert.equal(result.ok, false);
});

test("buildSearchBody trims and dedupes domains", () => {
  const result = buildSearchBody("q", [" developers.cloudflare.com ", "developers.cloudflare.com", ""]);
  assert.ok(result.ok);
  assert.deepEqual(result.body, {
    query: "q",
    allowed_domains: ["developers.cloudflare.com"],
  });
});

test("buildSearchBody rejects allowed and blocked domains together", () => {
  const result = buildSearchBody("q", ["a.com"], ["b.com"]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /not both/);
});

// ─── Search response ───────────────────────────────────────────────────────

test("parseSearchResponse reads results and metadata", () => {
  const parsed = parseSearchResponse({
    success: true,
    data: {
      query: "q",
      durationMs: 930,
      results: [
        { title: "A", url: "https://a.dev", ignored: 1 },
        { url: "https://b.dev" },
      ],
    },
  });
  assert.deepEqual(parsed.results, [
    { title: "A", url: "https://a.dev" },
    { title: "", url: "https://b.dev" },
  ]);
  assert.equal(parsed.query, "q");
  assert.equal(parsed.durationMs, 930);
  assert.equal(parsed.error, undefined);
});

test("parseSearchResponse skips junk entries and tolerates broken shapes", () => {
  const parsed = parseSearchResponse({
    success: true,
    data: { results: [{ title: "no url" }, "nope", null, { title: 5, url: "https://ok.dev" }] },
  });
  assert.deepEqual(parsed.results, [{ title: "", url: "https://ok.dev" }]);

  const empty = parseSearchResponse(undefined);
  assert.deepEqual(empty.results, []);
  assert.equal(empty.error, "unexpected response body");
});

test("parseSearchResponse surfaces server errors", () => {
  assert.equal(parseSearchResponse({ success: false, error: "Validation failed" }).error, "Validation failed");
  assert.equal(parseSearchResponse({ success: false }).error, "search failed");
});

test("readServerError prefers the error field and falls back to a snippet", () => {
  assert.equal(readServerError('{"data":[],"error":"Validation failed"}'), "Validation failed");
  assert.equal(readServerError("<html>502 Bad Gateway</html>"), "<html>502 Bad Gateway</html>");
  assert.equal(readServerError("   "), undefined);
});

// ─── Model-facing formatting ───────────────────────────────────────────────

test("formatSearchResults numbers results and nudges a fetch", () => {
  const text = formatSearchResults("q", [
    { title: "A", url: "https://a.dev" },
    { title: "", url: "https://b.dev" },
  ]);
  assert.equal(
    text,
    [
      "1. A — https://a.dev",
      "2. https://b.dev",
      "",
      "(2 results, titles and URLs only. Fetch promising pages with web_fetch before answering factual questions.)",
    ].join("\n"),
  );
});

test("formatSearchResults adapts its note when content is included", () => {
  const text = formatSearchResults("q", [{ title: "A", url: "https://a.dev" }], { fetchedCount: 1 });
  assert.ok(text.endsWith("(1 results; full text of the top 1 below.)"));
});

test("formatSearchResults handles no results", () => {
  assert.equal(formatSearchResults("nothing here", []), 'No web results for "nothing here".');
});

test("formatPageText emits Cline-style headers and an optional focus", () => {
  const plain = formatPageText({
    url: "https://a.dev",
    contentType: "text/html",
    bytes: 10,
    text: "Body",
  });
  assert.equal(
    plain,
    ["URL: https://a.dev", "Content-Type: text/html", "Size: 10 bytes", "", "--- Content ---", "Body"].join("\n"),
  );

  const focused = formatPageText({
    url: "https://a.dev",
    contentType: "",
    bytes: 0,
    text: "Body",
    prompt: "find the API name",
  });
  assert.ok(focused.includes("Content-Type: unknown"));
  assert.ok(focused.endsWith("\n\nExtract focus: find the API name"));
});

// ─── URL handling ──────────────────────────────────────────────────────────

test("validateHttpUrl accepts http and https and trims", () => {
  assert.deepEqual(validateHttpUrl("  https://a.dev/x?y=1  "), { ok: true, url: "https://a.dev/x?y=1" });
  assert.deepEqual(validateHttpUrl("http://a.dev"), { ok: true, url: "http://a.dev" });
});

test("validateHttpUrl rejects other protocols and junk", () => {
  assert.equal(validateHttpUrl("ftp://a.dev").ok, false);
  assert.equal(validateHttpUrl("data:text/plain,hi").ok, false);
  assert.equal(validateHttpUrl("file:///etc/passwd").ok, false);
  assert.equal(validateHttpUrl("/relative/path").ok, false);
  assert.equal(validateHttpUrl("   ").ok, false);
});

// ─── HTML to text ──────────────────────────────────────────────────────────

test("extractHtmlText strips scripts, styles and comments", () => {
  const text = extractHtmlText(
    `<html><head><title>T</title><script>var x = 1;</script><style>.a{color:red}</style></head>` +
      `<body><!-- note --><h1>Hello</h1><p>World &amp; friends</p><div>Line<br>two</div></body></html>`,
  );
  assert.equal(text, "T\nHello\nWorld & friends\nLine\ntwo");
});

test("extractHtmlText decodes entities, including numeric and hex", () => {
  const text = extractHtmlText("<p>&nbsp;&lt;a&gt; &quot;q&quot; &apos;s&apos; &#65; &#x42;</p>");
  assert.equal(text, `<a> "q" 's' A B`);
});

test("extractHtmlText drops out-of-range and surrogate code points", () => {
  assert.equal(extractHtmlText("<p>A&#x110000;B&#55296;C</p>"), "ABC");
});

test("extractHtmlText collapses whitespace but keeps lines", () => {
  assert.equal(extractHtmlText("<p>  a   b  </p><div>c</div><div></div><div></div><div>d</div>"), "a b\nc\n\nd");
});

test("isHtmlContentType recognizes html documents", () => {
  assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlContentType("application/xhtml+xml"), true);
  assert.equal(isHtmlContentType("application/json"), false);
});

test("decodeBody extracts html and pretty-prints json", () => {
  assert.equal(decodeBody("<p>Hi &amp; bye</p>", "text/html"), "Hi & bye");
  assert.equal(decodeBody('{"b":1,"a":2}', "application/json"), '{\n  "b": 1,\n  "a": 2\n}');
  assert.equal(decodeBody("{not json", "application/json"), "{not json");
  assert.equal(decodeBody("plain text", "text/plain"), "plain text");
});

// ─── Endpoint constants ────────────────────────────────────────────────────

test("SEARCH_PATH points at Cline's web search endpoint", () => {
  assert.equal(SEARCH_PATH, "/api/v1/search/websearch");
});
