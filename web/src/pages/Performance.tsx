/**
 * Performance: how the game runs on players' devices (frame rate, memory, ping) and on the servers (TPS, memory,
 * players), over time, by device class / input / screen size / branch / build, with p50, p90 and p99 (on the bad side).
 * Every chart carries deploy marks (releases, rollbacks, kernel publishes, backup refreshes); clicking one filters to its
 * build. Builds can be compared side by side, or before vs after a mark over two equal windows.
 *
 * Tables are plain markup with each number's raw value in `data-value` (the shared sortable table replaces them later).
 */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router";
import { cn } from "cn";
import { PerfChart } from "@/components/PerfChart";
import { EmptyState, ErrorState, LoadingBlock, PageHeader, QueryState, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, ApiError } from "@/lib/api";
import { describeRange } from "@/lib/filters";
import { fmtInt, shortId } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import {
	AROUND_HOURS,
	bucketText,
	CLIENT_GROUPS,
	CLIENT_METRIC_KEYS,
	delta,
	fmtDelta,
	fmtMetric,
	GROUP_BY_LABELS,
	groupLabel,
	MARK_KINDS,
	MARK_STYLE,
	markDetails,
	markTitle,
	METRICS,
	PERCENTILE_HELP,
	PERCENTILES,
	pivot,
	rangeMs,
	SERIES_COLORS,
	SERVER_GROUPS,
	SERVER_METRIC_KEYS,
	seriesOf,
	type ChartRow,
	type ComparePeriod,
	type DeployMark,
	type Percentile,
	type PerfCompareResult,
	type PerfGroup,
	type PerfGroupBy,
	type PerfSeriesResult,
	type ServerMetricPoint,
} from "@/lib/perf";
import type { Filters } from "@/lib/types";

// URL state -------------------------------------------------------------------------------------------------------------

/** Several URL parameters in one update (separate setSearchParams calls in one event overwrite each other). */
function useUrlPatch(): (patch: Record<string, string | null>) => void {
	const [, setParams] = useSearchParams();
	return useCallback(
		(patch) =>
			setParams((current) => {
				const next = new URLSearchParams(current);
				for (const [key, value] of Object.entries(patch)) {
					if (value === null || value === "") next.delete(key);
					else next.set(key, value);
				}
				return next;
			}),
		[setParams],
	);
}

// Marks -----------------------------------------------------------------------------------------------------------------

/** The filters' range for the marks read, `to` rounded up to the minute so the cache key holds still. */
function useRange(filters: Filters): { from: number; to: number } {
	return useMemo(() => {
		const now = Math.ceil(Date.now() / 60_000) * 60_000;
		return rangeMs({ ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) }, now);
	}, [filters.from, filters.to]);
}

function useMarks(range: { from: number; to: number }, branch: string | undefined) {
	return useQuery({
		queryKey: ["fleet", "marks", range.from, range.to, branch ?? ""],
		queryFn: ({ signal }) => api.fleetMarks({ since: range.from, until: range.to, ...(branch ? { branch } : {}), limit: 1000 }, signal),
		retry: false,
	});
}

function MarkLegend({ marks, error, shown, onToggle }: { marks: DeployMark[]; error: unknown; shown: boolean; onToggle(): void }) {
	const counts = MARK_KINDS.map((kind) => ({ kind, n: marks.filter((m) => m.kind === kind).length })).filter((c) => c.n > 0);
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
			<span className="font-medium text-foreground">Marks</span>
			{error ? (
				<span>{error instanceof ApiError && error.notFound ? "not on this backend (the fleet part is off, or it is older)" : "couldn't load"}</span>
			) : counts.length ? (
				counts.map((c) => (
					<span key={c.kind} className="inline-flex items-center gap-1.5">
						<span className="inline-block h-3 w-0.5" style={{ background: MARK_STYLE[c.kind].color }} aria-hidden />
						{c.n} {MARK_STYLE[c.kind].label.toLowerCase()}
						{c.n === 1 ? "" : "s"}
					</span>
				))
			) : (
				<span>none in this range</span>
			)}
			{marks.length ? (
				<Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onToggle}>
					{shown ? "Hide marks" : "Show marks"}
				</Button>
			) : null}
		</div>
	);
}

