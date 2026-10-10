// @vitest-environment jsdom
/** The Players list's Robux spent column: thousands separators, 0 for none (and for older backends), sorting, and Top spenders asking the server. */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { PlayersResult } from "@/lib/types";
import Players from "./Players";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	localStorage.clear();
});

const base = { firstSeen: "2026-10-03T10:00:00.000Z", sessions: 1, events: 3, playtimeMinutes: 5, newInRange: false };
const recent: PlayersResult = {
	players: [
		{ ...base, pid: "pid-free-00001", lastSeen: "2026-10-08T10:00:00.000Z", robux: 0 },
		{ ...base, pid: "pid-whale-0002", lastSeen: "2026-10-07T10:00:00.000Z", robux: 12_345 },
		{ ...base, pid: "pid-old-000003", lastSeen: "2026-10-06T10:00:00.000Z" },
		{ ...base, pid: "pid-small-0004", lastSeen: "2026-10-05T10:00:00.000Z", robux: 99 },
	],
};
const top: PlayersResult = { players: [recent.players[1], recent.players[3]] };

let calls: Record<string, unknown>[] = [];
beforeEach(() => {
	calls = [];
	vi.spyOn(api, "identitySummary").mockResolvedValue({ count: 0, backfill: false });
	vi.spyOn(api, "identity").mockResolvedValue([]);
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: Record<string, unknown> = {}) => {
		if (name !== "players") throw new Error(`unexpected query ${name}`);
		calls.push(options);
		return options.sort === "robux" ? top : recent;
	}) as typeof api.query);
});

function mount() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/players"]}>
				<Players />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

const table = () => screen.findByRole("table", { name: "Players" });
const pidsInOrder = (t: HTMLElement) => [...t.querySelectorAll("tbody tr")].map((r) => r.querySelector("[title^='pid-']")?.getAttribute("title") ?? "");

describe("Players list: Robux spent", () => {
	it("shows Robux spent with thousands separators, and 0 for none or a missing value", async () => {
		mount();
		const t = await table();
		expect(within(t).getByRole("columnheader", { name: /Robux spent/ })).toBeTruthy();
		const row = (pid: string) => t.querySelector(`[title='${pid}']`)?.closest("tr") as HTMLElement;
		expect(within(row("pid-whale-0002")).getByText("12,345")).toBeTruthy();
		expect(within(row("pid-small-0004")).getByText("99")).toBeTruthy();
		expect(within(row("pid-free-00001")).getByText("0")).toBeTruthy();
		expect(within(row("pid-old-000003")).getByText("0")).toBeTruthy();
	});

	it("sorts by Robux spent (by the number, not the text)", async () => {
		mount();
		const t = await table();
		expect(pidsInOrder(t)).toEqual(["pid-free-00001", "pid-whale-0002", "pid-old-000003", "pid-small-0004"]);
		fireEvent.click(within(t).getByTitle(/^Sort by Robux spent/));
		// A number column sorts most first; the zeros (and the missing value) come last.
		await waitFor(() => expect(pidsInOrder(t).slice(0, 2)).toEqual(["pid-whale-0002", "pid-small-0004"]));
		expect(pidsInOrder(t).slice(2).sort()).toEqual(["pid-free-00001", "pid-old-000003"]);
		expect(within(t).getByRole("columnheader", { name: /Robux spent/ }).getAttribute("aria-sort")).toBe("descending");
	});

	it("Top spenders asks the server for sort=robux", async () => {
		mount();
		await table();
		expect(calls.at(-1)?.sort).toBeUndefined();
		fireEvent.click(screen.getByRole("button", { name: "Top spenders" }));
		await waitFor(() => expect(calls.at(-1)?.sort).toBe("robux"));
		await waitFor(async () => expect(pidsInOrder(await table())).toEqual(["pid-whale-0002", "pid-small-0004"]));
		expect(screen.getByText(/Most Robux spent first/)).toBeTruthy();
	});
});
