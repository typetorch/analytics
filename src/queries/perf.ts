/**
 * Performance: how the game runs on players' devices and on the servers, over time and by build, with percentiles (not
 * only averages). From the engine's tech rows (framework/src/analytics/SCHEMA.md):
 *   perf-client  — tech/client samples (`fps`, `mem` MB, `ping` ms; one per player every techEvery s) per time bucket
 *                  and per group: device class (`dev`), input type and screen size (the session's session/device row),
 *                  branch or build (`art`);
 *   perf-server  — tech/server samples (`hb` = the Heartbeat rate, the server's TPS; `fps` = physics FPS; `mem` MB;
 *                  `players`) the same way, by branch or build. Only the time, branch, build, channel, place and server
 *                  experiment filters apply to server rows (they have no player);
 *   perf-compare — the same numbers for a few builds side by side, or before vs after a moment (a deploy) over two equal
 *                  windows.
 * Percentiles: p90 and p99 are on the bad side: for fps and tps (higher is better) "p90" is the value 90% of samples reach or
 * beat (the 10th percentile) and "p99" the 1st; for mem and ping (lower is better) they are the 90th and 99th. p50 is the
 * median either way. p10 is the plain 10th percentile for every metric (the low end: 10% of samples are at or below it), so
 * for fps and tps it is the same value as p90, and for mem and ping the best case; the worst case of every metric is p99.
 * Values outside a sane range (a client can send anything) are left out.
 * The time step follows the window like every explorer chart (windowBucketMs: 1 h -> 1 min, 6 h -> 5 min, a day ->
 * hourly, longer -> daily) unless the caller picks one (bucketMinutes) or a bucket count (buckets).
 * Bounded so a query stays small on DuckDB and Basin: 92 days, 400 buckets, 20 groups, 6 builds, 7-day windows.
 */
import { whereSql, type NormalizedFilters } from "../sql/filters.ts";
import { defineQuery, int, intOption, iso, num, numOrNull, round, str, where, windowBucketMs, type QueryContext, type Row } from "./core.ts";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/** The longest range a perf query reads. */
export const PERF_MAX_DAYS = 92;
/** Bucket sizes a series snaps to (the first one at least range / buckets). */
export const BUCKET_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440].map((m) => m * MINUTE_MS);
/** The session/device row may come before the window starts (a long session): look this far back for it. */
const DEVICE_LOOKBACK_MS = 12 * HOUR_MS;

export type PerfGroupBy = "none" | "dev" | "input" | "screen" | "branch" | "art";
export const CLIENT_GROUPS: readonly PerfGroupBy[] = ["none", "dev", "input", "screen", "branch", "art"];
export const SERVER_GROUPS: readonly PerfGroupBy[] = ["none", "branch", "art"];

/** Screen-size buckets by the viewport's short side (points): phones, big phones / small tablets, tablets, desktops. */
export const SCREEN_BUCKETS = ["<400", "400-599", "600-799", "800-1079", "1080+", "unknown"] as const;

interface MetricSpec {
	/** The result key. */
	key: string;
	/** The SQL column inside the queries. */
	col: string;
	/** The props key. */
	prop: string;
	/** Higher is better (fps, tps): the bad tail is the low end. */
	higher: boolean;
	/** Samples outside [0, max] are left out. */
	max: number;
}

export const CLIENT_METRICS: readonly MetricSpec[] = [
	{ key: "fps", col: "fps", prop: "fps", higher: true, max: 1000 },
	{ key: "mem", col: "mem", prop: "mem", higher: false, max: 100_000 },
	{ key: "ping", col: "ping", prop: "ping", higher: false, max: 60_000 },
];

export const SERVER_METRICS: readonly MetricSpec[] = [
	{ key: "tps", col: "tps", prop: "hb", higher: true, max: 1000 },
	{ key: "physFps", col: "phys", prop: "fps", higher: true, max: 1000 },
	{ key: "mem", col: "mem", prop: "mem", higher: false, max: 1_000_000 },
];

/** One metric over a group of samples. p10 is the plain 10th percentile; p90 / p99 are on the bad side (module note). */
export interface PerfStat {
	p10: number | null;
	p50: number | null;
	p90: number | null;
	p99: number | null;
	avg: number | null;
	/** Samples that had this metric. */
	n: number;
}

