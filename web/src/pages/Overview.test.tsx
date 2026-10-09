import { describe, expect, it } from "vitest";
import { fillSteps } from "@/components/DayBars";
import type { OverviewResult } from "@/lib/types";
import { overviewBars } from "./Overview";

const T = Date.UTC(2026, 9, 9, 12, 0, 0);
const MIN = 60_000;

function result(over: Partial<OverviewResult>): OverviewResult {
	return {
		from: new Date(T - 60 * MIN).toISOString(),
		to: new Date(T).toISOString(),
		players: 3,
		newPlayers: 1,
		returningPlayers: 2,
		sessions: 4,
		events: 40,
		playtimeHours: 1,
		avgSessionMinutes: 15,
		playtimePerPlayerMinutes: 20,
		days: [{ date: "2026-10-09", players: 3, newPlayers: 1, sessions: 4, playtimeHours: 1 }],
		...over,
	};
}

describe("overview charts by window", () => {
	it("the last hour: one bar a minute, empty minutes as zero, the axis in hh:mm", () => {
		const r = result({
			bucketMs: MIN,
			buckets: [
				{ t: T - 30 * MIN, time: "", players: 2, newPlayers: 1, sessions: 3, playtimeHours: 0.5 },
				{ t: T - 5 * MIN, time: "", players: 1, newPlayers: 0, sessions: 1, playtimeHours: 0.1 },
			],
		});
		const { points, per } = overviewBars(r, "sessions");
		expect(per).toBe("per 1 min (UTC), by the time a session started");
		expect(points).toHaveLength(60);
		expect(points[0]).toEqual({ date: "2026-10-09 11:00", value: 0 });
		expect(points.find((p) => p.date === "2026-10-09 11:30")?.value).toBe(3);
		expect(points.reduce((s, p) => s + p.value, 0)).toBe(4);
	});

	it("longer windows (and older backends without buckets) stay per day", () => {
		const week = result({ from: "2026-10-03T00:00:00.000Z", bucketMs: 86_400_000 });
		expect(overviewBars(week, "players").per).toBe("per day (UTC), by the day a session started");
		expect(overviewBars(week, "players").points).toHaveLength(7);
		expect(overviewBars(result({}), "players").per).toMatch(/per day/);
	});

	it("never more than 400 steps", () => {
		expect(fillSteps([{ t: T, value: 1 }], T - 1000 * MIN, T, MIN)).toEqual([{ date: "2026-10-09 12:00", value: 1 }]);
	});
});
