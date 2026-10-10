/**
 * The banner on top of every page for an owner who signed in with typetorch.dev on a browser that was never trusted
 * (the auth check's `untrustedOwner`): why the session is read-only, and a form that trusts this browser with the admin
 * token once (POST /auth/device, as on the Settings page). The read-only session is not upgraded: after trusting, the
 * owner signs in again and gets admin. Viewers never see it.
 */
import { useMutation } from "@tanstack/react-query";
import { LogIn, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { blessError } from "@/components/CentralLoginSection";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";

/** Where "Sign in again" goes: the typetorch.dev login, which now finds the trusted browser. */
export const SIGN_IN_AGAIN = "/auth/typetorch/start";

export function UntrustedBrowserBanner() {
	const auth = useAuth();
	const [token, setToken] = useState("");
	const bless = useMutation({ mutationFn: (t: string) => api.blessDevice(t), onSuccess: () => setToken("") });
	if (!auth?.untrustedOwner || auth.role !== "web") return null;

	function submit(event: FormEvent) {
		event.preventDefault();
		if (token.trim() && !bless.isPending) bless.mutate(token.trim());
	}

	return (
		<section aria-label="Untrusted browser" data-untrusted-owner className="rounded-lg border border-[var(--status-warning)] bg-card px-3 py-2.5 text-sm">
			<div className="flex items-start gap-2">
				{bless.isSuccess ? <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--status-good)]" aria-hidden /> : <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" aria-hidden />}
				<div className="min-w-0 flex-1 space-y-2">
					{bless.isSuccess ? (
						<>
							<div className="font-medium">This browser is trusted</div>
							<div className="text-muted-foreground">Sign in again for full access.</div>
							<Button asChild size="sm">
								<a href={SIGN_IN_AGAIN}>
									<LogIn />
									Sign in again
								</a>
							</Button>
						</>
					) : (
						<>
							<div className="font-medium">Read-only: this browser isn't trusted yet</div>
							<div className="text-muted-foreground">
								{auth.trustWithToken === false ? "Run `typetorch backend bless` on the PC with the game's signing key, then sign in again." : "Trust it once with the admin token for full access."}
							</div>
							{auth.trustWithToken === false ? null : (
								<form className="flex flex-wrap items-center gap-2" onSubmit={submit}>
									<Label htmlFor="trust-browser-token" className="sr-only">
										Admin token
									</Label>
									<Input
										id="trust-browser-token"
										className="h-8 min-w-0 flex-1 basis-48"
										type="password"
										autoComplete="off"
										spellCheck={false}
										placeholder="admin token"
										value={token}
										onChange={(e) => setToken(e.target.value)}
									/>
									<Button type="submit" size="sm" disabled={bless.isPending || !token.trim()}>
										<ShieldCheck />
										{bless.isPending ? "Checking" : "Trust this browser"}
									</Button>
								</form>
							)}
							{bless.isError ? <p className="text-destructive">{blessError(bless.error)}</p> : null}
						</>
					)}
				</div>
			</div>
		</section>
	);
}
