/**
 * The numbers behind a Creator-Hub-style overview, from our own events:
 *   benchmarks — the headline metrics for the last N days and the N days before (period over period);
 *   realtime   — concurrent users from fleet heartbeats (hourly, N days), and session time, client errors per
 *                session, client fps and server memory for the last H hours vs the H hours before;
 *   trends     — per day, N-day moving averages of new users, daily active users, playtime per active user,
 *                Robux and D1 retention, in total and per join source (session/join `from`).
 * Days are UTC. Roblox's own Home / Search split isn't visible to games: those joins are `direct`.
 */
import { FLEET_HEARTBEAT, PROP_KEYS } from "../schema.ts";
import { DAY_MS, assertSafeKey } from "../sql/dialect.ts";
import { whereSql, type NormalizedFilters } from "../sql/filters.ts";
import { ENDED_AFTER_MS, SESSIONS_CTE, dayOf, defineQuery, int, intOption, iso, isoDay, num, numOrNull, playerRows, ratio, round, str, type QueryContext } from "./core.ts";

const HOUR_MS = 3_600_000;

interface Rate {
	rate: number;
	count: number;
	of: number;
}

const rate = (count: number, of: number): Rate => ({ rate: ratio(count, of), count, of });

/** Player events in [from, to) with the filters (time replaced). */
function playerEvents(ctx: QueryContext, f: NormalizedFilters, from: number, to: number, cols: string): string {
	const fr: NormalizedFilters = { ...f, from, to };
	return `SELECT ${cols} FROM ${ctx.table("events", from, to)} e WHERE ${playerRows(fr, ctx)}`;
}

// benchmarks -------------------------------------------------------------------------------------------------------

export interface BenchmarkOptions {
	/** Period length in days (default 7). */
	days: number;
	/** A session this long or longer is a qualified play (default 5 minutes). */
	qualifiedMinutes: number;
	robuxKey: string;
}

export interface BenchmarkPeriod {
	from: string;
	to: string;
	players: number;
	/** Daily active users, averaged over the period's days. */
	dau: number;
	/** Session time per daily active user (total playtime / player-days), minutes. */
	avgPlaytimeMinutes: number | null;
	/** New players back exactly 1 / 7 days after joining, counted on the return day (return days fully over). */
	d1Retention: Rate;
	d7Retention: Rate;
	payerConversion: Rate;
	/** Robux per paying user; null without payers. */
	arppu: number | null;
	robux: number;
	/** After-join play-through: first sessions (over) that lasted at least qualifiedMinutes. */
	playThrough: Rate & { minutes: number };
}

export interface BenchmarksResult {
	days: number;
	current: BenchmarkPeriod;
	previous: BenchmarkPeriod;
}

