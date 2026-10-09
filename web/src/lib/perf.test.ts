import { describe, expect, it } from "vitest";
import {
	bucketText,
	bucketTimes,
	delta,
	fmtDelta,
	fmtMetric,
	groupLabel,
	markDetails,
	marksIn,
	markTitle,
	PERCENTILE_HELP,
	PERCENTILES,
	percentileName,
	pivot,
	rangeMs,
	seriesOf,
	timeTick,
	WORST_PERCENTILE,
	type DeployMark,
	type PerfSeriesResult,
} from "./perf";

const H = 3_600_000;
const T = Date.UTC(2026, 9, 9, 0, 0, 0);
const stat = (p50: number | null, p90: number | null = p50, p99: number | null = p90, p10: number | null = p50) => ({ p10, p50, p90, p99, avg: p50, n: p50 === null ? 0 : 10 });

const result: PerfSeriesResult = {
	side: "server",
	from: new Date(T).toISOString(),
	to: new Date(T + 4 * H).toISOString(),
	fromMs: T,
	toMs: T + 4 * H,
	bucketMs: H,
	by: "art",
	metrics: [{ key: "tps", higherIsBetter: true }],
	overall: { key: "all", samples: 4, servers: 2, seq: 42, firstSeen: null, lastSeen: null, metrics: { tps: stat(60) } },
	groups: [
		{ key: "e4f5a6b-222222", samples: 3, servers: 2, seq: 42, firstSeen: null, lastSeen: null, metrics: { tps: stat(58) } },
		{ key: "a1b2c3d-111111", samples: 1, servers: 1, seq: 41, firstSeen: null, lastSeen: null, metrics: { tps: stat(60) } },
	],
	groupsTotal: 2,
	series: [
		{ t: T, key: "a1b2c3d-111111", samples: 1, metrics: { tps: stat(60, 59, 59, 59) }, players: 10, servers: 1 },
		{ t: T + 2 * H, key: "e4f5a6b-222222", samples: 2, metrics: { tps: stat(58, 50, 44, 51) }, players: 21.5, servers: 2 },
		{ t: T + 3 * H, key: "e4f5a6b-222222", samples: 1, metrics: { tps: stat(57, 49, 43, 50) }, players: 20, servers: 2 },
	],
};

describe("series", () => {
	it("pivots into one row per bucket with a CSS-safe id per group; gaps are null", () => {
		expect(seriesOf(result).map((s) => [s.id, s.label])).toEqual([
			["s0", "e4f5a6b-222222 #42"],
			["s1", "a1b2c3d-111111 #41"],
		]);
		expect(pivot(result, "tps", "p90")).toEqual([
			{ t: T, s0: null, s1: 59 },
			{ t: T + H, s0: null, s1: null },
			{ t: T + 2 * H, s0: 50, s1: null },
			{ t: T + 3 * H, s0: 49, s1: null },
		]);
		expect(pivot(result, "", "players").map((r) => r.s0)).toEqual([null, null, 21.5, 20]);
	});

	it("pivots p10 and the worst case (p99) like the other percentiles", () => {
		expect(pivot(result, "tps", "p10").map((r) => [r.s0, r.s1])).toEqual([
			[null, 59],
			[null, null],
			[51, null],
			[50, null],
		]);
		expect(pivot(result, "tps", WORST_PERCENTILE).map((r) => r.s0)).toEqual([null, null, 44, 43]);
	});

	it("lists p10 first, names the worst case, explains each percentile", () => {
		expect(PERCENTILES).toEqual(["p10", "p50", "p90", "p99"]);
		expect(WORST_PERCENTILE).toBe("p99");
		expect(PERCENTILES.map(percentileName)).toEqual(["p10", "p50", "p90", "p99 (worst)"]);
		for (const p of PERCENTILES) expect(PERCENTILE_HELP[p].length).toBeGreaterThan(10);
		expect(PERCENTILE_HELP.p10).toMatch(/10%/);
		expect(PERCENTILE_HELP.p99).toMatch(/worst/);
	});

	it("bucket times stop at the end and at 400", () => {
		expect(bucketTimes(T + 30 * 60_000, T + 3 * H, H)).toEqual([T, T + H, T + 2 * H]);
		expect(bucketTimes(0, 1e12, 60_000)).toHaveLength(400);
		expect(bucketTimes(0, 10, 0)).toEqual([]);
	});

	it("names buckets, ticks and groups", () => {
		expect(bucketText(15 * 60_000)).toBe("15 min");
		expect(bucketText(2 * H)).toBe("2 h");
		expect(bucketText(24 * H)).toBe("1 d");
		expect(timeTick(T + 14 * H, 24 * H)).toBe("10-09 14:00");
		expect(timeTick(T + 14 * H, 30 * 24 * H)).toBe("10-09");
		expect(groupLabel("dev", "phone")).toBe("Phone");
		expect(groupLabel("screen", "<400")).toBe("Under 400 pt");
		expect(groupLabel("input", "kbm")).toBe("Keyboard and mouse");
		expect(groupLabel("branch", "feature-x")).toBe("feature-x");
		expect(groupLabel("none", "all")).toBe("All");
	});

	it("formats metrics with their units", () => {
		expect(fmtMetric("fps", 59.6)).toBe("60 fps");
		expect(fmtMetric("mem", 1234.4)).toBe("1,234 MB");
		expect(fmtMetric("tps", 59.94)).toBe("59.9/s");
		expect(fmtMetric("ping", null)).toBe("–");
		expect(fmtMetric("players", 12)).toBe("12");
	});
});

