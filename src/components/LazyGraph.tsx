/** The graph view, loaded on demand (React Flow + dagre come with the first graph shown), and its small controls. */
import { ArrowRight } from "lucide-react";
import { Fragment, lazy, Suspense } from "react";
import { Link, useLocation } from "react-router";
import { Skeleton } from "@/components/ui/skeleton";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtDuration } from "@/lib/format";
import { LEFT, nodeKind, realStates, stateLines } from "@/lib/graph-text";
import { FACETS, type Facet, type GraphData } from "@/lib/types";

const GraphView = lazy(() => import("./GraphView"));

export function LazyGraph({ graph, maxEdges }: { graph: GraphData; maxEdges?: number }) {
	return (
		<Suspense fallback={<Skeleton className="h-[460px] w-full" />}>
			<GraphView graph={graph} {...(maxEdges ? { maxEdges } : {})} />
		</Suspense>
	);
}

/** Which part of the state is a node: all of it, or only the zone / screen / activity. */
export function FacetToggle({ value, onChange }: { value: Facet; onChange(facet: Facet): void }) {
	return (
		<ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v as Facet)} aria-label="Nodes are">
			{FACETS.map((f) => (
				<ToggleGroupItem key={f} value={f} className="px-2.5 text-xs">
					{f}
				</ToggleGroupItem>
			))}
		</ToggleGroup>
	);
}

export function isFacet(value: string): value is Facet {
	return (FACETS as string[]).includes(value);
}

/** Key moments (funnel steps, purchases, personal bests, round ends) as small nodes on the path. */
export function MomentsToggle({ value, onChange }: { value: boolean; onChange(on: boolean): void }) {
	return (
		<Toggle variant="outline" size="sm" pressed={value} onPressedChange={onChange} className="text-xs" title="Funnel steps, purchases, personal bests and round ends as small nodes">
			moments
		</Toggle>
	);
}

/** A link to the Events page that keeps the filters (and the player, when given). */
function EventsLink({ pid, children }: { pid?: string; children: string }) {
	const { search } = useLocation();
	const current = new URLSearchParams(search);
	const params = new URLSearchParams();
	for (const key of FILTER_KEYS) if (current.get(key)) params.set(key, current.get(key) as string);
	if (pid) params.set("pid", pid);
	const text = params.toString();
	return (
		<Link to={{ pathname: "/events", search: text ? `?${text}` : "" }} className="underline underline-offset-2 hover:text-foreground">
			{children}
		</Link>
	);
}

/** One dim line when a graph has fewer than 3 states: the game only logs these so far. */
export function SparseNote({ graph, pid }: { graph: GraphData; pid?: string }) {
	const states = realStates(graph);
	if (states >= 3) return null;
	const parts = new Set<string>();
	for (const n of graph.nodes) {
		if (nodeKind(n.id) !== "state") continue;
		for (const part of n.id.split("|")) if (part.includes(":")) parts.add(part.slice(0, part.indexOf(":")));
	}
	const which = parts.size ? ` (${[...parts].join(", ")})` : "";
	return (
		<p className="text-xs text-muted-foreground">
			Only {states} state{states === 1 ? "" : "s"}
			{which}: the graph shows what the game logs as state (zone, screen, activity), and this build logs only these so far.{" "}
			<EventsLink {...(pid ? { pid } : {})}>{pid ? "See this player's events" : "See the events"}</EventsLink>.
		</p>
	);
}

/** A one-session graph's visits in order, with the time in each. */
export function PathStrip({ graph }: { graph: GraphData }) {
	if (!graph.path?.length) return null;
	return (
		<div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs">
			<span className="text-muted-foreground">Path:</span>
			{graph.path.map((p, i) => (
				<Fragment key={p.step}>
					{i > 0 ? <ArrowRight className="size-3 text-muted-foreground" /> : null}
					<span className={nodeKind(p.state) === "moment" ? "rounded-full border border-[var(--chart-4)] px-1.5" : "rounded border px-1.5"}>
						<span className="text-muted-foreground tabular-nums">#{p.step}</span> {stateLines(p.state).join(" · ")}{" "}
						<span className="text-muted-foreground tabular-nums">{fmtDuration(p.ms)}</span>
					</span>
				</Fragment>
			))}
			{graph.ended ? (
				<>
					<ArrowRight className="size-3 text-muted-foreground" />
					<span className="text-muted-foreground">{stateLines(LEFT)[0]}</span>
				</>
			) : (
				<span className="text-muted-foreground">(session still on, or its last rows not in yet)</span>
			)}
		</div>
	);
}