function MarkBar({ mark, filtered, onFilter, onCompare, onClear }: { mark: DeployMark; filtered: boolean; onFilter(): void; onCompare(): void; onClear(): void }) {
	return (
		<Card className="gap-1 border-l-4 py-3" style={{ borderLeftColor: MARK_STYLE[mark.kind].color }}>
			<CardContent className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0 space-y-0.5">
					<div className="text-sm font-medium">{markTitle(mark)}</div>
					<div className="text-xs text-muted-foreground">{markDetails(mark).join(" · ")}</div>
				</div>
				<div className="flex flex-wrap gap-2">
					{mark.artifact ? (
						<Button size="sm" variant={filtered ? "secondary" : "default"} onClick={onFilter} disabled={filtered}>
							{filtered ? "Filtered to this build" : "Filter to this build"}
						</Button>
					) : null}
					<Button size="sm" variant="outline" onClick={onCompare}>
						Before vs after
					</Button>
					<Button size="sm" variant="ghost" onClick={onClear}>
						Clear
					</Button>
				</div>
			</CardContent>
		</Card>
	);
}

// Tables ----------------------------------------------------------------------------------------------------------------

function NumCell({ value, text }: { value: number | null | undefined; text?: string }) {
	return (
		<TableCell className="text-right tabular-nums" data-value={value ?? ""}>
			{text ?? fmtInt(value)}
		</TableCell>
	);
}

