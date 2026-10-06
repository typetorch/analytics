import { Link, useLocation } from "react-router";
import { cn } from "cn";
import { EventList } from "@/components/EventList";
import { EmptyState, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtInt, shortId } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { EventRow } from "@/lib/types";

const ALL = "all";

/** A link to a player's page that keeps the filters. */
function PlayerLink({ pid }: { pid: string }) {
	const { search } = useLocation();
	const params = new URLSearchParams();
	const current = new URLSearchParams(search);
	for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
	params.set("pid", pid);
	return (
		<Link to={{ pathname: "/players", search: `?${params.toString()}` }} className="font-mono text-xs underline-offset-2 hover:underline" title={pid}>
			{shortId(pid)}
		</Link>
	);
}

function RecentRows({ kind, name, pid, onClearPid }: { kind?: string; name?: string; pid?: string; onClearPid(): void }) {
	const q = useAnalytics("events", { ...(kind ? { kind } : {}), ...(name ? { name } : {}), ...(pid ? { pid } : {}), limit: 100 });
	const what = kind && name ? `${kind} / ${name} rows` : "rows";
	return (
		<Section
			title={pid ? <>Newest {what} of player <span className="font-mono text-sm">{shortId(pid)}</span></> : `Newest ${what}`}
			actions={
				pid ? (
					<Button variant="ghost" size="sm" onClick={onClearPid}>
						all players
					</Button>
				) : null
			}
			description="Up to 100, newest first. Fleet rows never show props (they can hold a private server's access code)."
		>
			<QueryState query={q} isEmpty={(d) => d.events.length === 0} empty="No rows of this event in this range.">
				{(data) => <Rows rows={data.events} />}
			</QueryState>
		</Section>
	);
}

function Rows({ rows }: { rows: EventRow[] }) {
	return (
		<EventList
			events={rows}
			dateToo
			extra={(e) => (
				<>
					{e.pid ? <PlayerLink pid={e.pid} /> : <span>server row</span>}
					<span>{[e.branch, e.dev].filter(Boolean).join(" · ")}</span>
					<span className="font-mono" title={e.job}>
						{e.art} · job {shortId(e.job, 6)}
					</span>
				</>
			)}
		/>
	);
}

export default function Events() {
	const top = useAnalytics("top-events", { limit: 500 });
	const [kindFilter, setKindFilter] = useParam("kind", ALL);
	const [picked, setPicked] = useParam("event");
	const [pid, setPid] = useParam("pid");
	const events = top.data?.events ?? [];
	const kinds = [...new Set(events.map((e) => e.kind))].sort();
	const shown = kindFilter === ALL ? events : events.filter((e) => e.kind === kindFilter);
	const max = Math.max(1, ...shown.map((e) => e.count));
	const at = picked.indexOf("/");
	const pick = at > 0 ? { kind: picked.slice(0, at), name: picked.slice(at + 1) } : null;
	return (
		<>
			<PageHeader title="Events" description="The most logged event names per kind; pick one to see its newest rows." />
			<QueryState query={top} isEmpty={(d) => d.events.length === 0} empty="No events in this range.">
				{() => (
					<div className="flex flex-col gap-4 xl:flex-row xl:items-start">
						<Section
							className="xl:w-[480px] xl:shrink-0"
							title={`${fmtInt(events.length)} event names`}
							actions={
								<ToggleGroup type="single" variant="outline" size="sm" value={kindFilter} onValueChange={(v) => v && setKindFilter(v)} className="flex-wrap">
									<ToggleGroupItem value={ALL} className="px-2 text-xs">
										all
									</ToggleGroupItem>
									{kinds.map((k) => (
										<ToggleGroupItem key={k} value={k} className="px-2 text-xs">
											{k}
										</ToggleGroupItem>
									))}
								</ToggleGroup>
							}
						>
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Event</TableHead>
										<TableHead className="text-right">Count</TableHead>
										<TableHead className="w-24" />
										<TableHead className="text-right">Players</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{shown.map((e) => {
										const key = `${e.kind}/${e.name}`;
										return (
											<TableRow key={key} className={cn("cursor-pointer", picked === key && "bg-muted")} onClick={() => setPicked(key)}>
												<TableCell>
													<Badge variant="outline" className="mr-1.5">
														{e.kind}
													</Badge>
													{e.name}
												</TableCell>
												<TableCell className="text-right tabular-nums">{fmtInt(e.count)}</TableCell>
												<TableCell>
													<ShareBar share={e.count / max} />
												</TableCell>
												<TableCell className="text-right tabular-nums" title="distinct pids; server rows have none">
													{fmtInt(e.players)}
												</TableCell>
											</TableRow>
										);
									})}
								</TableBody>
							</Table>
						</Section>
						<div className="min-w-0 flex-1">
							{pick || pid ? (
								<RecentRows {...(pick ?? {})} {...(pid ? { pid } : {})} onClearPid={() => setPid("")} />
							) : (
								<EmptyState>Pick an event on the left.</EmptyState>
							)}
						</div>
					</div>
				)}
			</QueryState>
		</>
	);
}