/** The percentile a "p90" / "p99" of this metric is (0.1 / 0.01 when higher is better). */
export function badSide(spec: Pick<MetricSpec, "higher">, p: 0.5 | 0.9 | 0.99): number {
	return spec.higher && p !== 0.5 ? round(1 - p, 2) : p;
}

/** The bucket size for a range: the first step at least range / buckets, else whole days. */
export function bucketFor(rangeMs: number, buckets: number): number {
	const want = rangeMs / buckets;
	const step = BUCKET_STEPS_MS.find((s) => s >= want);
	return step ?? Math.ceil(want / DAY_MS) * DAY_MS;
}

/** The viewport's short side as a bucket (SQL, on columns w and h; 0 or missing = unknown). */
export function screenBucketSql(w: string, h: string): string {
	const short = `(CASE WHEN ${w} < ${h} THEN ${w} ELSE ${h} END)`;
	return (
		`(CASE WHEN ${w} IS NULL OR ${h} IS NULL OR ${w} <= 0 OR ${h} <= 0 THEN 'unknown' ` +
		`WHEN ${short} < 400 THEN '<400' WHEN ${short} < 600 THEN '400-599' WHEN ${short} < 800 THEN '600-799' ` +
		`WHEN ${short} < 1080 THEN '800-1079' ELSE '1080+' END)`
	);
}

/** The same bucket in JS (tests, the explorer's labels). */
export function screenBucket(w: number, h: number): (typeof SCREEN_BUCKETS)[number] {
	if (!(w > 0) || !(h > 0)) return "unknown";
	const short = Math.min(w, h);
	return short < 400 ? "<400" : short < 600 ? "400-599" : short < 800 ? "600-799" : short < 1080 ? "800-1079" : "1080+";
}

function checkRange(from: number, to: number): void {
	if (to - from > PERF_MAX_DAYS * DAY_MS) throw new Error(`performance queries read at most ${PERF_MAX_DAYS} days: narrow the range`);
}

/** A metric's raw value from props (inner query) as `<col>_raw`. */
function rawSql(ctx: QueryContext, spec: Pick<MetricSpec, "col" | "prop">): string {
	return `${ctx.dialect.jsonNumber("e.props", spec.prop)} AS ${spec.col}_raw`;
}

/** The raw value kept when inside [0, max], else NULL. */
function cleanSql(spec: Pick<MetricSpec, "col" | "max">): string {
	const v = `r.${spec.col}_raw`;
	return `CASE WHEN ${v} >= 0 AND ${v} <= ${int(spec.max)} THEN ${v} END AS ${spec.col}`;
}

/** p10, p50, p90, p99 (p90 / p99 on the bad side), avg and n of each metric, on columns of `x`. */
function statColumns(ctx: QueryContext, specs: readonly MetricSpec[], alias = ""): string {
	const p = ctx.dialect.percentile;
	return specs
		.flatMap((s) => {
			const c = `${alias}${s.col}`;
			return [
				`${p(c, 0.1)} AS ${s.col}_p10`,
				`${p(c, 0.5)} AS ${s.col}_p50`,
				`${p(c, badSide(s, 0.9))} AS ${s.col}_p90`,
				`${p(c, badSide(s, 0.99))} AS ${s.col}_p99`,
				`AVG(${c}) AS ${s.col}_avg`,
				`COUNT(${c}) AS ${s.col}_n`,
			];
		})
		.join(", ");
}

function statOf(r: Row, spec: MetricSpec): PerfStat {
	const v = (key: string) => {
		const n = numOrNull(r[`${spec.col}_${key}`]);
		return n === null ? null : round(n, 2);
	};
	return { p10: v("p10"), p50: v("p50"), p90: v("p90"), p99: v("p99"), avg: v("avg"), n: num(r[`${spec.col}_n`]) };
}

function stats(r: Row, specs: readonly MetricSpec[]): Record<string, PerfStat> {
	return Object.fromEntries(specs.map((s) => [s.key, statOf(r, s)]));
}

