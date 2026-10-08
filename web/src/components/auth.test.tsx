// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthGate } from "@/components/AuthGate";
import { LoginPage, takeLoginError } from "@/components/LoginPage";
import { api, ApiError } from "@/lib/api";
import { loginErrorText, loginOptionsOf, userLabel } from "@/lib/auth";
import type { AuthInfo } from "@/lib/types";

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/");
});

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const withClient = (ui: React.ReactNode) => <QueryClientProvider client={client()}>{ui}</QueryClientProvider>;
const unauthorized = (login: unknown) => new ApiError(401, "sign in required", "/v1/auth/check", { error: "sign in required", login });

describe("login page", () => {
	it("offers Sign in with Roblox first and the admin token second", () => {
		render(<LoginPage options={{ roblox: true, token: true }} onSignedIn={() => {}} />);
		const roblox = screen.getByRole("link", { name: /sign in with roblox/i });
		expect(roblox.getAttribute("href")).toBe("/v1/auth/roblox/start");
		expect(screen.getByLabelText(/admin token/i)).toBeTruthy();
		expect(screen.getByRole("button", { name: /sign in with the token/i })).toBeTruthy();
		// The Roblox button comes before the token form.
		expect(roblox.compareDocumentPosition(screen.getByLabelText(/admin token/i)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("hides what the backend turned off", () => {
		render(<LoginPage options={{ roblox: true, token: false }} onSignedIn={() => {}} />);
		expect(screen.getByRole("link", { name: /sign in with roblox/i })).toBeTruthy();
		expect(screen.queryByLabelText(/admin token/i)).toBeNull();
		cleanup();
		render(<LoginPage options={{ roblox: false, token: true }} onSignedIn={() => {}} />);
		expect(screen.queryByRole("link", { name: /roblox/i })).toBeNull();
		expect(screen.getByLabelText(/admin token/i)).toBeTruthy();
		cleanup();
		render(<LoginPage options={{ roblox: false, token: false }} onSignedIn={() => {}} />);
		expect(screen.getByText(/no login is turned on/i)).toBeTruthy();
	});

	it("signs in with the token: the value is sent once and cleared", async () => {
		const login = vi.spyOn(api, "login").mockResolvedValue({ ok: true, role: "admin", via: "cookie" } as AuthInfo);
		const done = vi.fn();
		render(<LoginPage options={{ roblox: false, token: true }} onSignedIn={done} />);
		const input = screen.getByLabelText(/admin token/i) as HTMLInputElement;
		expect(input.type).toBe("password");
		fireEvent.change(input, { target: { value: "  the-pasted-token  " } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
		expect(login).toHaveBeenCalledWith("the-pasted-token");
		expect(input.value).toBe("");
	});

	it("says plainly when the token is wrong or the address is blocked", async () => {
		const login = vi.spyOn(api, "login").mockRejectedValueOnce(new ApiError(401, "wrong token", "/v1/auth/login"));
		render(<LoginPage options={{ roblox: false, token: true }} onSignedIn={() => {}} />);
		const input = screen.getByLabelText(/admin token/i);
		fireEvent.change(input, { target: { value: "nope" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		expect(await screen.findByText("That is not the admin token.")).toBeTruthy();
		login.mockRejectedValueOnce(new ApiError(429, "rate limited", "/v1/auth/login"));
		fireEvent.change(input, { target: { value: "nope again" } });
		fireEvent.submit(input.closest("form") as HTMLFormElement);
		expect(await screen.findByText(/too many wrong tries/i)).toBeTruthy();
	});

	it("shows why a Roblox sign-in failed, from the address, once", () => {
		window.history.replaceState(null, "", "/errors?login_error=not_owner");
		const text = takeLoginError();
		expect(text).toBe("That Roblox account is not an owner of this game.");
		expect(window.location.search).toBe("");
		expect(window.location.pathname).toBe("/errors");
		expect(takeLoginError()).toBeNull();
		render(<LoginPage options={{ roblox: true, token: true }} initialError={text} onSignedIn={() => {}} />);
		expect(screen.getByText("That Roblox account is not an owner of this game.")).toBeTruthy();
		for (const code of ["denied", "state", "failed", "unheard-of"]) expect(loginErrorText(code)).toMatch(/\w/);
		expect(loginErrorText(null)).toBeNull();
	});
});

describe("auth helpers", () => {
	it("reads the login offers from a 401 body, with safe defaults", () => {
		expect(loginOptionsOf({ login: { token: false, roblox: true } })).toEqual({ token: false, roblox: true });
		expect(loginOptionsOf(undefined)).toEqual({ token: true, roblox: false });
		expect(loginOptionsOf({ login: { roblox: true } })).toEqual({ token: true, roblox: true });
	});

	it("labels who is signed in", () => {
		expect(userLabel({ kind: "roblox", userId: 1, name: "OwnerName", displayName: "The Owner" })).toBe("The Owner");
		expect(userLabel({ kind: "roblox", userId: 1, name: "OwnerName" })).toBe("OwnerName");
		expect(userLabel({ kind: "token" }, "cookie")).toBe("admin token");
		expect(userLabel(undefined, "bearer")).toBe("admin token (proxy)");
	});
});

describe("auth gate", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("shows the app to an admin and the login page to nobody", async () => {
		vi.spyOn(api, "authCheck").mockResolvedValue({ ok: true, role: "admin", via: "cookie", user: { kind: "token" } });
		render(withClient(<AuthGate>{<p>the app</p>}</AuthGate>));
		expect(await screen.findByText("the app")).toBeTruthy();
		cleanup();
		vi.spyOn(api, "authCheck").mockRejectedValue(unauthorized({ token: true, roblox: true }));
		render(withClient(<AuthGate>{<p>the app</p>}</AuthGate>));
		expect(await screen.findByRole("link", { name: /sign in with roblox/i })).toBeTruthy();
		expect(screen.queryByText("the app")).toBeNull();
	});

	it("refuses a session that is not an admin", async () => {
		vi.spyOn(api, "authCheck").mockResolvedValue({ ok: true, role: "game", via: "bearer" });
		render(withClient(<AuthGate>{<p>the app</p>}</AuthGate>));
		expect(await screen.findByText("No access")).toBeTruthy();
		expect(screen.queryByText("the app")).toBeNull();
	});

	it("names a backend that can't be reached", async () => {
		vi.spyOn(api, "authCheck").mockRejectedValue(new ApiError(503, "no admin token: start the explorer with --game <the game repo>", "/v1/auth/check"));
		render(withClient(<AuthGate>{<p>the app</p>}</AuthGate>));
		expect(await screen.findByText("Could not reach the backend")).toBeTruthy();
		expect(screen.getAllByText(/--game/).length).toBeGreaterThan(0);
	});
});
