/**
 * The performance queries (perf-client, perf-server, perf-compare) on a DuckDB holding a small synthetic day of tech
 * rows, checked against plain-JS reference percentiles (DuckDB's quantile_cont: linear between the closest ranks), and the
 * Basin dialect run on the same data through shims (json_get_*, approx_percentile_cont as quantile_cont).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DuckDBConnection, DuckDBInstance } from "@duckdb/node-api";
import { bucketFor, screenBucket } from "../src/queries/perf.ts";
import type { EventRow } from "../src/schema.ts";
import { BasinStore } from "../src/store/basin.ts";
import { DuckDbStore, readRows } from "../src/store/duckdb.ts";
import { fixtureDb } from "./fixtures.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const DEPLOY = NOW - 12 * HOUR;
const ART_A = "aaaaaaa-111111";
const ART_B = "bbbbbbb-222222";
const ART_C = "ccccccc-333333";
const DEVICES = ["desktop", "phone", "tablet", "console", "vr"] as const;
const BASE_FPS: Record<string, number> = { desktop: 60, phone: 30, tablet: 45, console: 55, vr: 70 };
const SCREENS: Record<string, [number, number]> = { desktop: [1920, 1080], phone: [844, 390], tablet: [1180, 820], console: [1920, 1080], vr: [0, 0] };
const INPUTS: Record<string, string> = { desktop: "kbm", phone: "touch", tablet: "touch", console: "gamepad", vr: "vr" };

function generate(): EventRow[] {
	const rows: EventRow[] = [];
	const base = (t: number, art: string, branch = "prod"): Pick<EventRow, "v" | "t" | "job" | "art" | "seq" | "branch" | "channel"> => ({
		v: 1,
		t,
		job: "job-1",
		art,
		seq: art === ART_A ? 50 : art === ART_B ? 51 : 52,
		branch,
		channel: branch === "prod" ? "prod" : "dev",
	});
	// 30 sessions over the last 22 hours, 30 one-minute samples each; the build changes at DEPLOY (B is 10 fps slower).
	for (let i = 0; i < 30; i++) {
		const dev = DEVICES[i % DEVICES.length];
		const start = NOW - 22 * HOUR + i * 40 * MIN;
		const sid = `s${i}`;
		const pid = `p${i % 20}`;
		const [w, h] = SCREENS[dev];
		// Session 29's device row came 3 hours before its first sample (a long session): the screen join looks back for it.
		const deviceAt = i === 29 ? start - 3 * HOUR : start;
		rows.push({ ...base(deviceAt, start < DEPLOY ? ART_A : ART_B), kind: "session", name: "device", pid, sid, dev, src: "client", props: JSON.stringify({ input: INPUTS[dev], w, h, touch: dev === "phone", kb: true }) });
		for (let k = 0; k < 30; k++) {
			const t = start + k * MIN;
			const art = t < DEPLOY ? ART_A : ART_B;
			const fps = BASE_FPS[dev] - (art === ART_B ? 10 : 0) + ((i * 7 + k * 3) % 11) - 5;
			const props: Record<string, number> = { fps, mem: 1000 + ((i * 13 + k * 17) % 2000) };
			if (k % 3 !== 0) props.ping = 40 + ((i * 11 + k * 5) % 160);
			rows.push({ ...base(t, art), kind: "tech", name: "client", pid, sid, dev, src: "client", props: JSON.stringify(props) });
		}
	}
	// Garbage a client could send: left out of every number.
	rows.push({ ...base(NOW - 5 * HOUR, ART_B), kind: "tech", name: "client", pid: "p1", sid: "s1", dev: "phone", src: "client", props: JSON.stringify({ fps: 5000, mem: -1, ping: 1e9 }) });
	// Servers: two prod servers all day (build A, then B), one dev server on build C for the last 6 hours. One sample a minute.
	for (const job of ["job-1", "job-2"]) {
		for (let t = NOW - 24 * HOUR; t < NOW; t += MIN) {
			const art = t < DEPLOY ? ART_A : ART_B;
			const m = Math.floor((t - (NOW - 24 * HOUR)) / MIN);
			rows.push({ ...base(t, art), job, kind: "tech", name: "server", src: "server", props: JSON.stringify({ fps: 59 + (m % 3), hb: art === ART_B ? 50 + (m % 7) : 58 + (m % 5), mem: 500 + (m % 300) + (job === "job-2" ? 100 : 0), players: job === "job-1" ? 10 : 4 + (m % 3) }) });
		}
	}
	for (let t = NOW - 6 * HOUR; t < NOW; t += MIN) {
		rows.push({ ...base(t, ART_C, "dev"), job: "job-3", kind: "tech", name: "server", src: "server", props: JSON.stringify({ fps: 60, hb: 60, mem: 300, players: 1 }) });
	}
	return rows.sort((a, b) => a.t - b.t);
}

const ROWS = generate();
let instance: DuckDBInstance;
let connection: DuckDBConnection;
let store: DuckDbStore;

beforeAll(async () => {
	({ instance, connection } = await fixtureDb({ events: ROWS, recordings: [] }));
	store = new DuckDbStore(connection, (name) => name, () => NOW);
	await connection.run("CREATE SCHEMA typetorch");
	await connection.run("CREATE VIEW typetorch.events AS SELECT * FROM main.events");
	await connection.run("CREATE VIEW typetorch.recordings AS SELECT * FROM main.recordings");
	await connection.run(`CREATE MACRO json_get_str(j, k) AS json_extract_string(j, '$."' || k || '"')`);
	await connection.run(`CREATE MACRO json_get_float(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS DOUBLE)`);
	await connection.run(`CREATE MACRO json_get_int(j, k) AS TRY_CAST(json_extract(j, '$."' || k || '"') AS BIGINT)`);
	await connection.run("CREATE MACRO approx_percentile_cont(x, p) AS quantile_cont(x, p)");
});
afterAll(() => {
	connection.closeSync();
	instance.closeSync();
});

// References ---------------------------------------------------------------------------------------------------------

/** DuckDB's quantile_cont: linear between the two closest ranks. */
function quantile(values: number[], p: number): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const pos = p * (s.length - 1);
	const lo = Math.floor(pos);
	const hi = Math.ceil(pos);
	return Math.round((s[lo] + (s[hi] - s[lo]) * (pos - lo)) * 100) / 100;
}