/** Only the filters that exist on server rows (no player: no dev, new/returning or variant). */
export function serverFilters(f: NormalizedFilters, from = f.from, to = f.to): NormalizedFilters {
	return {
		from,
		to,
		...(f.branch ? { branch: f.branch } : {}),
		...(f.art ? { art: f.art } : {}),
		...(f.channel ? { channel: f.channel } : {}),
		...(f.sexp ? { sexp: f.sexp } : {}),
		...(f.place !== undefined ? { place: f.place } : {}),
	};
}

function groupSql(by: PerfGroupBy): string {
	switch (by) {
		case "none":
			return "'all'";
		case "dev":
			return "COALESCE(NULLIF(e.dev, ''), 'unknown')";
		case "input":
			return "COALESCE(NULLIF(dv.input, ''), 'unknown')";
		case "screen":
			return screenBucketSql("dv.w", "dv.h");
		case "branch":
			return "COALESCE(NULLIF(e.branch, ''), '(none)')";
		case "art":
			return "COALESCE(NULLIF(e.art, ''), '(none)')";
	}
}

/** The client sample CTEs (`dv` when the group needs the device row, then `x`) for [from, to). */
function clientCtes(ctx: QueryContext, f: NormalizedFilters, groupExpr: string, needsDevice: boolean): string {
	const d = ctx.dialect;
	const dv = needsDevice
		? `dv AS (SELECT e.sid AS sid, MAX(${d.jsonText("e.props", "input")}) AS input, MAX(${d.jsonNumber("e.props", "w")}) AS w, MAX(${d.jsonNumber("e.props", "h")}) AS h ` +
			`FROM ${ctx.table("events", f.from - DEVICE_LOOKBACK_MS, f.to)} e WHERE e.t >= ${int(f.from - DEVICE_LOOKBACK_MS)} AND e.t < ${int(f.to)} ` +
			`AND e.kind = 'session' AND e.name = 'device' AND e.sid IS NOT NULL AND e.sid <> '' GROUP BY e.sid), `
		: "";
	return (
		dv +
		`x AS (SELECT r.t AS t, r.sid AS sid, r.pid AS pid, r.seq AS seq, r.g AS g, ${CLIENT_METRICS.map(cleanSql).join(", ")} FROM (` +
		`SELECT e.t AS t, e.sid AS sid, e.pid AS pid, e.seq AS seq, ${groupExpr} AS g, ${CLIENT_METRICS.map((m) => rawSql(ctx, m)).join(", ")} ` +
		`FROM ${ctx.table("events", f.from, f.to)} e${needsDevice ? " LEFT JOIN dv ON dv.sid = e.sid" : ""} ` +
		`WHERE ${where(f, ctx)} AND e.kind = 'tech' AND e.name = 'client') r)`
	);
}

/** The server sample CTE `x` for [from, to). */
function serverCtes(ctx: QueryContext, f: NormalizedFilters, groupExpr: string): string {
	const players = { col: "players", prop: "players", max: 1000 };
	return (
		`x AS (SELECT r.t AS t, r.job AS job, r.seq AS seq, r.g AS g, ${[...SERVER_METRICS, players].map(cleanSql).join(", ")} FROM (` +
		`SELECT e.t AS t, e.job AS job, e.seq AS seq, ${groupExpr} AS g, ${[...SERVER_METRICS, players].map((m) => rawSql(ctx, m)).join(", ")} ` +
		`FROM ${ctx.table("events", f.from, f.to)} e WHERE ${whereSql(f, ctx.dialect, { prefix: "e." })} AND e.kind = 'tech' AND e.name = 'server') r)`
	);
}

// Series (perf-client, perf-server) -------------------------------------------------------------------------------------

export interface PerfSeriesOptions {
	by: PerfGroupBy;
	/** About this many time buckets (10-400); the size snaps to BUCKET_STEPS_MS. Default: the step follows the window. */
	buckets?: number;
	/** Or an exact bucket size in minutes (1-1440); wins over buckets. */
	bucketMinutes?: number;
	/** Groups kept (busiest first), 1-20, default 8. */
	maxGroups: number;
}

