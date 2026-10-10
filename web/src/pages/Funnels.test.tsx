// @vitest-environment jsdom
/** The Funnels page: one funnel's steps, or two side by side with their headline numbers (?compare=). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import type { FunnelResult } from "@/lib/types";
import Funnels from "./Funnels";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const step = (n: number, label: string, reached: number, start: number, previous: number) => ({
	step: n,
	label,
	reached,
	ofStart: reached / start,
	fromPrevious: reached / previous,
	logged: reached,
	medianSecondsFromStart: n * 10,
});

const FUNNELS: Record<string, FunnelResult> = {
	v1_tutorial: { funnel: "v1_tutorial", players: 100, steps: [step(1, "joined", 100, 100, 100), step(2, "moved", 60, 100, 100), step(3, "done", 40, 100, 60)], biggestDrop: { step: 2, lost: 40, share: 0.4 } },
	v3_tutorial: { funnel: "v3_tutorial", players: 80, steps: [step(1, "joined", 80, 80, 80), step(2, "moved", 72, 80, 80), step(3, "done", 60, 80, 72)], biggestDrop: { step: 3, lost: 12, share: 0.1667 } },
};

beforeEach(() => {
	vi.spyOn(api, "query").mockImplementation((async (name: string, _filters: unknown, options: { funnel?: string } = {}) => {
		if (name !== "funnel") throw new Error(`unexpected query ${name}`);
		if (!options.funnel) return { funnel: null, funnels: [{ name: "v1_tutorial", players: 100, events: 200 }, { name: "v3_tutorial", players: 80, events: 210 }] };
		return FUNNELS[options.funnel];
	}) as typeof api.query);
});

function mount(query = "") {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[`/funnels${query}`]}>
				<Funnels />
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

describe("Funnels", () => {
	it("shows one funnel without compare", async () => {
		mount();
		expect(await screen.findByText("v1_tutorial: 100 players started")).toBeTruthy();
		expect(screen.queryByText(/ vs /)).toBeNull();
		expect(screen.getByRole("combobox", { name: "Compare with" })).toBeTruthy();
	});

	it("compares two funnels side by side", async () => {
		mount("?funnel=v1_tutorial&compare=v3_tutorial");
		expect(await screen.findByText("v1_tutorial: 100 players started")).toBeTruthy();
		expect(await screen.findByText("v3_tutorial: 80 players started")).toBeTruthy();
		expect(await screen.findByText("v1_tutorial vs v3_tutorial")).toBeTruthy();
		// 40% vs 75% completed: 35 points more.
		await waitFor(() => expect(screen.getByText(/35 points more than/)).toBeTruthy());
		expect(screen.getByRole("button", { name: "Swap funnels" })).toBeTruthy();
	});

	it("ignores compare with itself", async () => {
		mount("?funnel=v1_tutorial&compare=v1_tutorial");
		expect(await screen.findByText("v1_tutorial: 100 players started")).toBeTruthy();
		expect(screen.queryByText(/ vs /)).toBeNull();
	});
});