const props = (e: EventRow) => JSON.parse(e.props as string) as Record<string, number>;
const valid = (v: number | undefined, max: number) => (typeof v === "number" && v >= 0 && v <= max ? v : undefined);
const clientRows = (from: number, to: number, pick: (e: EventRow) => boolean = () => true) => ROWS.filter((e) => e.kind === "tech" && e.name === "client" && e.t >= from && e.t < to && pick(e));
const serverRows = (from: number, to: number, pick: (e: EventRow) => boolean = () => true) => ROWS.filter((e) => e.kind === "tech" && e.name === "server" && e.t >= from && e.t < to && pick(e));
const values = (rows: EventRow[], key: string, max: number) => rows.map((e) => valid(props(e)[key], max)).filter((v): v is number => v !== undefined);

/** p50, the bad-side p90 / p99 and n of one metric. */
function ref(rows: EventRow[], key: string, max: number, higher: boolean) {
	const v = values(rows, key, max);
	return { p50: quantile(v, 0.5), p90: quantile(v, higher ? 0.1 : 0.9), p99: quantile(v, higher ? 0.01 : 0.99), n: v.length };
}
const pick = (s: { p50: number | null; p90: number | null; p99: number | null; n: number }) => ({ p50: s.p50, p90: s.p90, p99: s.p99, n: s.n });

const DAY_RANGE = { from: NOW - 24 * HOUR, to: NOW };