export const benchmarks = defineQuery<BenchmarkOptions, BenchmarksResult>({
	name: "benchmarks",
	summary: "headline metrics (playtime per DAU, D1/D7, payer conversion, ARPPU, play-through) for the last N days and the N days before",
	defaultDays: 7,
	options: (input = {}) => ({
		days: intOption(input.days, "days", 7, 1, 90),
		qualifiedMinutes: intOption(input.qualifiedMinutes, "qualifiedMinutes", 5, 1, 240),
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const to = f.to;
		const mid = to - o.days * DAY_MS;
		const from = to - 2 * o.days * DAY_MS;
		const ended = int(ctx.now - ENDED_AFTER_MS);
		const robux = ctx.dialect.jsonNumber("props", o.robuxKey);
		// Retention by return day: the last fully finished day in the range, back N days (current) and N more (previous).
		const today = Math.floor(ctx.now / DAY_MS);
		const lastDay = Math.min(Math.floor((to - 1) / DAY_MS), today - 1);
		const curStart = lastDay - o.days + 1;
		const prevStart = curStart - o.days;
		const cohortFrom = (prevStart - 7) * DAY_MS;
		const inRange = (k: number, a: number, b: number) => `cday + ${int(k)} >= ${int(a)} AND cday + ${int(k)} <= ${int(b)}`;
		const sums = [1, 7]
			.flatMap((k) => [
				`SUM(CASE WHEN ${inRange(k, curStart, lastDay)} THEN 1 ELSE 0 END) AS d${k}_cur_n`,
				`SUM(CASE WHEN ${inRange(k, curStart, lastDay)} THEN k${k} ELSE 0 END) AS d${k}_cur_k`,
				`SUM(CASE WHEN ${inRange(k, prevStart, curStart - 1)} THEN 1 ELSE 0 END) AS d${k}_prev_n`,
				`SUM(CASE WHEN ${inRange(k, prevStart, curStart - 1)} THEN k${k} ELSE 0 END) AS d${k}_prev_k`,
			])
			.join(", ");
		const fc: NormalizedFilters = { ...f, from: cohortFrom, to };
		return {
			numbers:
				`WITH ev AS (${playerEvents(ctx, f, from, to, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp, e.kind AS kind, e.props AS props")}), ${SESSIONS_CTE}, ` +
				`sp AS (SELECT CASE WHEN t0 >= ${int(mid)} THEN 1 ELSE 0 END AS cur, pid, t0, t1, isnew, ${dayOf("t0")} AS day FROM s), ` +
				`pt AS (SELECT cur, COUNT(DISTINCT pid) AS players, SUM(t1 - t0) AS playtime_ms, ` +
				`SUM(CASE WHEN isnew = 1 AND t1 < ${ended} THEN 1 ELSE 0 END) AS first_sessions, ` +
				`SUM(CASE WHEN isnew = 1 AND t1 < ${ended} AND t1 - t0 >= ${int(o.qualifiedMinutes * 60_000)} THEN 1 ELSE 0 END) AS first_qualified FROM sp GROUP BY cur), ` +
				`pdays AS (SELECT cur, COUNT(*) AS player_days FROM (SELECT DISTINCT cur, pid, day FROM sp) d GROUP BY cur), ` +
				`pu AS (SELECT CASE WHEN t >= ${int(mid)} THEN 1 ELSE 0 END AS cur, pid, robux FROM (SELECT pid, t, ${robux} AS robux FROM ev WHERE kind = 'purchase') q), ` +
				`pay AS (SELECT cur, COUNT(DISTINCT pid) AS payers, SUM(COALESCE(robux, 0)) AS robux FROM pu GROUP BY cur) ` +
				`SELECT pt.cur AS cur, pt.players AS players, pt.playtime_ms AS playtime_ms, pt.first_sessions AS first_sessions, pt.first_qualified AS first_qualified, ` +
				`pdays.player_days AS player_days, pay.payers AS payers, pay.robux AS robux ` +
				`FROM pt LEFT JOIN pdays ON pdays.cur = pt.cur LEFT JOIN pay ON pay.cur = pt.cur ORDER BY cur ${lim(10)}`,
			retention:
				`WITH c AS (SELECT e.pid AS pid, ${dayOf("MIN(e.t)")} AS cday FROM ${ctx.table("events", cohortFrom, to)} e WHERE ${playerRows(fc, ctx, "e.newp = TRUE")} GROUP BY e.pid), ` +
				`a AS (SELECT DISTINCT e.pid AS pid, ${dayOf("e.t")} AS day FROM ${ctx.table("events", cohortFrom, to)} e WHERE e.t >= ${int(cohortFrom)} AND e.t < ${int(to)} AND e.pid IS NOT NULL AND e.pid <> ''), ` +
				`r AS (SELECT c.pid AS pid, c.cday AS cday, MAX(CASE WHEN a.day = c.cday + 1 THEN 1 ELSE 0 END) AS k1, MAX(CASE WHEN a.day = c.cday + 7 THEN 1 ELSE 0 END) AS k7 ` +
				`FROM c LEFT JOIN a ON a.pid = c.pid GROUP BY c.pid, c.cday) ` +
				`SELECT ${sums} FROM r ${lim(1)}`,
		};
	},
	shape(rows, _ctx, f, o) {
		const to = f.to;
		const mid = to - o.days * DAY_MS;
		const r = rows.retention[0] ?? {};
		const period = (cur: 0 | 1): BenchmarkPeriod => {
			const n = rows.numbers.find((x) => num(x.cur) === cur) ?? {};
			const tag = cur ? "cur" : "prev";
			const players = num(n.players);
			const payers = num(n.payers);
			const robux = num(n.robux);
			const playerDays = num(n.player_days);
			return {
				from: iso(cur ? mid : mid - o.days * DAY_MS),
				to: iso(cur ? to : mid),
				players,
				dau: round(playerDays / o.days, 2),
				avgPlaytimeMinutes: playerDays ? round(num(n.playtime_ms) / playerDays / 60_000, 2) : null,
				d1Retention: rate(num(r[`d1_${tag}_k`]), num(r[`d1_${tag}_n`])),
				d7Retention: rate(num(r[`d7_${tag}_k`]), num(r[`d7_${tag}_n`])),
				payerConversion: rate(payers, players),
				arppu: payers ? round(robux / payers, 2) : null,
				robux,
				playThrough: { ...rate(num(n.first_qualified), num(n.first_sessions)), minutes: o.qualifiedMinutes },
			};
		};
		return { days: o.days, current: period(1), previous: period(0) };
	},
});

// realtime ---------------------------------------------------------------------------------------------------------

export interface RealtimeOptions {
	/** Window for the period-over-period numbers, hours (default 24). */
	hours: number;
	/** Days of concurrent-user history (default 7). */
	ccuDays: number;
}

export interface RealtimeWindow {
	sessions: number;
	/** Average length of the sessions that started in the window and are over, minutes. */
	avgSessionMinutes: number | null;
	/** tech/error rows sent by clients (each counts its `n`). */
	clientErrors: number;
	errorsPerSession: number | null;
	/** Average of tech/client `fps`. */
	clientFps: number | null;
	/** Average of tech/server `mem` (MB). */
	serverMemoryMb: number | null;
}

export interface RealtimeResult {
	hours: number;
	current: RealtimeWindow;
	previous: RealtimeWindow;
	ccu: {
		/** Players on servers that sent a heartbeat in the last 2 minutes (the newest minute's sum). */
		now: number;
		/** Per hour: average concurrent users (minutes without heartbeats count as 0) and the peak minute. */
		series: { hour: string; avg: number; peak: number }[];
		currentAvg: number;
		previousAvg: number;
	};
}

export const realtime = defineQuery<RealtimeOptions, RealtimeResult>({
	name: "realtime",
	summary: "concurrent users per hour from fleet heartbeats; session time, client errors per session, client fps, server memory: last hours vs the hours before",
	defaultDays: 7,
	options: (input = {}) => ({
		hours: intOption(input.hours, "hours", 24, 1, 168),
		ccuDays: intOption(input.ccuDays, "ccuDays", 7, 1, 30),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const d = ctx.dialect;
		const now = ctx.now;
		const mid = now - o.hours * HOUR_MS;
		const from = now - 2 * o.hours * HOUR_MS;
		const ended = int(now - ENDED_AFTER_MS);
		const ccuFrom = Math.floor((now - o.ccuDays * DAY_MS) / HOUR_MS) * HOUR_MS;
		// Server rows (tech/server, fleet) have no player: only the branch / artifact / place filters apply to them.
		const serverFilters: NormalizedFilters = { from, to: now, ...(f.branch ? { branch: f.branch } : {}), ...(f.art ? { art: f.art } : {}), ...(f.place !== undefined ? { place: f.place } : {}) };
		const fleetFilters: NormalizedFilters = { ...serverFilters, from: ccuFrom };
		return {
			sessions:
				`WITH ev AS (${playerEvents(ctx, f, from, now, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp")}), ${SESSIONS_CTE} ` +
				`SELECT CASE WHEN t0 >= ${int(mid)} THEN 1 ELSE 0 END AS cur, COUNT(*) AS sessions, ` +
				`SUM(CASE WHEN t1 < ${ended} THEN t1 - t0 ELSE 0 END) AS ended_ms, SUM(CASE WHEN t1 < ${ended} THEN 1 ELSE 0 END) AS ended_n FROM s GROUP BY cur ORDER BY cur ${lim(10)}`,
			tech:
				`SELECT cur, AVG(CASE WHEN name = 'client' THEN fps END) AS fps, AVG(CASE WHEN name = 'server' THEN mem END) AS mem, ` +
				`SUM(CASE WHEN name = 'error' AND src = 'client' THEN COALESCE(n, 1) ELSE 0 END) AS errors ` +
				`FROM (SELECT CASE WHEN e.t >= ${int(mid)} THEN 1 ELSE 0 END AS cur, e.name AS name, e.src AS src, ${d.jsonNumber("e.props", "fps")} AS fps, ` +
				`${d.jsonNumber("e.props", "mem")} AS mem, ${d.jsonNumber("e.props", "n")} AS n FROM ${ctx.table("events", from, now)} e ` +
				`WHERE ${whereSql(serverFilters, d, { prefix: "e." })} AND e.kind = 'tech') x GROUP BY cur ORDER BY cur ${lim(10)}`,
			ccu:
				`WITH hb AS (SELECT e.job AS job, CAST(floor(e.t / 60000.0) AS BIGINT) AS minute, ${d.jsonNumber("e.props", "n")} AS players FROM ${ctx.table("events", ccuFrom, now)} e ` +
				`WHERE ${whereSql(fleetFilters, d, { prefix: "e." })} AND e.kind = 'fleet' AND e.name = '${FLEET_HEARTBEAT}'), ` +
				`pm AS (SELECT minute, job, MAX(COALESCE(players, 0)) AS players FROM hb GROUP BY minute, job), ` +
				`m AS (SELECT minute, SUM(players) AS ccu FROM pm GROUP BY minute) ` +
				`SELECT CAST(floor(minute / 60.0) AS BIGINT) AS hour, SUM(ccu) AS ccu_sum, MAX(ccu) AS peak, MAX(minute) AS last_minute FROM m GROUP BY CAST(floor(minute / 60.0) AS BIGINT) ORDER BY hour ${lim(10_000)}`,
			ccuNow:
				`WITH hb AS (SELECT e.job AS job, e.t AS t, ${d.jsonNumber("e.props", "n")} AS players, ROW_NUMBER() OVER (PARTITION BY e.job ORDER BY e.t DESC) AS rn ` +
				`FROM ${ctx.table("events", now - 120_000, now + 60_000)} e WHERE ${whereSql({ ...serverFilters, from: now - 120_000, to: now + 60_000 }, d, { prefix: "e." })} ` +
				`AND e.kind = 'fleet' AND e.name = '${FLEET_HEARTBEAT}') SELECT SUM(COALESCE(players, 0)) AS players FROM hb WHERE rn = 1 ${lim(1)}`,
		};
	},
	shape(rows, ctx, _f, o) {
		const window = (cur: 0 | 1): RealtimeWindow => {
			const s = rows.sessions.find((x) => num(x.cur) === cur) ?? {};
			const t = rows.tech.find((x) => num(x.cur) === cur) ?? {};
			const sessions = num(s.sessions);
			const errors = num(t.errors);
			const fps = numOrNull(t.fps);
			const mem = numOrNull(t.mem);
			return {
				sessions,
				avgSessionMinutes: num(s.ended_n) ? round(num(s.ended_ms) / num(s.ended_n) / 60_000, 2) : null,
				clientErrors: errors,
				errorsPerSession: sessions ? round(errors / sessions, 3) : null,
				clientFps: fps === null ? null : round(fps, 1),
				serverMemoryMb: mem === null ? null : round(mem, 0),
			};
		};
		const byHour = new Map(rows.ccu.map((r) => [num(r.hour), { avg: num(r.ccu_sum) / 60, peak: num(r.peak) }]));
		const firstHour = Math.floor((ctx.now - o.ccuDays * DAY_MS) / HOUR_MS);
		const lastHour = Math.floor(ctx.now / HOUR_MS);
		const series: RealtimeResult["ccu"]["series"] = [];
		for (let h = firstHour; h <= lastHour; h++) {
			const v = byHour.get(h);
			// The current hour isn't over: average over the minutes so far.
			const minutes = h === lastHour ? Math.max(1, Math.floor((ctx.now - h * HOUR_MS) / 60_000)) : 60;
			series.push({ hour: iso(h * HOUR_MS), avg: v ? round((v.avg * 60) / minutes, 2) : 0, peak: v?.peak ?? 0 });
		}
		const hoursBack = (a: number, b: number) => series.filter((p) => {
			const t = Date.parse(p.hour);
			return t >= ctx.now - a * HOUR_MS && t < ctx.now - b * HOUR_MS;
		});
		const mean = (points: { avg: number }[]) => (points.length ? round(points.reduce((s, p) => s + p.avg, 0) / points.length, 2) : 0);
		return {
			hours: o.hours,
			current: window(1),
			previous: window(0),
			ccu: {
				now: num(rows.ccuNow[0]?.players),
				series,
				currentAvg: mean(hoursBack(o.hours, 0)),
				previousAvg: mean(hoursBack(2 * o.hours, o.hours)),
			},
		};
	},
});

// trends -----------------------------------------------------------------------------------------------------------

export interface TrendsOptions {
	/** Moving-average window, days (default 7). */
	window: number;
	/** Join sources shown separately (busiest first); the rest is "other" (default 6). */
	maxSources: number;
	robuxKey: string;
}

export interface TrendValues {
	newUsers: number;
	dau: number;
	/** Session time per daily active user, minutes (null without players). */
	playtimeMinutes: number | null;
	robux: number;
	/** Share of the window's join-day cohorts back the next day (cohorts whose next day is over); null without any. */
	d1: number | null;
}

export interface TrendsResult {
	from: string;
	to: string;
	window: number;
	/** Join sources (session/join `from`), busiest first; "other" folds the rest, "unknown" = no join row. */
	sources: string[];
	days: { date: string; total: TrendValues; bySource: Record<string, TrendValues> }[];
}

export const trends = defineQuery<TrendsOptions, TrendsResult>({
	name: "trends",
	summary: "per day, moving averages of new users, DAU, playtime per DAU, Robux and D1, in total and per join source",
	defaultDays: 28,
	options: (input = {}) => ({
		window: intOption(input.window, "window", 7, 1, 28),
		maxSources: intOption(input.maxSources, "maxSources", 6, 1, 20),
		robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
	}),
	statements(ctx, f, o) {
		const lim = ctx.dialect.limit;
		const d = ctx.dialect;
		const firstDay = Math.floor(f.from / DAY_MS) - (o.window - 1);
		const lo = firstDay * DAY_MS;
		const hi = f.to + DAY_MS; // one more day: the last cohort's return day
		const sessions =
			`WITH ev AS (${playerEvents(ctx, f, lo, hi, "e.pid AS pid, e.sid AS sid, e.t AS t, e.newp AS newp, e.kind AS kind, e.name AS name, e.props AS props")}), ` +
			`s AS (SELECT sid, MIN(pid) AS pid, MIN(t) AS t0, MAX(t) AS t1, MAX(CASE WHEN newp THEN 1 ELSE 0 END) AS isnew, ` +
			`MAX(CASE WHEN kind = 'session' AND name = 'join' THEN ${d.jsonText("props", "from")} END) AS src FROM ev GROUP BY sid), ` +
			`s1 AS (SELECT sid, pid, t0, t1, isnew, COALESCE(src, 'unknown') AS src, ${dayOf("t0")} AS day FROM s), ` +
			`sd AS (SELECT sid, pid, t0, t1, isnew, src, day, ROW_NUMBER() OVER (PARTITION BY pid, day ORDER BY t0) AS rn FROM s1)`;
		return {
			days:
				`${sessions}, ` +
				`pd AS (SELECT pid, day, src FROM sd WHERE rn = 1), ` +
				`pdn AS (SELECT pid, day, MAX(isnew) AS isnew, SUM(t1 - t0) AS playtime FROM sd GROUP BY pid, day), ` +
				`pr AS (SELECT pid, day, SUM(COALESCE(robux, 0)) AS robux FROM (SELECT pid, ${dayOf("t")} AS day, ${d.jsonNumber("props", o.robuxKey)} AS robux FROM ev WHERE kind = 'purchase') q GROUP BY pid, day) ` +
				`SELECT pd.day AS day, pd.src AS src, COUNT(*) AS dau, SUM(pdn.isnew) AS new_users, SUM(pdn.playtime) AS playtime_ms, SUM(COALESCE(pr.robux, 0)) AS robux ` +
				`FROM pd JOIN pdn ON pdn.pid = pd.pid AND pdn.day = pd.day LEFT JOIN pr ON pr.pid = pd.pid AND pr.day = pd.day ` +
				`WHERE pd.day < ${int(Math.ceil(f.to / DAY_MS))} GROUP BY pd.day, pd.src ORDER BY day, src ${lim(10_000)}`,
			d1:
				`${sessions}, ` +
				`c AS (SELECT pid, day AS cday, src FROM (SELECT pid, day, src, ROW_NUMBER() OVER (PARTITION BY pid ORDER BY t0) AS n FROM sd WHERE isnew = 1) x WHERE n = 1), ` +
				`a AS (SELECT DISTINCT pid, ${dayOf("t")} AS day FROM ev) ` +
				`SELECT cday, src, COUNT(*) AS cohort, SUM(kept) AS kept FROM (SELECT c.pid AS pid, c.cday AS cday, c.src AS src, MAX(CASE WHEN a.day = c.cday + 1 THEN 1 ELSE 0 END) AS kept ` +
				`FROM c LEFT JOIN a ON a.pid = c.pid GROUP BY c.pid, c.cday, c.src) r WHERE cday < ${int(Math.ceil(f.to / DAY_MS))} GROUP BY cday, src ORDER BY cday, src ${lim(10_000)}`,
		};
	},
	shape(rows, ctx, f, o) {
		interface Raw {
			dau: number;
			newUsers: number;
			playtime: number;
			robux: number;
			cohort: number;
			kept: number;
		}
		const today = Math.floor(ctx.now / DAY_MS);
		const zero = (): Raw => ({ dau: 0, newUsers: 0, playtime: 0, robux: 0, cohort: 0, kept: 0 });
		// Sources, busiest first by active-user days; past maxSources - 1 they fold into "other".
		const weight = new Map<string, number>();
		for (const r of rows.days) weight.set(str(r.src), (weight.get(str(r.src)) ?? 0) + num(r.dau));
		const ranked = [...weight].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
		const kept = ranked.length > o.maxSources ? ranked.slice(0, o.maxSources - 1) : ranked;
		const sourceOf = (src: string) => (kept.includes(src) ? src : "other");
		const sources = ranked.length > o.maxSources ? [...kept, "other"] : kept;
		const raw = new Map<string, Raw>(); // `${day}|${source}` and `${day}|*` for the total
		const add = (day: number, src: string, patch: Partial<Raw>) => {
			for (const key of [`${day}|${sourceOf(src)}`, `${day}|*`]) {
				const v = raw.get(key) ?? zero();
				for (const [k, x] of Object.entries(patch) as [keyof Raw, number][]) v[k] += x;
				raw.set(key, v);
			}
		};
		for (const r of rows.days) add(num(r.day), str(r.src), { dau: num(r.dau), newUsers: num(r.new_users), playtime: num(r.playtime_ms), robux: num(r.robux) });
		for (const r of rows.d1) if (num(r.cday) + 1 < today) add(num(r.cday), str(r.src), { cohort: num(r.cohort), kept: num(r.kept) });
		const first = Math.floor(f.from / DAY_MS);
		const last = Math.ceil(f.to / DAY_MS) - 1;
		const average = (day: number, src: string): TrendValues => {
			const sum = zero();
			for (let d = day - o.window + 1; d <= day; d++) {
				const v = raw.get(`${d}|${src}`);
				if (v) for (const k of Object.keys(sum) as (keyof Raw)[]) sum[k] += v[k];
			}
			return {
				newUsers: round(sum.newUsers / o.window, 2),
				dau: round(sum.dau / o.window, 2),
				playtimeMinutes: sum.dau ? round(sum.playtime / sum.dau / 60_000, 2) : null,
				robux: round(sum.robux / o.window, 2),
				d1: sum.cohort ? ratio(sum.kept, sum.cohort) : null,
			};
		};
		const days: TrendsResult["days"] = [];
		for (let day = first; day <= last; day++) {
			days.push({ date: isoDay(day), total: average(day, "*"), bySource: Object.fromEntries(sources.map((s) => [s, average(day, s)])) });
		}
		return { from: iso(f.from), to: iso(f.to), window: o.window, sources, days };
	},
});

