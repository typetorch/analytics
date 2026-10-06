/** The graph view, loaded on demand (React Flow + dagre come with the first graph shown). */
import { lazy, Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
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
