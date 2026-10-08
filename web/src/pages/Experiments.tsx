import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { fmtInt, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { ExperimentResult } from "@/lib/types";

type Results = Extract<ExperimentResult, { variants: unknown }>;

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

function ResultsView({ data }: { data: Results }) {
	if (!data.variants.length) return <EmptyState>No player in this experiment in this range.</EmptyState>;
	return (
		<>
			<Section
				title={data.scope === "server" ? "Per server: pinned artifacts vs unpinned servers" : `Variants of ${data.experiment}`}
				description={`${data.control ? `Compared with the control variant "${data.control}".` : "No control variant."}${data.mixedPlayers ? ` ${plural(data.mixedPlayers, "player")} seen in more than one variant are left out.` : ""}`}
			>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Variant</TableHead>
							<TableHead className="text-right">Players</TableHead>
							<TableHead className="text-right">Came back</TableHead>
							<TableHead className="text-right">Paid</TableHead>
							<TableHead className="text-right">Playtime / player</TableHead>
							<TableHead className="text-right">Robux / player</TableHead>
							<TableHead className="text-right">Sessions / player</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.variants.map((v) => (
							<TableRow key={v.variant}>
								<TableCell className="font-medium">
									{v.variant} {v.variant === data.control ? <Badge variant="secondary">control</Badge> : null}
								</TableCell>
								<TableCell className="text-right tabular-nums">{fmtInt(v.players)}</TableCell>
								<TableCell className="text-right tabular-nums">
									{fmtPct(v.returned.rate)} <span className="text-muted-foreground">({fmtInt(v.returned.count)})</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">
									{fmtPct(v.payers.rate)} <span className="text-muted-foreground">({fmtInt(v.payers.count)})</span>
								</TableCell>
								<TableCell className="text-right tabular-nums">{fmtNum(v.playtimeMinutes, 1)} min</TableCell>
								<TableCell className="text-right tabular-nums">{fmtNum(v.robuxPerPlayer)}</TableCell>
								<TableCell className="text-right tabular-nums">{fmtNum(v.sessionsPerPlayer)}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</Section>
			<Section title="How sure" description="Each variant against the control: two-proportion test for shares, bootstrap (or Welch) for averages.">
				{data.comparisons.length ? (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>In words</TableHead>
								<TableHead>Metric</TableHead>
								<TableHead className="text-right">Control</TableHead>
								<TableHead className="text-right">Variant</TableHead>
								<TableHead className="text-right">Lift</TableHead>
								<TableHead className="text-right">Sure</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{data.comparisons.map((c) => (
								<TableRow key={`${c.variant}-${c.metric}`}>
									<TableCell className="font-medium whitespace-normal">{c.words}</TableCell>
									<TableCell className="text-muted-foreground">{METRICS[c.metric] ?? c.metric}</TableCell>
									<TableCell className="text-right tabular-nums">{fmtMetric(c.metric, c.control)}</TableCell>
									<TableCell className="text-right tabular-nums">{fmtMetric(c.metric, c.value)}</TableCell>
									<TableCell className="text-right tabular-nums">{c.lift === null ? "–" : `${c.lift > 0 ? "+" : ""}${fmtPct(c.lift)}`}</TableCell>
									<TableCell className="text-right tabular-nums" title={c.method}>
										{fmtPct(c.sure, 0)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
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
