// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sparkPaths } from "@/components/Sparkline";
import { api } from "@/lib/api";
import type { ErrorDetail, ErrorList } from "@/lib/types";
import Errors, { bucketLabel } from "./Errors";

beforeAll(() => {
	// recharts measures its container.
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const window24 = { from: "2026-10-08T12:00:00.000Z", to: "2026-10-09T12:00:00.000Z", bucketSeconds: 1800, buckets: 48 };
const list: ErrorList = {
	window: window24,
	kinds: [
		{
			fp: "fp-boom",
			template: "Script <player.name> failed: attempt to index nil",
			topFrame: "Workspace.Game.Round:42",
			realm: "server",
			count: 12,
			players: 4,
			firstAt: "2026-10-09T11:57:00.000Z",
			lastAt: "2026-10-09T11:59:00.000Z",
			total: 12,
			spark: [0, 4, 6, 2],
		},
		{ fp: "fp-two", template: "HTTP 429 from <url>", topFrame: null, realm: "client", count: 1, players: 0, firstAt: "2026-10-09T10:00:00.000Z", lastAt: "2026-10-09T10:00:00.000Z", total: 1, spark: [1] },
	],
	totals: { count: 13, kinds: 2, players: 4 },
	more: 0,
};
const detail: ErrorDetail = {
	kind: { fp: "fp-boom", template: list.kinds[0]!.template, stack: "Workspace.Game.Round:42\nWorkspace.Game.Main:7", realm: "server", firstAt: list.kinds[0]!.firstAt, lastAt: list.kinds[0]!.lastAt, total: 12 },
	window: window24,
	count: 12,
	players: 4,
	series: [
		{ t: "2026-10-09T11:00:00.000Z", n: 4 },
		{ t: "2026-10-09T11:30:00.000Z", n: 8 },
	],
	byBuild: [
		{ build: "a1b2c3d-000042", n: 10 },
		{ build: "b2-000043", n: 2 },
	],
	byBranch: [{ branch: "prod", n: 12 }],
	byRealm: [{ realm: "server", n: 12 }],
};

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/errors"]}>
				<Errors />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("Errors page", () => {
	it("lists kinds with counts, players, side and when; a click shows the sample stack and where it happens", async () => {
		const errors = vi.spyOn(api, "errors").mockResolvedValue(list);
		const kind = vi.spyOn(api, "errorKind").mockResolvedValue(detail);
		mount();
		expect(await screen.findByText("Script <player.name> failed: attempt to index nil")).toBeTruthy();
		expect(screen.getByText("Workspace.Game.Round:42")).toBeTruthy();
		expect(screen.getByText("HTTP 429 from <url>")).toBeTruthy();
		const row = screen.getByText("Script <player.name> failed: attempt to index nil").closest("tr") as HTMLElement;
		expect(within(row).getByText("server")).toBeTruthy();
		expect(within(row).getByText("12")).toBeTruthy();
		expect(within(row).getByText("4")).toBeTruthy();
		expect(within(row).getByRole("img", { name: /errors per 30 min, peak 6/ })).toBeTruthy();
		// The window and totals come from the backend's answer.
		expect(screen.getByText("13")).toBeTruthy();
		expect(errors).toHaveBeenCalledWith(expect.objectContaining({ window: "24h", limit: 200 }), expect.anything());
		fireEvent.click(row);
		expect(await screen.findByText("Sample stack (from the first report)")).toBeTruthy();
		await waitFor(() => expect(document.body.textContent).toContain("Workspace.Game.Main:7"));
		expect(screen.getByText("a1b2c3d-000042")).toBeTruthy();
		expect(screen.getByText("By build")).toBeTruthy();
		expect(kind).toHaveBeenCalledWith("fp-boom", expect.objectContaining({ window: "24h" }), expect.anything());
	});

	it("says so when there are no errors", async () => {
		vi.spyOn(api, "errors").mockResolvedValue({ ...list, kinds: [], totals: { count: 0, kinds: 0, players: 0 } });
		mount();
		expect(await screen.findByText(/No errors in this window/)).toBeTruthy();
	});

	it("names a failure of the backend", async () => {
		vi.spyOn(api, "errors").mockRejectedValue(new Error("the backend is not answering"));
		mount();
		expect(await screen.findByText("the backend is not answering")).toBeTruthy();
	});
});

describe("trend lines", () => {
	it("draws a line and an area scaled to the peak", () => {
		const { line, area, max } = sparkPaths([0, 5, 10], 100, 20);
		expect(max).toBe(10);
		expect(line).toBe("M0 18 L50 10 L100 2");
		expect(area).toBe("M0 18 L50 10 L100 2 L100 18 L0 18 Z");
	});

	it("handles nothing, one point and all zeros", () => {
		expect(sparkPaths([], 100, 20)).toEqual({ line: "", area: "", max: 0 });
		expect(sparkPaths([3], 100, 20).line).toBe("M0 2");
		expect(sparkPaths([0, 0], 100, 20).line).toBe("M0 18 L100 18");
	});

	it("names the bucket size", () => {
		expect(bucketLabel(60)).toBe("1 min");
		expect(bucketLabel(1800)).toBe("30 min");
		expect(bucketLabel(7200)).toBe("2 h");
		expect(bucketLabel(86_400)).toBe("1 d");
	});
});