export interface PerfGroup {
	key: string;
	samples: number;
	/** Client: sessions and players; server: servers (JobIds). */
	sessions?: number;
	players?: number;
	servers?: number;
	/** Highest deploy seq seen in the group (a build's seq). */
	seq: number | null;
	firstSeen: string | null;
	lastSeen: string | null;
	metrics: Record<string, PerfStat>;
}

export interface PerfPoint {
	/** Bucket start, unix ms. */
	t: number;
	key: string;
	samples: number;
	metrics: Record<string, PerfStat>;
	/** Server only: players summed over servers (each server's average in the bucket), and servers seen. */
	players?: number;
	servers?: number;
}

export interface PerfSeriesResult {
	side: "client" | "server";
	from: string;
	to: string;
	fromMs: number;
	toMs: number;
	bucketMs: number;
	by: PerfGroupBy;
	/** The metric keys, and which are better high. */
	metrics: { key: string; higherIsBetter: boolean }[];
	overall: PerfGroup;
	/** Busiest first (at most maxGroups); `groupsTotal` says how many there were. */
	groups: PerfGroup[];
	groupsTotal: number;
	/** Per bucket and kept group, oldest first. Buckets without samples are left out. */
	series: PerfPoint[];
}

function seriesOptions(allowed: readonly PerfGroupBy[]) {
	return (input: Partial<PerfSeriesOptions> = {}): PerfSeriesOptions => {
		const by = (input.by ?? "none") as PerfGroupBy;
		if (!allowed.includes(by)) throw new Error(`by must be one of ${allowed.join(", ")}`);
		const out: PerfSeriesOptions = { by, maxGroups: intOption(input.maxGroups, "maxGroups", 8, 1, 20) };
		if (input.buckets !== undefined) out.buckets = intOption(input.buckets, "buckets", 120, 10, 400);
		if (input.bucketMinutes !== undefined) out.bucketMinutes = intOption(input.bucketMinutes, "bucketMinutes", 15, 1, 1440);
		return out;
	};
}

function bucketMsOf(f: NormalizedFilters, o: PerfSeriesOptions): number {
	checkRange(f.from, f.to);
	const span = f.to - f.from;
	const ms = o.bucketMinutes !== undefined ? o.bucketMinutes * MINUTE_MS : o.buckets !== undefined ? bucketFor(span, o.buckets) : windowBucketMs(span);
	if ((f.to - f.from) / ms > 400) throw new Error("more than 400 buckets: use a larger bucketMinutes or a shorter range");
	return ms;
}

const bucketSql = (bucketMs: number, column = "x.t") => `CAST(floor(${column} / ${int(bucketMs)}.0) AS BIGINT)`;

function groupOf(r: Row, specs: readonly MetricSpec[], side: "client" | "server"): PerfGroup {
	const first = numOrNull(r.first_t);
	const last = numOrNull(r.last_t);
	return {
		key: str(r.g) || "all",
		samples: num(r.n),
		...(side === "client" ? { sessions: num(r.sessions), players: num(r.players) } : { servers: num(r.servers) }),
		seq: numOrNull(r.seq),
		firstSeen: first === null ? null : iso(first),
		lastSeen: last === null ? null : iso(last),
		metrics: stats(r, specs),
	};
}

function seriesShape(side: "client" | "server", specs: readonly MetricSpec[]) {
	return (rows: Record<string, Row[]>, _ctx: QueryContext, f: NormalizedFilters, o: PerfSeriesOptions): PerfSeriesResult => {
		const bucketMs = bucketMsOf(f, o);
		const overallRow = rows.overall[0] ?? {};
		const load = new Map((rows.load ?? []).map((r) => [`${num(r.b)}|${str(r.g)}`, r]));
		return {
			side,
			from: iso(f.from),
			to: iso(f.to),
			fromMs: f.from,
			toMs: f.to,
			bucketMs,
			by: o.by,
			metrics: specs.map((s) => ({ key: s.key, higherIsBetter: s.higher })),
			overall: { ...groupOf({ ...overallRow, g: "all" }, specs, side) },
			groups: rows.groups.map((r) => groupOf(r, specs, side)),
			groupsTotal: num(overallRow.ngroups),
			series: rows.series.map((r) => {
				const extra = load.get(`${num(r.b)}|${str(r.g)}`);
				return {
					t: num(r.b) * bucketMs,
					key: str(r.g) || "all",
					samples: num(r.n),
					metrics: stats(r, specs),
					...(side === "server" ? { players: round(num(extra?.players), 1), servers: num(extra?.servers) } : {}),
				};
			}),
		};
	};
}

