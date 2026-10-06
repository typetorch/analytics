import { cn } from "cn";
import { PageHeader, QueryState, Section } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtInt, fmtPct, plural } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { RetentionResult } from "@/lib/types";

/** One heatmap cell: the share kept (blue, darker = more), "–" while that day isn't over. */
function Cell({ rate, kept }: { rate: number | null; kept?: number | null }) {
	if (rate === null) {
		return (
			<TableCell className="text-center text-xs text-muted-foreground" title="this day isn't over yet">
				–
			</TableCell>
		);
	}
	const alpha = 0.08 + Math.min(1, rate) * 0.82;
	return (
		<TableCell className="p-0.5 text-center">
			<div
				className={cn("rounded px-2 py-1.5 text-xs tabular-nums", alpha > 0.5 ? "text-white" : "text-foreground")}
				style={{ backgroundColor: `rgba(var(--heat), ${alpha.toFixed(2)})` }}
				title={kept !== undefined && kept !== null ? plural(kept, "player") : undefined}
			>
				{fmtPct(rate, 0)}
				{kept !== undefined && kept !== null ? <span className="ml-1 opacity-70">({kept})</span> : null}
			</div>
		</TableCell>
	);
}

function Body({ data }: { data: RetentionResult }) {
	const total = data.cohorts.reduce((s, c) => s + c.size, 0);
	return (
		<Section
			title="Cohorts by join day"
			description={`${plural(data.cohorts.length, "cohort")}, ${plural(total, "new player")}. A cell = share of the cohort that played again exactly that many days after joining.`}
		>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Joined (UTC)</TableHead>
						<TableHead className="text-right">New players</TableHead>
						{data.days.map((d) => (
							<TableHead key={d} className="text-center">
								Day {d}
							</TableHead>
						))}
					</TableRow>
				</TableHeader>
				<TableBody>
					<TableRow className="font-medium">
						<TableCell>Weighted average</TableCell>
						<TableCell className="text-right tabular-nums">{fmtInt(total)}</TableCell>
						{data.days.map((d) => (
							<Cell key={d} rate={data.average[d] ?? null} />
						))}
					</TableRow>
					{[...data.cohorts].reverse().map((c) => (
						<TableRow key={c.date}>
							<TableCell className="tabular-nums">{c.date}</TableCell>
							<TableCell className="text-right tabular-nums">{fmtInt(c.size)}</TableCell>
							{data.days.map((d) => (
								<Cell key={d} rate={c.kept[d] ?? null} kept={c.keptPlayers[d]} />
							))}
						</TableRow>
					))}
				</TableBody>
			</Table>
		</Section>
	);
}

export default function Retention() {
	const q = useAnalytics("retention", { days: [1, 3, 7, 14, 30] });
	return (
		<>
			<PageHeader
				title="Retention"
				description="New players by the day they joined, and how many came back on day 1, 3, 7, 14 and 30. Days not over yet show –."
			/>
			<QueryState query={q} isEmpty={(d) => d.cohorts.length === 0} empty="No new players joined in this range.">
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
