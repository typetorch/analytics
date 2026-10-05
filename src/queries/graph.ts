/**
 * Node graphs: one player's (all their sessions) and the merged flow graph for a filter. Per session, consecutive
 * events with the same state collapse into one visit; each visit's next visit is an edge, the first visit hangs off
 * `(start)`, and the last one leads to `(left)` once the session is over.
 */
import { Graph, LEFT, START, buildGraph } from "../graph.ts";
import { lit } from "../sql/dialect.ts";
import type { NormalizedFilters } from "../sql/filters.ts";
import { ENDED_AFTER_MS, checkPid, defineQuery, eventsTable, int, intOption, num, stateExpr, str, where, type QueryContext } from "./core.ts";

export type Facet = "all" | "zone" | "screen" | "activity" | (string & {});

export interface GraphOptions {
	/** Which part of the state is a node: all of it (default) or one key, e.g. zone. */
	facet: Facet;
	/** Drop edges taken fewer times than this. */
	minCount: number;
	/** Keep at most this many edges (busiest first). */
	maxEdges: number;
}

function graphStatements(ctx: QueryContext, f: NormalizedFilters, o: GraphOptions, pid?: string): Record<string, string> {
	const lim = ctx.dialect.limit;
	const pidCond = pid ? ` AND e.pid = ${lit(pid)}` : " AND e.pid IS NOT NULL AND e.pid <> ''";
	const base =
		`ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, ${stateExpr("e.state", o.facet)} AS st FROM ${eventsTable(ctx, f)} e ` +
		`WHERE ${where(f, ctx)} AND e.sid IS NOT NULL AND e.sid <> ''${pidCond}), ` +
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
	return {
		edges:
			`WITH ${base}, ${visits} SELECT m.src AS src, m.dst AS dst, COUNT(*) AS n, COUNT(DISTINCT se.pid) AS players, SUM(m.dwell) AS dwell_ms ` +
			`FROM m JOIN se ON se.sid = m.sid GROUP BY m.src, m.dst ORDER BY n DESC, src, dst ${lim(10_000)}`,
		nodes:
			`WITH ${base} SELECT v.st AS st, COUNT(*) AS visits, COUNT(DISTINCT se.pid) AS players FROM v JOIN se ON se.sid = v.sid ` +
			`GROUP BY v.st ORDER BY visits DESC, st ${lim(10_000)}`,
	};
}

function graphOptions(input: Partial<GraphOptions> = {}, defaults: { minCount: number; maxEdges: number }): GraphOptions {
	const facet = input.facet ?? "all";
	stateExpr("e.state", facet); // validates
	return {
		facet,
		minCount: intOption(input.minCount, "minCount", defaults.minCount, 1, 1_000_000),
		maxEdges: intOption(input.maxEdges, "maxEdges", defaults.maxEdges, 1, 10_000),
	};
}

function shapeGraph(rows: Record<string, Record<string, unknown>[]>, kind: "player" | "flow", o: GraphOptions, pid?: string): Graph {
	return buildGraph({
		kind,
		facet: o.facet,
		...(pid !== undefined ? { pid } : {}),
		minCount: o.minCount,
		maxEdges: o.maxEdges,
		edges: rows.edges.map((r) => ({ src: str(r.src), dst: str(r.dst), n: num(r.n), players: num(r.players), dwell_ms: num(r.dwell_ms) })),
		nodes: rows.nodes.map((r) => ({ st: str(r.st), visits: num(r.visits), players: num(r.players) })),
	});
}

export type PlayerGraphOptions = GraphOptions & { pid: string };

export const playerGraph = defineQuery<PlayerGraphOptions, Graph>({
	name: "player-graph",
	summary: "one player's node graph over all their sessions (states as nodes, moves as edges)",
	defaultDays: 90,
	options: (input = {}) => ({ ...graphOptions(input, { minCount: 1, maxEdges: 200 }), pid: checkPid(input.pid) }),
	statements: (ctx, f, o) => graphStatements(ctx, f, o, o.pid),
	shape: (rows, _ctx, _f, o) => shapeGraph(rows, "player", o, o.pid),
});

export const flow = defineQuery<GraphOptions, Graph>({
	name: "flow",
	summary: "the merged flow graph of every player matching the filters (where most go next, where they quit)",
	defaultDays: 7,
	options: (input = {}) => graphOptions(input, { minCount: 2, maxEdges: 200 }),
	statements: (ctx, f, o) => graphStatements(ctx, f, o),
	shape: (rows, _ctx, _f, o) => shapeGraph(rows, "flow", o),
});
