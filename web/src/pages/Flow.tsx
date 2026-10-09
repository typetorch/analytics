import { FacetToggle, isFacet, LazyGraph, MomentsToggle, SparseNote } from "@/components/LazyGraph";
import { realStates } from "@/lib/graph-text";
import { MermaidButton } from "@/components/MermaidButton";
import { DataTable, type DataColumn } from "@/components/data-table";
import { PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtDuration, fmtInt, fmtPct, plural } from "@/lib/format";
import { exits, stateLines, topEdges } from "@/lib/graph-text";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { GraphData, GraphEdge } from "@/lib/types";

const name = (id: string) => stateLines(id).join(" · ");

type Exit = ReturnType<typeof exits>[number];

const EXIT_COLUMNS: DataColumn<Exit>[] = [
	{ id: "state", header: "State", accessor: (e) => e.state, cell: (e) => name(e.state), className: "whitespace-normal" },
	{ id: "count", header: "Sessions", accessor: (e) => e.count, cell: (e) => fmtInt(e.count) },
	{
		id: "share",
		header: "Share",
		accessor: (e) => e.share,
		format: (v) => fmtPct(v as number),
		cell: (e) => (
			<div className="flex items-center gap-2">
				<ShareBar share={e.share} />
				<span className="w-12 text-right text-xs tabular-nums">{fmtPct(e.share)}</span>
			</div>
		),
		align: "left",
		filter: false,
		minWidth: 140,
	},
];

const MOVE_COLUMNS: DataColumn<GraphEdge>[] = [
	{ id: "from", header: "From", accessor: (e) => name(e.from), className: "whitespace-normal" },
	{ id: "to", header: "To", accessor: (e) => name(e.to), className: "whitespace-normal" },
	{ id: "count", header: "Times", accessor: (e) => e.count, cell: (e) => fmtInt(e.count) },
	{ id: "share", header: "Share", accessor: (e) => e.share, cell: (e) => fmtPct(e.share), format: (v) => fmtPct(v as number) },
	{
		id: "before",
		header: "Avg before",
		title: "Average time in the state before the move",
		accessor: (e) => (e.from === "(start)" ? null : e.count ? e.dwellMs / e.count : 0),
		cell: (e) => (e.from === "(start)" ? "–" : fmtDuration(e.count ? e.dwellMs / e.count : 0)),
		format: (_v, e) => (e.from === "(start)" ? "" : fmtDuration(e.count ? e.dwellMs / e.count : 0)),
		exportValue: (e) => (e.from === "(start)" ? null : (e.count ? e.dwellMs / e.count : 0) / 1000),
	},
];

function Tables({ graph }: { graph: GraphData }) {
	const out = exits(graph);
	const moves = topEdges(graph.edges, 15);
	return (
		<div className="grid gap-4 xl:grid-cols-2">
			<Section className="min-w-0" title="Where sessions end" description="The last state before leaving (sessions that are over).">
				{out.length ? (
					<DataTable id="flow-exits" label="Where sessions end" columns={EXIT_COLUMNS} data={out} rowId={(e) => e.state} />
				) : (
					<p className="text-sm text-muted-foreground">No session in this range is over yet.</p>
				)}
			</Section>
			<Section className="min-w-0" title="Busiest moves" description="Share = of all moves out of the same state.">
				<DataTable id="flow-moves" label="Busiest moves" columns={MOVE_COLUMNS} data={moves} rowId={(e) => `${e.from}>${e.to}`} />
			</Section>
		</div>
	);
}

export default function Flow() {
	const [facetParam, setFacet] = useParam("facet", "all");
	const [minParam, setMin] = useParam("minCount", "1");
	const [momentsParam, setMoments] = useParam("moments");
	const moments = momentsParam === "1";
	const facet = isFacet(facetParam) ? facetParam : "all";
	const minCount = Math.max(1, Math.min(1_000_000, Number.parseInt(minParam, 10) || 1));
	const q = useAnalytics("flow", { facet, minCount, maxEdges: 200, ...(moments ? { moments: true } : {}) });
	return (
		<>
			<PageHeader
				title="Flow"
				description="Every matching player's moves merged into one graph: where most go next, and where they quit."
				actions={
					<>
						<FacetToggle value={facet} onChange={setFacet} />
						<MomentsToggle value={moments} onChange={(on) => setMoments(on ? "1" : "")} />
						<Label className="text-xs text-muted-foreground">
							Min moves
							<Input type="number" min={1} className="h-8 w-20" value={minCount} onChange={(e) => setMin(String(Math.max(1, Number(e.target.value) || 1)))} />
						</Label>
						{q.data ? <MermaidButton graph={q.data} /> : null}
					</>
				}
			/>
			<QueryState
				query={q}
				isEmpty={(g) => g.nodes.length === 0}
				empty={facet === "all" ? "No states logged in this range." : `No state in this range has a ${facet} part (try all).`}
			>
				{(graph) => (
					<>
						<Section title={`${plural(realStates(graph), "state")}, ${plural(graph.edges.length, "move")}`} contentClassName="space-y-2">
							<SparseNote graph={graph} />
							<LazyGraph graph={graph} />
						</Section>
						<Tables graph={graph} />
					</>
				)}
			</QueryState>
		</>
	);
}
