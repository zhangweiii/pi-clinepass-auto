# pi-clinepass-auto

[![CI](https://github.com/zhangweiii/pi-clinepass-auto/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangweiii/pi-clinepass-auto/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pi-clinepass-auto)](https://www.npmjs.com/package/pi-clinepass-auto)

ClinePass provider for [pi](https://pi.dev) with:

- **live model catalog** — new ClinePass and free-tier models appear
  without a package update (availability from Cline, metadata from
  models.dev);
- **server-truth usage meter** — the footer shows per-turn and per-session
  cost as billed by Cline, plus plan-window utilization;
- **web tools** — `web_search` (Cline's Exa-backed search) and `web_fetch`
  (local URL fetching), active only when a Cline credential is available;
- **`/clinepass`** — report, manual catalog refresh, meter and web tool
toggles;
- **`/cline-usage`** (alias `/usage`) — print the same usage/limits report
  on demand, without the footer.

## How the catalog updates itself

```
Cline recommended-models (/api/v1/ai/cline/recommended-models)
        │  "which cline-pass/* and free models exist right now"
        ▼
models.dev (api.json → provider "cline-pass")
        │  "price, context window, max output, reasoning options"
        ▼
merged catalog ──► pi provider models
        │
        ├─ on-disk cache  ~/.pi/agent/clinepass-auto-catalog.json (6 h TTL)
        └─ bundled seed   (first run without network)
```

- Availability always comes from Cline, so **retired models disappear** and
  **new models show up** on the next catalog refresh (pi refreshes at
  startup, the model selector can refresh on demand, and `/clinepass →
  Refresh model catalog` forces it). This covers both the paid
  `cline-pass/*` lineup and the free-tier `cline-free/*` / `stealth/*`
  models from the same response.
- Metadata comes from models.dev, which only knows the paid lineup. A model
  that models.dev does not know yet (including every free-tier model) still
  registers, with conservative defaults and no invented prices.
- Thinking levels are derived from models.dev `reasoning_options`
  (`effort` values map 1:1 to pi levels; `off` maps to `none` only when the
  provider advertises it). Without metadata the plugin uses a conservative
  default map instead of guessing.
- If both sources fail, the last cached catalog is used; if there is no
  cache, the bundled seed is used. The provider is never empty.

## Install

```sh
pi install npm:pi-clinepass-auto                                      # from npm
pi install git:github.com/zhangweiii/pi-clinepass-auto                # from git
pi install ./pi-clinepass-auto                                        # local checkout
pi -e ./pi-clinepass-auto                                             # try without installing
```

The package carries the `pi-package` keyword, so publishing it to npm also
lists it in the [Pi package gallery](https://pi.dev/packages) — no separate
submission step.

> The provider id is `clinepass`, the same id used by `pi-clinepass` and
> `pi-clinepass-provider`. Do not install more than one of them at a time.

## Authenticate

Run `/login` inside pi and select **ClinePass**. The login flow:

1. reuses an existing Cline CLI login (`~/.cline/data/settings/providers.json`);
2. otherwise lets you paste a static API key.

A static key can also be provided without `/login`:

```sh
export CLINE_API_KEY="your_key_here"
```

Short-lived WorkOS tokens are refreshed automatically through Cline's
`/api/v1/auth/refresh`. Rotated refresh tokens are written back to the store
they came from (pi's `auth.json` or the Cline CLI's `providers.json`) with a
compare-and-swap, so either client can keep refreshing.

This extension deliberately does not reimplement Cline's browser OAuth flow.
If you prefer browser sign-in, run `cline auth` from the Cline CLI first, then
`/login` in pi to import it.

## Use

```sh
pi --model clinepass/cline-pass/glm-5.3
pi --model clinepass/cline-free/mimo-v2.6-flash
pi --list-models clinepass
```

The footer meter shows server-billed numbers when the active model belongs to
this provider:

```
Cline: $0.01 turn · $0.18 session · 5h 12% · 7d 34%
```

The text is plain (no box-drawing frame), so a footer extension such as
`pi-status-line` can style it like its own widgets — the `ext-status` widget
dims it to match the rest of the status line.

When the footer is used for something else, `/cline-usage` (alias `/usage`)
prints the report below instead; `/clinepass → Hide report` clears it again.

The meter is shown only while a ClinePass model is active; `/clinepass →
Hide footer meter` turns it off (and `Show footer meter` turns it back on).
That choice is remembered across sessions.

`/clinepass` opens a small menu:

- **Report** — plan windows (5 h / 7 d / 30 d) with cap amounts and reset
  times, session cost, catalog status, and any fetch warnings.
- **Refresh model catalog** — forces a live refresh and re-registers models
  immediately, without restarting pi.
- **Hide report** — clears the report widget.
- **Hide footer meter** / **Show footer meter** — toggles the footer meter;
  persisted in `clinepass-auto-prefs.json` under the pi agent directory.
- **Hide web tools** / **Show web tools** — toggles `web_search` and
  `web_fetch`; persisted in the same preferences file.

Per-turn costs are adopted from Cline's `/usages` feed (polled briefly after
each turn while the server flushes the record) and persisted as session
entries, so the session total survives resume. Web search records are adopted
the same way and folded into the session total, which the footer shows as
`$0.20 session ($0.05 search)` — only searches attributed to a `web_search`
this extension actually ran are counted, so another Cline client on the same
account never leaks into the figure. If the usage API is unreachable, the
meter simply keeps the last known numbers.

## Web search and page fetching

Two tools are registered; both can be disabled per invocation with pi's own
`-t` / `-xt` flags or persistently with `/clinepass → Hide web tools`.

| Tool | Backend | Cost | Available when |
| --- | --- | --- | --- |
| `web_search` | Cline's Exa-backed search API | about **$0.007** per call | a Cline credential exists |
| `web_fetch` | plain HTTP GET, local HTML→text | free | always |

- **`web_search(query, allowed_domains?, blocked_domains?, fetch_top?)`** —
  the endpoint returns **titles and URLs only**, so the tool appends a note
  telling the model to open a page with `web_fetch` before answering. Set
  `fetch_top` (0–3) to also pull the full text of the top results in the same
  call; each page is truncated to a share of the 50 KB result budget.
- **`web_fetch(url, prompt?)`** — fetches a URL over plain HTTP, converts HTML
  to text (the same dependency-free approach Cline uses), pretty-prints JSON,
  and truncates the output to pi's standard limit. When truncated, the full
  text is written to a temp file that the model can `read`. `prompt` is an
  optional note appended to the returned text.

`web_search` is only activated while a credential is available (`/login`
ClinePass, `CLINE_API_KEY`, or the Cline CLI login). Without one, neither the
provider request nor the system prompt mentions it — the tool simply does not
exist for the model. Signing in mid-session activates it immediately. Tools
deactivated by `-t` / `-xt` are never re-enabled by the extension; the
`/clinepass` toggle only restores what it hid itself.

Search spending is billed to the ClinePass plan windows (visible as 5 h / 7 d /
30 d percentages) and, unlike model turns, is folded straight into the footer's
session total (shown as the `(... search)` share); the `turn` figure keeps
pi's own meaning of the most recent model request.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `CLINE_API_KEY` | static ClinePass API key (alternative to `/login`) |
| `CLINE_API_BASE` | override the API base (default `https://api.cline.bot`) |
| `PI_CODING_AGENT_DIR` | where the catalog cache is written (pi standard) |

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
| `src/discovery.ts` | fetch/merge/cache catalog, thinking-map derivation (pure) |
| `src/auth.ts` | credential resolution, WorkOS refresh, `/login` handlers |
| `src/usage.ts` | usage/plan API parsing, meter and report formatting (pure) |
| `src/web.ts` | search request/response, HTML→text, formatting (pure) |
| `src/webtools.ts` | `web_search` / `web_fetch` tools, activation rules |
| `src/index.ts` | provider registration, pi event hooks, `/clinepass` |
| `src/seed.ts` | generated offline fallback catalog |

## Releasing

Releases are tag driven and run in GitHub Actions (`.github/workflows/release.yml`):

| Command | Version | npm dist-tag |
| --- | --- | --- |
| `npm run release:stable` | `0.2.0` | `latest` |
| `npm run release:beta` | `0.2.0-beta.0` | `beta` |
| `npm version minor && git push --follow-tags` | any bump | `latest` |

The workflow refuses to publish when the tag does not match the version in
`package.json`, runs the test suite, publishes with `--provenance` (so npm
shows the build attestation), and creates a GitHub release with generated
notes (marked prerelease for `-beta`/`-rc` versions).

Install a prerelease with a pinned dist-tag:

```sh
pi install npm:pi-clinepass-auto@beta
```

Authentication uses npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC): on npmjs.com open the package → Settings → Trusted publishing and add
this repository plus the workflow file `release.yml`. The alternative is an
`NPM_TOKEN` secret with the `NODE_AUTH_TOKEN` line in the workflow
uncommented.

Publishing with the `pi-package` keyword is all that is needed for the
[Pi package gallery](https://pi.dev/packages) to pick the release up;
optional `pi.image` / `pi.video` fields add gallery previews.

## Limits and notes

- Free-tier models (`cline-free/*`, `stealth/*`) are registered under the
  same `clinepass` provider and labelled `(Cline Free)`. models.dev has no
  metadata for them, so they use conservative defaults and $0 pricing; free
  turns may not appear in the billed `/usages` feed, in which case the meter
  simply does not count them.
- The usage/plan endpoints are undocumented Cline APIs. Field parsing is
  defensive and unit-tested, but unlike model discovery it could not be
  verified against a live account from here.
- The web search endpoint (`POST /api/v1/search/websearch`) is likewise
  undocumented and Exa-backed. It ignores result-count parameters, returns
  ten title/URL pairs with no snippets, and currently bills about $0.007 per
  request. If Cline changes it, `web_search` fails loudly rather than
  returning invented results.
- `web_fetch` uses the same regex HTML→text extractor as Cline's
  `fetch_web_content`, so JavaScript-rendered pages come back mostly empty and
  navigation chrome is not stripped. It never touches Cline's API.
- Cline's billing pipeline flushes usage records asynchronously; a turn whose
  record does not appear within ~12 s is not counted in the meter.
- This package is not affiliated with Cline, pi, or models.dev.
