# TypeTorch web: analytics explorer

An internal, client-only explorer for the self-hosted TypeTorch analytics server (`../analytics`): overview, Roblox
numbers, retention, funnels, players (timeline and node graph), flow, experiments, first-session signals, events,
the live fleet, and raw queries / read-only SQL. Vite + React + TypeScript + Tailwind + shadcn/ui; no SSR.

Part of TypeTorch. Read `../TypeTorch.md` (hub) and `../plans/07-web-mobile.md` (this repo's plan) first.

## Run it

Needs Bun (package manager), Node 22.12+ (runs Vite) and a running analytics server.

```sh
bun install
bun run dev -- --env-file C:\Users\<you>\.config\typetorch\fleet\fleet.env    # http://localhost:5173
bun run local -- --env-file <same file>                                      # build, then serve dist/ at http://localhost:4173
bun run preview -- --env-file <same file>                                    # serve an existing dist/
```

`--env-file` is the analytics server's own env file: the explorer reads `TT_ANALYTICS_HOST`, `TT_ANALYTICS_PORT`
(0.0.0.0 means this machine) and `TT_ANALYTICS_ADMIN_TOKEN` from it. For a remote server, use a file (or environment
variables) with `TT_ANALYTICS_URL=https://...` and `TT_ANALYTICS_ADMIN_TOKEN`. Instead of the flag you can set
`TT_ANALYTICS_ENV_FILE`. `--port <n>` picks another port.

**The token never reaches the browser.** The page calls `/api/...`; the dev or preview server forwards it to the
analytics server and adds `Authorization: Bearer <admin token>` (`server/proxy.ts`). Because any other page open in
the same browser could also send requests to localhost, a guard runs first: only the read endpoints the explorer uses
(`POST /v1/query/*`, `POST /v1/sql`, `GET /v1/queries`, `GET /v1/rollups/*`, `GET /v1/fleet/servers|reports|alerts|stream`,
`GET /healthz`), only from the explorer's own origin (Sec-Fetch-Site / Origin), JSON bodies only. Erasure, ingest,
alert acks and settings are never forwarded. The servers listen on localhost only. No CORS change is needed on the
analytics server.

Without a token every `/api` call answers 503 and the header shows "no admin token".

## Pages

All pages share the filter bar (date range in UTC days, branch, artifact, device, new/returning, experiment variant);
it lives in the URL, so a view can be bookmarked.

| Page | What it shows | Query |
|---|---|---|
| Overview | players, new, returning, sessions, events, playtime; per-day bars | `overview` |
| Roblox | first-play bounce, qualified plays, D1/D7, playtime and play days per user, payer conversion, Robux per user / payer, one-line definitions | `roblox` |
| Retention | join-day cohorts x day 1/3/7/14/30 heatmap, weighted average, days not over shown as – | `retention` |
| Funnels | funnel picker, step bars (reached, of start, from previous, median time), biggest drop highlighted | `funnel` |
| Players | recent players + pid search; the node graph for all sessions or one (session picker, or "View graph" on a session): one session numbers its moves in order, shows the time in each state and the path; sessions with every event, state and props | `players`, `player-graph`, `timeline` |
| Flow | the merged node graph for the filters, where sessions end, busiest moves, "Copy Mermaid" | `flow` |
| Experiments | per-variant numbers and the plain "how sure" sentences, per player or per server (A/B pins) | `experiment` |
| First session | early leaves per zone, screen loops, back-and-forth, idle / camera spins / repeated clicks from recordings | `confusion` |
| Events | top event names by kind, then the newest rows of a picked name (fleet rows without props) | `top-events`, `events` |
| Fleet | live servers, latest deploy, alerts, live event log, updated over the SSE stream | fleet API |
| Query | any named query with JSON filters/options (raw JSON), and read-only SQL over `events` / `recordings` | `/v1/query/*`, `/v1/sql` |

Graphs are drawn with React Flow and laid out by dagre (left to right; top to bottom in a narrow column), edges labelled
"count · average time before the move" (one session: #1, #2, ... in order), width by count, moves back to an earlier
state routed around the side. Each state shows what happened there (its top events and funnel steps; click it for the
list). "moments" adds key moments (funnel steps, purchases, personal_best, round_end) as small nodes on the path. A
graph with fewer than 3 states says so in one dim line, with a link to the player's events.

## Development

```sh
bun run test        # vitest: API client, graph adapter, filters, proxy guard, a component test
bun run typecheck
bun run build       # dist/ (pages, charts and the graph view load on demand)
```

`src/lib/types.ts` mirrors the analytics queries' result types (a separate repo: copied, not imported); keep it in
step when a query changes. `src/components/ui/` is shadcn/ui as generated (radix, nova preset); chart colors and
status colors are tokens in `src/index.css`.

## Open issues

- Not hosted anywhere: it's a local tool. Hosting it (e.g. the Cloudflare Worker in plan 07) needs a server side that
  holds the token and an auth layer in front.
- `top-events` counts server rows (no pid) as one "player" (an analytics query quirk).
- Days are UTC everywhere (the server's day buckets).
