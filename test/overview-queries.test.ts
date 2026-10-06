/**
 * The Creator-Hub-style queries (benchmarks, realtime, trends) on a DuckDB holding the fixture, with a third of the
 * players joining by teleport and some tech rows, checked against plain-JS reference computations.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import type { EventRow } from "../src/schema.ts";
import { DuckDbStore } from "../src/store/duckdb.ts";
import { DAY, NOW, TODAY, fixtureDb, generateFixture, type Fixture } from "./fixtures.ts";

const HOUR = 3_600_000;
const ENDED = NOW - 10 * 60_000;

/** The fixture, with every 3rd player's joins coming from a teleport and a day of tech rows. */
function fixture(): Fixture {
	const fx = generateFixture();
	for (const e of fx.events) {
		if (e.kind === "session" && e.name === "join" && e.pid && Number(e.pid.slice(1)) % 3 === 0) {
			e.props = JSON.stringify({ ...JSON.parse(e.props as string), from: "teleport" });
		}
	}
	const tech = (t: number, name: string, src: "server" | "client", props: object): EventRow => ({
		v: 1,
		t,
		kind: "tech",
		name,
		job: "job-1",
		art: "a1b2c3d-111111",
		branch: "prod",
		src,
		props: JSON.stringify(props),
		...(src === "client" ? { pid: "p0001", sid: "tech-session" } : {}),
	});
	for (let h = 1; h <= 47; h++) {
		const cur = h <= 24; // NOW - 24 h is the first moment of the current window
		fx.events.push(tech(NOW - h * HOUR, "client", "client", { fps: cur ? 50 : 30, mem: 2000 }));
		fx.events.push(tech(NOW - h * HOUR, "server", "server", { fps: 60, mem: cur ? 400 : 300 }));
	}
	fx.events.push(tech(NOW - 2 * HOUR, "error", "client", { msg: "boom", n: 3 }));
	fx.events.push(tech(NOW - 3 * HOUR, "error", "client", { msg: "boom" }));
	fx.events.push(tech(NOW - 30 * HOUR, "error", "server", { msg: "server only", n: 5 }));
	return fx;
}

const fx = fixture();
let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;

