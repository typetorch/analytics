/** Funnels (e.g. onboarding steps) and one player's timeline. */
import { PROP_KEYS } from "../schema.ts";
import { assertSafeKey, lit } from "../sql/dialect.ts";
import { checkPid, defineQuery, eventsTable, intOption, iso, num, numOrNull, ratio, round, str, strOrNull, where } from "./core.ts";

// funnel ------------------------------------------------------------------------------------------------------------------

export interface FunnelOptions {
	/** The funnel (the `name` of its funnel rows). Without it, the query lists the funnels it finds. */
	funnel?: string;
	stepKey: string;
	labelKey: string;
}

export interface FunnelStep {
	step: number;
	label: string | null;
	/** Players who got at least this far (their highest step >= this one). */
	reached: number;
	/** Share of the players who started the funnel. */
	ofStart: number;
	/** Share of the players who reached the step before. */
	fromPrevious: number;
	/** Players who logged exactly this step. */
	logged: number;
	/** Median time from the player's first funnel step to this one. */
	medianSecondsFromStart: number | null;
}

export type FunnelResult =
	| { funnel: null; funnels: { name: string; players: number; events: number }[] }
	| { funnel: string; players: number; steps: FunnelStep[]; biggestDrop: { step: number; lost: number; share: number } | null };