export const perfClient = defineQuery<PerfSeriesOptions, PerfSeriesResult>({
	name: "perf-client",
	summary: "client fps, memory and ping over time (p10/p50/p90/p99, p90/p99 on the bad side) by device class, input, screen size, branch or build",
	defaultDays: 7,
	options: seriesOptions(CLIENT_GROUPS),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const bucketMs = bucketMsOf(f, o);
		const ctes = clientCtes(ctx, f, groupSql(o.by), o.by === "input" || o.by === "screen");
		const stat = statColumns(ctx, CLIENT_METRICS);
		const whole = "COUNT(*) AS n, COUNT(DISTINCT sid) AS sessions, COUNT(DISTINCT pid) AS players, MAX(seq) AS seq, MIN(t) AS first_t, MAX(t) AS last_t";
		return {
			overall: `WITH ${ctes} SELECT ${whole}, COUNT(DISTINCT g) AS ngroups, ${stat} FROM x ${lim(1)}`,
			groups: `WITH ${ctes} SELECT g, ${whole}, ${stat} FROM x GROUP BY g ORDER BY n DESC, g ${lim(o.maxGroups)}`,
			series:
				`WITH ${ctes}, top AS (SELECT g FROM x GROUP BY g ORDER BY COUNT(*) DESC, g ${lim(o.maxGroups)}) ` +
				`SELECT ${bucketSql(bucketMs)} AS b, x.g AS g, COUNT(*) AS n, ${statColumns(ctx, CLIENT_METRICS, "x.")} FROM x JOIN top ON top.g = x.g ` +
				`GROUP BY ${bucketSql(bucketMs)}, x.g ORDER BY b, g ${lim(10_000)}`,
		};
	},
	shape: seriesShape("client", CLIENT_METRICS),
});

export const perfServer = defineQuery<PerfSeriesOptions, PerfSeriesResult>({
	name: "perf-server",
	summary: "server TPS (Heartbeat rate), physics FPS, memory and players over time (p10/p50/p90/p99, p90/p99 on the bad side) by branch or build",
	defaultDays: 7,
	options: seriesOptions(SERVER_GROUPS),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const bucketMs = bucketMsOf(f, o);
		const ctes = serverCtes(ctx, serverFilters(f), groupSql(o.by));
		const stat = statColumns(ctx, SERVER_METRICS);
		const whole = "COUNT(*) AS n, COUNT(DISTINCT job) AS servers, MAX(seq) AS seq, MIN(t) AS first_t, MAX(t) AS last_t";
		const top = `top AS (SELECT g FROM x GROUP BY g ORDER BY COUNT(*) DESC, g ${lim(o.maxGroups)})`;
		return {
			overall: `WITH ${ctes} SELECT ${whole}, COUNT(DISTINCT g) AS ngroups, ${stat} FROM x ${lim(1)}`,
			groups: `WITH ${ctes} SELECT g, ${whole}, ${stat} FROM x GROUP BY g ORDER BY n DESC, g ${lim(o.maxGroups)}`,
			series:
				`WITH ${ctes}, ${top} SELECT ${bucketSql(bucketMs)} AS b, x.g AS g, COUNT(*) AS n, ${statColumns(ctx, SERVER_METRICS, "x.")} FROM x JOIN top ON top.g = x.g ` +
				`GROUP BY ${bucketSql(bucketMs)}, x.g ORDER BY b, g ${lim(10_000)}`,
			// Players at a moment = each server's average in the bucket, summed over servers.
			load:
				`WITH ${ctes}, ${top}, pj AS (SELECT ${bucketSql(bucketMs)} AS b, x.g AS g, x.job AS job, AVG(x.players) AS p FROM x JOIN top ON top.g = x.g ` +
				`GROUP BY ${bucketSql(bucketMs)}, x.g, x.job) SELECT b, g, SUM(p) AS players, COUNT(*) AS servers FROM pj GROUP BY b, g ORDER BY b, g ${lim(10_000)}`,
		};
	},
	shape: seriesShape("server", SERVER_METRICS),
});

