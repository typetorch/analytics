import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { FacetToggle, isFacet, LazyGraph } from "@/components/LazyGraph";
import { EventList } from "@/components/EventList";
import { MermaidButton } from "@/components/MermaidButton";
import { EmptyState, KeyValue, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtAgo, fmtInt, fmtMinutes, fmtTime, plural, shortId } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { PlayerSummary, TimelineEvent, TimelineResult } from "@/lib/types";

const PID = /^[A-Za-z0-9_-]{1,64}$/;

function PlayerList({ selected, onPick }: { selected: string; onPick(pid: string): void }) {
	const [text, setText] = useState("");
	const [search, setSearch] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setSearch(text.trim()), 400);
		return () => clearTimeout(timer);
	}, [text]);
	const valid = search === "" || PID.test(search);
	const q = useAnalytics("players", { limit: 100, ...(search ? { search } : {}) }, { enabled: valid });
	return (
		<Section title="Players" description="Most recent first. Search matches any part of a pid." contentClassName="space-y-3">
			<div className="flex gap-2">
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
					<Input aria-label="Search pid" className="h-8 pl-8" placeholder="pid or part of it" value={text} onChange={(e) => setText(e.target.value)} />
				</div>
				{PID.test(text.trim()) && text.trim().length >= 8 ? (
					<Button size="sm" variant="outline" onClick={() => onPick(text.trim())}>
						Open
					</Button>
				) : null}
			</div>
			{!valid ? <p className="text-xs text-muted-foreground">A pid has only letters, digits, _ and -.</p> : null}
			<QueryState query={q} isEmpty={(d) => d.players.length === 0} empty={search ? "No pid matches." : "No players in this range."}>
				{(data) => (
					<div className="max-h-[70vh] space-y-1 overflow-y-auto pr-1">
						{data.players.map((p) => (
							<PlayerRow key={p.pid} player={p} active={p.pid === selected} onPick={onPick} />
						))}
					</div>
				)}
			</QueryState>
		</Section>
	);
}

function PlayerRow({ player: p, active, onPick }: { player: PlayerSummary; active: boolean; onPick(pid: string): void }) {
	return (
		<button
			type="button"
			onClick={() => onPick(p.pid)}
			className={cn("w-full rounded-md border px-2.5 py-2 text-left text-xs hover:bg-muted", active && "border-primary bg-muted")}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="truncate font-mono" title={p.pid}>
					{shortId(p.pid, 10)}
				</span>
				{p.newInRange ? <Badge variant="secondary">new</Badge> : null}
			</div>
			<div className="mt-1 text-muted-foreground tabular-nums">
				{fmtAgo(p.lastSeen)} · {fmtInt(p.sessions)} session{p.sessions === 1 ? "" : "s"} · {fmtMinutes(p.playtimeMinutes)}
			</div>
		</button>
	);
}

function Timeline({ data }: { data: TimelineResult }) {
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
				>
					{bySession.get(s.sid)?.length ? <EventList events={bySession.get(s.sid) ?? []} /> : <EmptyState>No events of this session in the list.</EmptyState>}
				</Section>
			))}
		</div>
	);
}

function PlayerDetail({ pid }: { pid: string }) {
	const [facetParam, setFacet] = useParam("facet", "all");
	const facet = isFacet(facetParam) ? facetParam : "all";
	const timeline = useAnalytics("timeline", { pid, limit: 2000 });
	const graph = useAnalytics("player-graph", { pid, facet });
	return (
		<div className="min-w-0 flex-1 space-y-4">
			<Section
				title={<span className="font-mono text-sm break-all">{pid}</span>}
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
			<Section title="Node graph" description="States are nodes, moves are edges." actions={<FacetToggle value={facet} onChange={setFacet} />}>
				<QueryState
					query={graph}
					isEmpty={(g) => g.nodes.length === 0}
					empty={facet === "all" ? "No states logged for this player in this range." : `None of this player's states has a ${facet} part (try all).`}
				>
					{(g) => <LazyGraph graph={g} />}
				</QueryState>
			</Section>
			<QueryState query={timeline} isEmpty={(t) => t.sessions.length === 0} empty="This player has no events in this range: widen the date range.">
				{(t) => <Timeline data={t} />}
			</QueryState>
		</div>
	);
}

export default function Players() {
	const [pid, setPid] = useParam("pid");
	return (
		<>
			<PageHeader title="Players" description="Find a player by pid (random ids, never a UserId), then read their timeline and graph." />
			<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
				<div className="w-full shrink-0 lg:w-80">
					<PlayerList selected={pid} onPick={setPid} />
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
