/**
 * First-session confusion signals, per zone and per button (plans/16 section 3).
 *   From events (always): early leaves (per last zone), screens opened and closed over and over, walking back and
 *   forth between two zones.
 *   From recordings (when the tt-rec-1 decoder exists): standing still, spinning the camera without getting anywhere,
 *   pressing the same button again and again.
 */
import {
	decodeSessions,
	detectSignals,
	hasDecoder,
	RecordingCodecUnavailable,
	type ChunkRow,
	type DetectorOptions,
	type ZoneTimeline,
} from "../recording.ts";
import { whereSql } from "../sql/filters.ts";
import { ENDED_AFTER_MS, defineQuery, eventsTable, int, intOption, num, playerRows, ratio, round, stateExpr, str, strOrNull } from "./core.ts";

export interface ConfusionOptions extends DetectorOptions {
	/** A first session shorter than this is an early leave. Default 120 s. */
	earlyLeaveSeconds: number;
	/** Opening the same screen this many times in one session is a loop. Default 3. */
	loopMin: number;
	/** This many moves between the same two zones in one session is back-and-forth. Default 3 (A→B→A→B). */
	backForthMin: number;
	/** Most recording chunks to read (decoding happens here). Default 5000. */
	maxChunks: number;
}

export interface RecordingSignals {
	available: boolean;
	/** Why recordings weren't used (no decoder yet, nothing recorded). */
	reason?: string;
	sessions?: number;
	idle?: { zone: string; count: number; avgSeconds: number }[];
	cameraSpin?: { zone: string; count: number }[];
	repeatedClicks?: { button: string; count: number; avgPresses: number }[];
}

export interface ConfusionResult {
	firstSessions: number;
	players: number;
	/** Per zone the first session ended in: how many ended there, and how many of those were early leaves. */
	earlyLeave: { zone: string; sessions: number; early: number; share: number }[];
	/** Per screen: sessions that opened it, and sessions that opened it loopMin+ times. */
	screenLoops: { screen: string; sessions: number; loopSessions: number; share: number; opens: number }[];
	/** Per zone pair: sessions that moved between them, and sessions with backForthMin+ moves. */
	backAndForth: { a: string; b: string; sessions: number; flagged: number; share: number }[];
	recordings: RecordingSignals;
}

const firstSession = "e.newp = TRUE";

