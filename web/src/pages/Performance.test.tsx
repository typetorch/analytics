// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { DeployMark, PerfCompareResult, PerfSeriesResult, PerfServer, PerfStat } from "@/lib/perf";
import type { Filters } from "@/lib/types";
import Performance, { historyRows } from "./Performance";

beforeAll(() => {
	// recharts measures its container: give it a size, so the charts (and their marks) render in jsdom.
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
	const rect = Element.prototype.getBoundingClientRect;
	Element.prototype.getBoundingClientRect = function (this: Element) {
		return this.classList?.contains("recharts-responsive-container") ? ({ width: 600, height: 224, top: 0, left: 0, right: 600, bottom: 224, x: 0, y: 0, toJSON() {} } as DOMRect) : rect.call(this);
	};
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const H = 3_600_000;
const T = Date.UTC(2026, 9, 8, 0, 0, 0);
const ART_OLD = "a1b2c3d-111111";
const ART_NEW = "e4f5a6b-222222";
const s = (p50: number, p90: number, p99: number): PerfStat => ({ p50, p90, p99, avg: p50, n: 50 });

function clientResult(by: string): PerfSeriesResult {
	const metrics = (fps: number) => ({ fps: s(fps, fps - 12, fps - 25), mem: s(1800, 2600, 3100), ping: s(80, 190, 420) });
	return {
		side: "client",
		from: new Date(T).toISOString(),
		to: new Date(T + 24 * H).toISOString(),
		fromMs: T,
		toMs: T + 24 * H,
		bucketMs: H,
		by: by as PerfSeriesResult["by"],
		metrics: [
			{ key: "fps", higherIsBetter: true },
			{ key: "mem", higherIsBetter: false },
			{ key: "ping", higherIsBetter: false },
		],
		overall: { key: "all", samples: 300, sessions: 40, players: 30, seq: 42, firstSeen: null, lastSeen: null, metrics: metrics(50) },
		groups:
			by === "dev"
				? [
						{ key: "phone", samples: 200, sessions: 25, players: 20, seq: 42, firstSeen: null, lastSeen: null, metrics: metrics(31) },
						{ key: "desktop", samples: 100, sessions: 15, players: 10, seq: 42, firstSeen: null, lastSeen: null, metrics: metrics(61) },
					]
				: [{ key: "all", samples: 300, sessions: 40, players: 30, seq: 42, firstSeen: null, lastSeen: null, metrics: metrics(50) }],
		groupsTotal: by === "dev" ? 2 : 1,
		series: [
			{ t: T + H, key: by === "dev" ? "phone" : "all", samples: 20, metrics: metrics(30) },
			{ t: T + 5 * H, key: by === "dev" ? "phone" : "all", samples: 20, metrics: metrics(28) },
		],
	};
}

const serverResult: PerfSeriesResult = {
	side: "server",
	from: new Date(T).toISOString(),
	to: new Date(T + 24 * H).toISOString(),
	fromMs: T,
	toMs: T + 24 * H,
	bucketMs: H,
	by: "none",
	metrics: [
		{ key: "tps", higherIsBetter: true },
		{ key: "physFps", higherIsBetter: true },
		{ key: "mem", higherIsBetter: false },
	],
	overall: { key: "all", samples: 2880, servers: 2, seq: 42, firstSeen: null, lastSeen: null, metrics: { tps: s(59.5, 55, 41), physFps: s(60, 59, 58), mem: s(612, 790, 830) } },
	groups: [{ key: "all", samples: 2880, servers: 2, seq: 42, firstSeen: null, lastSeen: null, metrics: { tps: s(59.5, 55, 41), physFps: s(60, 59, 58), mem: s(612, 790, 830) } }],
	groupsTotal: 1,
	series: [{ t: T + H, key: "all", samples: 120, metrics: { tps: s(59, 54, 40), physFps: s(60, 59, 58), mem: s(600, 700, 800) }, players: 14, servers: 2 }],
};

const compare: PerfCompareResult = {
	mode: "builds",
	clientMetrics: [
		{ key: "fps", higherIsBetter: true },
		{ key: "mem", higherIsBetter: false },
		{ key: "ping", higherIsBetter: false },
	],
	serverMetrics: [
		{ key: "tps", higherIsBetter: true },
		{ key: "physFps", higherIsBetter: true },
		{ key: "mem", higherIsBetter: false },
	],
	periods: [
		{
			key: ART_OLD,
			seq: 41,
			from: new Date(T).toISOString(),
			to: new Date(T + 12 * H).toISOString(),
			client: { samples: 150, sessions: 20, players: 15, metrics: { fps: s(60, 48, 35), mem: s(1800, 2600, 3100), ping: s(80, 190, 420) } },
			server: { samples: 1440, servers: 2, avgPlayers: 7, metrics: { tps: s(60, 58, 55), physFps: s(60, 59, 58), mem: s(600, 700, 750) } },
		},
		{
			key: ART_NEW,
			seq: 42,
			from: new Date(T + 12 * H).toISOString(),
			to: new Date(T + 24 * H).toISOString(),
			client: { samples: 150, sessions: 20, players: 15, metrics: { fps: s(50, 40, 30), mem: s(1700, 2500, 3000), ping: s(80, 190, 420) } },
			server: { samples: 1440, servers: 2, avgPlayers: 7, metrics: { tps: s(52, 50, 41), physFps: s(60, 59, 58), mem: s(640, 800, 900) } },
		},
	],
};

const marks: DeployMark[] = [
	{ id: "deploy:42", kind: "deploy", at: T + 12 * H, time: new Date(T + 12 * H).toISOString(), branch: "prod", seq: 42, artifact: ART_NEW, channel: "prod", from: ART_OLD, kernel: null, placeVersion: null, message: null, results: { swapped: 2 } },
	{ id: "mark:7", kind: "kernel", at: T + 18 * H, time: new Date(T + 18 * H).toISOString(), branch: null, seq: null, artifact: null, channel: null, from: null, kernel: "0.4.0", placeVersion: 23, message: null },
];

const liveServers: PerfServer[] = [
	{ job: "11111111-2222-3333-4444-555555555555", serverType: "public", branch: "prod", artifact: ART_NEW, players: 9, maxPlayers: 20, startedAt: null, appliedSeq: 42, generation: 3, health: "ok", lastError: null, kernel: "0.4.0", experiment: false, tps: 59.8, tpsMin: 41.2, physFps: 60, memMb: 712, luaMb: 88 },
];

type QueryCall = { name: string; filters: Filters; options: Record<string, unknown> };

function mockApi(overrides: { serverMetrics?: () => Promise<never> | Promise<unknown> } = {}) {
	const calls: QueryCall[] = [];
	vi.spyOn(api, "query").mockImplementation((async (name: string, filters: Filters = {}, options: Record<string, unknown> = {}) => {
		calls.push({ name, filters, options });
		if (name === "perf-client") return clientResult(String(options.by ?? "none"));
		if (name === "perf-server") return serverResult;
		if (name === "perf-compare") return compare;
		if (name === "values") return { branch: [], art: [{ value: ART_NEW, events: 10, lastSeen: "" }, { value: ART_OLD, events: 5, lastSeen: "" }], channel: [], dev: [] };
		throw new Error(`unexpected query ${name}`);
	}) as typeof api.query);
	const marksSpy = vi.spyOn(api, "fleetMarks").mockResolvedValue(marks);
	vi.spyOn(api, "perfServers").mockResolvedValue({ servers: liveServers, players: 9 });
	const history = vi.spyOn(api, "serverMetrics").mockImplementation(
		(overrides.serverMetrics as typeof api.serverMetrics) ??
			(async () => [
				{ t: Math.floor((T + H) / 1000), tps: 60, tpsMin: 50, physFps: 60, memMb: 700, luaMb: 80, players: 8 },
				{ t: Math.floor((T + 2 * H) / 1000), tps: 58, tpsMin: 40, physFps: 60, memMb: 720, luaMb: 85, players: 9 },
			]),
	);
	return { calls, marksSpy, history };
}

function mount(path = "/performance?by=dev") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Performance />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("Performance page", () => {
	it("shows client groups with p50/p90/p99, server numbers, and the marks in range", async () => {
		const { calls, marksSpy } = mockApi();
		mount();
		const phone = (await screen.findByText("Phone", { selector: "td" })).closest("tr") as HTMLElement;
		expect(within(phone).getByText("31 fps")).toBeTruthy();
		expect(within(phone).getByText("19 fps")).toBeTruthy(); // p90 on the bad side
		expect(within(phone).getByText("6 fps")).toBeTruthy();
		expect(screen.getByText("Desktop", { selector: "td" })).toBeTruthy();
		// The shared table: "All" is pinned above the groups, and the groups sort by the raw value (fps p50: phone 31 < desktop 61).
		const table = phone.closest("table") as HTMLElement;
		const firstCells = () => [...table.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent);
		expect(firstCells()).toEqual(["All", "Phone", "Desktop"]);
		fireEvent.click(within(table).getByRole("button", { name: /^Frame rate p50/ }));
		await waitFor(() => expect(firstCells()).toEqual(["All", "Desktop", "Phone"]));
		expect(calls.find((c) => c.name === "perf-client")?.options).toMatchObject({ by: "dev" });
		// Servers have no device class: the server query runs ungrouped.
		expect(calls.find((c) => c.name === "perf-server")?.options).toMatchObject({ by: "none" });
		expect(await screen.findByText("59.5/s")).toBeTruthy();
		// Marks: legend and the read's window.
		expect(await screen.findByText(/1 deploy$/)).toBeTruthy();
		expect(screen.getByText(/1 kernel publish$/)).toBeTruthy();
		const window = marksSpy.mock.calls[0]?.[0];
		expect(window?.since).toBeLessThan(window?.until as number);
	});

	it("draws a mark on every chart; clicking one filters to its build and offers before vs after", async () => {
		const { calls } = mockApi();
		mount();
		await screen.findByText("Phone", { selector: "td" });
		const buttons = await screen.findAllByRole("button", { name: /^Deploy #42 prod e4f5a6b-222222/ });
		// Three client charts and two server metric charts plus players.
		expect(buttons.length).toBe(6);
		expect(screen.getAllByRole("button", { name: /^Kernel publish 0.4.0/ }).length).toBe(6);
		fireEvent.click(buttons[0] as HTMLElement);
		expect(await screen.findByRole("button", { name: "Filtered to this build" })).toBeTruthy();
		await waitFor(() => expect(calls.some((c) => c.name === "perf-client" && c.filters.art === ART_NEW)).toBe(true));
		expect(screen.getByText(/from a1b2c3d-111111/)).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Before vs after" }));
		await waitFor(() => expect(calls.some((c) => c.name === "perf-compare" && c.options.mode === "around" && c.options.at === marks[0]?.at && c.filters.branch === "prod")).toBe(true));
	});

	it("compares two builds with a change column that says better or worse", async () => {
		mockApi();
		mount();
		const row = (await screen.findByText("Frame rate p50", { selector: "td" })).closest("tr") as HTMLElement;
		expect(within(row).getByText("60 fps")).toBeTruthy();
		expect(within(row).getByText("50 fps")).toBeTruthy();
		expect(within(row).getByText("-16.7%")).toBeTruthy();
		expect(within(row).getByText("worse")).toBeTruthy();
		const mem = screen.getByText("Memory p50", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(mem).getByText("better")).toBeTruthy();
		expect(screen.getByRole("columnheader", { name: /^e4f5a6b-222222 #42/ })).toBeTruthy();
		// The sample counts stay pinned on top.
		expect(screen.getByText("Client samples", { selector: "td" }).closest("tr")?.className).toMatch(/font-medium/);
	});

	it("live servers: TPS and memory from heartbeats, a server's history on demand", async () => {
		const { history } = mockApi();
		mount();
		const row = (await screen.findByTitle(liveServers[0]?.job as string)).closest("tr") as HTMLElement;
		expect(within(row).getByText("59.8/s")).toBeTruthy();
		expect(within(row).getByText("712 MB")).toBeTruthy();
		fireEvent.click(within(row).getByRole("button", { name: "History" }));
		await waitFor(() => expect(history).toHaveBeenCalledWith(liveServers[0]?.job, expect.any(Number), expect.anything()));
		expect(await screen.findByRole("figure", { name: /TPS of server/ })).toBeTruthy();
	});

	it("a backend without per-server history says so", async () => {
		mockApi({ serverMetrics: () => Promise.reject(new ApiError(404, "not found", "/v1/fleet/servers/x/metrics")) });
		mount(`/performance?job=${liveServers[0]?.job}`);
		expect(await screen.findByText(/keeps no per-server history yet/)).toBeTruthy();
	});

	it("history points in seconds or ms", () => {
		const { rows, fromMs, toMs } = historyRows([
			{ t: 2_000, tps: 1, tpsMin: 1, physFps: 1, memMb: 1, luaMb: 1, players: 1 },
			{ t: 1_000, tps: 2, tpsMin: 2, physFps: 2, memMb: 2, luaMb: 2, players: 2 },
		]);
		expect(rows.map((r) => r.t)).toEqual([1_000_000, 2_000_000]);
		expect([fromMs, toMs]).toEqual([1_000_000, 2_000_001]);
	});
});
