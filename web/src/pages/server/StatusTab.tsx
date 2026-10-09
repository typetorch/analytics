/**
 * The Status tab: TPS, memory and players over the last hour (the fleet metrics history, GET .../metrics, kernel 0.4.2
 * heartbeats) and the kernel's status() on request (op `status`, what the dev menu's Server > Status shows).
 */
import { useQuery } from "@tanstack/react-query";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { EmptyState, ErrorState, JsonBlock, KeyValue, LoadingBlock } from "@/components/common";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { api, ApiError } from "@/lib/api";
import { fmtDuration, fmtInt, fmtNum, fmtTime } from "@/lib/format";
import type { RemoteState } from "@/lib/remote-debug";
import type { RemoteStatus, ServerMetricPoint } from "@/lib/types";
import { RemoteBar, useDebug, useFirstFetch } from "./shared";

/** The charts' window. */
export const CHART_MINUTES = 60;

const hhmm = (t: number) => fmtTime(t).slice(11, 16);

interface SeriesSpec {
	key: keyof ServerMetricPoint;
	label: string;
	color: string;
}

/** One small line chart: one axis, one unit; a legend when it has two series (one series: the title names it). */
function MetricChart({ title, unit, points, series, digits, minMax }: { title: string; unit: string; points: ServerMetricPoint[]; series: SeriesSpec[]; digits: number; minMax?: number }) {
	const config: ChartConfig = Object.fromEntries(series.map((s) => [s.key, { label: s.label, color: s.color }]));
	const values = points.flatMap((p) => series.map((s) => p[s.key])).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
	const last = points.length ? points[points.length - 1] : undefined;
	return (
		<figure className="min-w-0 space-y-1" aria-label={`${title} over the last ${CHART_MINUTES} minutes`}>
			<figcaption className="flex items-baseline justify-between gap-2 text-sm">
				<span className="font-medium">{title}</span>
				<span className="text-xs text-muted-foreground tabular-nums">
					{last && typeof last[series[0].key] === "number" ? `now ${fmtNum(last[series[0].key] as number, digits)} ${unit}` : unit}
				</span>
			</figcaption>
			{values.length ? (
				<ChartContainer config={config} className="aspect-auto h-40 w-full">
					<LineChart data={points} margin={{ top: 6, right: 8, bottom: 0, left: 0 }}>
						<CartesianGrid vertical={false} />
						<XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickLine={false} axisLine={false} tickMargin={6} minTickGap={36} tickFormatter={hhmm} />
						<YAxis
							tickLine={false}
							axisLine={false}
							width={44}
							domain={[0, (max: number) => Math.max(minMax ?? 0, Math.ceil(max))]}
							tickFormatter={(v: number) => fmtNum(v, 0)}
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									labelFormatter={(_, p) => `${fmtTime(Number(p?.[0]?.payload?.t)).slice(11, 19)} UTC`}
									formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? `${fmtNum(v, digits)} ${unit}` : "–"}`}
								/>
							}
						/>
						{series.length > 1 ? <ChartLegend content={<ChartLegendContent />} /> : null}
						{series.map((s) => (
							<Line key={s.key} dataKey={s.key} stroke={`var(--color-${s.key})`} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls={false} />
						))}
					</LineChart>
				</ChartContainer>
			) : (
				<p className="flex h-40 items-center justify-center rounded-lg border border-dashed px-3 text-center text-xs text-muted-foreground">No readings in this window.</p>
			)}
		</figure>
	);
}

/** TPS, memory and players over the last hour, from the fleet metrics (also for a closed or lost server: its last hour). */
export function ServerCharts({ job, live }: { job: string; live: boolean }) {
	const metrics = useQuery({
		queryKey: ["fleet", "server-metrics", job],
		queryFn: ({ signal }) => api.fleetServerMetrics(job, Date.now() - CHART_MINUTES * 60_000, signal),
		refetchInterval: live ? 30_000 : false,
	});
	if (metrics.isPending) return <LoadingBlock rows={3} />;
	if (metrics.isError) {
		if (metrics.error instanceof ApiError && metrics.error.notFound)
			return <EmptyState>This backend has no TPS and memory history yet (the fleet metrics route; kernel 0.4.2+ heartbeats fill it).</EmptyState>;
		return <ErrorState error={metrics.error} title="Could not load the TPS and memory history" />;
	}
	const points = metrics.data;
	if (!points.length) return <EmptyState>No TPS or memory readings in the last hour (kernel 0.4.2+ sends them with every heartbeat).</EmptyState>;
	return (
		<div className="grid gap-4 md:grid-cols-3">
			<MetricChart
				title="Server TPS"
				unit="TPS"
				digits={1}
				minMax={60}
				points={points}
				series={[
					{ key: "tps", label: "Average", color: "var(--chart-1)" },
					{ key: "tpsMin", label: "Slowest second", color: "var(--chart-2)" },
				]}
			/>
			<MetricChart
				title="Memory"
				unit="MB"
				digits={0}
				points={points}
				series={[
					{ key: "memMb", label: "Total", color: "var(--chart-1)" },
					{ key: "luaMb", label: "Lua heap", color: "var(--chart-2)" },
				]}
			/>
			<MetricChart title="Players" unit="players" digits={0} points={points} series={[{ key: "players", label: "Players", color: "var(--chart-1)" }]} />
		</div>
	);
}

const yesNo = (v: boolean | undefined) => (v === undefined ? "–" : v ? "yes" : "no");

/** The kernel's status(), the facts the dev menu leads with; the whole answer under "Raw answer". */
export function StatusFacts({ data }: { data: RemoteStatus }) {
	const s = data.status ?? {};
	const g = s.generation;
	const rd = s.remoteDebug;
	const artifact = g?.artifact as { artifactId?: string; id?: string } | undefined;
	return (
		<div className="space-y-3">
			<div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-3">
				<KeyValue label="Place version">{s.placeVersion ?? "–"}</KeyValue>
				<KeyValue label="Server up">{s.uptime !== undefined ? fmtDuration(s.uptime * 1000) : "–"}</KeyValue>
				<KeyValue label="Players">
					{fmtInt(s.players)} / {fmtInt(s.maxPlayers)}
				</KeyValue>
				<KeyValue label="Generation">{g ? `${g.name ?? "?"} #${g.number ?? "?"}${g.uptime !== undefined ? `, up ${fmtDuration(g.uptime * 1000)}` : ""}` : "nothing runs"}</KeyValue>
				<KeyValue label="Build">{artifact?.artifactId ?? artifact?.id ?? "–"}</KeyValue>
				<KeyValue label="Kernel">{`${s.kernelVersion ?? "?"}${s.kernelBuild ? ` (${s.kernelBuild})` : ""}`}</KeyValue>
				<KeyValue label="Memory">{s.memoryMb !== undefined ? `${fmtNum(s.memoryMb, 0)} MB` : "–"}</KeyValue>
				<KeyValue label="Lua heap">{s.luaHeapKb !== undefined ? `${fmtNum(s.luaHeapKb / 1024, 1)} MB` : "–"}</KeyValue>
				<KeyValue label="Health">{s.health?.state ?? "–"}</KeyValue>
				<KeyValue label="Branch">{`${s.branch ?? "–"}${s.channel ? ` (${s.channel})` : ""}`}</KeyValue>
				<KeyValue label="Rules">{s.rules ?? "–"}</KeyValue>
				<KeyValue label="Signed only">{yesNo(s.signedOnly)}</KeyValue>
				<KeyValue label="Pinned">{yesNo(s.pinned)}</KeyValue>
				<KeyValue label="Applied seq">{s.appliedSeq ?? "–"}</KeyValue>
				<KeyValue label="Remote debug">
					{rd ? `${rd.state ?? "?"}: ${fmtInt(rd.commands)} commands, ${fmtInt(rd.refused)} refused${rd.redacted ? `, ${fmtInt(rd.redacted)} redacted` : ""}` : "–"}
				</KeyValue>
			</div>
			<details className="group">
				<summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Raw answer</summary>
				<JsonBlock value={data} className="mt-2" />
			</details>
		</div>
	);
}

/** `status` is the page's (its header shows the place version from it). */
export function StatusTab({ active, job, live, status }: { active: boolean; job: string; live: boolean; status: RemoteState<RemoteStatus> & { run: () => Promise<unknown> } }) {
	const { ready } = useDebug();
	const run = status.run;
	useFirstFetch(active && ready, run);
	return (
		<div className="space-y-6">
			<section className="space-y-2">
				<h2 className="text-sm font-medium">Last {CHART_MINUTES} minutes</h2>
				<ServerCharts job={job} live={live} />
			</section>
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Kernel status</h2>
				<RemoteBar state={status} onFetch={() => void run()} />
				{status.data ? <StatusFacts data={status.data} /> : null}
			</section>
		</div>
	);
}