export const confusion = defineQuery<ConfusionOptions, ConfusionResult>({
	name: "confusion",
	summary: "first-session confusion signals per zone and button (early leaves, screen loops, back-and-forth, idle, camera spins, repeated clicks)",
	defaultDays: 14,
	options: (input = {}) => ({
		...input,
		earlyLeaveSeconds: intOption(input.earlyLeaveSeconds, "earlyLeaveSeconds", 120, 5, 3600),
		loopMin: intOption(input.loopMin, "loopMin", 3, 2, 100),
		backForthMin: intOption(input.backForthMin, "backForthMin", 3, 2, 100),
		maxChunks: intOption(input.maxChunks, "maxChunks", 5000, 0, 1_000_000),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const table = eventsTable(ctx, f);
		const cond = playerRows(f, ctx, firstSession);
		const zone = stateExpr("e.state", "zone");
		const screen = stateExpr("e.state", "screen");
		return {
			sessions: `SELECT COUNT(DISTINCT e.sid) AS sessions, COUNT(DISTINCT e.pid) AS players FROM ${table} e WHERE ${cond} ${lim(1)}`,
			early:
				`WITH ev AS (SELECT e.sid AS sid, e.t AS t, ${zone} AS zone FROM ${table} e WHERE ${cond}), ` +
				`s AS (SELECT sid, MIN(t) AS t0, MAX(t) AS t1 FROM ev GROUP BY sid), ` +
				`lz AS (SELECT sid, zone FROM (SELECT sid, zone, ROW_NUMBER() OVER (PARTITION BY sid ORDER BY t DESC) AS rn FROM ev WHERE zone IS NOT NULL) z WHERE rn = 1), ` +
				`j AS (SELECT COALESCE(lz.zone, '(none)') AS zone, s.t1 - s.t0 AS len FROM s LEFT JOIN lz ON lz.sid = s.sid WHERE s.t1 < ${int(ctx.now - ENDED_AFTER_MS)}) ` +
				`SELECT zone, COUNT(*) AS sessions, SUM(CASE WHEN len < ${int(o.earlyLeaveSeconds * 1000)} THEN 1 ELSE 0 END) AS early FROM j GROUP BY zone ORDER BY early DESC, zone ${lim(1000)}`,
			loops:
				`WITH ev AS (SELECT e.sid AS sid, e.t AS t, ${screen} AS scr FROM ${table} e WHERE ${cond} AND e.state IS NOT NULL), ` +
				`x AS (SELECT sid, t, scr, LAG(scr) OVER (PARTITION BY sid ORDER BY t) AS prev FROM ev), ` +
				`per AS (SELECT sid, scr, COUNT(*) AS opens FROM x WHERE scr IS NOT NULL AND (prev IS NULL OR prev <> scr) GROUP BY sid, scr) ` +
				`SELECT scr AS screen, COUNT(*) AS sessions, SUM(CASE WHEN opens >= ${int(o.loopMin)} THEN 1 ELSE 0 END) AS loop_sessions, SUM(opens) AS opens ` +
				`FROM per GROUP BY scr ORDER BY loop_sessions DESC, screen ${lim(1000)}`,
			backforth:
				`WITH ev AS (SELECT e.sid AS sid, e.t AS t, ${zone} AS zone FROM ${table} e WHERE ${cond} AND e.state IS NOT NULL), ` +
				`x AS (SELECT sid, t, zone, LAG(zone) OVER (PARTITION BY sid ORDER BY t) AS prev FROM ev WHERE zone IS NOT NULL), ` +
				`mv AS (SELECT sid, CASE WHEN prev < zone THEN prev ELSE zone END AS a, CASE WHEN prev < zone THEN zone ELSE prev END AS b FROM x WHERE prev IS NOT NULL AND prev <> zone), ` +
				`per AS (SELECT sid, a, b, COUNT(*) AS moves FROM mv GROUP BY sid, a, b) ` +
				`SELECT a, b, COUNT(*) AS sessions, SUM(CASE WHEN moves >= ${int(o.backForthMin)} THEN 1 ELSE 0 END) AS flagged FROM per GROUP BY a, b ` +
				`ORDER BY flagged DESC, a, b ${lim(1000)}`,
		};
	},
	shape(rows) {
		const first = rows.sessions[0] ?? {};
		return {
			firstSessions: num(first.sessions),
			players: num(first.players),
			earlyLeave: rows.early.map((r) => ({ zone: str(r.zone), sessions: num(r.sessions), early: num(r.early), share: ratio(num(r.early), num(r.sessions)) })),
			screenLoops: rows.loops.map((r) => ({
				screen: str(r.screen),
				sessions: num(r.sessions),
				loopSessions: num(r.loop_sessions),
				share: ratio(num(r.loop_sessions), num(r.sessions)),
				opens: num(r.opens),
			})),
			backAndForth: rows.backforth.map((r) => ({ a: str(r.a), b: str(r.b), sessions: num(r.sessions), flagged: num(r.flagged), share: ratio(num(r.flagged), num(r.sessions)) })),
			recordings: { available: false, reason: "not read yet" },
		};
	},
	async finish(result, ctx, f, o, run) {
		if (o.maxChunks === 0) return { ...result, recordings: { available: false, reason: "maxChunks is 0" } };
		if (!hasDecoder("tt-rec-1")) {
			return { ...result, recordings: { available: false, reason: "the tt-rec-1 decoder isn't written yet (TODO: framework/src/analytics/SCHEMA.md)" } };
		}
		const lim = ctx.dialect.limit;
		const table = eventsTable(ctx, f);
		const cond = playerRows(f, ctx, firstSession);
		const sids = `SELECT DISTINCT e.sid FROM ${table} e WHERE ${cond}`;
		const zone = stateExpr("e.state", "zone");
		const rows = await run({
			chunks:
				`SELECT r.sid AS sid, r.pid AS pid, r.chunk AS chunk, r.codec AS codec, r.data AS data, r.n AS n, r.t AS t FROM ${ctx.table("recordings", f.from, f.to)} r ` +
				`WHERE ${whereSql(f, ctx.dialect, { prefix: "r.", recordings: true })} AND r.sid IN (${sids}) ORDER BY r.sid, r.chunk ${lim(o.maxChunks)}`,
			zones:
				`WITH ev AS (SELECT e.sid AS sid, e.t AS t, ${zone} AS zone FROM ${table} e WHERE ${cond} AND e.state IS NOT NULL), ` +
				`x AS (SELECT sid, t, zone, LAG(zone) OVER (PARTITION BY sid ORDER BY t) AS prev FROM ev) ` +
				`SELECT sid, t, zone FROM x WHERE (prev IS NULL AND zone IS NOT NULL) OR (prev IS NOT NULL AND zone IS NULL) OR prev <> zone ` +
				`ORDER BY sid, t ${lim(200_000)}`,
		});
		if (rows.chunks.length === 0) return { ...result, recordings: { available: false, reason: "no recordings in this range" } };
		const chunks: ChunkRow[] = rows.chunks.map((r) => ({ sid: str(r.sid), pid: str(r.pid), chunk: num(r.chunk), codec: str(r.codec) as ChunkRow["codec"], data: str(r.data), n: num(r.n), t: num(r.t) }));
		const zones = new Map<string, ZoneTimeline>();
		for (const r of rows.zones) {
			const list = zones.get(str(r.sid)) ?? [];
			list.push({ t: num(r.t), zone: strOrNull(r.zone) });
			zones.set(str(r.sid), list);
		}
		let decoded;
		try {
			decoded = decodeSessions(chunks);
		} catch (error) {
			if (error instanceof RecordingCodecUnavailable) return { ...result, recordings: { available: false, reason: error.message } };
			throw error;
		}
		const idle = new Map<string, { count: number; ms: number }>();
		const spin = new Map<string, number>();
		const clicks = new Map<string, { count: number; presses: number }>();
		for (const rec of decoded) {
			for (const s of detectSignals(rec, zones.get(rec.sid), o)) {
				const zoneName = s.zone ?? "(unknown)";
				if (s.kind === "idle") {
					const e = idle.get(zoneName) ?? { count: 0, ms: 0 };
					e.count++;
					e.ms += s.amount;
					idle.set(zoneName, e);
				} else if (s.kind === "camera_spin") {
					spin.set(zoneName, (spin.get(zoneName) ?? 0) + 1);
				} else {
					const key = s.target ?? "(unknown)";
					const e = clicks.get(key) ?? { count: 0, presses: 0 };
					e.count++;
					e.presses += s.amount;
					clicks.set(key, e);
				}
			}
		}
		const byCount = <T extends { count: number }>(a: T, b: T) => b.count - a.count;
		return {
			...result,
			recordings: {
				available: true,
				sessions: decoded.length,
				idle: [...idle].map(([zone, e]) => ({ zone, count: e.count, avgSeconds: round(e.ms / e.count / 1000, 1) })).sort(byCount),
				cameraSpin: [...spin].map(([zone, count]) => ({ zone, count })).sort(byCount),
				repeatedClicks: [...clicks].map(([button, e]) => ({ button, count: e.count, avgPresses: round(e.presses / e.count, 1) })).sort(byCount),
			},
		};
	},
});
