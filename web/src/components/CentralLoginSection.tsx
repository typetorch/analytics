/**
 * The Settings page's Sign in with typetorch.dev section: a read-only line saying whether it is on (it is set in the
 * environment only), this backend's fingerprint, and the browsers trusted for full admin through it, with a revoke
 * button each and a form that trusts this browser with the admin token once. Owners only (the page is).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Section } from "@/components/common";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, ApiError } from "@/lib/api";
import { fmtAgo, fmtTime } from "@/lib/format";
import type { BlessedDevice, CentralLoginInfo } from "@/lib/types";

export const DEVICES_KEY = ["admin-devices"] as const;

export function blessError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.status === 401) return "That is not the admin token.";
		if (error.status === 429) return "Too many tries. Wait a few minutes.";
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

function DeviceRow({ device, onRevoke, busy }: { device: BlessedDevice; onRevoke(): void; busy: boolean }) {
	return (
		<li className="flex flex-wrap items-center justify-between gap-2 py-2" data-device={device.id}>
			<div className="min-w-0 space-y-0.5">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="truncate">{device.agent ?? "Unknown browser"}</span>
					{device.current ? <Badge variant="secondary">This browser</Badge> : null}
				</div>
				<div className="text-xs text-muted-foreground">
					Trusted with the {device.via} on {fmtTime(device.created)}, last used {fmtAgo(device.used)}
				</div>
			</div>
			<Button type="button" variant="outline" size="sm" onClick={onRevoke} disabled={busy} aria-label={`Revoke ${device.agent ?? device.id}`}>
				<Trash2 />
				Revoke
			</Button>
		</li>
	);
}

function Devices() {
	const client = useQueryClient();
	const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: ({ signal }) => api.devices(signal), staleTime: 0 });
	const revoke = useMutation({ mutationFn: (id: string) => api.revokeDevice(id), onSuccess: (list) => client.setQueryData(DEVICES_KEY, list) });
	const [token, setToken] = useState("");
	const bless = useMutation({
		mutationFn: (t: string) => api.blessDevice(t),
		onSuccess: () => {
			setToken("");
			void client.invalidateQueries({ queryKey: DEVICES_KEY });
		},
	});
	const list = devices.data ?? [];
	const here = list.some((d) => d.current);

	function submit(event: FormEvent) {
		event.preventDefault();
		if (token.trim() && !bless.isPending) bless.mutate(token.trim());
	}

	return (
		<div className="space-y-3">
			{devices.isError ? <p className="text-sm text-destructive">Could not load the trusted browsers.</p> : null}
			{list.length ? (
				<ul className="divide-y">
					{list.map((d) => (
						<DeviceRow key={d.id} device={d} busy={revoke.isPending} onRevoke={() => revoke.mutate(d.id)} />
					))}
				</ul>
			) : devices.isSuccess ? (
				<p className="text-sm text-muted-foreground">No browser is trusted yet: owners who sign in through typetorch.dev get read-only access.</p>
			) : null}
			{revoke.isError ? <p className="text-sm text-destructive">{blessError(revoke.error)}</p> : null}
			{here ? null : (
				<form className="space-y-2" onSubmit={submit}>
					<Label htmlFor="bless-token" className="text-xs text-muted-foreground">
						Trust this browser (the admin token, once)
					</Label>
					<div className="flex flex-wrap gap-2">
						<Input id="bless-token" className="min-w-0 flex-1" type="password" autoComplete="off" spellCheck={false} placeholder="paste the admin token" value={token} onChange={(e) => setToken(e.target.value)} />
						<Button type="submit" disabled={bless.isPending || !token.trim()}>
							<ShieldCheck />
							{bless.isPending ? "Checking" : "Trust"}
						</Button>
					</div>
					{bless.isError ? (
						<Alert variant="destructive">
							<AlertDescription>{blessError(bless.error)}</AlertDescription>
						</Alert>
					) : null}
					<p className="text-xs text-muted-foreground">Or run `typetorch backend bless` on the PC with the game's signing key.</p>
				</form>
			)}
		</div>
	);
}

export function CentralLoginSection({ info }: { info: CentralLoginInfo | undefined }) {
	const on = Boolean(info?.on);
	return (
		<Section title="Sign in with typetorch.dev" description="One Roblox sign-in on typetorch.dev for every backend. On by default with an https TYPETORCH_PUBLIC_URL; TYPETORCH_CENTRAL_LOGIN=off turns it off (environment only).">
			<div className="space-y-3" data-central-login={on ? "on" : "off"}>
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<Badge variant={on ? "default" : "outline"}>{on ? "On" : "Off"}</Badge>
					{on && info?.issuer ? <span className="text-muted-foreground">through {info.issuer}</span> : null}
				</div>
				{on && info?.fingerprint ? (
					<div className="space-y-1">
						<div className="text-xs text-muted-foreground">This backend's fingerprint (paste it into Add project on dash.typetorch.dev)</div>
						<code className="block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">{info.fingerprint}</code>
					</div>
				) : null}
				{on ? (
					<>
						<p className="text-xs text-muted-foreground">
							Owners get full admin only on a trusted browser; elsewhere they get {info?.unblessed === "refuse" ? "no access" : "read-only access"}.
						</p>
						<Devices />
					</>
				) : null}
			</div>
		</Section>
	);
}
