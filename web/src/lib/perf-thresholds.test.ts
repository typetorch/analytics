// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { HIGH_MEMORY_MB, LOW_TPS } from "@/pages/Fleet";
import { ABSOLUTE_RULES, absoluteFlag, isJudged, MIN_SAMPLES, REGRESSION_PCT, regression, thresholdText } from "./perf-thresholds";

const level = (...args: Parameters<typeof absoluteFlag>) => absoluteFlag(...args)?.level ?? null;

describe("absolute lines on the worst-case percentile", () => {
	it("client fps is judged at p10, low is bad: under 30 orange, under 20 red", () => {
		expect(level("client", "fps", "p10", 45)).toBeNull();
		expect(level("client", "fps", "p10", 30)).toBeNull(); // the line itself is fine
		expect(level("client", "fps", "p10", 29.9)).toBe("warning");
		expect(level("client", "fps", "p10", 20)).toBe("warning");
		expect(level("client", "fps", "p10", 19.9)).toBe("critical");
		expect(level("client", "fps", "p10", 0)).toBe("critical");
	});

	it("server TPS and physics FPS at p10: under 50 orange, under 40 red", () => {
		for (const metric of ["tps", "physFps"]) {
			expect(level("server", metric, "p10", 60)).toBeNull();
			expect(level("server", metric, "p10", 50)).toBeNull();
			expect(level("server", metric, "p10", 49.9)).toBe("warning");
			expect(level("server", metric, "p10", 40)).toBe("warning");
			expect(level("server", metric, "p10", 39.9)).toBe("critical");
		}
	});

	it("ping and memory are judged at p90 and p99, high is bad", () => {
		for (const p of ["p90", "p99"] as const) {
			expect(level("client", "ping", p, 150)).toBeNull();
			expect(level("client", "ping", p, 150.1)).toBe("warning");
			expect(level("client", "ping", p, 250)).toBe("warning");
			expect(level("client", "ping", p, 250.1)).toBe("critical");
			expect(level("client", "mem", p, 2000)).toBeNull();
			expect(level("client", "mem", p, 2001)).toBe("warning");
			expect(level("client", "mem", p, 3001)).toBe("critical");
			expect(level("server", "mem", p, 3000)).toBeNull();
			expect(level("server", "mem", p, 3001)).toBe("warning");
			expect(level("server", "mem", p, 5000)).toBe("warning");
			expect(level("server", "mem", p, 5001)).toBe("critical");
		}
	});

	it("only the worst-case percentiles are judged; a live reading uses the same lines", () => {
		// fps is judged at p10 only (p90 / p99 are the bad side's other names for the same tail); ping / memory never at p10 or p50.
		expect(level("client", "fps", "p50", 5)).toBeNull();
		expect(level("client", "fps", "p90", 5)).toBeNull();
		expect(level("client", "fps", "p99", 5)).toBeNull();
		expect(level("client", "ping", "p10", 900)).toBeNull();
		expect(level("client", "ping", "p50", 900)).toBeNull();
		expect(level("client", "mem", "p50", 9000)).toBeNull();
		expect(isJudged("client", "fps", "p10")).toBe(true);
		expect(isJudged("client", "fps", "p50")).toBe(false);
		expect(isJudged("client", "players", "p10")).toBe(false);
		expect(level("server", "tps", null, 35)).toBe("critical");
		expect(level("server", "physFps", null, 45)).toBe("warning");
		expect(level("server", "mem", null, 6000)).toBe("critical");
		expect(level("server", "tps", null, 59.8)).toBeNull();
	});

	it("says why: the value, the line it crossed and the next one", () => {
		expect(absoluteFlag("client", "fps", "p10", 24)?.why).toBe("Frame rate p10 is 24 fps: under the 30 fps warning line (under 20 fps is critical)");
		expect(absoluteFlag("client", "fps", "p10", 12)?.why).toBe("Frame rate p10 is 12 fps: under the 20 fps critical line");
		expect(absoluteFlag("server", "mem", "p99", 5200)?.why).toBe("Server memory p99 is 5,200 MB: over the 5,000 MB critical line");
		expect(absoluteFlag("server", "tps", null, 45)?.why).toBe("Server TPS is 45/s: under the 50/s warning line (under 40/s is critical)");
		expect(thresholdText("client", "fps", "p10")).toBe("flagged under 30 fps (orange) and under 20 fps (red)");
		expect(thresholdText("client", "ping", "p99")).toBe("flagged over 150 ms (orange) and over 250 ms (red)");
		expect(thresholdText("client", "fps", "p50")).toBeNull();
	});

	it("flags nothing from too few samples, nor from a missing value or an unknown metric", () => {
		expect(MIN_SAMPLES).toBe(20);
		expect(level("client", "fps", "p10", 5, MIN_SAMPLES - 1)).toBeNull();
		expect(level("client", "fps", "p10", 5, MIN_SAMPLES)).toBe("critical");
		expect(level("client", "fps", "p10", 5, 0)).toBeNull();
		expect(level("client", "fps", "p10", null)).toBeNull();
		expect(level("client", "fps", "p10", undefined)).toBeNull();
		expect(level("client", "fps", "p10", Number.NaN)).toBeNull();
		expect(level("client", "gpu", "p10", 1)).toBeNull();
	});

	it("keeps the Fleet table's own lines: 50 TPS and 3,000 MB", () => {
		expect(ABSOLUTE_RULES.server.tps.warning).toBe(LOW_TPS);
		expect(ABSOLUTE_RULES.server.mem.warning).toBe(HIGH_MEMORY_MB);
	});

	it("every rule is ordered: the red line is further out than the orange one, in the metric's direction", () => {
		for (const side of Object.values(ABSOLUTE_RULES)) {
			for (const rule of Object.values(side)) {
				expect(rule.higherIsBetter ? rule.critical < rule.warning : rule.critical > rule.warning).toBe(true);
				expect(rule.percentiles.length).toBeGreaterThan(0);
			}
		}
	});
});

