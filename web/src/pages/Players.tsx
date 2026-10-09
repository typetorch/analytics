import { Search, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { FacetToggle, isFacet, LazyGraph, MomentsToggle, PathStrip, SparseNote } from "@/components/LazyGraph";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EventTable } from "@/components/EventTable";
import { IdentityStatus, UserIdLink } from "@/components/Identity";
import { MermaidButton } from "@/components/MermaidButton";
import { EmptyState, KeyValue, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtMinutes, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { PlayerSummary, TimelineEvent, TimelineResult } from "@/lib/types";

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
			{missing ? <p className="text-xs text-muted-foreground">No pid known for {missing}: only players who joined after the identity update (or a backfill) are mapped.</p> : null}
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

function Timeline({ data, onGraph }: { data: TimelineResult; onGraph(sid: string): void }) {
	const bySession = new Map<string, TimelineEvent[]>();
	for (const e of data.events) bySession.set(e.sid, [...(bySession.get(e.sid) ?? []), e]);
	return (
		<div className="space-y-3">
			{data.truncated ? (
				<p className="text-xs text-muted-foreground">Showing the oldest {fmtInt(data.events.length)} events; narrow the date range to see later ones.</p>
			) : null}
			{[...data.sessions].reverse().map((s) => (
				<Section
					key={s.sid}
					title={
						<span className="flex flex-wrap items-center gap-2">
							Session {fmtTime(s.start)}
							{s.firstSession ? <Badge>first session</Badge> : null}
						</span>
					}
					description={`${fmtMinutes(s.minutes)} · ${plural(s.events, "event")} · ${s.dev ?? "unknown device"} · artifact ${s.art} · sid ${shortId(s.sid)}`}
					actions={
						<Button variant="outline" size="sm" onClick={() => onGraph(s.sid)}>
							<Workflow />
							View graph
						</Button>
					}
				>
					{bySession.get(s.sid)?.length ? (
						// One saved view for every session's table, kept off the URL (they would overwrite each other there).
						<EventTable id="player-events" label={`Events of session ${shortId(s.sid)}`} events={bySession.get(s.sid) ?? []} urlSync={false} maxHeight="24rem" />
					) : (
						<EmptyState>No events of this session in the list.</EmptyState>
					)}
				</Section>
			))}
		</div>
	);
}

const ALL_SESSIONS = "__all";

function PlayerDetail({ pid }: { pid: string }) {
	const [facetParam, setFacet] = useParam("facet", "all");
	const [sid, setSid] = useParam("sid");
	const [momentsParam, setMoments] = useParam("moments");
	const facet = isFacet(facetParam) ? facetParam : "all";
	const moments = momentsParam === "1";
	const graphRef = useRef<HTMLDivElement>(null);
	const timeline = useAnalytics("timeline", { pid, limit: 2000 });
	const sessions = timeline.data?.sessions ?? [];
	const session = sessions.find((s) => s.sid === sid);
	const graph = useAnalytics("player-graph", { pid, facet, ...(sid ? { sid } : {}), ...(moments ? { moments: true } : {}) });
	const showSession = (next: string) => {
		setSid(next);
		graphRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
	};
	return (
		<div className="min-w-0 flex-1 space-y-4">
			<Section
				title={
					<span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
						<span className="font-mono text-sm break-all">{pid}</span>
						{timeline.data?.uid !== undefined ? <UserIdLink uid={timeline.data.uid} className="inline-flex items-center gap-1 text-xs font-normal text-muted-foreground underline-offset-2 hover:underline" /> : null}
					</span>
				}
				description="One player's sessions and every event, and their moves between states."
				actions={graph.data ? <MermaidButton graph={graph.data} /> : null}
			>
				{timeline.data ? (
					<div className="flex flex-wrap gap-x-6 gap-y-1">
						<KeyValue label="sessions">{fmtInt(timeline.data.sessions.length)}</KeyValue>
						<KeyValue label="events">
							{fmtInt(timeline.data.events.length)}
							{timeline.data.truncated ? "+" : ""}
						</KeyValue>
						<KeyValue label="playtime">{fmtMinutes(timeline.data.sessions.reduce((s, x) => s + x.minutes, 0))}</KeyValue>
						<KeyValue label="first seen">{fmtTime(timeline.data.sessions[0]?.start)}</KeyValue>
					</div>
				) : null}
			</Section>
			<div ref={graphRef} className="scroll-mt-28">
				<Section
					title={session ? `Session ${fmtTime(session.start)}` : "Node graph, all sessions"}
					description={session ? `${fmtMinutes(session.minutes)}, ${plural(session.events, "event")}: the moves in order, and the time in each state.` : "States are nodes, moves are edges."}
					actions={
						<>
							<Select value={sid || ALL_SESSIONS} onValueChange={(v) => setSid(v === ALL_SESSIONS ? "" : v)}>
								<SelectTrigger size="sm" className="w-52" aria-label="Session">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value={ALL_SESSIONS}>All sessions</SelectItem>
									{sid && !session ? <SelectItem value={sid}>session {shortId(sid)}</SelectItem> : null}
									{[...sessions].reverse().map((s) => (
										<SelectItem key={s.sid} value={s.sid}>
											{fmtTime(s.start).slice(5, 16)} ({fmtMinutes(s.minutes)})
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<FacetToggle value={facet} onChange={setFacet} />
							<MomentsToggle value={moments} onChange={(on) => setMoments(on ? "1" : "")} />
						</>
					}
					contentClassName="space-y-2"
				>
					<QueryState
						query={graph}
						isEmpty={(g) => g.nodes.length === 0}
						empty={facet === "all" ? "No states logged for this player here." : `None of this player's states has a ${facet} part (try all).`}
					>
						{(g) => (
							<>
								<SparseNote graph={g} pid={pid} />
								<LazyGraph graph={g} />
								<PathStrip graph={g} />
							</>
						)}
					</QueryState>
				</Section>
			</div>
			<QueryState query={timeline} isEmpty={(t) => t.sessions.length === 0} empty="This player has no events in this range: widen the date range.">
				{(t) => <Timeline data={t} onGraph={showSession} />}
			</QueryState>
		</div>
	);
}

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
			<PageHeader title="Players" description="Find a player by pid (random ids, never a UserId), then read their timeline and graph." />
			<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
				<div className="w-full shrink-0 lg:w-96">
					<PlayerList selected={pid} onPick={setPid} initial={find} />
					<div className="px-1 pt-2">
						<IdentityStatus />
					</div>
				</div>
				{pid && PID.test(pid) ? (
					<PlayerDetail pid={pid} />
				) : (
					<div className="flex-1">
						<EmptyState>Pick a player on the left.</EmptyState>
					</div>
				)}
			</div>
		</>
	);
}