// perf-client ------------------------------------------------------------------------------------------------------------

describe("perf-client", () => {
	test("overall: percentiles on the bad side, garbage left out, sessions and players", async () => {
		const r = await store.query("perf-client", DAY_RANGE, {});
		const rows = clientRows(DAY_RANGE.from, DAY_RANGE.to);
		expect(r.side).toBe("client");
		expect(r.overall.samples).toBe(rows.length);
		expect(r.overall.sessions).toBe(30);
		expect(r.overall.players).toBe(20);
		expect(pick(r.overall.metrics.fps)).toEqual(ref(rows, "fps", 1000, true));
		expect(pick(r.overall.metrics.mem)).toEqual(ref(rows, "mem", 100_000, false));
		expect(pick(r.overall.metrics.ping)).toEqual(ref(rows, "ping", 60_000, false));
		// fps p90 is the low end: below the median.
		expect(r.overall.metrics.fps.p90 as number).toBeLessThan(r.overall.metrics.fps.p50 as number);
		expect(r.overall.metrics.mem.p90 as number).toBeGreaterThan(r.overall.metrics.mem.p50 as number);
		expect(r.metrics).toEqual([
			{ key: "fps", higherIsBetter: true },
			{ key: "mem", higherIsBetter: false },
			{ key: "ping", higherIsBetter: false },
		]);
	});

	test("by device class: one group per class, busiest first, each matching the reference", async () => {
		const r = await store.query("perf-client", DAY_RANGE, { by: "dev" });
		expect(r.groups.map((g) => g.key).sort()).toEqual([...DEVICES].sort());
		expect(r.groupsTotal).toBe(5);
		for (let i = 1; i < r.groups.length; i++) expect(r.groups[i - 1].samples).toBeGreaterThanOrEqual(r.groups[i].samples);
		for (const g of r.groups) {
			const rows = clientRows(DAY_RANGE.from, DAY_RANGE.to, (e) => e.dev === g.key);
			expect(g.samples).toBe(rows.length);
			expect(pick(g.metrics.fps)).toEqual(ref(rows, "fps", 1000, true));
		}
		const fps = Object.fromEntries(r.groups.map((g) => [g.key, g.metrics.fps.p50 as number]));
		expect(fps.vr).toBeGreaterThan(fps.phone);
	});

	test("by screen size and input: from the session's device row, also when it came before the window", async () => {
		const range = { from: NOW - 6 * HOUR, to: NOW };
		const screen = await store.query("perf-client", range, { by: "screen" });
		const rows = clientRows(range.from, range.to);
		// Device rows up to 12 hours before the window count (session s1's is older: its stray sample is "unknown").
		const deviceOf = new Map(ROWS.filter((e) => e.kind === "session" && e.name === "device" && e.t >= range.from - 12 * HOUR).map((e) => [e.sid, props(e)]));
		const expected = new Map<string, number>();
		for (const e of rows) {
			const d = deviceOf.get(e.sid);
			const key = d ? screenBucket(d.w, d.h) : "unknown";
			expected.set(key, (expected.get(key) ?? 0) + 1);
		}
		expect(Object.fromEntries(screen.groups.map((g) => [g.key, g.samples]))).toEqual(Object.fromEntries(expected));
		// Session 29 started in the window, its device row 3 hours before: still a known screen.
		expect(rows.some((e) => e.sid === "s29")).toBe(true);
		expect(screen.groups.find((g) => g.key === "unknown")?.samples ?? 0).toBe(rows.filter((e) => DEVICES[Number(String(e.sid).slice(1)) % 5] === "vr").length + 1);
		const input = await store.query("perf-client", range, { by: "input" });
		expect(input.groups.map((g) => g.key).sort()).toEqual(["gamepad", "kbm", "touch", "unknown", "vr"]);
		expect(input.groups.find((g) => g.key === "unknown")?.samples).toBe(1);
		expect(input.groups.reduce((s, g) => s + g.samples, 0)).toBe(rows.length);
	});

	test("series: buckets snap to a step, points add up, a bucket matches the reference", async () => {
		const r = await store.query("perf-client", DAY_RANGE, { by: "dev", buckets: 120 });
		expect(r.bucketMs).toBe(15 * MIN); // 24 h / 120 = 12 min -> 15 min
		expect(bucketFor(24 * HOUR, 120)).toBe(15 * MIN);
		expect(bucketFor(90 * 24 * HOUR, 120)).toBe(24 * HOUR);
		for (const g of r.groups) expect(r.series.filter((p) => p.key === g.key).reduce((s, p) => s + p.samples, 0)).toBe(g.samples);
		for (const p of r.series) expect(p.t % r.bucketMs).toBe(0);
		const point = r.series.find((p) => p.key === "phone" && p.samples >= 10) as (typeof r.series)[number];
		const rows = clientRows(point.t, point.t + r.bucketMs, (e) => e.dev === "phone");
		expect(pick(point.metrics.fps)).toEqual(ref(rows, "fps", 1000, true));
		// Oldest first.
		for (let i = 1; i < r.series.length; i++) expect(r.series[i].t).toBeGreaterThanOrEqual(r.series[i - 1].t);
	});

	test("the default step follows the window: 1 h -> 1 min, 6 h -> 5 min, a day -> hourly, longer -> daily", async () => {
		const step = async (hours: number, side: "perf-client" | "perf-server" = "perf-client") => (await store.query(side, { from: NOW - hours * HOUR, to: NOW }, {})).bucketMs;
		expect(await step(1)).toBe(MIN);
		expect(await step(6)).toBe(5 * MIN);
		expect(await step(24)).toBe(HOUR);
		expect(await step(24, "perf-server")).toBe(HOUR);
		expect(await step(7 * 24)).toBe(24 * HOUR);
		// "Last hour" from a whole minute is up to 61 minutes: still 1-minute steps. An explicit step wins.
		expect(await step(61 / 60)).toBe(MIN);
		expect((await store.query("perf-client", DAY_RANGE, { bucketMinutes: 5 })).bucketMs).toBe(5 * MIN);
	});

	test("by build, at most maxGroups: the busiest kept, the rest counted", async () => {
		const r = await store.query("perf-client", DAY_RANGE, { by: "art", maxGroups: 1 });
		expect(r.groupsTotal).toBe(2);
		expect(r.groups).toHaveLength(1);
		expect(new Set(r.series.map((p) => p.key))).toEqual(new Set([r.groups[0].key]));
		const both = await store.query("perf-client", DAY_RANGE, { by: "art" });
		const b = both.groups.find((g) => g.key === ART_B) as (typeof both.groups)[number];
		expect(b.seq).toBe(51);
		expect(Date.parse(b.firstSeen as string)).toBeGreaterThanOrEqual(DEPLOY);
		// B is slower.
		const a = both.groups.find((g) => g.key === ART_A) as (typeof both.groups)[number];
		expect(b.metrics.fps.p50 as number).toBeLessThan(a.metrics.fps.p50 as number);
	});

	test("filters apply: device class and build", async () => {
		const r = await store.query("perf-client", { ...DAY_RANGE, dev: "phone", art: ART_B }, {});
		expect(r.overall.samples).toBe(clientRows(DAY_RANGE.from, DAY_RANGE.to, (e) => e.dev === "phone" && e.art === ART_B).length);
	});

	test("bounds: range, buckets, groups, by", async () => {
		await expect(store.query("perf-client", { from: NOW - 100 * 24 * HOUR, to: NOW }, {})).rejects.toThrow(/92 days/);
		await expect(store.query("perf-client", DAY_RANGE, { buckets: 5 })).rejects.toThrow(/buckets/);
		await expect(store.query("perf-client", DAY_RANGE, { maxGroups: 50 })).rejects.toThrow(/maxGroups/);
		await expect(store.query("perf-client", { from: NOW - 30 * 24 * HOUR, to: NOW }, { bucketMinutes: 5 })).rejects.toThrow(/400 buckets/);
		await expect(store.query("perf-client", DAY_RANGE, { by: "os" as never })).rejects.toThrow(/by must be/);
	});
});

