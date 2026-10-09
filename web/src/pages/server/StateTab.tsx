/**
 * The State tab (op `state`, the dev menu's Modules > State on the server): the roots (live modules and the persist
 * store), then one table at a time, a page of 100 entries per answer, Prev / Next, a key filter the server applies, and
 * a breadcrumb back up. Reads only: the framework walks tables with rawget, never runs a metamethod or a function.
 */
import { ChevronRight } from "lucide-react";
import { useCallback, useState } from "react";
import { EmptyState } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtInt } from "@/lib/format";
import { useRemote } from "@/lib/remote-debug";
import type { StateEntry, StateQuery, StateReply } from "@/lib/types";
import { MEMORY_ONLY, RemoteBar, useDebug, useFirstFetch } from "./shared";

/** Where the browser is: no root = the list of roots; `segs` = the steps below the root (segment + the key shown). */
export interface StatePlace {
	root: string;
	label: string;
	segs: { seg: string; key: string }[];
}

/** The op's query for a place (the root list when `place` is undefined). */
export function stateQuery(place: StatePlace | undefined, page: number, filter: string): StateQuery {
	return { root: place?.root ?? "", path: place?.segs.map((s) => s.seg) ?? [], page, ...(filter ? { filter } : {}) };
}

/** One step down: a root from the root list, or a key below the current place. */
export function openEntry(place: StatePlace | undefined, entry: StateEntry): StatePlace {
	if (!place) return { root: entry.seg, label: entry.key, segs: [] };
	return { ...place, segs: [...place.segs, { seg: entry.seg, key: entry.key }] };
}

const COLUMNS: DataColumn<StateEntry>[] = [
	{
		id: "key",
		header: "Key",
		accessor: (e) => e.key,
		cell: (e) => (
			<span className="inline-flex items-center gap-1 font-mono text-xs">
				{e.expandable && !e.cycle ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /> : <span className="w-3.5 shrink-0" aria-hidden />}
				<span className="break-all">{e.key}</span>
			</span>
		),
		className: "max-w-[24rem]",
	},
	{ id: "type", header: "Type", type: "enum", accessor: (e) => e.type, className: "text-xs text-muted-foreground" },
	{
		id: "preview",
		header: "Value",
		accessor: (e) => e.preview,
		cell: (e) => <span className="break-all">{e.cycle ? `cycle: ${e.preview}` : e.preview}</span>,
		className: "min-w-48 max-w-[36rem] font-mono text-xs whitespace-pre-wrap",
	},
];

function Breadcrumb({ place, onGo }: { place?: StatePlace; onGo: (place: StatePlace | undefined) => void }) {
	const steps: { label: string; to: StatePlace | undefined }[] = [{ label: "Roots", to: undefined }];
	if (place) {
		steps.push({ label: place.label, to: { ...place, segs: [] } });
		place.segs.forEach((s, i) => steps.push({ label: s.key, to: { ...place, segs: place.segs.slice(0, i + 1) } }));
	}
	return (
		<nav aria-label="State path" className="flex flex-wrap items-center gap-1 text-sm">
			{steps.map((step, i) => (
				<span key={i} className="inline-flex items-center gap-1">
					{i > 0 ? <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden /> : null}
					{i === steps.length - 1 ? (
						<span className="font-mono text-xs font-medium break-all">{step.label}</span>
					) : (
						<button type="button" className="font-mono text-xs break-all text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => onGo(step.to)}>
							{step.label}
						</button>
					)}
				</span>
			))}
		</nav>
	);
}

export function StateTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const state = useRemote<StateReply[]>(call, "state");
	const run = state.run;
	const [place, setPlace] = useState<StatePlace | undefined>();
	const [page, setPage] = useState(0);
	const [filter, setFilter] = useState("");
	const [filterText, setFilterText] = useState("");
	const [reply, setReply] = useState<StateReply | undefined>();

	const load = useCallback(
		async (to: StatePlace | undefined, toPage: number, toFilter: string) => {
			const answer = await run({ queries: [stateQuery(to, toPage, toFilter)] });
			const first = Array.isArray(answer) ? answer[0] : undefined;
			if (!first) return;
			setPlace(to);
			setPage(first.page ?? toPage);
			setFilter(toFilter);
			setFilterText(toFilter);
			setReply(first);
		},
		[run],
	);
	const loadRoots = useCallback(() => load(undefined, 0, ""), [load]);
	useFirstFetch(active && ready, loadRoots);

	const busy = !ready || state.status === "running";
	const go = (to: StatePlace | undefined) => void load(to, 0, "");
	return (
		<div className="space-y-3">
			<RemoteBar state={state} onFetch={() => void load(place, page, filter)} label="Refresh">
				<Button type="button" variant="outline" size="sm" onClick={() => go(undefined)} disabled={busy}>
					Roots
				</Button>
			</RemoteBar>
			{reply ? (
				<>
					<Breadcrumb place={place} onGo={go} />
					<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
						{place ? (
							<span>
								<span className="font-mono">{reply.type}</span> {reply.preview}
							</span>
						) : null}
						<span className="tabular-nums">
							{fmtInt(reply.size)}
							{reply.capped ? "+" : ""} entries{filter ? `, ${fmtInt(reply.matched)} match` : ""}
						</span>
						{reply.pages > 1 ? (
							<span className="tabular-nums">
								page {reply.page + 1} of {fmtInt(reply.pages)}
							</span>
						) : null}
						{reply.truncated ? <span>only the first 20,000 keys are listed (in table order)</span> : null}
					</div>
					{/* The server filters the keys (case-insensitive part of the key); outside the table so it stays when nothing matches. */}
					<form
						className="flex flex-wrap items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							void load(place, 0, filterText.trim());
						}}
					>
						<Input aria-label="Filter keys" placeholder="filter keys" maxLength={64} className="h-8 w-48" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
						<Button type="submit" variant="outline" size="sm" disabled={busy}>
							Filter
						</Button>
						{filter ? (
							<Button type="button" variant="ghost" size="sm" onClick={() => void load(place, 0, "")} disabled={busy}>
								Clear
							</Button>
						) : null}
					</form>
					{reply.missing ? (
						<EmptyState>This path doesn't exist any more (the module reloaded, or the key went). Go back up.</EmptyState>
					) : reply.tooDeep ? (
						<EmptyState>Too deep: the server reads at most 24 steps below a root.</EmptyState>
					) : (
						<DataTable
							id="server-state"
							label={place ? `State of ${place.label}` : "State roots"}
							columns={COLUMNS}
							data={reply.entries ?? []}
							rowId={(e) => e.seg}
							pageSize={100}
							search={false}
							density="compact"
							onRowClick={(e) => {
								if (e.expandable && !e.cycle && !busy) void load(openEntry(place, e), 0, "");
							}}
							empty={<EmptyState>{filter ? "No key matches the filter." : place ? "This table is empty." : "No roots: nothing runs, or this build has no state to read."}</EmptyState>}
							{...MEMORY_ONLY}
						/>
					)}
					{reply.pages > 1 ? (
						<div className="flex items-center gap-2">
							<Button type="button" variant="outline" size="sm" onClick={() => void load(place, page - 1, filter)} disabled={busy || page <= 0}>
								Prev
							</Button>
							<Button type="button" variant="outline" size="sm" onClick={() => void load(place, page + 1, filter)} disabled={busy || !reply.hasMore}>
								Next
							</Button>
						</div>
					) : null}
				</>
			) : null}
		</div>
	);
}