describe("regressions between two periods", () => {
	const N = 100;

	it("lower fps / TPS is worse: over 10% orange, over 25% red; at the line it is plain worse", () => {
		expect(regression(60, 59, true, N, N)).toMatchObject({ kind: "worse", level: null }); // 1.7%
		expect(REGRESSION_PCT).toEqual({ warning: 10, critical: 25 });
		expect(regression(60, 54, true, N, N)).toMatchObject({ kind: "worse", level: null }); // exactly 10%
		expect(regression(60, 53, true, N, N)).toMatchObject({ kind: "worse", level: "warning" }); // 11.7%
		expect(regression(60, 45, true, N, N)).toMatchObject({ kind: "worse", level: "warning" }); // exactly 25%
		expect(regression(60, 44, true, N, N)).toMatchObject({ kind: "worse", level: "critical" }); // 26.7%
		expect(regression(60, 30, true, N, N)).toMatchObject({ kind: "worse", level: "critical" });
	});

	it("is direction-aware: higher memory / ping is worse, lower is better", () => {
		expect(regression(1000, 1300, false, N, N)).toMatchObject({ kind: "worse", level: "critical" });
		expect(regression(1000, 1150, false, N, N)).toMatchObject({ kind: "worse", level: "warning" });
		expect(regression(1000, 1100, false, N, N)).toMatchObject({ kind: "worse", level: null });
		expect(regression(1000, 800, false, N, N)).toMatchObject({ kind: "better" });
		expect(regression(40, 50, true, N, N)).toMatchObject({ kind: "better" });
		// A big drop in memory is an improvement, however large; a big rise in fps too.
		expect(regression(3000, 1000, false, N, N)?.kind).toBe("better");
		expect(regression(30, 60, true, N, N)?.kind).toBe("better");
	});

	it("says nothing for a change under half a percent or without both numbers", () => {
		expect(regression(100, 100.2, true, N, N)).toBeNull();
		expect(regression(null, 5, true, N, N)).toBeNull();
		expect(regression(5, null, true, N, N)).toBeNull();
		expect(regression(0, 5, true, N, N)).toBeNull();
	});

	it("does not flag from fewer than 20 samples on either side: it says there are few", () => {
		expect(regression(60, 30, true, MIN_SAMPLES - 1, N)).toMatchObject({ kind: "few" });
		expect(regression(60, 30, true, N, MIN_SAMPLES - 1)).toMatchObject({ kind: "few" });
		expect(regression(60, 30, true, 0, N)).toMatchObject({ kind: "few" });
		expect(regression(1000, 2000, false, 5, 5)).toMatchObject({ kind: "few" });
		expect(regression(60, 30, true, MIN_SAMPLES, MIN_SAMPLES)).toMatchObject({ kind: "worse", level: "critical" });
		// An improvement from few samples isn't celebrated either.
		expect(regression(30, 60, true, 3, N)).toMatchObject({ kind: "few" });
		// Nothing to compare (a missing number): nothing to say. An unchanged number from few samples still says it is few.
		expect(regression(null, 60, true, 3, N)).toBeNull();
		expect(regression(100, 100.2, true, 3, N)).toMatchObject({ kind: "few" });
	});

	it("explains the verdict", () => {
		expect(regression(60, 50, true, N, N)?.why).toBe("16.7% worse (over 10% is a warning, over 25% is critical)");
		expect(regression(1000, 900, false, N, N)?.why).toBe("10% better");
		expect(regression(60, 30, true, 12, 40)?.why).toBe("Fewer than 20 samples on one side (12 and 40): too few to judge the change.");
	});
});