// perf-server ------------------------------------------------------------------------------------------------------------

describe("perf-server", () => {
	test("TPS from the Heartbeat rate, physics FPS, memory; players summed over servers per bucket", async () => {
		const r = await store.query("perf-server", DAY_RANGE, { bucketMinutes: 60 });
		const rows = serverRows(DAY_RANGE.from, DAY_RANGE.to);
		expect(r.overall.samples).toBe(rows.length);
		expect(r.overall.servers).toBe(3);
		expect(pick(r.overall.metrics.tps)).toEqual(ref(rows, "hb", 1000, true));
		expect(pick(r.overall.metrics.physFps)).toEqual(ref(rows, "fps", 1000, true));
		expect(pick(r.overall.metrics.mem)).toEqual(ref(rows, "mem", 1_000_000, false));
		expect(r.bucketMs).toBe(HOUR);
		// The last hour: job-1 has 10, job-2 averages 5 (4, 5, 6), job-3 has 1.
		const last = r.series.at(-1) as (typeof r.series)[number];
		expect(last.t).toBe(NOW - HOUR);
		expect(last.servers).toBe(3);
		expect(last.players).toBeCloseTo(16, 0);
	});

	test("by build and branch; player filters don't apply to server rows; no device groups", async () => {
		const byArt = await store.query("perf-server", DAY_RANGE, { by: "art" });
		expect(byArt.groups.map((g) => g.key).sort()).toEqual([ART_A, ART_B, ART_C]);
		const b = byArt.groups.find((g) => g.key === ART_B) as (typeof byArt.groups)[number];
		expect(pick(b.metrics.tps)).toEqual(ref(serverRows(DAY_RANGE.from, DAY_RANGE.to, (e) => e.art === ART_B), "hb", 1000, true));
		const prod = await store.query("perf-server", { ...DAY_RANGE, branch: "prod", dev: "phone", players: "new" }, {});
		expect(prod.overall.samples).toBe(serverRows(DAY_RANGE.from, DAY_RANGE.to, (e) => e.branch === "prod").length);
		await expect(store.query("perf-server", DAY_RANGE, { by: "dev" })).rejects.toThrow(/by must be one of none, branch, art/);
	});
});

