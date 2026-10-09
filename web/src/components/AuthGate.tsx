/** Asks the backend who is signed in; shows the login page when nobody is, the app when somebody is. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ErrorState, LoadingBlock } from "@/components/common";
import { LoginPage, takeLoginError } from "@/components/LoginPage";
import { api, ApiError } from "@/lib/api";
import { AuthProvider, loginOptionsOf } from "@/lib/auth";

export const AUTH_KEY = ["auth"] as const;

export function AuthGate({ children }: { children: ReactNode }) {
	const client = useQueryClient();
	const [loginError] = useState(takeLoginError);
	const check = useQuery({
		queryKey: AUTH_KEY,
		queryFn: ({ signal }) => api.authCheck(signal),
		retry: false,
		staleTime: 60_000,
		refetchOnWindowFocus: true,
	});
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
	return <AuthProvider value={check.data}>{children}</AuthProvider>;
}
