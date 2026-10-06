/**
 * Node graphs: one player's (all their sessions, or one with `sid`) and the merged flow graph for a filter. Per
 * session, consecutive events with the same state collapse into one visit; each visit's next visit is an edge, the
 * first visit hangs off `(start)`, and the last one leads to `(left)` once the session is over.
 *
 * Each node also says what happened there: its busiest event names (custom, purchase and currency rows; top 5) and
 * the funnel steps reached in it. With `moments`, key moments (funnel steps, purchases, and the `momentNames` events,
 * by default personal_best and round_end) become small nodes on the path, ids starting with "@". A one-session graph
 * also returns the path in order.
 */
import { Graph, LEFT, START, buildGraph, type NodeEventRow, type NodeStepRow, type PathRow } from "../graph.ts";
import { PROP_KEYS } from "../schema.ts";
import { assertSafeKey, lit } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { ENDED_AFTER_MS, checkPid, defineQuery, eventsTable, int, intOption, num, numOrNull, stateExpr, str, strOrNull, where, type QueryContext } from "./core.ts";

export type Facet = "all" | "zone" | "screen" | "activity" | (string & {});

export interface GraphOptions {
	/** Which part of the state is a node: all of it (default) or one key, e.g. zone. */
	facet: Facet;
	/** Drop edges taken fewer times than this. */
	minCount: number;
	/** Keep at most this many edges (busiest first). */
	maxEdges: number;
	/** Key moments as their own small nodes on the path (default false). */
	moments: boolean;
	/** Event names that are moments, besides funnel steps and purchases (default personal_best, round_end). */
	momentNames: string[];
	/** Per node: top events and funnel steps (default true). */
	details: boolean;
}

/** The kinds counted as "what happened" in a state (the rest are bookkeeping: session, tech, state, zone, ...). */
export const NODE_EVENT_KINDS = ["custom", "purchase", "currency"] as const;
export const DEFAULT_MOMENTS = ["personal_best", "round_end"];

/** The node of an event row: its state (or one part of it), or with moments a "@..." id for key moments. */
function nodeExpr(ctx: QueryContext, o: GraphOptions): string {
	const state = stateExpr("e.state", o.facet);
	if (!o.moments) return state;
	const d = ctx.dialect;
	const step = `COALESCE(${d.jsonText("e.props", PROP_KEYS.funnelLabel)}, CAST(CAST(${d.jsonNumber("e.props", PROP_KEYS.funnelStep)} AS BIGINT) AS VARCHAR), '?')`;
	const named = o.momentNames.length ? ` WHEN e.name IN (${o.momentNames.map(lit).join(", ")}) THEN '@' || e.name` : "";
	return (
		`CASE WHEN e.kind = 'funnel' THEN '@' || e.name || ': ' || ${step} ` +
		`WHEN e.kind = 'purchase' THEN '@purchase: ' || COALESCE(${d.jsonText("e.props", PROP_KEYS.purchaseProduct)}, e.name)${named} ELSE ${state} END`
	);
}

