/** Who is signed in, for the header and anything that needs to know. Provided by AuthGate once the backend says yes. */
import { createContext, useContext } from "react";
import type { AuthInfo, AuthUser, LoginOptions } from "./types";

const AuthContext = createContext<AuthInfo | null>(null);
export const AuthProvider = AuthContext.Provider;

export function useAuth(): AuthInfo | null {
	return useContext(AuthContext);
}

/** The offers on the login page: the backend's list from the 401 body, else the token form only. */
export function loginOptionsOf(body: unknown): LoginOptions {
	const login = (body as { login?: Partial<LoginOptions> } | undefined)?.login;
	return { token: login?.token ?? true, roblox: login?.roblox ?? false };
}

/** The plain sentences for the `login_error` the backend puts in the address after a failed Roblox sign-in. */
export const LOGIN_ERRORS: Record<string, string> = {
	not_owner: "That Roblox account is not an owner or a viewer of this game.",
	denied: "Sign-in was cancelled at Roblox.",
	state: "That sign-in link expired or was already used. Try again.",
	failed: "Roblox sign-in did not work. Try again in a moment.",
};

export function loginErrorText(code: string | null | undefined): string | null {
	if (!code) return null;
	return LOGIN_ERRORS[code] ?? "Sign-in did not work. Try again.";
}

/** A short label for the header: "OwnerName", "admin token". */
export function userLabel(user: AuthUser | undefined, via?: string): string {
	if (user?.kind === "roblox") return user.displayName ?? user.name;
	if (via === "bearer") return "admin token (proxy)";
	return "admin token";
}

/** The session can only read (the web role): the pages that change something stay out, the rest is the same. */
export function isReadOnly(auth: Pick<AuthInfo, "role"> | null | undefined): boolean {
	return auth?.role === "web";
}
