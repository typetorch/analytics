import { FacetToggle, isFacet, LazyGraph, MomentsToggle, SparseNote } from "@/components/LazyGraph";
import { realStates } from "@/lib/graph-text";
import { MermaidButton } from "@/components/MermaidButton";
import { PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDuration, fmtInt, fmtPct, plural } from "@/lib/format";
import { exits, stateLines, topEdges } from "@/lib/graph-text";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { GraphData } from "@/lib/types";

const name = (id: string) => stateLines(id).join(" · ");

function Tables({ graph }: { graph: GraphData }) {
	const out = exits(graph);
	const moves = topEdges(graph.edges, 15);
	return (
		<div className="grid gap-4 xl:grid-cols-2">
			<Section title="Where sessions end" description="The last state before leaving (sessions that are over).">
				{out.length ? (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>State</TableHead>
								<TableHead className="text-right">Sessions</TableHead>
								<TableHead className="w-40">Share</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{out.map((e) => (
								<TableRow key={e.state}>
									<TableCell className="whitespace-normal">{name(e.state)}</TableCell>
									<TableCell className="text-right tabular-nums">{fmtInt(e.count)}</TableCell>
									<TableCell>
										<div className="flex items-center gap-2">
											<ShareBar share={e.share} />
											<span className="w-12 text-right text-xs tabular-nums">{fmtPct(e.share)}</span>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				) : (
					<p className="text-sm text-muted-foreground">No session in this range is over yet.</p>
				)}
			</Section>
			<Section title="Busiest moves" description="Share = of all moves out of the same state.">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>From</TableHead>
							<TableHead>To</TableHead>
							<TableHead className="text-right">Times</TableHead>
							<TableHead className="text-right">Share</TableHead>
							<TableHead className="text-right">Avg before</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{moves.map((e) => (
							<TableRow key={`${e.from}>${e.to}`}>
								<TableCell className="whitespace-normal">{name(e.from)}</TableCell>
								<TableCell className="whitespace-normal">{name(e.to)}</TableCell>
								<TableCell className="text-right tabular-nums">{fmtInt(e.count)}</TableCell>
								<TableCell className="text-right tabular-nums">{fmtPct(e.share)}</TableCell>
								<TableCell className="text-right tabular-nums">{e.from === "(start)" ? "–" : fmtDuration(e.count ? e.dwellMs / e.count : 0)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
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
