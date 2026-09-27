# pi-clinepass-auto

[![CI](https://github.com/zhangweiii/pi-clinepass-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangweiii/pi-clinepass-auto/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-clinepass-auto)](https://www.npmjs.com/package/pi-clinepass-auto)

**English** · [简体中文](https://github.com/zhangweiii/pi-clinepass-auto/blob/main/README.zh-CN.md)

Use your **Cline Pass** subscription inside [pi](https://pi.dev): the ClinePass
models, billed usage as the server reports it, and web search / page fetching
on the same account — all without a separate API key.

```
pi install npm:pi-clinepass-auto
/login        # choose ClinePass
```

- **Live model catalog** — new ClinePass models appear without a package update.
- **Server-truth usage meter** — the footer shows what Cline actually billed.
- **Web tools** — `web_search` and `web_fetch`, billed to the same subscription.
- **Zero configuration** — reuses an existing Cline CLI login if you have one.

---

## Quick start

### 1. Install

```sh
pi install npm:pi-clinepass-auto                    # from npm
pi install git:github.com/zhangweiii/pi-clinepass-auto   # from git
pi install ./pi-clinepass-auto                      # from a local checkout
pi -e ./pi-clinepass-auto                           # try it for one invocation
```

> The provider id is `clinepass` — the same id used by `pi-clinepass` and
> `pi-clinepass-provider`. Install **only one** of them, otherwise the provider
> is registered twice.

### 2. Sign in

Run `/login` inside pi and pick **ClinePass**. The login flow:

1. **reuses an existing Cline CLI login** (`~/.cline/data/settings/providers.json`) when present — no copy/paste needed;
2. otherwise asks you to **paste a ClinePass API key** (app.cline.bot → Settings → API Keys).

A static key also works without `/login`:

```sh
export CLINE_API_KEY="your_key_here"
```

Browser sign-in is intentionally not reimplemented here. If you prefer it, run
`cline auth` first and then `/login` in pi to import that session.

### 3. Pick a model

```sh
pi --list-models clinepass                  # everything the account can see
pi --model clinepass/cline-pass/glm-5.3     # start with a specific model
```

Or just run `pi` and use `/model` to pick from the list.

### 4. Check usage

While a `clinepass` model is active, the footer shows what Cline billed:

```
Cline: $0.01 turn · $0.18 session ($0.05 search) · 5h 12% · 7d 34%
```

`turn` is the cost of the most recent model request (pi's own definition of a
turn), `session` is everything adopted in this session — **including web
searches**, shown separately in parentheses — and the percentages are the
plan windows Cline reports. Run `/cline-usage` (alias `/usage`) for the full
report, or `/clinepass` for the menu.

---

## What you get

| Feature | Details |
| --- | --- |
| Models | `cline-pass/*` plus the free `cline-free/*` / `stealth/*` tiers, refreshed live → [Models](#models) |
| Usage meter | Footer meter, `/cline-usage` report, plan windows, per-session persistence → [Usage meter](#usage-meter-and-plan-limits) |
| Web tools | `web_search` (Cline's Exa-backed search) and `web_fetch` (local, free) → [Web tools](#web-search-and-page-fetching) |
| Commands | `/clinepass`, `/cline-usage`, `/usage` → [Reference](#commands-and-settings) |
| Auth | `/login` (Cline CLI reuse or API key), automatic WorkOS token refresh → [How it works](#how-it-works) |

---

## Models

The provider is registered as `clinepass`; model ids look like
`cline-pass/glm-5.3` and `cline-free/mimo-v2.6-flash`.

```sh
pi --list-models clinepass
pi --model clinepass/cline-pass/deepseek-v4.1-flash
```

- **New and retired models appear on their own.** Availability comes from
  Cline's `recommended-models` endpoint, so a model that Cline retires
  disappears from the list and a newly launched one shows up on the next
  refresh — no package update involved.
- **Metadata** (price, context window, max output, reasoning options) comes
  from [models.dev](https://models.dev). Models that models.dev does not know
  yet still register, with conservative defaults and no invented prices.
- **Refresh on demand** with `/clinepass → Refresh model catalog`, which
  re-registers models immediately without restarting pi.
- **Offline-safe**: the last cached catalog (or the bundled seed on a first
  run) is used when the network is unavailable. The provider is never empty.

> Free-tier models (`cline-free/*`, `stealth/*`) are visible in the catalog,
> but Cline currently rejects them on the API path used by pi with
> `403 ... only available via Cline product surfaces`. That is a Cline-side
> restriction; the catalog simply reflects what the account can see.

---

## Usage meter and plan limits

Cline bills the subscription server-side, so this extension does **not**
estimate token costs. It reads the same `/usages` feed the Cline apps use and
adopts the records Cline created for your turns.

```
Cline: $0.01 turn · $0.18 session ($0.05 search) · 5h 12% · 7d 34%
```

| Element | Meaning |
| --- | --- |
| `turn` | The most recent model request (pi calls each model request a turn). |
| `session` | Sum of every adopted record in this session, chat **and** web search. |
| `(… search)` | The web-search share of the session total; hidden while it is $0. |
| `5h` / `7d` | Plan-window utilization reported by Cline, with caps and reset times in `/cline-usage`. |

Notes:

- The meter appears only while a `clinepass` model is active and can be turned
  off with `/clinepass → Hide footer meter` (remembered across sessions).
- Costs are persisted as session entries, so the session total survives
  `pi --resume`.
- Web search records are only counted when they fall inside a time window in
  which this extension actually ran a `web_search`. Searches made by another
  Cline client on the same account never leak into the figure.
- Cline's billing pipeline flushes asynchronously. A record that does not show
  up within ~12 s is not counted; the meter simply keeps its last known value.
- The text is plain (no box-drawing frame) so footer extensions such as
  `pi-status-line` can style it like their own widgets — the `ext-status`
  widget dims it to match the rest of the status line.

`/cline-usage` (alias `/usage`) prints the report without using the footer:

```
ClinePass — Cline Pass (Annual)
5h   [██░░░░░░░░░░]  12% of $10  resets 13:00
7d   [████░░░░░░░░]  34% of $25  resets 00:41
30d  [█░░░░░░░░░░░]   5% of $50  resets 10-21 00:41

Session  $0.2012 across 12 adopted turns
Search   4 web searches ($0.028, included above)
Catalog  17 models (network, updated 9/27 11:02)
```

`/clinepass` opens a menu:

| Item | Effect |
| --- | --- |
| **Report** | Renders the report above as a widget. |
| **Refresh model catalog** | Forces a live catalog refresh and re-registers models. |
| **Hide report** | Clears the report widget. |
| **Hide / Show footer meter** | Toggles the footer meter (persisted). |
| **Hide / Show web tools** | Toggles `web_search` and `web_fetch` (persisted). |

---

## Web search and page fetching

Two tools are registered, both usable by any model — the credential, not the
active model, decides what is available.

| Tool | Backend | Cost | Available when |
| --- | --- | --- | --- |
| `web_search` | Cline's Exa-backed search API | ≈ **$0.007** per call | a Cline credential exists |
| `web_fetch` | plain HTTP GET + local HTML→text | **free** | always |

### `web_search`

```
web_search(query, allowed_domains?, blocked_domains?, fetch_top?)
```

- The endpoint returns **titles and URLs only** — no snippets. The tool appends
  a reminder telling the model to open a page with `web_fetch` before answering.
- `allowed_domains` / `blocked_domains` narrow the search; they are mutually
  exclusive (the API rejects a request with both).
- `fetch_top: 0–3` also fetches the full text of the top results in the same
  call. It is free but adds latency and context; each page is truncated to a
  share of the 50 KB result budget. Prefer leaving it at `0` and letting the
  model choose pages after seeing all ten results.
- Because one search costs roughly as much as ten model requests, the tool
  guides the model not to repeat the same query.

### `web_fetch`

```
web_fetch(url, prompt?)
```

- Fetches the URL over plain HTTP (browser-ish user agent, 30 s timeout, 5 MB
  response cap, redirects followed) and converts HTML to text with the same
  dependency-free extractor Cline's `fetch_web_content` uses. JSON is
  pretty-printed; other content types are returned verbatim.
- Output is truncated to pi's standard limit (50 KB / 2000 lines). When
  truncated, the full text is written to a temp file that the model can `read`.
- `prompt` is an optional note describing what to extract; it is appended to the
  returned text as `Extract focus: …`.

### Turning them off

| Scope | How |
| --- | --- |
| One invocation | `pi -xt web_search` or `pi -t read,bash,web_fetch` |
| Persistent | `/clinepass → Hide web tools` |

`web_search` is activated **only while a Cline credential exists**. Without one,
the tool is neither sent to the provider nor mentioned in the system prompt —
the model does not know it exists. Signing in mid-session (for example with
`/login`) activates it immediately. Tools excluded with `-t` / `-xt` are never
re-enabled by the extension; the `/clinepass` toggle only restores what it hid
itself.

---

## Commands and settings

### Slash commands

| Command | Description |
| --- | --- |
| `/clinepass` | Menu: report, catalog refresh, meter and web-tool toggles. |
| `/cline-usage` | Print the usage/limits report (no footer). |
| `/usage` | Alias of `/cline-usage`. |
| `/login` | Sign in — select **ClinePass**. |

### Environment variables

| Variable | Purpose |
| --- | --- |
| `CLINE_API_KEY` | Static ClinePass API key; alternative to `/login`. |
| `CLINE_API_BASE` | Override the API base (default `https://api.cline.bot`). |
| `PI_CODING_AGENT_DIR` | Where the catalog cache and preferences live (pi standard). |

### Files written

| Path | Content |
| --- | --- |
| `<agent dir>/clinepass-auto-catalog.json` | Cached model catalog (6 h TTL). |
| `<agent dir>/clinepass-auto-prefs.json` | Meter and web-tool visibility. |

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `No API key found for clinepass` | Run `/login` and choose ClinePass, or set `CLINE_API_KEY`. |
| `401 … re-authenticate your Cline account` | The stored token expired and refresh failed. Run `cline auth` (or `/login`) again. |
| Free model returns `403 … only available via Cline product surfaces` | Cline blocks free-tier models on third-party API paths. Use a `cline-pass/*` model. |
| `web_search` is missing from the model's tool list | No Cline credential, or `/clinepass → Hide web tools`, or `-xt web_search` was used. |
| The session total does not include a search | The billing record had not been flushed within ~12 s, or the search was made by another Cline client. |
| Plan limits show “unavailable” | The usage API could not be reached (offline, or not signed in yet). |
| Footer meter missing | The active model is not a `clinepass` model, or the meter is hidden. |

---

## How it works

The short version, for people who want to know what is happening underneath.

### Catalog discovery

```
Cline recommended-models (/api/v1/ai/cline/recommended-models)
        │  "which cline-pass/* and free models exist right now"
        ▼
models.dev (api.json → provider "cline-pass")
        │  "price, context window, max output, reasoning options"
        ▼
merged catalog ──► pi provider models
        │
        ├─ on-disk cache  <agent dir>/clinepass-auto-catalog.json (6 h TTL)
        └─ bundled seed   (first run without network)
```

Availability always comes from Cline, so retired models disappear and new ones
appear on the next refresh. Metadata comes from models.dev, which only knows
the paid lineup; unknown models still register with conservative defaults and
no invented prices. Thinking levels are derived from models.dev
`reasoning_options` (`effort` values map 1:1 to pi levels; `off` maps to `none`
only when the provider advertises it) — without metadata a conservative
default map is used instead of guessing.

### Credentials

Credentials are resolved in this order: `CLINE_API_KEY` → pi's credential
store (`<agent dir>/auth.json`, written by `/login`) → the Cline CLI login
(`~/.cline/data/settings/providers.json`).

ClinePass access tokens are short-lived WorkOS JWTs and are refreshed through
Cline's `/api/v1/auth/refresh`. Rotated refresh tokens are written back to the
store they came from with a compare-and-swap, so pi and the Cline CLI can both
keep refreshing without clobbering each other.

### Usage accounting

After every assistant message the extension polls `/usages` for the record of
that model request and adopts it into the session meter. The poll runs in the
background and never gates the agent loop; adoption is serialized so
overlapping tool loops cannot adopt a record twice.

Web search records share the same feed (`operation: "web_search"`,
`searchProviderName: "exa"`). They are adopted through the same polling loop
and folded into the session total; the `turn` figure keeps its original meaning
of “last model request”. To avoid stealing another Cline client's spending, a
search record is only adopted when its timestamp falls inside a window in which
this extension actually ran a `web_search` (±60 s for clock/queue spread).

### Web tool internals

`web_search` calls `POST {CLINE_API_BASE}/api/v1/search/websearch` with the
account bearer token and retries once with a refreshed token on 401.

`web_fetch` never touches Cline's API: it is a local GET plus a small
HTML-to-text pass (strip scripts/styles/comments, turn block tags into line
breaks, drop tags, decode common and numeric entities, collapse whitespace).
This is deliberately the same approach Cline's `fetch_web_content` uses, with
one fix: Cline's version collapses the line breaks it inserts, producing a
single very long line.

---

## Development

```sh
npm install           # dev dependencies: typescript, @types/node, typebox
npm test              # node --test, no build step
npm run typecheck     # tsc --noEmit
npm run generate-seed # regenerate src/seed.ts from the live sources
```

Layout:

| File | Role |
| --- | --- |
| `src/discovery.ts` | Fetch/merge/cache the catalog, thinking-map derivation (pure). |
| `src/auth.ts` | Credential resolution, WorkOS refresh, `/login` handlers. |
| `src/usage.ts` | Usage/plan API parsing, meter and report formatting (pure). |
| `src/web.ts` | Search request/response, URL validation, HTML→text (pure). |
| `src/webtools.ts` | `web_search` / `web_fetch` tools and activation rules. |
| `src/index.ts` | Provider registration, pi event hooks, `/clinepass`. |
| `src/seed.ts` | Generated offline fallback catalog. |

The test suite is `node --test` over TypeScript (Node 22.19+ strips types
natively), so there is no build step. CI runs `npm ci`, the type check, and the
tests on every push and pull request.

## Releasing

Releases are tag driven and run in GitHub Actions
(`.github/workflows/release.yml`):

| Command | Version | npm dist-tag |
| --- | --- | --- |
| `npm run release:stable` | `0.2.0` | `latest` |
| `npm run release:beta` | `0.2.0-beta.0` | `beta` |
| `npm version minor && git push --follow-tags` | any bump | `latest` |

The workflow refuses to publish when the tag does not match the version in
`package.json`, runs the test suite, publishes with `--provenance` (npm shows
the build attestation), and creates a GitHub release with generated notes
(marked prerelease for `-beta` / `-rc` versions).

Install a prerelease with a pinned dist-tag:

```sh
pi install npm:pi-clinepass-auto@beta
```

Authentication uses npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): on
npmjs.com open the package → Settings → Trusted publishing and add this
repository plus the workflow file `release.yml`. The alternative is an
`NPM_TOKEN` secret with the `NODE_AUTH_TOKEN` line in the workflow uncommented.

Publishing with the `pi-package` keyword is all that is needed for the
[Pi package gallery](https://pi.dev/packages) to pick the release up; optional
`pi.image` / `pi.video` fields add gallery previews.

## Limits and caveats

- **Undocumented APIs.** The catalog, usage, plan, and search endpoints are
  Cline APIs that are not publicly documented and may change. Parsing is
  defensive and unit-tested; `web_search` fails loudly rather than returning
  invented results.
- **Search shape.** `POST /api/v1/search/websearch` is Exa-backed, ignores
  result-count parameters, and returns ten title/URL pairs with no snippets.
  It currently bills about $0.007 per request.
- **Search attribution** relies on time windows (±60 s). A search made by
  another Cline client inside that window can be attributed to this session.
- **HTML extraction** uses the regex extractor described above, so
  JavaScript-rendered pages come back mostly empty and navigation chrome is not
  stripped. `web_fetch` never touches Cline's API.
- **Billing latency.** A record that Cline has not flushed within ~12 s is not
  counted. In `--print` mode the process can exit before the final record is
  adopted, so the footer in an interactive session is the accurate view.
- **Free tier** is listed but blocked on the API path (see
  [Models](#models)).
- This package is **not affiliated with** Cline, pi, or models.dev.

## License

[MIT](LICENSE)
