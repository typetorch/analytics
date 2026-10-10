// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/AppShell";
import { api, ApiError } from "@/lib/api";
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

	const owner = { kind: "roblox" as const, userId: 1001, name: "OwnerName", login: "typetorch.dev" as const };

	it("an owner on an untrusted browser: a banner that trusts it with the admin token; not upgraded in place, it asks to sign in again", async () => {
		const bless = vi.spyOn(api, "blessDevice").mockRejectedValueOnce(new ApiError(401, "wrong token", "/auth/device")).mockResolvedValueOnce({ ok: true, blessed: true });
		mount("/fleet", { ok: true, role: "web", via: "cookie", user: owner, untrustedOwner: true, trustWithToken: true });
		const banner = screen.getByRole("region", { name: "Untrusted browser" });
		expect(within(banner).getByText("Read-only: this browser isn't trusted yet")).toBeTruthy();
		const input = within(banner).getByLabelText("Admin token") as HTMLInputElement;
		expect(input.type).toBe("password");
		fireEvent.change(input, { target: { value: "wrong" } });
		fireEvent.click(within(banner).getByRole("button", { name: "Trust this browser" }));
		expect(await within(banner).findByText("That is not the admin token.")).toBeTruthy();
		fireEvent.change(input, { target: { value: " the-admin-token " } });
		fireEvent.click(within(banner).getByRole("button", { name: "Trust this browser" }));
		await waitFor(() => expect(bless).toHaveBeenLastCalledWith("the-admin-token"));
		const again = await within(banner).findByRole("link", { name: "Sign in again" });
		expect(again.getAttribute("href")).toBe("/auth/typetorch/start");
		expect(within(banner).queryByLabelText("Admin token")).toBeNull();
	});

	it("an owner on an untrusted browser with the token login off: points at the CLI, no token form", () => {
		mount("/fleet", { ok: true, role: "web", via: "cookie", user: owner, untrustedOwner: true, trustWithToken: false });
		const banner = screen.getByRole("region", { name: "Untrusted browser" });
		expect(within(banner).getByText(/typetorch backend bless/)).toBeTruthy();
		expect(within(banner).queryByLabelText("Admin token")).toBeNull();
	});

	it("a viewer keeps the plain read-only tag, no banner", () => {
		mount("/fleet", { ok: true, role: "web", via: "cookie", user: { kind: "roblox", userId: 2002, name: "ViewerName", login: "typetorch.dev" } });
		expect(screen.queryByRole("region", { name: "Untrusted browser" })).toBeNull();
		expect(screen.getAllByText("read-only").length).toBeGreaterThan(0);
	});

	it("closes the drawer with the close button", async () => {
		mount("/");
		fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
		const drawer = await screen.findByRole("dialog");
		fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});
});
