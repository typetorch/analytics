// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataTable, type DataColumn } from "@/components/data-table";
import type { FleetServer } from "@/lib/types";
import { budgetPressure, SERVER_COLUMNS } from "./Fleet";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const server = (job: string, over: Partial<FleetServer> & { tps?: number | null; memoryMb?: number | null } = {}): FleetServer & { tps: number | null; memoryMb: number | null } => ({
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
	kernel: "0.4.0",
	experiment: false,
	tps: null,
	memoryMb: null,
	...over,
});

const servers = [
	server("job-a", { players: 47, health: "ok", tps: 59.8, memoryMb: 812, budget: { ds: { r: 30, lr: 60 }, h: { r: 10, l: 500 } }, lastSeen: "2026-10-09T11:59:30Z" }),
	server("job-b", { players: 5, health: "failing", tps: 12, memoryMb: 95, budget: { ds: { r: 59, lr: 60 } }, lastSeen: "2026-10-09T09:00:00Z" }),
	server("job-c", { players: 110, maxPlayers: 120, health: "degraded", tps: null, memoryMb: null, lastSeen: "2026-10-08T12:00:00Z" }),
	server("job-d", { players: 9, health: "ok", tps: 30.5, memoryMb: 1203, budget: { h: { r: 400, l: 500 } }, lastSeen: "2026-10-09T11:00:00Z" }),
];

// What the /servers branch adds: TPS and memory, each with a number to sort by and its own text to show.
type Row = (typeof servers)[number];
const extra: DataColumn<Row>[] = [
	{ id: "tps", header: "TPS", hint: "avg", accessor: (s) => s.tps, cell: (s) => (s.tps === null ? "–" : s.tps.toFixed(1)) },
	{ id: "memory", header: "Memory", hint: "MB", accessor: (s) => s.memoryMb, cell: (s) => (s.memoryMb === null ? "–" : `${s.memoryMb} MB`) },
];

function mount() {
	return render(
		<MemoryRouter>
			<DataTable<Row> id="fleet-servers" columns={[...SERVER_COLUMNS, ...extra] as DataColumn<Row>[]} data={servers} rowId={(s) => s.job} />
		</MemoryRouter>,
	);
}

/** The Job cell of each body row (the id is shortened, so job-a stays job-a). */
const jobs = () => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelector("td")?.textContent ?? "");
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

	it("sorts a TPS column and a memory column added next to the real ones by their numbers, rows without a value last", () => {
		mount();
		sortBy("TPS");
		expect(jobs()).toEqual(["job-a", "job-d", "job-b", "job-c"]);
		sortBy("TPS");
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
		sortBy("Memory");
		expect(jobs()).toEqual(["job-d", "job-a", "job-b", "job-c"]);
		sortBy("Memory");
		expect(jobs()).toEqual(["job-b", "job-a", "job-d", "job-c"]);
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

	it("sorts the budget by the share of the tightest limit in use", () => {
		expect(budgetPressure(null)).toBeNull();
		expect(budgetPressure({ ds: { r: 30, lr: 60 }, h: { r: 10, l: 500 } })).toBe(0.5);
		expect(budgetPressure({ h: { r: 400, l: 500 } })).toBe(0.8);
		expect(budgetPressure({ mem: { t: 400 } })).toBeNull();
		mount();
		sortBy("Budget");
		// job-b 59/60, job-d 400/500, job-a 30/60; job-c has no budget.
		expect(jobs()).toEqual(["job-b", "job-d", "job-a", "job-c"]);
	});

	it("has the extra columns in the picker (channel, max players, place...), hidden until turned on", () => {
		mount();
		expect(screen.queryByRole("columnheader", { name: /Channel/ })).toBeNull();
		expect(screen.queryByRole("columnheader", { name: /Last error/ })).toBeNull();
		expect(screen.getByRole("columnheader", { name: /Health/ })).toBeTruthy();
	});
});