// Compare (perf-compare) ------------------------------------------------------------------------------------------------

export interface PerfCompareOptions {
	/** "builds": these builds side by side in the range; "around": before vs after `at` over two equal windows. */
	mode: "builds" | "around";
	/** builds: artifact ids (at most 6). Default: the 4 busiest builds in the range. */
	arts?: string[];
	/** around: the moment (unix ms), e.g. a deploy mark's time. */
	at?: number;
	/** around: each window's length in hours (1-168, default 24), shortened to the time since `at` when that is less. */
	hours: number;
}

export interface ComparePeriod {
	/** The build id (builds) or "before" / "after" (around). */
	key: string;
	from: string;
	to: string;
	client: { samples: number; sessions: number; players: number; metrics: Record<string, PerfStat> };
	server: { samples: number; servers: number; avgPlayers: number | null; metrics: Record<string, PerfStat> };
	/** builds: the highest seq seen for the build. */
	seq?: number | null;
}

export interface PerfCompareResult {
	mode: "builds" | "around";
	/** around: the moment and each window's length (equal on both sides). */
	at?: string;
	atMs?: number;
	windowMs?: number;
	clientMetrics: { key: string; higherIsBetter: boolean }[];
	serverMetrics: { key: string; higherIsBetter: boolean }[];
	periods: ComparePeriod[];
}

/** Each window of "around": at most `hours`, at most the time since `at`; at least 5 minutes. */
export function aroundWindow(at: number, hours: number, now: number): number {
	const w = Math.min(hours * HOUR_MS, Math.floor((now - at) / MINUTE_MS) * MINUTE_MS);
	if (w < 5 * MINUTE_MS) throw new Error("at least 5 minutes must have passed since `at` to compare before and after");
	return w;
}

const MAX_COMPARE_BUILDS = 6;
const DEFAULT_COMPARE_BUILDS = 4;

