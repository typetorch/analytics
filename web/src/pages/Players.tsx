import { Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { DataTable, type DataColumn } from "@/components/data-table";
import { IdentityStatus } from "@/components/Identity";
import { PlayerDetail } from "@/components/player-detail/PlayerDetail";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtMinutes, shortId } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { PlayerSummary } from "@/lib/types";

const PID = /^[A-Za-z0-9_-]{1,64}$/;

const UID = /^\d{1,16}$/;

/** A pid, or a UserId mapped to its most recently seen pid (undefined when the server doesn't know it). */
async function pidFor(text: string): Promise<string | undefined> {
	if (UID.test(text)) {
		const known = await api.identity({ uid: text }).catch(() => []);
		if (known.length) return known[0].pid;
	}
	return PID.test(text) && text.length >= 8 ? text : undefined;
}

function PlayerList({ selected, onPick, initial }: { selected: string; onPick(pid: string): void; initial: string }) {
	const [text, setText] = useState(initial);
	const [search, setSearch] = useState(initial);
	const [missing, setMissing] = useState("");
	useEffect(() => {
		setText(initial);
		setSearch(initial);
	}, [initial]);
	useEffect(() => {
		const timer = setTimeout(() => setSearch(text.trim()), 400);
		return () => clearTimeout(timer);
	}, [text]);
	const valid = search === "" || PID.test(search);
	const q = useAnalytics("players", { limit: 100, ...(search ? { search } : {}) }, { enabled: valid });
	return (
		<Section title="Players" description="Most recent first. Search by part of a pid, or by a UserId." contentClassName="space-y-3">
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
					<Input aria-label="Search pid or UserId" className="h-8 pl-8" placeholder="pid, part of one, or a UserId" value={text} onChange={(e) => setText(e.target.value)} />
				</div>
				{(PID.test(text.trim()) && text.trim().length >= 8) || UID.test(text.trim()) ? (
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							const pid = await pidFor(text.trim());
							if (pid) {
								setMissing("");
								onPick(pid);
							} else setMissing(text.trim());
						}}
					>
						Open
					</Button>
				) : null}
			</div>
			{!valid ? <p className="text-xs text-muted-foreground">A pid has only letters, digits, _ and -.</p> : null}
			{missing ? <p className="text-xs text-muted-foreground">No player found for UserId {missing}.</p> : null}
			<QueryState query={q} isEmpty={(d) => d.players.length === 0} empty={search ? "No pid matches." : "No players in this range."}>
				{(data) => (
					<DataTable
						id="players-list"
						label="Players"
						columns={PLAYER_COLUMNS}
						data={data.players}
						rowId={(p) => p.pid}
						density="compact"
						onRowClick={(p) => onPick(p.pid)}
						isRowSelected={(p) => p.pid === selected}
						maxHeight="22rem"
					/>
				)}
			</QueryState>
		</Section>
	);
}

/** The player list: pid with its UserId under it, then when, how often and how long. Sorts by the numbers, not the text. */
const PLAYER_COLUMNS: DataColumn<PlayerSummary>[] = [
	{
		id: "pid",
		header: "Player",
		accessor: (p) => p.pid,
		searchText: (p) => (p.uid !== undefined ? `UserId ${p.uid}` : ""),
		cell: (p) => (
			<>
				<div className="flex items-center gap-2">
					<span className="font-mono" title={p.pid}>
						{shortId(p.pid, 10)}
					</span>
					{p.newInRange ? <Badge variant="secondary">new</Badge> : null}
				</div>
				{p.uid !== undefined ? <div className="text-muted-foreground tabular-nums">UserId {p.uid}</div> : null}
			</>
		),
	},
	{ id: "lastSeen", header: "Seen", type: "date", accessor: (p) => p.lastSeen, cell: (p) => fmtAgo(p.lastSeen), format: (_v, p) => fmtAgo(p.lastSeen) },
	{ id: "sessions", header: "Sessions", accessor: (p) => p.sessions, cell: (p) => fmtInt(p.sessions) },
	{ id: "playtime", header: "Playtime", accessor: (p) => p.playtimeMinutes, cell: (p) => fmtMinutes(p.playtimeMinutes), format: (_v, p) => fmtMinutes(p.playtimeMinutes) },
	{ id: "events", header: "Events", accessor: (p) => p.events, defaultHidden: true },
	{ id: "firstSeen", header: "First seen", type: "date", accessor: (p) => p.firstSeen, defaultHidden: true },
	{ id: "new", header: "New", type: "boolean", accessor: (p) => p.newInRange, defaultHidden: true },
	{ id: "uid", header: "UserId", type: "text", accessor: (p) => (p.uid === undefined ? null : String(p.uid)), defaultHidden: true },
];

export default function Players() {
	const [params, setParams] = useSearchParams();
	const pid = params.get("pid") ?? "";
	const find = params.get("find") ?? "";
	// Another player: their own sessions, so the session pick goes.
	const setPid = (next: string) =>
		setParams((current) => {
			const copy = new URLSearchParams(current);
			copy.set("pid", next);
			copy.delete("sid");
			copy.delete("find");
			return copy;
		});
	// A pick in the list: the detail container is under the list, so bring it into view (phones especially).
	const detailRef = useRef<HTMLDivElement>(null);
	const pick = (next: string) => {
		setPid(next);
		setTimeout(() => detailRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }), 0);
	};
	// The top bar's "Find player": open the player when the text is a pid or a known UserId, else search for it.
	useEffect(() => {
		if (!find) return;
		let live = true;
		void pidFor(find).then((found) => {
			if (live && found) setPid(found);
		});
		return () => {
			live = false;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [find]);
	return (
		<>
			<PageHeader title="Players" description="Find a player by pid (random ids, never a UserId) or UserId, then read their spending, playtime, sessions and timeline." />
			<div className="space-y-4">
				<div>
					<PlayerList selected={pid} onPick={pick} initial={find} />
					<div className="px-1 pt-2">
						<IdentityStatus />
					</div>
				</div>
				<div ref={detailRef} className="scroll-mt-20">
					{pid && PID.test(pid) ? <PlayerDetail pid={pid} /> : <EmptyState>Pick a player in the list.</EmptyState>}
				</div>
			</div>
		</>
	);
}
