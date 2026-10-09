import { useMemo } from "react";
import { DataTable, type DataColumn } from "@/components/data-table";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtInt, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { ExperimentResult } from "@/lib/types";

type Results = Extract<ExperimentResult, { variants: unknown }>;
type Variant = Results["variants"][number];
type Comparison = Results["comparisons"][number];

const METRICS: Record<string, string> = {
	returned: "came back (2+ days)",
	payers: "paid",
	playtime: "playtime per player",
	robux: "Robux per player",
	sessions: "sessions per player",
};

function fmtMetric(metric: string, value: number): string {
	if (metric === "returned" || metric === "payers") return fmtPct(value);
	if (metric === "playtime") return `${fmtNum(value, 1)} min`;
	return fmtNum(value);
}

/** A rate shown as "12.5% (30)": it sorts and filters by the rate, in percent. */
const rateColumn = (id: string, header: string, pick: (v: Variant) => { rate: number; count: number }): DataColumn<Variant> => ({
	id,
	header,
	accessor: (v) => pick(v).rate * 100,
	cell: (v) => (
		<>
			{fmtPct(pick(v).rate)} <span className="text-muted-foreground">({fmtInt(pick(v).count)})</span>
		</>
	),
	format: (_value, v) => `${fmtPct(pick(v).rate)} (${fmtInt(pick(v).count)})`,
});

const variantColumns = (control: string | null): DataColumn<Variant>[] => [
	{
		id: "variant",
		header: "Variant",
		accessor: (v) => v.variant,
		cell: (v) => (
			<>
				{v.variant} {v.variant === control ? <Badge variant="secondary">control</Badge> : null}
			</>
		),
		className: "font-medium",
	},
	{ id: "players", header: "Players", accessor: (v) => v.players, cell: (v) => fmtInt(v.players) },
	rateColumn("returned", "Came back", (v) => v.returned),
	rateColumn("payers", "Paid", (v) => v.payers),
	{ id: "playtime", header: "Playtime / player", hint: "min", accessor: (v) => v.playtimeMinutes, cell: (v) => `${fmtNum(v.playtimeMinutes, 1)} min` },
	{ id: "robux", header: "Robux / player", accessor: (v) => v.robuxPerPlayer, cell: (v) => fmtNum(v.robuxPerPlayer) },
	{ id: "sessions", header: "Sessions / player", accessor: (v) => v.sessionsPerPlayer, cell: (v) => fmtNum(v.sessionsPerPlayer) },
];

const COMPARISON_COLUMNS: DataColumn<Comparison>[] = [
	{ id: "words", header: "In words", accessor: (c) => c.words, className: "font-medium whitespace-normal" },
	{ id: "metric", header: "Metric", type: "enum", accessor: (c) => c.metric, format: (v) => METRICS[v as string] ?? String(v), cell: (c) => METRICS[c.metric] ?? c.metric, className: "text-muted-foreground" },
	{ id: "control", header: "Control", accessor: (c) => c.control, cell: (c) => fmtMetric(c.metric, c.control), format: (_v, c) => fmtMetric(c.metric, c.control) },
	{ id: "value", header: "Variant", accessor: (c) => c.value, cell: (c) => fmtMetric(c.metric, c.value), format: (_v, c) => fmtMetric(c.metric, c.value) },
	{
		id: "lift",
		header: "Lift",
		accessor: (c) => c.lift,
		cell: (c) => (c.lift === null ? "–" : `${c.lift > 0 ? "+" : ""}${fmtPct(c.lift)}`),
		format: (_v, c) => (c.lift === null ? "" : `${c.lift > 0 ? "+" : ""}${fmtPct(c.lift)}`),
	},
	{ id: "sure", header: "Sure", accessor: (c) => c.sure, cell: (c) => <span title={c.method}>{fmtPct(c.sure, 0)}</span>, format: (_v, c) => fmtPct(c.sure, 0) },
];

function ResultsView({ data }: { data: Results }) {
	const variants = useMemo(() => variantColumns(data.control), [data.control]);
	if (!data.variants.length) return <EmptyState>No player in this experiment in this range.</EmptyState>;
	return (
		<>
			<Section
				title={data.scope === "server" ? "Per server: pinned artifacts vs unpinned servers" : `Variants of ${data.experiment}`}
				description={`${data.control ? `Compared with the control variant "${data.control}".` : "No control variant."}${data.mixedPlayers ? ` ${plural(data.mixedPlayers, "player")} seen in more than one variant are left out.` : ""}`}
			>
				<DataTable id="experiment-variants" label="Variants" columns={variants} data={data.variants} rowId={(v) => v.variant} />
			</Section>
			<Section title="How sure" description="Each variant against the control: two-proportion test for shares, bootstrap (or Welch) for averages.">
				{data.comparisons.length ? (
					<DataTable id="experiment-comparisons" label="Comparisons with the control" columns={COMPARISON_COLUMNS} data={data.comparisons} rowId={(c) => `${c.variant}-${c.metric}`} />
				) : (
					<p className="text-sm text-muted-foreground">Nothing to compare yet: it needs a control and at least one other variant with players.</p>
				)}
			</Section>
		</>
	);
}

function PlayerScope() {
	const list = useAnalytics("experiment", {});
	const [picked, setPicked] = useParam("experiment");
	const names = list.data && list.data.experiment === null ? [...new Set(list.data.experiments.map((e) => e.experiment))] : [];
	const name = picked || names[0] || "";
	const results = useAnalytics("experiment", { experiment: name, scope: "player" }, { enabled: Boolean(name) });
	return (
		<QueryState query={list} isEmpty={(d) => d.experiment === null && d.experiments.length === 0} empty="No experiment rows in this range.">
			{() => (
				<>
					<div className="flex items-center gap-2">
						<span className="text-sm text-muted-foreground">Experiment</span>
						<Select value={name} onValueChange={setPicked}>
							<SelectTrigger size="sm" className="w-56" aria-label="Experiment">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{names.map((n) => (
									<SelectItem key={n} value={n}>
										{n}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<QueryState query={results}>{(data) => (data.experiment === null ? null : <ResultsView data={data} />)}</QueryState>
				</>
			)}
		</QueryState>
	);
}

function ServerScope() {
	const results = useAnalytics("experiment", { scope: "server" });
	return <QueryState query={results}>{(data) => (data.experiment === null ? null : <ResultsView data={data} />)}</QueryState>;
}

export default function Experiments() {
	const [scope, setScope] = useParam("scope", "player");
	return (
		<>
			<PageHeader
				title="Experiments"
				description="Per-variant numbers and how sure each difference is. Per player: the variant in each row's exp. Per server: kernel A/B pins."
				actions={
					<ToggleGroup type="single" variant="outline" size="sm" value={scope} onValueChange={(v) => v && setScope(v)}>
						<ToggleGroupItem value="player" className="px-2.5 text-xs">
							per player
						</ToggleGroupItem>
						<ToggleGroupItem value="server" className="px-2.5 text-xs">
							per server
						</ToggleGroupItem>
					</ToggleGroup>
				}
			/>
			{scope === "server" ? <ServerScope /> : <PlayerScope />}
		</>
	);
}
