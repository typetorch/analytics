/**
 * Asks the backend who is signed in; shows the login page when nobody is, the app when somebody is. While the session is
 * an owner's read-only one on an untrusted browser, it asks again whenever the page comes back into view (focus or
 * visibility), so trusting the browser elsewhere (the CLI's link in another tab) shows here without a reload.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { ErrorState, LoadingBlock } from "@/components/common";
import { LoginPage, takeLoginError } from "@/components/LoginPage";
import { api, ApiError } from "@/lib/api";
import { AuthProvider, BlessedProvider, loginOptionsOf, takeBlessed } from "@/lib/auth";

export const AUTH_KEY = ["auth"] as const;

export function AuthGate({ children }: { children: ReactNode }) {
	const client = useQueryClient();
	const [loginError] = useState(takeLoginError);
	const [blessed] = useState(takeBlessed);
	const check = useQuery({
		queryKey: AUTH_KEY,
		queryFn: ({ signal }) => api.authCheck(signal),
		retry: false,
		staleTime: 60_000,
		refetchOnWindowFocus: true,
	});
	const untrusted = check.data?.untrustedOwner === true;
	useEffect(() => {
		if (!untrusted) return;
		const recheck = () => {
			if (document.visibilityState === "visible") void client.refetchQueries({ queryKey: AUTH_KEY }, { cancelRefetch: false });
		};
		window.addEventListener("focus", recheck);
		document.addEventListener("visibilitychange", recheck);
		return () => {
			window.removeEventListener("focus", recheck);
			document.removeEventListener("visibilitychange", recheck);
		};
	}, [untrusted, client]);
	if (check.isPending)
		return (
			<div className="mx-auto max-w-sm p-8">
				<LoadingBlock rows={2} />
			</div>
		);
	if (check.isError) {
		const error = check.error;
		if (error instanceof ApiError && error.unauthorized) {
			return <LoginPage options={loginOptionsOf(error.body)} initialError={loginError} onSignedIn={() => void client.resetQueries()} />;
		}
		return (
			<div className="mx-auto max-w-xl p-6">
				<ErrorState error={error} title="Could not reach the backend" />
			</div>
		);
	}
	// The admin role and the read-only web role: a game API key has no business here.
	if (check.data.role !== "admin" && check.data.role !== "web")
		return (
			<div className="mx-auto max-w-xl p-6">
				<ErrorState error={new Error("This session is not an admin or a viewer.")} title="No access" />
			</div>
		);
	return (
		<AuthProvider value={check.data}>
			<BlessedProvider value={blessed}>{children}</BlessedProvider>
		</AuthProvider>
	);
}
