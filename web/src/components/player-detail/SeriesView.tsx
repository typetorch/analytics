/** A player's numbers per bucket (UTC day, or hour for short ranges): a line chart, or with "Table" the same numbers in the shared table. */
import { useMemo, type ReactNode } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { EmptyState } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { PlayerBucket } from "@/lib/types";

export type Show = "chart" | "table";
export type Bucket = "hour" | "day";
export type MetricKey = "robux" | "minutes" | "sessions" | "purchases";

/** "2026-10-08" for a day, "2026-10-08 14:00" for an hour (UTC). */
export function bucketLabel(start: string, bucket: Bucket): string {
	return bucket === "hour" ? `${start.slice(0, 10)} ${start.slice(11, 16)}` : start.slice(0, 10);
}

const tick = (start: string, bucket: Bucket) => (bucket === "hour" ? start.slice(11, 16) : start.slice(5, 10));

export interface Metric {
	key: MetricKey;
	/** "Robux", "Minutes played", "Sessions". */
	label: string;
	format(value: number): string;
	/** The y axis ticks (default: the plain number). */
	axis?: (value: number) => string;
	decimals?: boolean;
}

/** Chart or Table, for every view of the player detail. */
export function ShowToggle({ value, onChange }: { value: Show; onChange(next: Show): void }) {
	return (
		<ToggleGroup type="single" variant="outline" size="sm" value={value} onValueChange={(v) => v && onChange(v as Show)} aria-label="Show as">
			<ToggleGroupItem value="chart" className="px-2.5 text-xs">
				Chart
			</ToggleGroupItem>
			<ToggleGroupItem value="table" className="px-2.5 text-xs">
				Table
			</ToggleGroupItem>
		</ToggleGroup>
	);
}

/** The bucket column, then one column per metric (in the order given). */
export function useBucketColumns(bucket: Bucket, metrics: readonly Metric[]): DataColumn<PlayerBucket>[] {
	return useMemo(
		() => [
			{
				id: "start",
				header: bucket === "hour" ? "Hour (UTC)" : "Day (UTC)",
				type: "date",
				accessor: (b) => b.start,
				cell: (b) => bucketLabel(b.start, bucket),
				format: (_v, b) => bucketLabel(b.start, bucket),
				className: "font-mono text-xs tabular-nums",
			},
			...metrics.map<DataColumn<PlayerBucket>>((m) => ({ id: m.key, header: m.label, type: "number", accessor: (b) => b[m.key], cell: (b) => m.format(b[m.key]), align: "right" })),
		],
		[bucket, metrics],
	);
}

export function SeriesView({
	id,
	series,
	bucket,
	metric,
	columns,
	show,
	empty,
}: {
	/** The table's id (saved view, URL). */
	id: string;
	series: PlayerBucket[];
	bucket: Bucket;
	/** The line. */
	metric: Metric;
	/** The table's columns (the same numbers, and related ones). */
	columns: DataColumn<PlayerBucket>[];
	show: Show;
	empty: ReactNode;
}) {
	if (series.every((b) => b[metric.key] === 0)) return <EmptyState>{empty}</EmptyState>;
	if (show === "table") {
		return <DataTable id={id} label={`${metric.label} per ${bucket}`} columns={columns} data={series} rowId={(b) => b.start} density="compact" maxHeight="24rem" />;
	}
	const config: ChartConfig = { [metric.key]: { label: metric.label, color: "var(--chart-1)" } };
	return (
		<div role="img" aria-label={`${metric.label} per ${bucket}, line chart`}>
			<ChartContainer config={config} className="aspect-auto h-56 w-full">
				<LineChart data={series} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
					<CartesianGrid vertical={false} />
					<XAxis dataKey="start" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={(s: string) => tick(s, bucket)} />
					<YAxis tickLine={false} axisLine={false} width={44} allowDecimals={metric.decimals ?? false} tickFormatter={(v: number) => (metric.axis ? metric.axis(v) : String(v))} />
					<ChartTooltip
						content={
							<ChartTooltipContent
								labelFormatter={(_, payload) => bucketLabel(String(payload?.[0]?.payload?.start ?? ""), bucket)}
								formatter={(v) => `${metric.label}: ${typeof v === "number" ? metric.format(v) : "–"}`}
							/>
						}
					/>
					<Line dataKey={metric.key} stroke={`var(--color-${metric.key})`} strokeWidth={2} dot={series.length <= 31} isAnimationActive={false} />
				</LineChart>
			</ChartContainer>
		</div>
	);
}
