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

`--env-file` is needed once: the path (never the token) is remembered in `.explorer.local` (git-ignored), and without any, `~/.config/typetorch/fleet/fleet.env` (the `bun run local` server's file) is used when it exists. So after the first run, `bun run dev` is enough.

`--env-file` is the analytics server's own env file: the explorer reads `TT_ANALYTICS_HOST`, `TT_ANALYTICS_PORT`
(0.0.0.0 means this machine) and `TT_ANALYTICS_ADMIN_TOKEN` from it. For a remote server, use a file (or environment
variables) with `TT_ANALYTICS_URL=https://...` and `TT_ANALYTICS_ADMIN_TOKEN`. Instead of the flag you can set
`TT_ANALYTICS_ENV_FILE`. `--port <n>` picks another port.

**The token never reaches the browser.** The page calls `/api/...`; the dev or preview server forwards it to the
analytics server and adds `Authorization: Bearer <admin token>` (`server/proxy.ts`). Because any other page open in
the same browser could also send requests to localhost, a guard runs first: only the read endpoints the explorer uses
(`POST /v1/query/*`, `POST /v1/sql`, `GET /v1/queries`, `GET /v1/storage`, `GET /v1/identity`, `POST /v1/identity/backfill`, `GET /v1/rollups/*`, `GET /v1/fleet/servers|reports|alerts|stream`,
`GET /v1/admin/settings`, `GET /healthz`), only from the explorer's own origin (Sec-Fetch-Site / Origin), JSON bodies only. Erasure, ingest,
alert acks and settings changes (`PATCH /v1/admin/settings`, the test alert) are never forwarded. The servers listen on localhost only. No CORS change is needed on the
analytics server.

Without a token every `/api` call answers 503 and the header shows "no admin token".

## Pages

All pages share the filter bar (date range in UTC days, branch, artifact, device, new/returning, experiment variant);
it lives in the URL, so a view can be bookmarked.

| Page | What it shows | Query |
|---|---|---|
| Overview | players, new, returning, sessions, events, playtime; per-day bars; Storage: what the server keeps on disk (DuckDB live, Parquet history, raw, fleet, rows, today's growth), every 30 s | `overview`, `/v1/storage` |
| Roblox | Creator Hub's overview from our events: benchmark cards (playtime per DAU, D1, D7, payer conversion, ARPPU, after-join play-through; 7/14/28 days vs the period before; the 50th/90th you copy from Creator Hub, kept in this browser, with an estimated percentile), a realtime column (concurrent users and a 7-day line from heartbeats, session time, client errors per session, client fps, server memory vs the 24 h before), and 7-day moving averages per join source | `benchmarks`, `realtime`, `trends` |
| Retention | join-day cohorts x day 1/3/7/14/30 heatmap, weighted average, days not over shown as – | `retention` |
| Funnels | funnel picker, step bars (reached, of start, from previous, median time), biggest drop highlighted | `funnel` |
| Players | recent players, search by part of a pid or by a UserId (the UserId shows next to the pid, linking to the Roblox profile; a "Find player" field in the top bar too; a backfill button when the server can read the DataStore links); the node graph for all sessions or one (session picker, or "View graph" on a session): one session numbers its moves in order, shows the time in each state and the path; sessions with every event, state and props | `players`, `player-graph`, `timeline` |
| Flow | the merged node graph for the filters, where sessions end, busiest moves, "Copy Mermaid" | `flow` |
| Experiments | per-variant numbers and the plain "how sure" sentences, per player or per server (A/B pins) | `experiment` |
| First session | early leaves per zone, screen loops, back-and-forth, idle / camera spins / repeated clicks from recordings | `confusion` |
| Events | top event names by kind, then the newest rows of a picked name (fleet rows without props) | `top-events`, `events` |
| Fleet | live servers, latest deploy, alerts, live event log, updated over the SSE stream | fleet API |
| Query | any named query with JSON filters/options (raw JSON), and read-only SQL over `events` / `recordings` | `/v1/query/*`, `/v1/sql` |
| Settings | the backend's runtime settings (alert webhook as set / not set, format and levels, admin allow list, token login, rate limits, retention): source badge per field (Dashboard / Env / Default), bounds checked before saving, Reset to env, Send test alert, recent changes, the env-only names. Through the dev proxy it is read only | `/v1/admin/settings` |

Graphs are drawn with React Flow and laid out by dagre (left to right; top to bottom in a narrow column), edges labelled
"count · average time before the move" (one session: #1, #2, ... in order), width by count, moves back to an earlier
state routed around the side. Each state shows what happened there (its top events and funnel steps; click it for the
list). "moments" adds key moments (funnel steps, purchases, personal_best, round_end) as small nodes on the path. A
graph with fewer than 3 states says so in one dim line, with a link to the player's events.

## Tables

Every table in the explorer is one component, `src/components/data-table/` (TanStack Table 8 for sorting, paging and column
visibility; filtering, saved views and export in `model.ts`). A table gives you, without page code:

- **Sort**: click a header (first click: biggest / newest first for numbers and dates, A to Z for text; again: the other way;
  again: off); shift-click adds a column to the sort. Sorting uses the column's **underlying value**, never the text it shows, so
  "47 / 60", "812 MB", "5 min ago" and "42%" sort as numbers and times. Missing values sort last in both directions.
- **Find**: a search box over the visible columns (every word must match, from 6 rows up), a filter button per column (a checklist
  for enum / boolean columns, a min and max for numbers, "last hour / 24 hours / 7 / 30 days" for dates, "contains" for text),
  chips for the active filters, and "12 of 340 rows".
- **Columns**: a Columns picker on every table (checkboxes, Reset columns), draggable widths (arrow keys too, double-click resets),
  a sticky header, horizontal scroll inside the table (never the page), pages of 25 to 500 rows.
- **Copy and export**: a row menu (Copy row as JSON, Copy cell), and Export: Download CSV or Copy as CSV or JSON of the current
  filtered and sorted view (visible columns, underlying values, formula-safe), Copy link to this view.
- **Remembered**: sort, search, filters, hidden columns and widths are kept per table id in localStorage, and written to the URL
  (`fleet-servers.sort=-players,job`, `fleet-servers.f.health=set:ok,failing`, `fleet-servers.cols=-kernel,+channel`). A link with a
  table's parameters wins over the saved view. Both are optional: without storage or a router the table still works.

```tsx
const COLUMNS: DataColumn<Server>[] = [
	{ id: "job", header: "Job", accessor: (s) => s.job, cell: (s) => shortId(s.job) },
	// Shown as "47 / 60", sorted and filtered by 47:
	{ id: "players", header: "Players", accessor: (s) => s.players, cell: (s) => `${s.players} / ${s.max}` },
	// Memory in MB with a unit hint; null sorts last:
	{ id: "memory", header: "Memory", hint: "MB", accessor: (s) => s.memoryMb, cell: (s) => `${s.memoryMb} MB` },
	{ id: "health", header: "Health", type: "enum", order: ["ok", "degraded", "failing"], accessor: (s) => s.health },
	{ id: "seen", header: "Seen", type: "date", accessor: (s) => s.lastSeen, cell: (s) => fmtAgo(s.lastSeen) },
	{ id: "channel", header: "Channel", type: "enum", accessor: (s) => s.channel, defaultHidden: true },
];

<DataTable id="fleet-servers" label="Live servers" columns={COLUMNS} data={servers} rowId={(s) => s.job}
	defaultSort={[{ id: "players", desc: true }]} onRowClick={open} empty={<EmptyState>No servers.</EmptyState>} />
```

`accessor` is the value (number for numbers, epoch ms / ISO string / Date for dates, `null` for none); `cell` is what shows. Other column
options: `type` (`text` `number` `date` `enum` `boolean`, guessed from the values when left out), `format` (plain text of the cell, for
search and filter labels), `searchText`, `filter` (`false` or a kind), `options` and `order` (enums), `firstSort`, `sortable`,
`hideable`, `defaultHidden`, `searchable`, `align`, `minWidth`, `className`, `hint`, `title`, `exportValue`. Table props: `id` (unique
in the app), `columns` and `data` (define the column array outside the component or in `useMemo`), `label`, `rowId`, `loading`, `empty`,
`defaultSort`, `pageSize`, `maxHeight`, `search`, `toolbar`, `onRowClick`, `isRowSelected`, `rowClassName`, `pinnedRows` (a total row
outside sorting and filtering), `rowJson`, `rowMenu`, `persist`, `urlSync`, `density`. Event rows have `EventTable`; SQL results build
their columns from DuckDB's types (`sqlColumns` in `pages/Query.tsx`).

## Development

```sh
bun run test        # vitest: API client, graph adapter, filters, proxy guard, the table (sorting, filters, saved view), page tests
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