function graphStatements(ctx: QueryContext, f: NormalizedFilters, o: GraphOptions, who: { pid?: string; sid?: string } = {}): Record<string, string> {
	const lim = ctx.dialect.limit;
	const d = ctx.dialect;
	const table = eventsTable(ctx, f);
	const whoCond = (who.pid ? ` AND e.pid = ${lit(who.pid)}` : " AND e.pid IS NOT NULL AND e.pid <> ''") + (who.sid ? ` AND e.sid = ${lit(who.sid)}` : "");
	const rows = `${where(f, ctx)} AND e.sid IS NOT NULL AND e.sid <> ''${whoCond}`;
	const base =
		`ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, ${nodeExpr(ctx, o)} AS st FROM ${table} e WHERE ${rows}), ` +
		`se AS (SELECT sid, MIN(pid) AS pid, MAX(t) AS end_t FROM ev GROUP BY sid), ` +
		`x AS (SELECT sid, t, st, LAG(st) OVER (PARTITION BY sid ORDER BY t) AS prev FROM ev WHERE st IS NOT NULL), ` +
		`v AS (SELECT sid, t AS enter_t, st FROM x WHERE prev IS NULL OR prev <> st)`;
	const visits =
		`vis AS (SELECT sid, st, enter_t, LEAD(st) OVER (PARTITION BY sid ORDER BY enter_t) AS nxt, ` +
		`LEAD(enter_t) OVER (PARTITION BY sid ORDER BY enter_t) AS nxt_t, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY enter_t) AS rn FROM v), ` +
		`m AS (SELECT sid, ${lit(START)} AS src, st AS dst, CAST(0 AS BIGINT) AS dwell FROM vis WHERE rn = 1 ` +
		`UNION ALL SELECT sid, st AS src, nxt AS dst, nxt_t - enter_t AS dwell FROM vis WHERE nxt IS NOT NULL ` +
		`UNION ALL SELECT vis.sid AS sid, vis.st AS src, ${lit(LEFT)} AS dst, se.end_t - vis.enter_t AS dwell FROM vis JOIN se ON se.sid = vis.sid ` +
		`WHERE vis.nxt IS NULL AND se.end_t < ${int(ctx.now - ENDED_AFTER_MS)})`;
	const statements: Record<string, string> = {
		edges:
			`WITH ${base}, ${visits} SELECT m.src AS src, m.dst AS dst, COUNT(*) AS n, COUNT(DISTINCT se.pid) AS players, SUM(m.dwell) AS dwell_ms ` +
			`FROM m JOIN se ON se.sid = m.sid GROUP BY m.src, m.dst ORDER BY n DESC, src, dst ${lim(10_000)}`,
		nodes:
			`WITH ${base} SELECT v.st AS st, COUNT(*) AS visits, COUNT(DISTINCT se.pid) AS players FROM v JOIN se ON se.sid = v.sid ` +
			`GROUP BY v.st ORDER BY visits DESC, st ${lim(10_000)}`,
	};
	if (o.details) {
		// What happened in each state: the state after each event (moments mode doesn't move these).
		const inState = `SELECT ${stateExpr("e.state", o.facet)} AS st, e.kind AS kind, e.name AS name, e.pid AS pid, e.props AS props FROM ${table} e WHERE ${rows}`;
		statements.nodeEvents =
			`WITH ne AS (${inState} AND e.kind IN (${NODE_EVENT_KINDS.map(lit).join(", ")})) ` +
			`SELECT st, kind, name, COUNT(*) AS n FROM ne WHERE st IS NOT NULL GROUP BY st, kind, name ORDER BY n DESC, st, name ${lim(10_000)}`;
		statements.nodeSteps =
			`WITH ns AS (SELECT st, name AS funnel, ${d.jsonText("props", PROP_KEYS.funnelLabel)} AS label, ${d.jsonNumber("props", PROP_KEYS.funnelStep)} AS i, pid ` +
			`FROM (${inState} AND e.kind = 'funnel') q) ` +
			`SELECT st, funnel, label, MIN(i) AS i, COUNT(*) AS n, COUNT(DISTINCT pid) AS players FROM ns WHERE st IS NOT NULL ` +
			`GROUP BY st, funnel, label ORDER BY st, funnel, i ${lim(10_000)}`;
	}
	if (who.sid) {
		statements.path =
			`WITH ${base}, ${visits} SELECT vis.rn AS rn, vis.st AS st, vis.enter_t AS t0, COALESCE(vis.nxt_t, se.end_t) AS t1, ` +
			`CASE WHEN vis.nxt IS NULL AND se.end_t < ${int(ctx.now - ENDED_AFTER_MS)} THEN 1 ELSE 0 END AS left_after ` +
			`FROM vis JOIN se ON se.sid = vis.sid ORDER BY vis.rn ${lim(10_000)}`;
	}
	return statements;
}