function GroupTable({ result, metricKeys }: { result: PerfSeriesResult; metricKeys: readonly string[] }) {
	const client = result.side === "client";
	const rows: PerfGroup[] = result.by === "none" ? [result.overall] : [result.overall, ...result.groups];
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>{GROUP_BY_LABELS[result.by]}</TableHead>
					<TableHead className="text-right">Samples</TableHead>
					{client ? (
						<>
							<TableHead className="text-right">Sessions</TableHead>
							<TableHead className="text-right">Players</TableHead>
						</>
					) : (
						<TableHead className="text-right">Servers</TableHead>
					)}
					{metricKeys.flatMap((k) =>
						PERCENTILES.map((p) => (
							<TableHead key={`${k}-${p}`} className="text-right whitespace-nowrap">
								{METRICS[k]?.label ?? k} {p}
							</TableHead>
						)),
					)}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((g, i) => (
					<TableRow key={i === 0 ? "(all)" : g.key} className={i === 0 && result.by !== "none" ? "font-medium" : undefined}>
						<TableCell className="whitespace-nowrap">{i === 0 ? "All" : groupLabel(result.by, g.key, g.seq)}</TableCell>
						<NumCell value={g.samples} />
						{client ? (
							<>
								<NumCell value={g.sessions} />
								<NumCell value={g.players} />
							</>
						) : (
							<NumCell value={g.servers} />
						)}
						{metricKeys.flatMap((k) => PERCENTILES.map((p) => <NumCell key={`${k}-${p}`} value={g.metrics[k]?.[p]} text={fmtMetric(k, g.metrics[k]?.[p])} />))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

// Charts ----------------------------------------------------------------------------------------------------------------

interface MarkProps {
	marks: DeployMark[];
	selectedMark: string | null;
	onMark(mark: DeployMark): void;
}

function MetricCard({ title, about, children }: { title: string; about: string; children: React.ReactNode }) {
	return (
		<Card className="gap-2 py-4">
			<CardContent className="space-y-2">
				<div>
					<div className="text-sm font-medium">{title}</div>
					<div className="text-xs text-muted-foreground">{about}</div>
				</div>
				{children}
			</CardContent>
		</Card>
	);
}

function SeriesCharts({ result, metricKeys, pct, players, ...marks }: { result: PerfSeriesResult; metricKeys: readonly string[]; pct: Percentile; players?: boolean } & MarkProps) {
	const series = seriesOf(result);
	const charts: { key: string; title: string; about: string; rows: ChartRow[] }[] = metricKeys.map((k) => ({
		key: k,
		title: `${METRICS[k]?.label ?? k}, ${pct}`,
		about: `${METRICS[k]?.about ?? ""} Line: ${PERCENTILE_HELP[pct]}.`,
		rows: pivot(result, k, pct),
	}));
	if (players) charts.push({ key: "players", title: "Players", about: METRICS.players.about, rows: pivot(result, "", "players") });
	return (
		<div className="grid gap-3 lg:grid-cols-3">
			{charts.map((c) => (
				<MetricCard key={c.key} title={c.title} about={c.about}>
					<PerfChart
						label={`${c.title} over time`}
						rows={c.rows}
						series={series}
						fromMs={result.fromMs}
						toMs={result.toMs}
						format={(v) => fmtMetric(c.key, v)}
						marks={marks.marks}
						selectedMark={marks.selectedMark}
						onMarkClick={marks.onMark}
						legend
					/>
				</MetricCard>
			))}
		</div>
	);
}

function ClientSection({ by, pct, filters, ...marks }: { by: PerfGroupBy; pct: Percentile; filters: Filters } & MarkProps) {
	const q = useAnalytics("perf-client", { by, maxGroups: 8 }, { filters });
	return (
		<Section
			title="Players' devices"
			description={q.data ? `Frame rate, memory and ping from tech/client, per ${bucketText(q.data.bucketMs)}, by ${GROUP_BY_LABELS[by].toLowerCase()}.` : "Frame rate, memory and ping from tech/client."}
			contentClassName="space-y-3"
		>
			<QueryState
				query={q}
				loadingRows={6}
				isEmpty={(r) => r.overall.samples === 0}
				empty="No client samples in this range. Clients send tech/client every techEvery seconds (60 by default) while the AnalyticsEngine runs."
			>
				{(r) => (
					<>
						<SeriesCharts result={r} metricKeys={CLIENT_METRIC_KEYS} pct={pct} {...marks} />
						{r.groupsTotal > r.groups.length ? <p className="text-xs text-muted-foreground">The {r.groups.length} busiest of {r.groupsTotal} groups are shown.</p> : null}
						<GroupTable result={r} metricKeys={CLIENT_METRIC_KEYS} />
					</>
				)}
			</QueryState>
		</Section>
	);
}

function ServerSection({ by, pct, filters, ...marks }: { by: PerfGroupBy; pct: Percentile; filters: Filters } & MarkProps) {
	const serverBy = SERVER_GROUPS.includes(by) ? by : "none";
	const q = useAnalytics("perf-server", { by: serverBy, maxGroups: 8 }, { filters });
	const note = serverBy !== by ? ` Servers have no ${GROUP_BY_LABELS[by].toLowerCase()}: shown for everything.` : "";
	return (
		<Section
			title="Servers"
			description={`TPS (the Heartbeat rate), physics FPS, memory and players from tech/server${q.data ? `, per ${bucketText(q.data.bucketMs)}` : ""}. Device, player and experiment filters don't apply to servers.${note}`}
			contentClassName="space-y-3"
		>
			<QueryState query={q} loadingRows={6} isEmpty={(r) => r.overall.samples === 0} empty="No server samples in this range (tech/server, every techEvery seconds per server).">
				{(r) => (
					<>
						<SeriesCharts result={r} metricKeys={["tps", "mem"]} pct={pct} players {...marks} />
						<GroupTable result={r} metricKeys={SERVER_METRIC_KEYS} />
					</>
				)}
			</QueryState>
		</Section>
	);
}

// Live servers (the heartbeat-metrics contract) -----------------------------------------------------------------------------

/** Unix seconds or ms -> ms. */
const ms = (t: number) => (t < 1e11 ? t * 1000 : t);

export function historyRows(points: ServerMetricPoint[]): { rows: ChartRow[]; fromMs: number; toMs: number } {
	const rows = points
		.map((p) => ({ t: ms(p.t), tps: p.tps, tpsMin: p.tpsMin, physFps: p.physFps, memMb: p.memMb, luaMb: p.luaMb, players: p.players }) as ChartRow)
		.sort((a, b) => a.t - b.t);
	return { rows, fromMs: rows[0]?.t ?? 0, toMs: (rows.at(-1)?.t ?? 0) + 1 };
}

function ServerHistory({ job, since, ...marks }: { job: string; since: number } & MarkProps) {
	const q = useQuery({ queryKey: ["fleet", "server-metrics", job, since], queryFn: ({ signal }) => api.serverMetrics(job, since, signal), retry: false });
	if (q.isPending) return <LoadingBlock rows={3} />;
	if (q.isError) {
		return q.error instanceof ApiError && q.error.notFound ? (
			<EmptyState>This backend keeps no per-server history yet (it comes with the heartbeat metrics update).</EmptyState>
		) : (
			<ErrorState error={q.error} />
		);
	}
	if (!q.data.length) return <EmptyState>No history for this server in this range.</EmptyState>;
	const { rows, fromMs, toMs } = historyRows(q.data);
	const charts = [
		{ title: "TPS", about: "The Heartbeat rate and the slowest step in each heartbeat.", key: "tps", series: [{ id: "tps", key: "tps", label: "TPS" }, { id: "tpsMin", key: "tpsMin", label: "TPS (min)" }] },
		{ title: "Memory", about: "Total and Lua heap, MB.", key: "mem", series: [{ id: "memMb", key: "memMb", label: "Memory" }, { id: "luaMb", key: "luaMb", label: "Lua heap" }] },
		{ title: "Players", about: "Players on this server.", key: "players", series: [{ id: "players", key: "players", label: "Players" }] },
	];
	return (
		<div className="grid gap-3 lg:grid-cols-3">
			{charts.map((c) => (
				<MetricCard key={c.title} title={c.title} about={c.about}>
					<PerfChart
						label={`${c.title} of server ${shortId(job, 6)}`}
						rows={rows}
						series={c.series.map((s, i) => ({ ...s, color: SERIES_COLORS[i] as string }))}
						fromMs={fromMs}
						toMs={toMs}
						format={(v) => fmtMetric(c.key, v)}
						marks={marks.marks}
						selectedMark={marks.selectedMark}
						onMarkClick={marks.onMark}
						legend
					/>
				</MetricCard>
			))}
		</div>
	);
}

function LiveServers({ branch, since, ...marks }: { branch: string | undefined; since: number } & MarkProps) {
	const [job, setJob] = useParam("job");
	const q = useQuery({ queryKey: ["fleet", "perf-servers", branch ?? ""], queryFn: ({ signal }) => api.perfServers(branch, signal), refetchInterval: 30_000, retry: false });
	return (
		<Section title="Live servers" description="Each server's latest TPS and memory from its heartbeat; pick one for its history." contentClassName="space-y-3">
			<QueryState query={q} isEmpty={(d) => d.servers.length === 0} empty="No live servers right now.">
				{(d) => {
					const hasMetrics = d.servers.some((s) => typeof s.tps === "number" || typeof s.memMb === "number");
					return (
						<>
							{!hasMetrics ? <p className="text-xs text-muted-foreground">These heartbeats carry no TPS or memory yet (they come with the heartbeat metrics update).</p> : null}
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Server</TableHead>
										<TableHead>Branch</TableHead>
										<TableHead>Build</TableHead>
										<TableHead className="text-right">Players</TableHead>
										<TableHead className="text-right">TPS</TableHead>
										<TableHead className="text-right">TPS min</TableHead>
										<TableHead className="text-right">Physics FPS</TableHead>
										<TableHead className="text-right">Memory</TableHead>
										<TableHead className="text-right">Lua heap</TableHead>
										<TableHead />
									</TableRow>
								</TableHeader>
								<TableBody>
									{d.servers.map((s) => (
										<TableRow key={s.job} data-state={s.job === job ? "selected" : undefined}>
											<TableCell className="font-mono text-xs" title={s.job}>
												{shortId(s.job, 6)}
											</TableCell>
											<TableCell>{s.branch ?? "–"}</TableCell>
											<TableCell className="font-mono text-xs">
												{s.artifact ?? "–"}
												{s.appliedSeq ? ` #${s.appliedSeq}` : ""}
											</TableCell>
											<NumCell value={s.players} />
											<NumCell value={s.tps} text={fmtMetric("tps", s.tps)} />
											<NumCell value={s.tpsMin} text={fmtMetric("tps", s.tpsMin)} />
											<NumCell value={s.physFps} text={fmtMetric("physFps", s.physFps)} />
											<NumCell value={s.memMb} text={fmtMetric("mem", s.memMb)} />
											<NumCell value={s.luaMb} text={fmtMetric("mem", s.luaMb)} />
											<TableCell className="text-right">
												<Button size="sm" variant={s.job === job ? "secondary" : "outline"} className="h-7" onClick={() => setJob(s.job === job ? "" : s.job)} aria-pressed={s.job === job}>
													History
												</Button>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</>
					);
				}}
			</QueryState>
			{job ? <ServerHistory job={job} since={since} {...marks} /> : null}
		</Section>
	);
}

// Compare -----------------------------------------------------------------------------------------------------------------

const COMPARE_ROWS: { side: "client" | "server"; key: string }[] = [
	...CLIENT_METRIC_KEYS.map((key) => ({ side: "client" as const, key })),
	...SERVER_METRIC_KEYS.map((key) => ({ side: "server" as const, key })),
];

function periodLabel(result: PerfCompareResult, p: ComparePeriod): string {
	if (result.mode === "around") {
		const hours = Math.round((result.windowMs ?? 0) / 3_600_000);
		return `${p.key === "before" ? "Before" : "After"} (${hours ? `${hours} h` : `${Math.round((result.windowMs ?? 0) / 60_000)} min`})`;
	}
	return groupLabel("art", p.key, p.seq);
}

export function CompareTable({ result }: { result: PerfCompareResult }) {
	const periods = result.periods;
	const pair = periods.length === 2;
	const info = (side: "client" | "server", key: string) => (side === "client" ? result.clientMetrics : result.serverMetrics).find((m) => m.key === key);
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Metric</TableHead>
					{periods.map((p) => (
						<TableHead key={p.key} className="text-right whitespace-nowrap">
							{periodLabel(result, p)}
						</TableHead>
					))}
					{pair ? <TableHead className="text-right">Change</TableHead> : null}
				</TableRow>
			</TableHeader>
			<TableBody>
				<TableRow>
					<TableCell className="text-muted-foreground">Client samples</TableCell>
					{periods.map((p) => (
						<NumCell key={p.key} value={p.client.samples} />
					))}
					{pair ? <TableCell /> : null}
				</TableRow>
				<TableRow>
					<TableCell className="text-muted-foreground">Server samples</TableCell>
					{periods.map((p) => (
						<NumCell key={p.key} value={p.server.samples} />
					))}
					{pair ? <TableCell /> : null}
				</TableRow>
				{COMPARE_ROWS.flatMap(({ side, key }) =>
					PERCENTILES.map((pct) => {
						const values = periods.map((p) => p[side].metrics[key]?.[pct] ?? null);
						const d = pair ? delta(values[0], values[1], info(side, key)?.higherIsBetter ?? true) : null;
						return (
							<TableRow key={`${side}-${key}-${pct}`}>
								<TableCell className="whitespace-nowrap">
									{side === "server" && key === "mem" ? "Server memory" : (METRICS[key]?.label ?? key)} {pct}
								</TableCell>
								{values.map((v, i) => (
									<NumCell key={periods[i]?.key ?? i} value={v} text={fmtMetric(key, v)} />
								))}
								{pair ? (
									<TableCell
										className={cn("text-right tabular-nums", d?.better === true && "text-[var(--status-good)]", d?.better === false && "text-[var(--status-critical)]")}
										data-value={d ? Math.round(d.pct * 10) / 10 : ""}
									>
										{fmtDelta(d)}
										{d && d.better !== null ? <span className="ml-1 text-xs">{d.better ? "better" : "worse"}</span> : null}
									</TableCell>
								) : null}
							</TableRow>
						);
					}),
				)}
			</TableBody>
		</Table>
	);
}

function CompareSection({ filters, marks, seqOf }: { filters: Filters; marks: DeployMark[]; seqOf: Map<string, number> }) {
	const [mode, setMode] = useParam("cmode", "builds");
	const [picked, setPicked] = useParam("cmp");
	const [aroundId, setAround] = useParam("around");
	const [hoursParam, setHours] = useParam("hours", "24");
	const hours = AROUND_HOURS.includes(Number(hoursParam)) ? Number(hoursParam) : 24;
	const arts = picked ? picked.split(",").filter(Boolean).slice(0, 6) : [];
	const values = useAnalytics("values", {}, { filters: { ...(filters.from ? { from: filters.from } : {}), ...(filters.to ? { to: filters.to } : {}) } });
	const now = Date.now();
	const candidates = [...marks].filter((m) => m.at < now - 5 * 60_000).reverse();
	const around = marks.find((m) => m.id === aroundId) ?? (mode === "around" ? candidates[0] : undefined);
	const aroundFilters: Filters = { ...filters, ...(around?.branch && around.kind !== "kernel" && around.kind !== "backup" ? { branch: around.branch } : {}) };
	const q = useAnalytics(
		"perf-compare",
		mode === "around" ? { mode: "around", at: around?.at, hours } : { mode: "builds", ...(arts.length ? { arts } : {}) },
		{ filters: mode === "around" ? aroundFilters : filters, enabled: mode !== "around" || around !== undefined },
	);
	const toggle = (art: string) => {
		const next = arts.includes(art) ? arts.filter((a) => a !== art) : [...arts, art].slice(-6);
		setPicked(next.join(","));
	};
	return (
		<Section
			title="Compare"
			description="Builds side by side over the range, or before vs after a mark over two windows of the same length."
			contentClassName="space-y-3"
			actions={
				<Tabs value={mode === "around" ? "around" : "builds"} onValueChange={setMode}>
					<TabsList>
						<TabsTrigger value="builds">Builds</TabsTrigger>
						<TabsTrigger value="around">Before vs after</TabsTrigger>
					</TabsList>
				</Tabs>
			}
		>
			<div id="compare" className="scroll-mt-16" />
			{mode === "around" ? (
				<div className="flex flex-wrap items-center gap-2">
					<Select value={around?.id ?? ""} onValueChange={setAround}>
						<SelectTrigger size="sm" className="w-72 max-w-full" aria-label="Mark">
							<SelectValue placeholder="Pick a mark" />
						</SelectTrigger>
						<SelectContent>
							{candidates.slice(0, 100).map((m) => (
								<SelectItem key={m.id} value={m.id}>
									{markTitle(m)} · {m.time.slice(5, 16).replace("T", " ")}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={String(hours)} onValueChange={setHours}>
						<SelectTrigger size="sm" className="w-36" aria-label="Window">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{AROUND_HOURS.map((h) => (
								<SelectItem key={h} value={String(h)}>
									{h < 24 ? `${h} h each side` : `${h / 24} d each side`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{around?.branch && around.kind !== "kernel" && around.kind !== "backup" ? <span className="text-xs text-muted-foreground">Branch {around.branch} only.</span> : null}
				</div>
			) : (
				<div className="flex flex-wrap gap-1.5" role="group" aria-label="Builds to compare">
					{(values.data?.art ?? []).slice(0, 16).map((a) => (
						<Button key={a.value} size="sm" variant={arts.includes(a.value) ? "secondary" : "outline"} className="h-7 font-mono text-xs" aria-pressed={arts.includes(a.value)} onClick={() => toggle(a.value)}>
							{groupLabel("art", a.value, seqOf.get(a.value))}
						</Button>
					))}
					{arts.length ? (
						<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setPicked("")}>
							Busiest builds
						</Button>
					) : (
						<span className="self-center text-xs text-muted-foreground">Showing the busiest builds; pick up to 6.</span>
					)}
				</div>
			)}
			{mode === "around" && !around ? (
				<EmptyState>No marks in this range to compare around.</EmptyState>
			) : (
				<QueryState query={q} loadingRows={5} isEmpty={(r) => r.periods.every((p) => p.client.samples === 0 && p.server.samples === 0)} empty="No samples to compare.">
					{(r) => <CompareTable result={r} />}
				</QueryState>
			)}
		</Section>
	);
}

// The page ----------------------------------------------------------------------------------------------------------------

export default function Performance() {
	const { state, apiFilters } = useFilters();
	const patch = useUrlPatch();
	const [byParam, setBy] = useParam("by", "none");
	const by = (CLIENT_GROUPS as string[]).includes(byParam) ? (byParam as PerfGroupBy) : "none";
	const [pctParam, setPct] = useParam("pct", "p50");
	const pct = (PERCENTILES as string[]).includes(pctParam) ? (pctParam as Percentile) : "p50";
	const [markId] = useParam("mark");
	const [marksShown] = useParam("marks", "on");
	const range = useRange(apiFilters);
	const branch = typeof apiFilters.branch === "string" ? apiFilters.branch : undefined;
	const marksQ = useMarks(range, branch);
	const allMarks = marksQ.data ?? [];
	const marks = marksShown === "off" ? [] : allMarks;
	const selected = allMarks.find((m) => m.id === markId);
	const seqOf = useMemo(() => new Map(allMarks.filter((m) => m.artifact && m.seq !== null && m.kind !== "backup").map((m) => [m.artifact as string, m.seq as number])), [allMarks]);
	const onMark = useCallback((m: DeployMark) => patch({ mark: m.id, ...(m.artifact && m.kind !== "kernel" ? { art: m.artifact } : {}) }), [patch]);
	const markProps: MarkProps = { marks, selectedMark: selected?.id ?? null, onMark };
	return (
		<>
			<PageHeader
				title="Performance"
				description={`Frame rate, memory and ping on players' devices, and TPS and memory on the servers, ${describeRange(state)}. Percentiles are on the bad side: p90 is the value 90% of samples reach or beat.`}
				actions={
					<>
						<Select value={by} onValueChange={setBy}>
							<SelectTrigger size="sm" className="w-40" aria-label="Group by">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{CLIENT_GROUPS.map((g) => (
									<SelectItem key={g} value={g}>
										By {GROUP_BY_LABELS[g].toLowerCase()}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<ToggleGroup type="single" variant="outline" size="sm" value={pct} onValueChange={(v) => v && setPct(v)} aria-label="Percentile">
							{PERCENTILES.map((p) => (
								<ToggleGroupItem key={p} value={p} className="px-2.5 text-xs" title={PERCENTILE_HELP[p]}>
									{p}
								</ToggleGroupItem>
							))}
						</ToggleGroup>
					</>
				}
			/>
			<MarkLegend marks={allMarks} error={marksQ.error} shown={marksShown !== "off"} onToggle={() => patch({ marks: marksShown === "off" ? null : "off" })} />
			{selected ? (
				<MarkBar
					mark={selected}
					filtered={!!selected.artifact && apiFilters.art === selected.artifact}
					onFilter={() => patch({ art: selected.artifact })}
					onCompare={() => {
						patch({ cmode: "around", around: selected.id });
						document.getElementById("compare")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
					}}
					onClear={() => patch({ mark: null, ...(apiFilters.art === selected.artifact ? { art: null } : {}) })}
				/>
			) : null}
			<ClientSection by={by} pct={pct} filters={apiFilters} {...markProps} />
			<ServerSection by={by} pct={pct} filters={apiFilters} {...markProps} />
			<LiveServers branch={branch} since={range.from} {...markProps} />
			<CompareSection filters={apiFilters} marks={allMarks} seqOf={seqOf} />
		</>
	);
}