describe("marks", () => {
	const deploy: DeployMark = {
		id: "deploy:42",
		kind: "deploy",
		at: T + 2 * H,
		time: new Date(T + 2 * H).toISOString(),
		branch: "prod",
		seq: 42,
		artifact: "e4f5a6b-222222",
		channel: "prod",
		from: "a1b2c3d-111111",
		kernel: null,
		placeVersion: null,
		message: "new shop",
		results: { swapped: 3, rolled_back: 1 },
	};
	const kernel: DeployMark = { ...deploy, id: "mark:1", kind: "kernel", seq: null, artifact: null, branch: null, from: null, kernel: "0.4.0", placeVersion: 23, message: null, results: undefined };

	it("titles and details", () => {
		expect(markTitle(deploy)).toBe("Deploy #42 prod e4f5a6b-222222");
		expect(markTitle(kernel)).toBe("Kernel publish 0.4.0");
		expect(markTitle({ ...deploy, kind: "rollback" })).toBe("Rollback #42 prod e4f5a6b-222222");
		expect(markDetails(deploy)).toEqual(["2026-10-09 02:00:00 UTC", "from a1b2c3d-111111", "3 swapped, 1 rolled back", "new shop"]);
		expect(markDetails(kernel)).toEqual(["2026-10-09 02:00:00 UTC", "place version 23"]);
		expect(markDetails({ ...deploy, inferred: true, results: {}, from: null, message: null })).toEqual(["2026-10-09 02:00:00 UTC", "known from server reports only"]);
		expect(marksIn([deploy, kernel], T, T + 2 * H)).toEqual([]);
		expect(marksIn([deploy], T, T + 3 * H)).toEqual([deploy]);
	});
});

describe("comparing", () => {
	it("says whether a change is better, by the metric's direction", () => {
		expect(delta(60, 50, true)).toEqual({ pct: (-10 / 60) * 100, better: false });
		expect(delta(1000, 900, false)?.better).toBe(true);
		expect(delta(100, 100.2, true)?.better).toBeNull();
		expect(delta(0, 5, true)).toBeNull();
		expect(delta(null, 5, true)).toBeNull();
		expect(fmtDelta(delta(60, 50, true))).toBe("-16.7%");
		expect(fmtDelta(delta(50, 60, true))).toBe("+20%");
		expect(fmtDelta(null)).toBe("–");
	});

	it("resolves the filter range like the backend", () => {
		expect(rangeMs({ from: "2026-10-01" }, T)).toEqual({ from: Date.UTC(2026, 9, 1), to: T });
		expect(rangeMs({ from: "2026-10-01", to: "2026-10-05" }, T)).toEqual({ from: Date.UTC(2026, 9, 1), to: Date.UTC(2026, 9, 6) });
		expect(rangeMs({}, T)).toEqual({ from: T - 7 * 24 * H, to: T });
	});
});
