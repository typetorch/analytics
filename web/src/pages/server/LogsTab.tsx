/**
 * The Logs tab. Server: the kernel's log ring (op `logs`: the newest 200, then "Fetch newer" from the last index).
 * Player: pick a player, then their client's log ring (op `player.logs`: the kernel asks that client on its own channel,
 * so it works while the game's code is broken). Lines stay in this page's memory, at most LOGS_KEPT per view.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fmtInt } from "@/lib/format";
import { useRemote, type RemoteState } from "@/lib/remote-debug";
import type { RemoteLogEntry, RemoteLogs, RemotePlayerLogs, RemotePlayers } from "@/lib/types";
import { LogTable, RemoteBar, useDebug, useFirstFetch } from "./shared";

/** Lines kept per view (the kernel's server ring holds about as many). */
export const LOGS_KEPT = 2000;
/** The first fetch: the newest this many lines. */
export const LOGS_FIRST = 200;

/** Adds `incoming` to `current` by index (no duplicates), oldest first, the newest `keep` only. */
export function mergeLogs(current: readonly RemoteLogEntry[], incoming: readonly RemoteLogEntry[], keep = LOGS_KEPT): RemoteLogEntry[] {
	const byIndex = new Map<number, RemoteLogEntry>();
	for (const entry of current) byIndex.set(entry.i, entry);
	for (const entry of incoming) if (entry && typeof entry.i === "number") byIndex.set(entry.i, entry);
	return [...byIndex.values()].sort((a, b) => a.i - b.i).slice(-keep);
}

function ServerLogs({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const logs = useRemote<RemoteLogs>(call, "logs");
	const run = logs.run;
	const [entries, setEntries] = useState<RemoteLogEntry[]>([]);
	const [last, setLast] = useState<number | undefined>();
	const fetchLatest = useCallback(async () => {
		const answer = await run({ limit: LOGS_FIRST });
		if (!answer) return;
		setEntries(mergeLogs([], answer.entries ?? []));
		setLast(answer.last);
	}, [run]);
	const fetchNewer = useCallback(async () => {
		if (last === undefined) return fetchLatest();
		const answer = await run({ since: last, limit: 500 });
		if (!answer) return;
		setEntries((current) => mergeLogs(current, answer.entries ?? []));
		setLast(answer.last);
	}, [run, last, fetchLatest]);
	useFirstFetch(active && ready, fetchLatest);
	return (
		<div className="space-y-3">
			<RemoteBar state={logs} onFetch={() => void fetchLatest()} label={`Fetch latest ${LOGS_FIRST}`}>
				<Button type="button" variant="outline" size="sm" onClick={() => void fetchNewer()} disabled={!ready || logs.status === "running" || last === undefined}>
					Fetch newer
				</Button>
				{entries.length ? <span className="text-xs text-muted-foreground tabular-nums">{fmtInt(entries.length)} lines</span> : null}
			</RemoteBar>
			{logs.data || entries.length ? (
				<LogTable id="server-logs" label="Server log" entries={entries} empty={<EmptyState>The server log is empty.</EmptyState>} />
			) : null}
		</div>
	);
}

export interface PlayerLogRequest {
	userId: number;
	/** A new request for the same player fetches again. */
	n: number;
}

function PlayerLogs({ players, request }: { players: RemoteState<RemotePlayers> & { run: () => Promise<unknown> }; request?: PlayerLogRequest }) {
	const { call, ready } = useDebug();
	const logs = useRemote<RemotePlayerLogs>(call, "player.logs");
	const run = logs.run;
	const [userId, setUserId] = useState<number | undefined>();
	const [entries, setEntries] = useState<RemoteLogEntry[]>([]);
	const [last, setLast] = useState<number | undefined>();
	// The player the lines on screen belong to: a slow answer for the previous pick is dropped.
	const shown = useRef<number | undefined>(undefined);

	const fetchFor = useCallback(
		async (id: number, since?: number) => {
			const answer = await run({ userId: id, ...(since !== undefined ? { since } : {}) });
			if (!answer || shown.current !== id || answer.userId !== id) return;
			const incoming = answer.entries ?? [];
			setEntries((current) => mergeLogs(since === undefined ? [] : current, incoming));
			setLast((previous) => (incoming.length ? incoming[incoming.length - 1].i : (previous ?? since)));
		},
		[run],
	);
	const pick = useCallback(
		(id: number) => {
			shown.current = id;
			setUserId(id);
			setEntries([]);
			setLast(undefined);
			void fetchFor(id);
		},
		[fetchFor],
	);
	useEffect(() => {
		if (request) pick(request.userId);
	}, [request, pick]);

	const list = players.data?.players ?? [];
	const current = list.find((p) => p.userId === userId);
	const who = current ? `${current.displayName ?? current.name} (@${current.name})` : userId !== undefined ? `UserId ${userId}` : "";
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				{players.data ? (
					<Select value={userId !== undefined ? String(userId) : ""} onValueChange={(v) => pick(Number(v))} disabled={!ready || !list.length}>
						<SelectTrigger size="sm" className="w-64 max-w-full" aria-label="Player">
							<SelectValue placeholder={list.length ? "Pick a player" : "Nobody is in this server"} />
						</SelectTrigger>
						<SelectContent>
							{list.map((p) => (
								<SelectItem key={p.userId} value={String(p.userId)}>
									{p.displayName ?? p.name} (@{p.name})
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				) : null}
				<Button type="button" variant="outline" size="sm" onClick={() => void players.run()} disabled={!ready || players.status === "running"}>
					{players.data ? "Refresh players" : "Load players"}
				</Button>
			</div>
			{userId !== undefined ? (
				<>
					<RemoteBar state={logs} onFetch={() => void fetchFor(userId)} label="Fetch client logs">
						<Button type="button" variant="outline" size="sm" onClick={() => void fetchFor(userId, last)} disabled={!ready || logs.status === "running" || last === undefined}>
							Fetch newer
						</Button>
						<span className="text-xs text-muted-foreground">{who}</span>
					</RemoteBar>
					{logs.data || entries.length ? (
						<LogTable id="server-player-logs" label={`Client log of ${who}`} entries={entries} empty={<EmptyState>No log lines from this client yet.</EmptyState>} />
					) : null}
				</>
			) : (
				<p className="text-sm text-muted-foreground">Pick a player to read their client log (asked from their client, at most 200 lines).</p>
			)}
		</div>
	);
}

export function LogsTab({
	active,
	players,
	request,
}: {
	active: boolean;
	players: RemoteState<RemotePlayers> & { run: () => Promise<unknown> };
	request?: PlayerLogRequest;
}) {
	const [view, setView] = useState<"server" | "player">("server");
	useEffect(() => {
		if (request) setView("player");
	}, [request]);
	return (
		<Tabs value={view} onValueChange={(v) => setView(v as "server" | "player")} className="gap-3">
			<TabsList variant="line" aria-label="Whose log">
				<TabsTrigger value="server">Server</TabsTrigger>
				<TabsTrigger value="player">Player</TabsTrigger>
			</TabsList>
			<TabsContent value="server" forceMount className="data-[state=inactive]:hidden">
				<ServerLogs active={active && view === "server"} />
			</TabsContent>
			<TabsContent value="player" forceMount className="data-[state=inactive]:hidden">
				<PlayerLogs players={players} request={request} />
			</TabsContent>
		</Tabs>
	);
}
