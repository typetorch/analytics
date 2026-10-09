// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataTable } from "@/components/data-table";
import type { FleetServer } from "@/lib/types";
import { budgetPressure, budgetText, memoryHigh, SERVER_COLUMNS, tpsLow, tpsText } from "./Fleet";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const server = (job: string, over: Partial<FleetServer> = {}): FleetServer => ({
	job,
	serverType: "public",
	branch: "prod",
	artifact: "a1",
	players: 10,
	maxPlayers: 60,
	startedAt: "2026-10-09T08:00:00Z",
	lastSeen: "2026-10-09T11:59:00Z",
	appliedSeq: 5,
	generation: 1,
	health: "ok",
	lastError: null,
	kernel: "0.4.2",
	experiment: false,
	...over,
});

// Kernel 0.4.2 rows carry tps / tpsMin / physFps / memMb / luaMb; job-c is an older kernel (none of them).
const servers = [
	server("job-a", { players: 47, health: "ok", tps: 59.8, tpsMin: 52, physFps: 60, memMb: 812, luaMb: 140.5, budget: { ds: { r: 30, lr: 60 }, h: { r: 10, l: 500 } }, lastSeen: "2026-10-09T11:59:30Z" }),
	server("job-b", { players: 5, health: "failing", tps: 12, tpsMin: 3.5, physFps: 20, memMb: 95, luaMb: 30, budget: { ds: { r: 59, lr: 60 } }, lastSeen: "2026-10-09T09:00:00Z" }),
	server("job-c", { players: 110, maxPlayers: 120, health: "degraded", kernel: "0.4.0", lastSeen: "2026-10-08T12:00:00Z" }),
	server("job-d", { players: 9, health: "ok", tps: 30.5, tpsMin: 55, physFps: 59, memMb: 3203, luaMb: null, budget: { h: { r: 400, l: 500 } }, lastSeen: "2026-10-09T11:00:00Z" }),
];

function mount(rows: FleetServer[] = servers) {
	return render(
		<MemoryRouter>
			<DataTable<FleetServer> id="fleet-servers" columns={SERVER_COLUMNS} data={rows} rowId={(s) => s.job} />
		</MemoryRouter>,
	);
}

/** The Job cell of each body row (the id is shortened, so job-a stays job-a). */
const jobs = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")?.textContent ?? "");
/** The text of one column's cells, top to bottom. */
const cells = (header: string) => {
	const index = Array.from(document.querySelectorAll("thead th")).findIndex((th) => th.textContent?.startsWith(header));
	return Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[index]?.textContent ?? "");
};
const sortBy = (name: string, options?: { shiftKey?: boolean }) => fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }), options);

describe("the fleet servers table", () => {
	it("shows players as '47 / 60' but sorts them by the number", () => {
		mount();
		expect(screen.getByText("47 / 60")).toBeTruthy();
		sortBy("Players");
		expect(jobs()).toEqual(["job-c", "job-a", "job-d", "job-b"]);
		sortBy("Players");
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
	});

	it("shows TPS as 'average / slowest second' and memory in MB, '–' for an older kernel", () => {
		mount();
		expect(cells("TPS")).toEqual(["59.8 / 52.0", "12.0 / 3.5(warning)", "–", "30.5 / 55.0(warning)"]);
		expect(cells("Memory")).toEqual(["812", "95", "–", "3,203(warning)"]);
		expect(tpsText(servers[0])).toBe("59.8 / 52.0");
		expect(tpsText(servers[2])).toBe("–");
		expect(tpsText(server("x", { tps: 60 }))).toBe("60.0");
	});

	it("sorts TPS by the average, slowest first, and memory by the number, biggest first; rows without a value last", () => {
		mount();
		sortBy("TPS");
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
		sortBy("TPS");
		expect(jobs()).toEqual(["job-a", "job-d", "job-b", "job-c"]);
		sortBy("TPS"); // off
		sortBy("Memory");
		expect(jobs()).toEqual(["job-d", "job-a", "job-b", "job-c"]);
		sortBy("Memory");
		expect(jobs()).toEqual(["job-b", "job-a", "job-d", "job-c"]);
	});

	it("warns under 50 TPS and over 3,000 MB, never for an unknown reading", () => {
		expect(tpsLow(49.9)).toBe(true);
		expect(tpsLow(50)).toBe(false);
		expect(tpsLow(null)).toBe(false);
		expect(tpsLow(undefined)).toBe(false);
		expect(memoryHigh(3001)).toBe(true);
		expect(memoryHigh(3000)).toBe(false);
		expect(memoryHigh(null)).toBe(false);
		mount();
		// The tooltip says why (colour never carries the meaning alone).
		expect(screen.getByTitle(/average 12\.0, slowest second 3\.5, physics 20 FPS \(under 50\)/)).toBeTruthy();
		expect(screen.getByTitle(/Total 3,203 MB, Lua heap \? \(over 3,000 MB\)/)).toBeTruthy();
		expect(screen.getByTitle(/Total 812 MB, Lua heap 140\.5 MB$/)).toBeTruthy();
	});

	it("puts the worst health first on the first click, and sorts 'Seen' by the heartbeat time", () => {
		mount();
		sortBy("Health");
		expect(jobs()[0]).toBe("job-b");
		expect(jobs()[1]).toBe("job-c");
		sortBy("Health"); // asc
		sortBy("Health"); // off
		sortBy("Seen");
		expect(jobs()).toEqual(["job-a", "job-d", "job-b", "job-c"]);
	});

	it("sorts the budget by the share of the tightest limit in use; memory is not repeated in its text", () => {
		expect(budgetPressure(null)).toBeNull();
		expect(budgetPressure({ ds: { r: 30, lr: 60 }, h: { r: 10, l: 500 } })).toBe(0.5);
		expect(budgetPressure({ h: { r: 400, l: 500 } })).toBe(0.8);
		expect(budgetPressure({ mem: { t: 400 } })).toBeNull();
		expect(budgetText({ ds: { r: 30, lr: 60 }, mem: { t: 812 } })).toBe("DS 30/60");
		mount();
		sortBy("Budget");
		// job-b 59/60, job-d 400/500, job-a 30/60; job-c has no budget.
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
	});

	it("has the extra columns in the picker (channel, TPS min, physics, Lua heap...), hidden until turned on", () => {
		mount();
		expect(screen.queryByRole("columnheader", { name: /Channel/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Last error/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /TPS min/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Physics/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Lua heap/ })).toBeNull();
		expect(screen.getByRole("columnheader", { name: /Health/ })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: /^TPS/ })).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: /Memory/ })).toBeTruthy();
	});
});
