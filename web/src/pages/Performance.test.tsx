// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "@/lib/api";
import type { ComparePeriod, DeployMark, PerfCompareResult, PerfSeriesResult, PerfServer, PerfStat } from "@/lib/perf";
import type { Filters } from "@/lib/types";
import Performance, { changeOrder, CompareTable, compareRows, historyRows, stepChoices } from "./Performance";

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
// p10 is the plain 10th percentile; a distinct number here (55% of the median) so the tests can tell the columns apart
// (for fps and TPS the real p10 equals the bad-side p90).
const s = (p50: number, p90: number, p99: number, p10 = Math.round(p50 * 0.55)): PerfStat => ({ p10, p50, p90, p99, avg: p50, n: 50 });

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

function mockApi(overrides: { serverMetrics?: () => Promise<never> | Promise<unknown>; servers?: PerfServer[] } = {}) {
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
	vi.spyOn(api, "perfServers").mockResolvedValue({ servers: overrides.servers ?? liveServers, players: 9 });
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

// Each test renders the whole page with recharts: seconds on a loaded machine (the suite runs a worker per file).
describe("Performance page", { timeout: 20_000 }, () => {
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

	it("p10 next to p50/p90/p99: a column per metric, p99 marked as the worst case, sorted by the raw value", async () => {
		mockApi();
		mount();
		const phone = (await screen.findByText("Phone", { selector: "td" })).closest("tr") as HTMLElement;
		const table = phone.closest("table") as HTMLElement;
		expect(within(phone).getByText("17 fps")).toBeTruthy(); // fps p10 of the phone: 55% of 31
		expect(within(phone).getByText("990 MB")).toBeTruthy(); // memory p10
		const header = (name: RegExp) => within(table).queryByRole("button", { name });
		for (const name of [/^Frame rate p10/, /^Frame rate p50/, /^Frame rate p90/, /^Frame rate p99 \(worst\)/, /^Memory p10/, /^Memory p99 \(worst\)/, /^Ping p10/, /^Ping p99 \(worst\)/]) {
			expect(header(name), String(name)).toBeTruthy();
		}
		// p10 is the low end, not the worst case, for any metric.
		expect(header(/p10 \(worst\)/)).toBeNull();
		// The raw value sorts it (fps p10: phone 17 < desktop 34); the first click goes high to low.
		fireEvent.click(within(table).getByRole("button", { name: /^Frame rate p10/ }));
		await waitFor(() => expect([...table.querySelectorAll("tbody tr")].map((tr) => tr.querySelector("td")?.textContent)).toEqual(["All", "Desktop", "Phone"]));
		// The server table has it too, under the server memory name.
		expect(await screen.findByRole("button", { name: /^Server memory p10/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Server memory p99 \(worst\)/ })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Server TPS p10/ })).toBeTruthy();
	});

	it("the chart toggle has p10; the line's title says which percentile and marks the worst case", async () => {
		mockApi();
		mount();
		await screen.findByText("Phone", { selector: "td" });
		expect(screen.getAllByText("Frame rate, p50").length).toBe(1);
		const toggle = screen.getByRole("radiogroup", { name: "Percentile" });
		expect(within(toggle).getAllByRole("radio").map((r) => r.textContent)).toEqual(["p10", "p50", "p90", "p99"]);
		expect(within(toggle).getByRole("radio", { name: "p50" }).getAttribute("data-state")).toBe("on");
		fireEvent.click(within(toggle).getByRole("radio", { name: "p10" }));
		expect(await screen.findByText("Frame rate, p10")).toBeTruthy();
		// The picked percentile is filled with the primary colour (the item's data-state selectors), the one left is off.
		expect(within(toggle).getByRole("radio", { name: "p10" }).getAttribute("data-state")).toBe("on");
		expect(within(toggle).getByRole("radio", { name: "p10" }).className).toContain("data-[state=on]:bg-primary");
		expect(within(toggle).getByRole("radio", { name: "p50" }).getAttribute("data-state")).toBe("off");
		expect(screen.getAllByText("Memory, p10").length).toBe(2); // players' devices and servers
		expect(screen.getByText("Server TPS, p10")).toBeTruthy();
		expect(screen.queryByText(/\(worst\)/, { selector: "div.text-sm" })).toBeNull();
		fireEvent.click(within(toggle).getByRole("radio", { name: "p99" }));
		expect(await screen.findByText("Frame rate, p99 (worst)")).toBeTruthy();
		expect(screen.getByText("Ping, p99 (worst)")).toBeTruthy();
		expect(screen.getAllByText("Memory, p99 (worst)").length).toBe(2);
		expect(screen.getByText("Server TPS, p99 (worst)")).toBeTruthy();
		expect(screen.getByRole("figure", { name: "Frame rate, p99 (worst) over time" })).toBeTruthy();
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
		// p10 rows for every metric, p99 marked as the worst case.
		const p10 = screen.getByText("Frame rate p10", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(p10).getByText("33 fps")).toBeTruthy();
		expect(within(p10).getByText("28 fps")).toBeTruthy();
		expect(screen.getByText("Memory p99 (worst)", { selector: "td" })).toBeTruthy();
		expect(screen.getByText("Server memory p99 (worst)", { selector: "td" })).toBeTruthy();
		expect(screen.queryByText(/p10 \(worst\)/, { selector: "td" })).toBeNull();
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

	it("the last hour: exact instants to the queries and the marks, the window's own step unless one is picked", async () => {
		const { calls, marksSpy } = mockApi();
		mount("/performance?range=1h");
		await waitFor(() => expect(calls.some((c) => c.name === "perf-client")).toBe(true));
		const client = calls.find((c) => c.name === "perf-client") as QueryCall;
		expect(client.filters.from).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
		const from = Date.parse(client.filters.from as string);
		expect(Date.now() - from).toBeGreaterThanOrEqual(3_600_000);
		expect(Date.now() - from).toBeLessThan(3_661_000);
		expect(client.options.bucketMinutes).toBeUndefined();
		const window = marksSpy.mock.calls[0]?.[0];
		expect(window?.since).toBe(from);
		cleanup();
		const picked = mockApi();
		mount("/performance?range=6h&step=15");
		await waitFor(() => expect(picked.calls.find((c) => c.name === "perf-server")?.options.bucketMinutes).toBe(15));
		expect(picked.calls.find((c) => c.name === "perf-client")?.options.bucketMinutes).toBe(15);
	});

	it("the change goes from the older build to the newer one (the backend lists newest first), and from before to after", () => {
		const [older, newer] = compare.periods as [ComparePeriod, ComparePeriod];
		const newestFirst: PerfCompareResult = { ...compare, periods: [newer, older] };
		expect(changeOrder(compare)).toEqual([0, 1]);
		expect(changeOrder(newestFirst)).toEqual([1, 0]);
		// Same numbers either way: the newer build's fps is 16.7% worse.
		for (const r of [compare, newestFirst]) {
			const fps = compareRows(r).rows.find((row) => row.id === "client-fps-p50");
			expect(fps?.change).toMatchObject({ better: false });
			expect(Math.round((fps?.change?.pct ?? 0) * 10) / 10).toBe(-16.7);
		}
		expect(changeOrder({ ...compare, periods: [{ ...newer, seq: null }, { ...older, seq: null }] })).toEqual([1, 0]);
		expect(changeOrder({ ...compare, mode: "around", periods: [{ ...older, key: "before" }, { ...newer, key: "after" }] })).toEqual([0, 1]);
		expect(changeOrder({ ...compare, periods: [older] })).toBeNull();
	});

	it("compare rows: p10 of every metric, in the percentiles' order, p99 named the worst case", () => {
		const rows = compareRows(compare).rows;
		expect(rows.filter((r) => r.id.startsWith("client-fps-")).map((r) => r.label)).toEqual(["Frame rate p10", "Frame rate p50", "Frame rate p90", "Frame rate p99 (worst)"]);
		const p10 = rows.find((r) => r.id === "server-tps-p10");
		expect(p10?.values).toEqual([33, 29]); // 55% of 60 and of 52
		// Lower TPS is worse: the change is measured on the p10 values like on the others.
		expect(p10?.change).toMatchObject({ better: false });
		expect(rows.find((r) => r.id === "client-mem-p99")?.label).toBe("Memory p99 (worst)");
		expect(rows).toHaveLength(6 * 4);
	});

	it("flags possible problems in the group tables: orange and red cells, each with its reason", async () => {
		mockApi();
		mount();
		const phone = (await screen.findByText("Phone", { selector: "td" })).closest("tr") as HTMLElement;
		const desktop = screen.getByText("Desktop", { selector: "td" }).closest("tr") as HTMLElement;
		const flag = (row: HTMLElement, text: string) => within(row).getByText(text).getAttribute("data-flag");
		// Frame rate is judged at p10 (under 30 orange, under 20 red): the phone's 17 is red, the desktop's 34 is fine.
		expect(flag(phone, "17 fps")).toBe("critical");
		expect(within(phone).getByText("17 fps").getAttribute("title")).toBe("Frame rate p10 is 17 fps: under the 20 fps critical line");
		expect(within(phone).getByText("17 fps").textContent).toContain("(critical)"); // not by colour alone
		expect(flag(desktop, "34 fps")).toBeNull();
		// Not judged at the other percentiles: the phone's p50 31 and its p90 19 stay plain.
		expect(flag(phone, "31 fps")).toBeNull();
		expect(flag(phone, "19 fps")).toBeNull();
		// Ping and memory at p90 (orange) and p99 (red).
		expect(flag(phone, "190 ms")).toBe("warning");
		expect(flag(phone, "420 ms")).toBe("critical");
		expect(flag(phone, "2,600 MB")).toBe("warning");
		expect(flag(phone, "3,100 MB")).toBe("critical");
		expect(within(phone).getByText("2,600 MB").getAttribute("title")).toBe("Memory p90 is 2,600 MB: over the 2,000 MB warning line (over 3,000 MB is critical)");
		// The median of the same metrics isn't judged.
		expect(flag(phone, "80 ms")).toBeNull();
		expect(flag(phone, "1,800 MB")).toBeNull();
	});

	it("Compare flags the worse build: orange over 10%, the absolute lines on each build, green for better", async () => {
		mockApi();
		mount();
		const median = (await screen.findByText("Frame rate p50", { selector: "td" })).closest("tr") as HTMLElement;
		// 60 -> 50 fps: 16.7% worse, over 10%: orange, with the reason as its tooltip.
		const change = within(median).getByText("-16.7%");
		expect(change.getAttribute("data-flag")).toBe("warning");
		expect(change.getAttribute("title")).toBe("16.7% worse (over 10% is a warning, over 25% is critical)");
		// fps p10: the older build's 33 is fine, the newer build's 28 is under 30.
		const p10 = screen.getByText("Frame rate p10", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(p10).getByText("33 fps").hasAttribute("data-flag")).toBe(false);
		expect(within(p10).getByText("28 fps").getAttribute("data-flag")).toBe("warning");
		// Server TPS p10: 33 -> 29, both under 40 (red); 12.1% worse is orange.
		const tps = screen.getByText("Server TPS p10", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(tps).getByText("33/s").getAttribute("data-flag")).toBe("critical");
		expect(within(tps).getByText("29/s").getAttribute("data-flag")).toBe("critical");
		expect(within(tps).getByText("-12.1%").getAttribute("data-flag")).toBe("warning");
		// Memory p50 went down: better, green, not flagged.
		const mem = screen.getByText("Memory p50", { selector: "td" }).closest("tr") as HTMLElement;
		const better = within(mem).getByText("-5.6%");
		expect(better.hasAttribute("data-flag")).toBe(false);
		expect(better.className).toContain("status-good");
		// A worse change under 10% is plain: server memory p50 +6.7%.
		const smem = screen.getByText("Server memory p50", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(smem).getByText("+6.7%").hasAttribute("data-flag")).toBe(false);
	});

	it("Compare says 'few samples' instead of flagging a change (or a number) from under 20 samples", () => {
		const few = (stat: PerfStat): PerfStat => ({ ...stat, n: 5 });
		const [older, newer] = compare.periods as [ComparePeriod, ComparePeriod];
		const result: PerfCompareResult = {
			...compare,
			periods: [older, { ...newer, client: { ...newer.client, metrics: { ...newer.client.metrics, fps: few(newer.client.metrics.fps as PerfStat) } } }],
		};
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<CompareTable result={result} />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const median = screen.getByText("Frame rate p50", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(median).getByText("few samples")).toBeTruthy();
		expect(median.querySelector("[data-flag]")).toBeNull();
		expect(within(median).getByText("-16.7%").getAttribute("title")).toMatch(/^Fewer than 20 samples on one side \(50 and 5\)/);
		// The 28 fps p10 of the newer build would be orange with enough samples; from 5 it isn't flagged.
		const p10 = screen.getByText("Frame rate p10", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(p10).getByText("28 fps").hasAttribute("data-flag")).toBe(false);
		// Other metrics, with enough samples, are judged as before.
		const tps = screen.getByText("Server TPS p10", { selector: "td" }).closest("tr") as HTMLElement;
		expect(within(tps).getByText("-12.1%").getAttribute("data-flag")).toBe("warning");
		expect(within(tps).queryByText("few samples")).toBeNull();
	});

	it("live servers: TPS, physics FPS and memory use the same lines", async () => {
		const sick = { ...(liveServers[0] as PerfServer), tps: 35, physFps: 45, memMb: 5200 };
		mockApi({ servers: [sick] });
		mount();
		const row = (await screen.findByTitle(sick.job)).closest("tr") as HTMLElement;
		expect(within(row).getByText("35/s").getAttribute("data-flag")).toBe("critical");
		expect(within(row).getByText("45 fps").getAttribute("data-flag")).toBe("warning");
		expect(within(row).getByText("5,200 MB").getAttribute("data-flag")).toBe("critical");
		expect(within(row).getByText("5,200 MB").getAttribute("title")).toBe("Server memory is 5,200 MB: over the 5,000 MB critical line");
		cleanup();
		mockApi();
		mount();
		const fine = (await screen.findByTitle(sick.job)).closest("tr") as HTMLElement;
		expect(within(fine).getByText("59.8/s").hasAttribute("data-flag")).toBe(false);
		expect(within(fine).getByText("712 MB").hasAttribute("data-flag")).toBe(false);
	});

	it("the Compare build chips: a picked build is pressed, filled and checked; the others are outlined", async () => {
		mockApi();
		mount();
		const group = await screen.findByRole("group", { name: "Builds to compare" });
		const chip = async (id: string) => (await within(group).findByRole("button", { name: new RegExp(`^${id}`) })) as HTMLElement;
		const newer = await chip(ART_NEW);
		const older = await chip(ART_OLD);
		for (const c of [newer, older]) {
			expect(c.getAttribute("aria-pressed")).toBe("false");
			expect(c.className).toContain("text-muted-foreground");
			expect(c.querySelector("svg")).toBeNull();
		}
		fireEvent.click(newer);
		await waitFor(() => expect(newer.getAttribute("aria-pressed")).toBe("true"));
		expect(newer.className).toContain("bg-primary");
		expect(newer.className).toContain("text-primary-foreground");
		expect(newer.querySelector("svg.lucide-check")).not.toBeNull();
		expect(older.getAttribute("aria-pressed")).toBe("false");
		expect(older.querySelector("svg")).toBeNull();
		fireEvent.click(newer);
		await waitFor(() => expect(newer.getAttribute("aria-pressed")).toBe("false"));
		expect(newer.className).not.toContain("bg-primary");
	});

	it("a live server's History chip is pressed while its history is open", async () => {
		mockApi();
		mount();
		const row = (await screen.findByTitle(liveServers[0]?.job as string)).closest("tr") as HTMLElement;
		const history = within(row).getByRole("button", { name: "History" });
		expect(history.getAttribute("aria-pressed")).toBe("false");
		fireEvent.click(history);
		await waitFor(() => expect(within(row).getByRole("button", { name: "History" }).getAttribute("aria-pressed")).toBe("true"));
		expect(within(row).getByRole("button", { name: "History" }).querySelector("svg.lucide-check")).not.toBeNull();
	});

	it("step choices: 2 to 400 steps in the window", () => {
		const H = 3_600_000;
		expect(stepChoices(H)).toEqual([1, 5, 15]);
		expect(stepChoices(6 * H)).toEqual([1, 5, 15, 60]);
		expect(stepChoices(7 * 24 * H)).toEqual([60, 360, 1440]);
		expect(stepChoices(90 * 24 * H)).toEqual([360, 1440]);
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