// perf-compare -----------------------------------------------------------------------------------------------------------

describe("perf-compare", () => {
	test("builds: by default the busiest builds, newest (highest seq) first, client and server side by side", async () => {
		const r = await store.query("perf-compare", DAY_RANGE, {});
		expect(r.mode).toBe("builds");
		expect(r.periods.map((p) => p.key)).toEqual([ART_C, ART_B, ART_A]);
		const b = r.periods[1];
		expect(b.seq).toBe(51);
		const rows = clientRows(DAY_RANGE.from, DAY_RANGE.to, (e) => e.art === ART_B);
		expect(b.client.samples).toBe(rows.length);
		expect(pick(b.client.metrics.fps)).toEqual(ref(rows, "fps", 1000, true));
		expect(pick(b.server.metrics.tps)).toEqual(ref(serverRows(DAY_RANGE.from, DAY_RANGE.to, (e) => e.art === ART_B), "hb", 1000, true));
		expect(b.server.servers).toBe(2);
		// Build C ran on servers only.
		expect(r.periods[0].client.samples).toBe(0);
		expect(r.periods[0].client.metrics.fps.p50).toBeNull();
	});

	test("builds: the ones asked for, in that order", async () => {
		const r = await store.query("perf-compare", DAY_RANGE, { arts: [ART_A, ART_B] });
		expect(r.periods.map((p) => p.key)).toEqual([ART_A, ART_B]);
		expect(r.periods[1].client.metrics.fps.p50 as number).toBeLessThan(r.periods[0].client.metrics.fps.p50 as number);
		await expect(store.query("perf-compare", DAY_RANGE, { arts: ["a", "b", "c", "d", "e", "f", "g"] })).rejects.toThrow(/at most 6/);
		await expect(store.query("perf-compare", DAY_RANGE, { arts: ["no spaces"] })).rejects.toThrow(/artifact ids/);
	});

	test("around a deploy: two equal windows, before and after; the build filter doesn't apply", async () => {
		const r = await store.query("perf-compare", { art: ART_B }, { mode: "around", at: DEPLOY, hours: 6 });
		expect(r.windowMs).toBe(6 * HOUR);
		expect(r.at).toBe(new Date(DEPLOY).toISOString());
		const [before, after] = r.periods;
		expect([before.key, after.key]).toEqual(["before", "after"]);
		expect(Date.parse(before.from)).toBe(DEPLOY - 6 * HOUR);
		expect(Date.parse(after.to)).toBe(DEPLOY + 6 * HOUR);
		const pre = clientRows(DEPLOY - 6 * HOUR, DEPLOY);
		expect(before.client.samples).toBe(pre.length);
		expect(pick(before.client.metrics.fps)).toEqual(ref(pre, "fps", 1000, true));
		expect(pick(after.server.metrics.tps)).toEqual(ref(serverRows(DEPLOY, DEPLOY + 6 * HOUR), "hb", 1000, true));
		expect(after.server.metrics.tps.p50 as number).toBeLessThan(before.server.metrics.tps.p50 as number);
		// Shortened to the time since `at` (both windows), and refused right after it.
		const recent = await store.query("perf-compare", {}, { mode: "around", at: NOW - 2 * HOUR, hours: 24 });
		expect(recent.windowMs).toBe(2 * HOUR);
		await expect(store.query("perf-compare", {}, { mode: "around", at: NOW - 2 * MIN })).rejects.toThrow(/5 minutes/);
		await expect(store.query("perf-compare", {}, { mode: "around" })).rejects.toThrow(/needs at/);
		await expect(store.query("perf-compare", {}, { mode: "sideways" as never })).rejects.toThrow(/mode/);
	});
});

