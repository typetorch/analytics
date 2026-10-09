// @vitest-environment jsdom
// Plans/25: every JobId on the Fleet page opens its server page (kept apart from Fleet.test.tsx, which the TPS / memory
// columns work changes).
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataTable } from "@/components/data-table";
import type { FleetServer } from "@/lib/types";
import { SERVER_COLUMNS } from "./Fleet";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const JOB = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";
const server: FleetServer = {
	job: JOB,
	serverType: "public",
	branch: "prod",
	artifact: "art-1",
	players: 3,
	maxPlayers: 20,
	startedAt: "2026-10-09T10:00:00Z",
	appliedSeq: 7,
	generation: 1,
	health: "ok",
	lastError: null,
	kernel: "0.5.0",
	experiment: false,
};

describe("Fleet JobIds", () => {
	it("link the servers table's Job column to /servers/<JobId>", () => {
		render(
			<MemoryRouter initialEntries={["/fleet"]}>
				<Routes>
					<Route path="/fleet" element={<DataTable<FleetServer> id="fleet-servers" columns={SERVER_COLUMNS} data={[server]} rowId={(s) => s.job} />} />
					<Route path="/servers/:jobId" element={<p>server page</p>} />
				</Routes>
			</MemoryRouter>,
		);
		const link = screen.getByRole("link", { name: "0b5c7d…789abc" });
		expect(link.getAttribute("href")).toBe(`/servers/${JOB}`);
		expect(link.getAttribute("title")).toContain(JOB);
		fireEvent.click(link);
		expect(screen.getByText("server page")).toBeTruthy();
	});
});