function graphOptions(input: Partial<GraphOptions> = {}, defaults: { minCount: number; maxEdges: number }): GraphOptions {
	const facet = input.facet ?? "all";
	stateExpr("e.state", facet); // validates
	const momentNames = input.momentNames ?? DEFAULT_MOMENTS;
	if (!Array.isArray(momentNames) || momentNames.length > 20) throw new Error("momentNames must be a list of at most 20 event names");
	return {
		facet,
		minCount: intOption(input.minCount, "minCount", defaults.minCount, 1, 1_000_000),
		maxEdges: intOption(input.maxEdges, "maxEdges", defaults.maxEdges, 1, 10_000),
		moments: input.moments === true,
		momentNames: momentNames.map((n) => assertSafeKey(String(n), "momentNames")),
		details: input.details !== false,
	};
}

function shapeGraph(rows: Record<string, Record<string, unknown>[]>, kind: "player" | "flow", o: GraphOptions, who: { pid?: string; sid?: string } = {}): Graph {
	const nodeEvents: NodeEventRow[] | undefined = rows.nodeEvents?.map((r) => ({ st: str(r.st), kind: str(r.kind), name: str(r.name), n: num(r.n) }));
	const nodeSteps: NodeStepRow[] | undefined = rows.nodeSteps?.map((r) => ({
		st: str(r.st),
		funnel: str(r.funnel),
		label: strOrNull(r.label),
		i: numOrNull(r.i),
		n: num(r.n),
		players: num(r.players),
	}));
	const path: PathRow[] | undefined = rows.path?.map((r) => ({ rn: num(r.rn), st: str(r.st), t0: num(r.t0), t1: num(r.t1), left: num(r.left_after) === 1 }));
	return buildGraph({
		kind,
		facet: o.facet,
		...(who.pid !== undefined ? { pid: who.pid } : {}),
		...(who.sid !== undefined ? { sid: who.sid } : {}),
		minCount: o.minCount,
		maxEdges: o.maxEdges,
		moments: o.moments,
		edges: rows.edges.map((r) => ({ src: str(r.src), dst: str(r.dst), n: num(r.n), players: num(r.players), dwell_ms: num(r.dwell_ms) })),
		nodes: rows.nodes.map((r) => ({ st: str(r.st), visits: num(r.visits), players: num(r.players) })),
		...(nodeEvents ? { nodeEvents } : {}),
		...(nodeSteps ? { nodeSteps } : {}),
		...(path ? { path } : {}),
	});
}

export type PlayerGraphOptions = GraphOptions & { pid: string; sid?: string };

/** A session id for SQL (the framework's are hex GUIDs). */
function checkSid(sid: unknown): string {
	if (typeof sid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(sid)) throw new Error("sid must be 1-64 characters of letters, digits, _ or -");
	return sid;
}

export const playerGraph = defineQuery<PlayerGraphOptions, Graph>({
	name: "player-graph",
	summary: "one player's node graph over all their sessions or one (sid): states as nodes, moves as edges, what happened in each",
	defaultDays: 90,
	options: (input = {}) => {
		const out: PlayerGraphOptions = { ...graphOptions(input, { minCount: 1, maxEdges: 200 }), pid: checkPid(input.pid) };
		if (input.sid !== undefined && input.sid !== "") out.sid = checkSid(input.sid);
		return out;
	},
	statements: (ctx, f, o) => graphStatements(ctx, f, o, { pid: o.pid, ...(o.sid ? { sid: o.sid } : {}) }),
	shape: (rows, _ctx, _f, o) => shapeGraph(rows, "player", o, { pid: o.pid, ...(o.sid ? { sid: o.sid } : {}) }),
});

export const flow = defineQuery<GraphOptions, Graph>({
	name: "flow",
	summary: "the merged flow graph of every player matching the filters (where most go next, where they quit)",
	defaultDays: 7,
	options: (input = {}) => graphOptions(input, { minCount: 2, maxEdges: 200 }),
	statements: (ctx, f, o) => graphStatements(ctx, f, o),
	shape: (rows, _ctx, _f, o) => shapeGraph(rows, "flow", o),
});