export const perfCompare = defineQuery<PerfCompareOptions, PerfCompareResult>({
	name: "perf-compare",
	summary: "client and server performance (p10/p50/p90/p99) for builds side by side, or before vs after a moment (a deploy) over equal windows",
	defaultDays: 7,
	options: (input = {}) => {
		const mode = input.mode ?? "builds";
		if (mode !== "builds" && mode !== "around") throw new Error('mode must be "builds" or "around"');
		const out: PerfCompareOptions = { mode, hours: intOption(input.hours, "hours", 24, 1, 168) };
		if (input.arts !== undefined) {
			if (!Array.isArray(input.arts) || input.arts.length > MAX_COMPARE_BUILDS) throw new Error(`arts must be a list of at most ${MAX_COMPARE_BUILDS} artifact ids`);
			for (const a of input.arts) if (typeof a !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(a)) throw new Error("arts must be artifact ids (letters, digits, _ . -)");
			if (input.arts.length) out.arts = [...new Set(input.arts)];
		}
		if (mode === "around") {
			const at = typeof input.at === "string" ? Date.parse(input.at) : input.at;
			if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) throw new Error("around needs at (unix ms or an ISO time)");
			out.at = at;
		} else if (input.at !== undefined) throw new Error("at belongs to mode around");
		return out;
	},
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		let range: NormalizedFilters;
		let groupExpr: string;
		if (o.mode === "around") {
			const at = o.at as number;
			const w = aroundWindow(at, o.hours, ctx.now);
			// Before vs after spans builds: the art filter doesn't apply here.
			const { art: _art, ...rest } = f;
			range = { ...rest, from: at - w, to: at + w };
			groupExpr = `CASE WHEN e.t < ${int(at)} THEN 'before' ELSE 'after' END`;
		} else {
			checkRange(f.from, f.to);
			range = o.arts ? { ...f, art: o.arts } : f;
			groupExpr = groupSql("art");
		}
		const client = clientCtes(ctx, range, groupExpr, false).replace(/^x AS/, "c AS");
		const server = serverCtes(ctx, serverFilters(range), groupExpr).replace(/^x AS/, "s AS");
		// Default builds: the busiest in the range, by client and server samples together.
		const top =
			o.mode === "builds" && !o.arts
				? `, top AS (SELECT g FROM (SELECT g FROM c UNION ALL SELECT g FROM s) u GROUP BY g ORDER BY COUNT(*) DESC, g ${lim(DEFAULT_COMPARE_BUILDS)})`
				: "";
		const join = (alias: string) => (top ? ` JOIN top ON top.g = ${alias}.g` : "");
		return {
			client:
				`WITH ${client}${top ? `, ${server}${top}` : ""} SELECT c.g AS g, COUNT(*) AS n, COUNT(DISTINCT c.sid) AS sessions, COUNT(DISTINCT c.pid) AS players, MAX(c.seq) AS seq, ` +
				`MIN(c.t) AS first_t, MAX(c.t) AS last_t, ${statColumns(ctx, CLIENT_METRICS, "c.")} FROM c${join("c")} GROUP BY c.g ORDER BY c.g ${lim(MAX_COMPARE_BUILDS + 2)}`,
			server:
				`WITH ${server}${top ? `, ${client}${top}` : ""} SELECT s.g AS g, COUNT(*) AS n, COUNT(DISTINCT s.job) AS servers, AVG(s.players) AS avg_players, MAX(s.seq) AS seq, ` +
				`MIN(s.t) AS first_t, MAX(s.t) AS last_t, ${statColumns(ctx, SERVER_METRICS, "s.")} FROM s${join("s")} GROUP BY s.g ORDER BY s.g ${lim(MAX_COMPARE_BUILDS + 2)}`,
		};
	},
	shape(rows, ctx, f, o) {
		const byKey = new Map<string, { c?: Row; s?: Row }>();
		for (const r of rows.client) byKey.set(str(r.g), { ...byKey.get(str(r.g)), c: r });
		for (const r of rows.server) byKey.set(str(r.g), { ...byKey.get(str(r.g)), s: r });
		let keys: string[];
		let window: { at: number; w: number } | undefined;
		if (o.mode === "around") {
			window = { at: o.at as number, w: aroundWindow(o.at as number, o.hours, ctx.now) };
			keys = ["before", "after"];
		} else {
			// The order asked for; by default newest build (highest seq) first.
			keys = o.arts ?? [...byKey.keys()].sort((a, b) => seqOf(byKey.get(b)) - seqOf(byKey.get(a)) || a.localeCompare(b));
		}
		const periods = keys.map((key): ComparePeriod => {
			const { c = {}, s = {} } = byKey.get(key) ?? {};
			const span = (r: Row) => [numOrNull(r.first_t), numOrNull(r.last_t)] as const;
			let from: number;
			let to: number;
			if (window) {
				from = key === "before" ? window.at - window.w : window.at;
				to = key === "before" ? window.at : window.at + window.w;
			} else {
				const times = [...span(c), ...span(s)].filter((t): t is number => t !== null);
				from = times.length ? Math.min(...times) : f.from;
				to = times.length ? Math.max(...times) : f.to;
			}
			const avgPlayers = numOrNull(s.avg_players);
			return {
				key,
				from: iso(from),
				to: iso(to),
				client: { samples: num(c.n), sessions: num(c.sessions), players: num(c.players), metrics: stats(c, CLIENT_METRICS) },
				server: { samples: num(s.n), servers: num(s.servers), avgPlayers: avgPlayers === null ? null : round(avgPlayers, 1), metrics: stats(s, SERVER_METRICS) },
				...(o.mode === "builds" ? { seq: numOrNull(c.seq) ?? numOrNull(s.seq) } : {}),
			};
		});
		return {
			mode: o.mode,
			...(window ? { at: iso(window.at), atMs: window.at, windowMs: window.w } : {}),
			clientMetrics: CLIENT_METRICS.map((m) => ({ key: m.key, higherIsBetter: m.higher })),
			serverMetrics: SERVER_METRICS.map((m) => ({ key: m.key, higherIsBetter: m.higher })),
			periods,
		};
	},
});

function seqOf(entry: { c?: Row; s?: Row } | undefined): number {
	return num(entry?.c?.seq ?? entry?.s?.seq);
}