// Basin ------------------------------------------------------------------------------------------------------------------

describe("Basin SQL gives the same answers (run on DuckDB through shims)", () => {
	const basin = () =>
		new BasinStore({
			accountId: "0123456789abcdef0123456789abcdef",
			bucket: "typetorch-analytics",
			token: "test-token-not-a-secret-123",
			clock: () => NOW,
			fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
				const query = JSON.parse(String(init?.body)).query as string;
				try {
					return new Response(JSON.stringify({ success: true, errors: [], result: { rows: await readRows(connection, query) } }), { status: 200 });
				} catch (error) {
					return new Response(JSON.stringify({ success: false, errors: [{ code: 40004, message: String(error) }] }), { status: 400 });
				}
			}) as typeof fetch,
		});

	test.each([
		["perf-client", { by: "screen" }],
		["perf-client", { by: "dev", bucketMinutes: 60 }],
		["perf-server", { by: "art" }],
		["perf-compare", {}],
		["perf-compare", { mode: "around", at: DEPLOY, hours: 3 }],
	] as const)("%s %o", async (name, options) => {
		const expected = await store.query(name, DAY_RANGE, options as never);
		const got = await basin().query(name, DAY_RANGE, options as never);
		expect(JSON.parse(JSON.stringify(got))).toEqual(JSON.parse(JSON.stringify(expected)));
		const sql = Object.values(basin().render(name, DAY_RANGE, options as never).statements).join("\n");
		expect(sql).toContain("approx_percentile_cont(");
		expect(sql).not.toContain("quantile_cont(x");
	});
});
