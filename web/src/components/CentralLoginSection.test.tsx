// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CentralLoginSection } from "@/components/CentralLoginSection";
import { LoginPage } from "@/components/LoginPage";
import { api, ApiError } from "@/lib/api";
import { loginErrorText, loginOptionsOf } from "@/lib/auth";
import type { BlessedDevice } from "@/lib/types";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

const FP = `tt1-${"a".repeat(32)}`;
const withClient = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>;
const device = (over: Partial<BlessedDevice> = {}): BlessedDevice => ({ id: "0123456789abcdef", created: "2026-10-09T10:00:00.000Z", used: "2026-10-10T10:00:00.000Z", via: "admin token", agent: "Chrome/140 on Windows", ...over });

describe("Sign in with typetorch.dev on the login page", () => {
	it("shows the button only when the backend offers it, linking to the backend's start route", () => {
		render(<LoginPage options={{ roblox: false, token: true, typetorch: true }} onSignedIn={() => {}} />);
		const link = screen.getByRole("link", { name: /sign in with typetorch\.dev/i });
		expect(link.getAttribute("href")).toBe("/auth/typetorch/start");
		expect(screen.getByText("or")).toBeTruthy();
		cleanup();
		render(<LoginPage options={{ roblox: true, token: true }} onSignedIn={() => {}} />);
		expect(screen.queryByRole("link", { name: /typetorch\.dev/i })).toBeNull();
		cleanup();
		render(<LoginPage options={{ roblox: false, token: false, typetorch: true }} onSignedIn={() => {}} />);
		expect(screen.queryByText(/no login is turned on/i)).toBeNull();
	});

	it("reads the offer from the 401 body and explains the new errors", () => {
		expect(loginOptionsOf({ login: { token: true, roblox: false, typetorch: true } })).toEqual({ token: true, roblox: false, typetorch: true });
		expect(loginOptionsOf({ login: { token: true, roblox: false } })).toEqual({ token: true, roblox: false });
		expect(loginErrorText("not_blessed")).toMatch(/not trusted/);
		expect(loginErrorText("bless")).toMatch(/trust link/);
	});
});

describe("the Settings section", () => {
	it("off: one read-only line, no devices asked for", () => {
		const devices = vi.spyOn(api, "devices");
		render(withClient(<CentralLoginSection info={{ on: false }} />));
		expect(screen.getByText("Off")).toBeTruthy();
		expect(document.querySelector('[data-central-login="off"]')).toBeTruthy();
		expect(devices).not.toHaveBeenCalled();
	});

	it("on: the fingerprint, the trusted browsers with revoke, and this browser marked", async () => {
		vi.spyOn(api, "devices").mockResolvedValue([device({ current: true }), device({ id: "fedcba9876543210", via: "signing key", agent: "Firefox/131 on Linux" })]);
		const revoke = vi.spyOn(api, "revokeDevice").mockResolvedValue([device({ current: true })]);
		render(withClient(<CentralLoginSection info={{ on: true, issuer: "https://dash.typetorch.dev", fingerprint: FP, unblessed: "web" }} />));
		expect(screen.getByText(FP)).toBeTruthy();
		expect(screen.getByText(/read-only access/)).toBeTruthy();
		expect(await screen.findByText("This browser")).toBeTruthy();
		expect(screen.getByText(/Trusted with the signing key/)).toBeTruthy();
		// This browser is trusted already: no form.
		expect(screen.queryByLabelText(/trust this browser/i)).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: /revoke Firefox/i }));
		await waitFor(() => expect(revoke).toHaveBeenCalledWith("fedcba9876543210"));
		await waitFor(() => expect(screen.queryByText(/Firefox/)).toBeNull());
	});

	it("trusts this browser with the admin token once; a wrong token says so", async () => {
		vi.spyOn(api, "devices").mockResolvedValue([]);
		const bless = vi.spyOn(api, "blessDevice").mockRejectedValueOnce(new ApiError(401, "wrong token", "/auth/device")).mockResolvedValueOnce({ ok: true, blessed: true });
		render(withClient(<CentralLoginSection info={{ on: true, fingerprint: FP, unblessed: "refuse" }} />));
		expect(screen.getByText(/no access/)).toBeTruthy();
		expect(await screen.findByText(/No browser is trusted yet/)).toBeTruthy();
		const input = screen.getByLabelText(/trust this browser/i) as HTMLInputElement;
		expect(input.type).toBe("password");
		fireEvent.change(input, { target: { value: "wrong" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		expect(await screen.findByText("That is not the admin token.")).toBeTruthy();
		fireEvent.change(input, { target: { value: " the-admin-token " } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		await waitFor(() => expect(bless).toHaveBeenLastCalledWith("the-admin-token"));
		await waitFor(() => expect(input.value).toBe(""));
	});
});