beforeAll(async () => {
	({ instance, connection } = await fixtureDb(fx));
	store = new DuckDbStore(connection, (name) => name, () => NOW);
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

const day = (t: number) => Math.floor(t / DAY);
const players = (from: number, to: number) => fx.events.filter((e) => e.pid && e.sid && e.t >= from && e.t < to);

function sessions(rows: EventRow[]) {
	const out = new Map<string, { pid: string; t0: number; t1: number; isnew: boolean; src: string }>();
	for (const e of rows) {
		const s = out.get(e.sid as string) ?? { pid: e.pid as string, t0: e.t, t1: e.t, isnew: false, src: "unknown" };
		s.t0 = Math.min(s.t0, e.t);
		s.t1 = Math.max(s.t1, e.t);
		s.isnew ||= e.newp === true;
		if (e.kind === "session" && e.name === "join") s.src = JSON.parse(e.props as string).from;
		out.set(e.sid as string, s);
	}
	return [...out.values()];
}

describe("benchmarks", () => {
	test("period over period: playtime per DAU, payers, ARPPU, play-through", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		expect(r.days).toBe(7);
		const mid = NOW - 7 * DAY;
		const all = sessions(players(NOW - 14 * DAY, NOW));
		for (const [period, list] of [
			[r.current, all.filter((s) => s.t0 >= mid)],
			[r.previous, all.filter((s) => s.t0 < mid)],
		] as const) {
			const pids = new Set(list.map((s) => s.pid));
			const playerDays = new Set(list.map((s) => `${s.pid}|${day(s.t0)}`));
			const playtime = list.reduce((sum, s) => sum + s.t1 - s.t0, 0);
			expect(period.players).toBe(pids.size);
			expect(period.avgPlaytimeMinutes).toBeCloseTo(playtime / playerDays.size / 60_000, 2);
			expect(period.dau).toBeCloseTo(playerDays.size / 7, 2);
			const first = list.filter((s) => s.isnew && s.t1 < ENDED);
			expect(period.playThrough.of).toBe(first.length);
			expect(period.playThrough.count).toBe(first.filter((s) => s.t1 - s.t0 >= 5 * 60_000).length);
			const from = period === r.current ? mid : NOW - 14 * DAY;
			const to = period === r.current ? NOW : mid;
			const buys = fx.events.filter((e) => e.kind === "purchase" && e.t >= from && e.t < to);
			const payers = new Set(buys.map((e) => e.pid));
			const robux = buys.reduce((sum, e) => sum + JSON.parse(e.props as string).robux, 0);
			expect(period.payerConversion).toEqual({ rate: Math.round((payers.size / pids.size) * 10_000) / 10_000, count: payers.size, of: pids.size });
			expect(period.arppu).toBe(payers.size ? Math.round((robux / payers.size) * 100) / 100 : null);
		}
	});

	test("D1 / D7 by return day (return days fully over)", async () => {
		const r = await store.query("benchmarks", {}, { days: 7 });
		const lastDay = TODAY - 1;
		const curStart = lastDay - 6;
		const cohortFrom = (curStart - 7 - 7) * DAY;
		const firsts = new Map<string, number>();
		for (const e of fx.events) if (e.pid && e.sid && e.newp && e.t >= cohortFrom && e.t < NOW) firsts.set(e.pid, Math.min(firsts.get(e.pid) ?? Infinity, e.t));
		const active = new Set(fx.events.filter((e) => e.pid && e.t >= cohortFrom && e.t < NOW).map((e) => `${e.pid}|${day(e.t)}`));
		for (const k of [1, 7]) {
			const cohort = [...firsts].filter(([, t]) => day(t) + k >= curStart && day(t) + k <= lastDay);
			const kept = cohort.filter(([pid, t]) => active.has(`${pid}|${day(t) + k}`));
			expect(k === 1 ? r.current.d1Retention : r.current.d7Retention).toMatchObject({ count: kept.length, of: cohort.length });
		}
		expect(r.current.d7Retention.of).toBeGreaterThan(0);
	});
});

describe("realtime", () => {
	test("sessions, client errors per session, fps, server memory: last 24 h vs the 24 h before", async () => {
		const r = await store.query("realtime", {}, { hours: 24 });
		const mid = NOW - 24 * HOUR;
		const all = sessions(players(NOW - 48 * HOUR, NOW));
		const cur = all.filter((s) => s.t0 >= mid);
		const ended = cur.filter((s) => s.t1 < ENDED);
		expect(r.current.sessions).toBe(cur.length);
		expect(r.current.avgSessionMinutes).toBeCloseTo(ended.reduce((sum, s) => sum + s.t1 - s.t0, 0) / ended.length / 60_000, 2);
		expect(r.current.clientErrors).toBe(4); // n = 3, and one row without n; the server error doesn't count
		expect(r.current.errorsPerSession).toBeCloseTo(4 / cur.length, 3);
		expect(r.previous.clientErrors).toBe(0);
		expect(r.current.clientFps).toBe(50);
		expect(r.previous.clientFps).toBe(30);
		expect(r.current.serverMemoryMb).toBe(400);
		expect(r.previous.serverMemoryMb).toBe(300);
	});

	test("concurrent users from heartbeats: per minute, summed over servers, hourly averages and peaks", async () => {
		const r = await store.query("realtime", {}, { ccuDays: 2 });
		expect(r.ccu.now).toBe(30); // three servers with 10 players each sent a heartbeat in the last 2 minutes
		expect(r.ccu.series.length).toBe(49);
		const perMinute = new Map<number, Map<string, number>>();
		for (const e of fx.events.filter((x) => x.kind === "fleet" && x.name === "heartbeat" && x.t >= NOW - 2 * DAY)) {
			const m = Math.floor(e.t / 60_000);
			const jobs = perMinute.get(m) ?? new Map<string, number>();
			jobs.set(e.job, Math.max(jobs.get(e.job) ?? 0, JSON.parse(e.props as string).n));
			perMinute.set(m, jobs);
		}
		const byHour = new Map<number, { sum: number; peak: number }>();
		for (const [m, jobs] of perMinute) {
			const ccu = [...jobs.values()].reduce((a, b) => a + b, 0);
			const h = Math.floor(m / 60);
			const v = byHour.get(h) ?? { sum: 0, peak: 0 };
			v.sum += ccu;
			v.peak = Math.max(v.peak, ccu);
			byHour.set(h, v);
		}
		const last = r.ccu.series.at(-1);
		const before = r.ccu.series.at(-2);
		const h = Math.floor(NOW / HOUR);
		expect(before?.peak).toBe(byHour.get(h - 1)?.peak ?? 0);
		expect(before?.avg).toBeCloseTo((byHour.get(h - 1)?.sum ?? 0) / 60, 2);
		expect(last?.hour).toBe(new Date(h * HOUR).toISOString());
		expect(r.ccu.series.slice(0, 20).every((p) => p.avg === 0 && p.peak === 0)).toBe(true);
		expect(r.ccu.currentAvg).toBeGreaterThan(0);
	});
});

describe("trends", () => {
	test("moving averages per day, in total and per join source", async () => {
		const r = await store.query("trends", {}, { window: 7 });
		expect(r.window).toBe(7);
		expect(r.sources.sort()).toEqual(["direct", "teleport"]);
		expect(r.days.length).toBe(29); // 28 days back from mid-day: 29 calendar days
		const lastDay = r.days.at(-1);
		expect(lastDay?.date).toBe(new Date(TODAY * DAY).toISOString().slice(0, 10));
		// Reference: player-days by the day their first session that day started, source = that session's join.
		const all = sessions(players(NOW - 35 * DAY, NOW + DAY));
		const firstOfDay = new Map<string, { src: string; t0: number }>();
		for (const s of all) {
			const key = `${s.pid}|${day(s.t0)}`;
			const seen = firstOfDay.get(key);
			if (!seen || s.t0 < seen.t0) firstOfDay.set(key, { src: s.src, t0: s.t0 });
		}
		const dauOn = (d: number, src?: string) => [...firstOfDay].filter(([key, v]) => Number(key.split("|")[1]) === d && (!src || v.src === src)).length;
		const ma = (d: number, src?: string) => Math.round((Array.from({ length: 7 }, (_, i) => dauOn(d - i, src)).reduce((a, b) => a + b, 0) / 7) * 100) / 100;
		for (const [i, point] of r.days.entries()) {
			const d = Math.floor((NOW - 28 * DAY) / DAY) + i;
			expect(point.total.dau).toBeCloseTo(ma(d), 2);
			expect(point.bySource.teleport.dau).toBeCloseTo(ma(d, "teleport"), 2);
			expect(point.bySource.direct.dau + point.bySource.teleport.dau).toBeCloseTo(point.total.dau, 1);
		}
		// D1: share of the window's join-day cohorts back the next day; the last day's cohort isn't over yet.
		const firsts = new Map<string, number>();
		for (const s of all) if (s.isnew) firsts.set(s.pid, Math.min(firsts.get(s.pid) ?? Infinity, s.t0));
		const active = new Set(fx.events.filter((e) => e.pid && e.t >= NOW - 35 * DAY).map((e) => `${e.pid}|${day(e.t)}`));
		const d1At = (d: number) => {
			const cohort = [...firsts].filter(([, t]) => day(t) <= d && day(t) > d - 7 && day(t) + 1 < TODAY);
			const kept = cohort.filter(([pid, t]) => active.has(`${pid}|${day(t) + 1}`));
			return cohort.length ? Math.round((kept.length / cohort.length) * 10_000) / 10_000 : null;
		};
		expect(r.days.at(-3)?.total.d1).toBe(d1At(TODAY - 2));
		expect(r.days.at(-1)?.total.d1).toBe(d1At(TODAY));
		expect(r.days[10].total.newUsers).toBeGreaterThan(0);
		expect(r.days[10].total.playtimeMinutes).toBeGreaterThan(0);
	});

	test("sources past maxSources fold into other", async () => {
		const r = await store.query("trends", {}, { maxSources: 1 });
		expect(r.sources).toEqual(["other"]);
		expect(r.days.at(-2)?.bySource.other.dau).toBeCloseTo(r.days.at(-2)?.total.dau ?? -1, 2);
	});
});