export const funnel = defineQuery<FunnelOptions, FunnelResult>({
	name: "funnel",
	summary: "a funnel step by step (players reaching each step, drop-off, time from the start); no funnel: the list",
	defaultDays: 30,
	options: (input = {}) => {
		const out: FunnelOptions = {
			stepKey: assertSafeKey(input.stepKey ?? PROP_KEYS.funnelStep, "stepKey"),
			labelKey: assertSafeKey(input.labelKey ?? PROP_KEYS.funnelLabel, "labelKey"),
		};
		if (input.funnel !== undefined && input.funnel !== "") out.funnel = assertSafeKey(input.funnel, "funnel");
		return out;
	},
	statements(ctx, f, o): Record<string, string> {
		const lim = ctx.dialect.limit;
		const table = eventsTable(ctx, f);
		if (!o.funnel) {
			return {
				list:
					`SELECT e.name AS name, COUNT(DISTINCT e.pid) AS players, COUNT(*) AS events FROM ${table} e ` +
					`WHERE ${where(f, ctx)} AND e.kind = 'funnel' GROUP BY e.name ORDER BY players DESC, name ${lim(1000)}`,
			};
		}
		const d = ctx.dialect;
		const base =
			`f AS (SELECT e.pid AS pid, e.t AS t, CAST(${d.jsonNumber("e.props", o.stepKey)} AS BIGINT) AS step, ${d.jsonText("e.props", o.labelKey)} AS label ` +
			`FROM ${table} e WHERE ${where(f, ctx)} AND e.kind = 'funnel' AND e.name = ${lit(o.funnel)} AND e.pid IS NOT NULL AND e.pid <> ''), ` +
			`f2 AS (SELECT pid, step, MIN(t) AS t FROM f WHERE step IS NOT NULL GROUP BY pid, step), ` +
			`pm AS (SELECT pid, MAX(step) AS maxstep, MIN(t) AS t0 FROM f2 GROUP BY pid)`;
		return {
			steps: `WITH ${base} SELECT f2.step AS step, COUNT(*) AS logged, MEDIAN(f2.t - pm.t0) AS median_ms FROM f2 JOIN pm ON pm.pid = f2.pid GROUP BY f2.step ORDER BY step ${lim(1000)}`,
			reached: `WITH ${base} SELECT st.step AS step, COUNT(*) AS reached FROM (SELECT DISTINCT step FROM f2) st JOIN pm ON pm.maxstep >= st.step GROUP BY st.step ORDER BY step ${lim(1000)}`,
			labels: `WITH ${base} SELECT step, label, COUNT(*) AS n FROM f WHERE step IS NOT NULL AND label IS NOT NULL GROUP BY step, label ORDER BY step, n DESC ${lim(10_000)}`,
			players: `WITH ${base} SELECT COUNT(*) AS players FROM pm ${lim(1)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		if (!o.funnel) {
			return { funnel: null, funnels: rows.list.map((r) => ({ name: str(r.name), players: num(r.players), events: num(r.events) })) };
		}
		const labels = new Map<number, string>();
		for (const r of rows.labels) if (!labels.has(num(r.step))) labels.set(num(r.step), str(r.label));
		const logged = new Map(rows.steps.map((r) => [num(r.step), r]));
		const players = num(rows.players[0]?.players);
		let previous = players;
		let biggestDrop: { step: number; lost: number; share: number } | null = null;
		const steps: FunnelStep[] = rows.reached.map((r) => {
			const step = num(r.step);
			const reached = num(r.reached);
			const lost = previous - reached;
			if (lost > 0 && (!biggestDrop || lost > biggestDrop.lost)) biggestDrop = { step, lost, share: ratio(lost, previous) };
			const median = numOrNull(logged.get(step)?.median_ms);
			const out: FunnelStep = {
				step,
				label: labels.get(step) ?? null,
				reached,
				ofStart: ratio(reached, players),
				fromPrevious: ratio(reached, previous),
				logged: num(logged.get(step)?.logged),
				medianSecondsFromStart: median === null ? null : round(median / 1000, 1),
			};
			previous = reached;
			return out;
		});
		return { funnel: o.funnel, players, steps, biggestDrop };
	},
});

// timeline --------------------------------------------------------------------------------------------------------------

export interface TimelineOptions {
	pid: string;
	/** Most events to return (oldest first). Default 2000. */
	limit: number;
}

export interface TimelineEvent {
	time: string;
	t: number;
	kind: string;
	name: string;
	sid: string;
	state: string | null;
	art: string;
	src: string | null;
	props: unknown;
}

export interface TimelineResult {
	pid: string;
	sessions: { sid: string; start: string; end: string; minutes: number; events: number; firstSession: boolean; art: string; dev: string | null }[];
	events: TimelineEvent[];
	/** More events exist than `limit`. */
	truncated: boolean;
}

export const timeline = defineQuery<TimelineOptions, TimelineResult>({
	name: "timeline",
	summary: "one player's sessions and events, oldest first (by pid)",
	defaultDays: 90,
	options: (input = {}) => ({ pid: checkPid(input.pid), limit: intOption(input.limit, "limit", 2000, 1, 10_000) }),
	statements(ctx, f, o) {
		const table = eventsTable(ctx, f);
		const cond = `${where(f, ctx)} AND e.pid = ${lit(o.pid)}`;
		return {
			events:
				`SELECT e.t AS t, e.kind AS kind, e.name AS name, e.sid AS sid, e.state AS state, e.art AS art, e.src AS src, e.props AS props ` +
				`FROM ${table} e WHERE ${cond} ORDER BY e.t ${ctx.dialect.limit(o.limit + 1)}`,
			sessions:
				`SELECT e.sid AS sid, MIN(e.t) AS t0, MAX(e.t) AS t1, COUNT(*) AS events, MAX(CASE WHEN e.newp THEN 1 ELSE 0 END) AS isnew, ` +
				`MIN(e.art) AS art, MIN(e.dev) AS dev FROM ${table} e WHERE ${cond} GROUP BY e.sid ORDER BY t0 ${ctx.dialect.limit(10_000)}`,
		};
	},
	shape(rows, _ctx, _f, o) {
		const events = rows.events.slice(0, o.limit).map<TimelineEvent>((r) => {
			let props: unknown = null;
			if (typeof r.props === "string" && r.props) {
				try {
					props = JSON.parse(r.props);
				} catch {
					props = r.props;
				}
			}
			return { time: iso(num(r.t)), t: num(r.t), kind: str(r.kind), name: str(r.name), sid: str(r.sid), state: strOrNull(r.state), art: str(r.art), src: strOrNull(r.src), props };
		});
		return {
			pid: o.pid,
			sessions: rows.sessions.map((r) => ({
				sid: str(r.sid),
				start: iso(num(r.t0)),
				end: iso(num(r.t1)),
				minutes: round((num(r.t1) - num(r.t0)) / 60_000, 1),
				events: num(r.events),
				firstSession: num(r.isnew) === 1,
				art: str(r.art),
				dev: strOrNull(r.dev),
			})),
			events,
			truncated: rows.events.length > o.limit,
		};
	},
});
