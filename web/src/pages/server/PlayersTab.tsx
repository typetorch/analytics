/**
 * The Players tab (op `players`): who is in the server, dev or not by the kernel's rule, ping, account age and how their
 * client start went. "Logs" opens that player's client logs in the Logs tab.
 */
import { ScrollText } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { fmtInt } from "@/lib/format";
import type { RemoteState } from "@/lib/remote-debug";
import type { RemotePlayer, RemotePlayers } from "@/lib/types";
import { MEMORY_ONLY, RemoteBar, Tone, useDebug, useFirstFetch } from "./shared";

/** How a player's client start went: ok, failed (with why), or no report yet. */
export function clientState(p: RemotePlayer): "ok" | "failed" | "waiting" {
	if (!p.client || p.client.ok === undefined) return "waiting";
	return p.client.ok ? "ok" : "failed";
}

const CLIENT_TONE = { ok: "bg-[var(--status-good)]", failed: "bg-[var(--status-critical)]", waiting: "bg-muted-foreground" } as const;

function playerColumns(onLogs: (userId: number) => void, ready: boolean): DataColumn<RemotePlayer>[] {
	return [
		{
			id: "name",
			header: "Player",
			accessor: (p) => p.displayName ?? p.name,
			searchText: (p) => `${p.name} ${p.displayName ?? ""}`,
			cell: (p) => (
				<span className="flex flex-col">
					<span className="font-medium">{p.displayName ?? p.name}</span>
					{p.displayName && p.displayName !== p.name ? <span className="text-xs text-muted-foreground">@{p.name}</span> : null}
				</span>
			),
		},
		{ id: "userId", header: "UserId", type: "text", accessor: (p) => String(p.userId), className: "font-mono text-xs" },
		{
			id: "dev",
			header: "Access",
			type: "enum",
			accessor: (p) => (p.dev ? (p.role ?? "dev") : "player"),
			cell: (p) => <span title={p.reason}>{p.dev ? (p.role ?? "dev") : "player"}</span>,
		},
		{ id: "ping", header: "Ping", hint: "ms", type: "number", firstSort: "desc", accessor: (p) => p.pingMs ?? null, cell: (p) => fmtInt(p.pingMs) },
		{ id: "accountAge", header: "Account age", hint: "days", type: "number", accessor: (p) => p.accountAge ?? null, cell: (p) => fmtInt(p.accountAge) },
		{
			id: "client",
			header: "Client start",
			type: "enum",
			order: ["failed", "waiting", "ok"],
			options: ["failed", "waiting", "ok"],
			accessor: (p) => clientState(p),
			cell: (p) => (
				<span title={p.client?.error ?? (p.client?.generation ? `generation ${p.client.generation}` : undefined)}>
					<Tone tone={CLIENT_TONE[clientState(p)]}>{clientState(p)}</Tone>
				</span>
			),
		},
		{
			id: "actions",
			header: "Logs",
			accessor: () => null,
			sortable: false,
			filter: false,
			searchable: false,
			hideable: false,
			cell: (p) => (
				<Button type="button" variant="ghost" size="xs" onClick={() => onLogs(p.userId)} disabled={!ready} aria-label={`Client logs of ${p.name}`}>
					<ScrollText aria-hidden />
					Logs
				</Button>
			),
		},
	];
}

export function PlayersTab({ active, players, onLogs }: { active: boolean; players: RemoteState<RemotePlayers> & { run: () => Promise<unknown> }; onLogs: (userId: number) => void }) {
	const { ready } = useDebug();
	const run = players.run;
	useFirstFetch(active && ready, run);
	const columns = useMemo(() => playerColumns(onLogs, ready), [onLogs, ready]);
	const list = players.data?.players ?? [];
	return (
		<div className="space-y-3">
			<RemoteBar state={players} onFetch={() => void run()}>
				{players.data ? (
					<span className="text-xs text-muted-foreground tabular-nums">
						{fmtInt(list.length)} / {fmtInt(players.data.max)} players
					</span>
				) : null}
			</RemoteBar>
			{players.data ? (
				<DataTable
					id="server-players"
					label="Players in this server"
					columns={columns}
					data={list}
					rowId={(p) => String(p.userId)}
					defaultSort={[{ id: "name", desc: false }]}
					empty={<EmptyState>Nobody is in this server.</EmptyState>}
					{...MEMORY_ONLY}
				/>
			) : null}
		</div>
	);
}
