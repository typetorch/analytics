// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { api } from "@/lib/api";
import { AuthProvider } from "@/lib/auth";
import { reloadCollapsed } from "@/lib/nav-state";
import { ThemeProvider } from "@/lib/theme";
import type { AuthInfo } from "@/lib/types";

beforeEach(() => {
	localStorage.clear();
	reloadCollapsed();
	vi.spyOn(api, "health").mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof api.health>>);
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

function mount(path: string, auth: AuthInfo = { ok: true, role: "admin", via: "cookie", user: { kind: "roblox", userId: 1001, name: "OwnerName", displayName: "Owner Display" } }) {
	return render(
		<ThemeProvider>
			<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
				<AuthProvider value={auth}>
					<MemoryRouter initialEntries={[path]}>
						<Routes>
							<Route element={<AppShell />}>
								<Route path="*" element={<div>the page</div>} />
							</Route>
						</Routes>
					</MemoryRouter>
				</AuthProvider>
			</QueryClientProvider>
		</ThemeProvider>,
	);
}

describe("app shell", () => {
	it("names the page in the header and shows who is signed in at the foot of the sidebar", () => {
		mount("/fleet");
		expect(screen.getAllByText("Fleet").length).toBeGreaterThan(1); // the sidebar item and the header title
		expect(screen.getByText("Owner Display")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
		expect(screen.getByText("the page")).toBeTruthy();
	});

	it("has no sign-out button for a token the proxy adds", () => {
		mount("/fleet", { ok: true, role: "admin", via: "bearer", user: { kind: "token" } });
		expect(screen.getByText("admin token (proxy)")).toBeTruthy();
		expect(screen.queryByRole("button", { name: "Sign out" })).toBeNull();
	});

	it("opens the sidebar as a drawer behind the menu button, and closes it on a page click", async () => {
		mount("/fleet");
		expect(screen.queryByRole("dialog")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
		const drawer = await screen.findByRole("dialog");
		const link = within(drawer).getByRole("link", { name: "Players" });
		expect(within(drawer).getByRole("link", { name: "Fleet" }).getAttribute("aria-current")).toBe("page");
		expect(within(drawer).getByText("Owner Display")).toBeTruthy();
		fireEvent.click(link);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		// The page changed with the click.
		expect(screen.getAllByRole("link", { name: "Players" }).some((l) => l.getAttribute("aria-current") === "page")).toBe(true);
	});

	it("closes the drawer with the close button", async () => {
		mount("/");
		fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
		const drawer = await screen.findByRole("dialog");
		fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
