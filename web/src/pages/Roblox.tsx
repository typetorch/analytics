/**
 * The Roblox page, laid out like Creator Hub's experience overview, from our own events: benchmark cards (period over
 * period, against the 50th / 90th the user copies from Creator Hub), a realtime column, and 7-day moving averages
 * per join source.
 */
import { useQuery } from "@tanstack/react-query";
import { SlidersHorizontal } from "lucide-react";
import { useMemo, useState } from "react";
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from "recharts";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { EmptyState, PageHeader, QueryState, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api } from "@/lib/api";
import { barMax, change, estimatePercentile, loadBenchmarks, saveBenchmarks, type Benchmark, type BenchmarkKey, type Benchmarks } from "@/lib/benchmarks";
import { isoDate } from "@/lib/filters";
import { fmtInt, fmtMinutes, fmtNum, fmtPct } from "@/lib/format";
import { useAnalytics, useFilters, useParam } from "@/lib/hooks";
import type { BenchmarkPeriod, Filters, RealtimeResult, TrendValues } from "@/lib/types";

/** The filter bar's filters without its date range (these sections have their own). */
function useNoRange(): Filters {
	const { apiFilters } = useFilters();
	return useMemo(() => {
		const { from: _from, to: _to, ...rest } = apiFilters;
		return rest;
	}, [apiFilters]);
}

// Benchmark cards ----------------------------------------------------------------------------------------------------

interface CardSpec {
	key: BenchmarkKey;
	title: string;
	/** Value in the unit the user types benchmarks in (minutes, percent, Robux). */
	value(p: BenchmarkPeriod): number | null;
	format(v: number): string;
	unit: string;
	info: string;
}

const pct = (r: { rate: number; of: number }) => (r.of > 0 ? r.rate * 100 : null);

const CARDS: CardSpec[] = [
	{
		key: "playtime",
		title: "Average playtime",
		value: (p) => p.avgPlaytimeMinutes,
		format: (v) => fmtMinutes(v),
		unit: "minutes",
		info: "Session time per daily active user: all playtime in the period divided by player-days. A session runs from its first to its last event.",
	},
	{
		key: "d1",
		title: "Day 1 retention",
		value: (p) => pct(p.d1Retention),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "New players who played again exactly 1 day after joining, counted on the day they came back (days that are over only).",
	},
	{
		key: "d7",
		title: "Day 7 retention",
		value: (p) => pct(p.d7Retention),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "New players who played again exactly 7 days after joining, counted on the day they came back (days that are over only).",
	},
	{
		key: "payer",
		title: "Payer conversion",
		value: (p) => pct(p.payerConversion),
		format: (v) => `${fmtNum(v, 2)}%`,
		unit: "%",
		info: "Players with at least one purchase, out of all players in the period.",
	},
	{
		key: "arppu",
		title: "ARPPU",
		value: (p) => p.arppu,
		format: (v) => `${fmtNum(v, 1)} R$`,
		unit: "Robux",
		info: "Average revenue per paying user: Robux from purchases divided by the players who paid in the period.",
	},
	{
		key: "playThrough",
		title: "Play-through rate (after join)",
		value: (p) => pct(p.playThrough),
		format: (v) => `${fmtNum(v, 1)}%`,
		unit: "%",
		info: "Our version: the share of new players' first sessions (that are over) lasting at least 5 minutes, a qualified play. Creator Hub's play-through starts at the home-page impression, which games can't see.",
	},
];

function sub(spec: CardSpec, p: BenchmarkPeriod): string {
	switch (spec.key) {
		case "playtime":
			return `${fmtNum(p.dau, 1)} daily active users`;
		case "d1":
			return `${fmtInt(p.d1Retention.count)} of ${fmtInt(p.d1Retention.of)} new players`;
		case "d7":
			return `${fmtInt(p.d7Retention.count)} of ${fmtInt(p.d7Retention.of)} new players`;
		case "payer":
			return `${fmtInt(p.payerConversion.count)} of ${fmtInt(p.payerConversion.of)} players`;
		case "arppu":
			return `${fmtInt(p.robux)} Robux in all`;
		case "playThrough":
			return `${fmtInt(p.playThrough.count)} of ${fmtInt(p.playThrough.of)} first sessions`;
	}
}

function BenchmarkBar({ value, bench, onSet }: { value: number | null; bench?: Benchmark; onSet(): void }) {
	if (value === null) return <div className="h-2 rounded-full bg-muted" />;
	const max = barMax(value, bench);
	const at = (v: number) => `${Math.min(100, (v / max) * 100)}%`;
	const percentile = bench ? estimatePercentile(value, bench) : null;
	return (
		<div className="space-y-1">
			<div className="relative h-2 rounded-full bg-muted">
				<div className="absolute inset-y-0 left-0 rounded-full bg-[var(--chart-1)]" style={{ width: at(value) }} />
				{bench
					? [bench.p50, bench.p90].map((v, i) => (
							<div key={i} className="absolute -top-1 h-4 w-0.5 bg-foreground/70" style={{ left: at(v) }} title={`${i ? "90th" : "50th"} percentile: ${fmtNum(v)}`} />
						))
					: null}
			</div>
			{bench ? (
				<div className="flex justify-between text-[11px] text-muted-foreground">
					<span>
						50th {fmtNum(bench.p50)} · 90th {fmtNum(bench.p90)}
					</span>
					<span className="tabular-nums">{percentile === null ? "" : `est. ~${ordinal(percentile)} percentile`}</span>
				</div>
			) : (
				<button type="button" onClick={onSet} className="text-[11px] text-muted-foreground underline-offset-2 hover:underline">
					set benchmarks
				</button>
			)}
		</div>
	);
}

function ordinal(n: number): string {
	const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${s}`;
}

function BenchmarkCard({ spec, current, previous, bench, days, onSet }: { spec: CardSpec; current: BenchmarkPeriod; previous: BenchmarkPeriod; bench?: Benchmark; days: number; onSet(): void }) {
	const value = spec.value(current);
	return (
		<Card className="gap-2 py-4">
			<CardContent className="space-y-2">
				<div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
					{spec.title}
					<InfoTip>{spec.info}</InfoTip>
				</div>
				<div className="flex items-baseline gap-2">
					<span className={value === null ? "text-2xl font-semibold text-muted-foreground" : "text-2xl font-semibold tracking-tight tabular-nums"}>{value === null ? "n/a" : spec.format(value)}</span>
					<ChangeChip change={change(value, spec.value(previous))} against={`the ${days} days before`} />
				</div>
				<div className="text-xs text-muted-foreground tabular-nums">{sub(spec, current)}</div>
				<BenchmarkBar value={value} {...(bench ? { bench } : {})} onSet={onSet} />
			</CardContent>
		</Card>
	);
}

function BenchmarkEditor({ value, onSave, onClose }: { value: Benchmarks; onSave(b: Benchmarks): void; onClose(): void }) {
	const [draft, setDraft] = useState<Record<string, { p50: string; p90: string }>>(() =>
		Object.fromEntries(CARDS.map((c) => [c.key, { p50: value[c.key]?.p50?.toString() ?? "", p90: value[c.key]?.p90?.toString() ?? "" }])),
	);
	const save = () => {
		const out: Benchmarks = {};
		for (const c of CARDS) {
			const p50 = Number.parseFloat(draft[c.key]?.p50 ?? "");
			const p90 = Number.parseFloat(draft[c.key]?.p90 ?? "");
			if (Number.isFinite(p50) && Number.isFinite(p90) && p50 > 0 && p90 > 0) out[c.key] = { p50, p90 };
		}
		onSave(out);
		onClose();
	};
	return (
		<div className="space-y-3">
			<div>
				<div className="text-sm font-medium">Benchmarks</div>
				<p className="text-xs text-muted-foreground">Copy the 50th and 90th percentile from your Creator Hub overview. Kept in this browser only.</p>
			</div>
			<div className="grid grid-cols-[1fr_5rem_5rem] items-center gap-x-2 gap-y-1.5 text-xs">
				<span />
				<span className="text-muted-foreground">50th</span>
				<span className="text-muted-foreground">90th</span>
				{CARDS.map((c) => (
					<div key={c.key} className="contents">
						<span>
							{c.title} <span className="text-muted-foreground">({c.unit})</span>
						</span>
						{(["p50", "p90"] as const).map((k) => (
							<Input
								key={k}
								aria-label={`${c.title} ${k === "p50" ? "50th" : "90th"} percentile`}
								inputMode="decimal"
								className="h-7 text-xs"
								value={draft[c.key]?.[k] ?? ""}
								onChange={(e) => setDraft((d) => ({ ...d, [c.key]: { ...(d[c.key] ?? { p50: "", p90: "" }), [k]: e.target.value } }))}
							/>
						))}
					</div>
				))}
			</div>
			<div className="flex justify-end gap-2">
				<Button variant="ghost" size="sm" onClick={() => setDraft(Object.fromEntries(CARDS.map((c) => [c.key, { p50: "", p90: "" }])))}>
					Clear
				</Button>
				<Button size="sm" onClick={save}>
					Save
				</Button>
			</div>
		</div>
	);
}

// Realtime -----------------------------------------------------------------------------------------------------------

function Sparkline({ series }: { series: RealtimeResult["ccu"]["series"] }) {
	const config: ChartConfig = { avg: { label: "Concurrent users (hourly average)", color: "var(--chart-1)" } };
	return (
		<ChartContainer config={config} className="aspect-auto h-16 w-full">
			<LineChart data={series} margin={{ top: 4, right: 2, bottom: 2, left: 2 }}>
				<ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(_, p) => String(p?.[0]?.payload?.hour ?? "").replace("T", " ").slice(0, 16)} />} />
				<Line dataKey="avg" stroke="var(--color-avg)" strokeWidth={2} dot={false} isAnimationActive={false} />
			</LineChart>
		</ChartContainer>
	);
}

function RealtimeRow({ label, info, value, current, previous, lowerIsBetter = false }: { label: string; info: string; value: string; current: number | null; previous: number | null; lowerIsBetter?: boolean }) {
	return (
		<div className="flex items-center justify-between gap-2 border-t py-2.5 text-sm">
			<div className="flex items-center gap-1.5 text-muted-foreground">
				{label}
				<InfoTip>{info}</InfoTip>
			</div>
			<div className="flex items-center gap-2">
				<span className="font-semibold tabular-nums">{value}</span>
				<ChangeChip change={change(current, previous, lowerIsBetter)} against="the 24 h before" />
			</div>
		</div>
	);
}

function Realtime({ filters }: { filters: Filters }) {
	const q = useAnalytics("realtime", { hours: 24, ccuDays: 7 }, { filters });
	const live = useQuery({ queryKey: ["fleet", "servers", filters.branch ?? ""], queryFn: ({ signal }) => api.fleetServers(typeof filters.branch === "string" ? filters.branch : undefined, signal), refetchInterval: 30_000 });
	return (
		<Section title="Realtime" description="Last 24 hours vs the 24 before.">
			<QueryState query={q} loadingRows={5}>
				{(r) => {
					const now = live.data?.players ?? r.ccu.now;
					const hasCcu = r.ccu.series.some((p) => p.peak > 0);
					return (
						<div>
							<div className="flex items-center justify-between gap-2">
								<div className="flex items-center gap-1.5 text-sm text-muted-foreground">
									Concurrent users
									<InfoTip>Players on live servers now (fleet API). The line is the hourly average over 7 days, from the servers' heartbeats: players per minute, summed over servers.</InfoTip>
								</div>
								<ChangeChip change={change(r.ccu.currentAvg, r.ccu.previousAvg)} against="the 24 h before (hourly average)" />
							</div>
							<div className="text-3xl font-semibold tabular-nums">{fmtInt(now)}</div>
							{hasCcu ? <Sparkline series={r.ccu.series} /> : <p className="py-3 text-xs text-muted-foreground">No heartbeats with players in 7 days.</p>}
							<RealtimeRow
								label="Session time"
								info="Average length of the sessions that started in the window and are over."
								value={r.current.avgSessionMinutes === null ? "n/a" : fmtMinutes(r.current.avgSessionMinutes)}
								current={r.current.avgSessionMinutes}
								previous={r.previous.avgSessionMinutes}
							/>
							<RealtimeRow
								label="Client error rate"
								info="Script errors clients reported (tech/error) per session. Games can't see crashes, so this is errors, not crashes."
								value={r.current.errorsPerSession === null ? "n/a" : `${fmtNum(r.current.errorsPerSession, 2)} / session`}
								current={r.current.errorsPerSession}
								previous={r.previous.errorsPerSession}
								lowerIsBetter
							/>
							<RealtimeRow
								label="Client frame rate"
								info="Average of the fps clients report every minute (tech/client)."
								value={r.current.clientFps === null ? "n/a" : `${fmtNum(r.current.clientFps, 0)} fps`}
								current={r.current.clientFps}
								previous={r.previous.clientFps}
							/>
							<RealtimeRow
								label="Server memory"
								info="Average of the memory servers report every minute (tech/server, MB)."
								value={r.current.serverMemoryMb === null ? "n/a" : `${fmtInt(r.current.serverMemoryMb)} MB`}
								current={r.current.serverMemoryMb}
								previous={r.previous.serverMemoryMb}
								lowerIsBetter
							/>
							<p className="pt-1 text-[11px] text-muted-foreground">{fmtInt(r.current.sessions)} sessions in the last 24 h.</p>
						</div>
					);
				}}
			</QueryState>
		</Section>
	);
}

// 7-day moving averages ---------------------------------------------------------------------------------------------

type TrendKey = "d1" | "newUsers" | "playtimeMinutes" | "dau" | "robux";

const TRENDS: { key: TrendKey; label: string; format(v: number): string }[] = [
	{ key: "d1", label: "D1 retention", format: (v) => fmtPct(v) },
	{ key: "newUsers", label: "New users", format: (v) => fmtNum(v, 1) },
	{ key: "playtimeMinutes", label: "Average playtime", format: (v) => fmtMinutes(v) },
	{ key: "dau", label: "Daily active users", format: (v) => fmtNum(v, 1) },
	{ key: "robux", label: "Daily revenue (Robux)", format: (v) => fmtNum(v, 0) },
];

/** Each join source keeps its color whatever the filters (the order of the categorical palette). */
const SOURCE_COLORS: Record<string, string> = {
	direct: "var(--chart-1)",
	teleport: "var(--chart-2)",
	teleport_game: "var(--chart-3)",
	referral: "var(--chart-4)",
	share: "var(--chart-5)",
	follow: "var(--chart-6)",
	unknown: "var(--chart-7)",
	other: "var(--chart-8)",
};

const SOURCE_LABELS: Record<string, string> = {
	direct: "Direct",
	teleport: "Teleport (same game)",
	teleport_game: "From another game",
	referral: "Referral link",
	share: "Share link",
	follow: "Followed a friend",
	unknown: "Unknown",
	other: "Other",
};

function Trends({ filters }: { filters: Filters }) {
	const [metric, setMetric] = useParam("trend", "d1");
	const [range, setRange] = useParam("trendDays", "28");
	const days = Number.parseInt(range, 10) || 28;
	const from = isoDate(Date.now() - (days - 1) * 86_400_000);
	const q = useAnalytics("trends", { window: 7 }, { filters: { ...filters, from } });
	const spec = TRENDS.find((t) => t.key === metric) ?? TRENDS[0];
	return (
		<Section
			title="Snapshot of 7-day moving averages"
			description="Total and per join source (where the session came from). Roblox's own Home / Search split isn't visible to games: those joins count as direct."
			actions={
				<Select value={String(days)} onValueChange={setRange}>
					<SelectTrigger size="sm" className="w-32" aria-label="Date range">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{[14, 28, 56, 90].map((d) => (
							<SelectItem key={d} value={String(d)}>
								Last {d} days
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			}
			contentClassName="space-y-3"
		>
			<Tabs value={spec.key} onValueChange={setMetric}>
				<TabsList className="flex-wrap">
					{TRENDS.map((t) => (
						<TabsTrigger key={t.key} value={t.key}>
							{t.label}
						</TabsTrigger>
					))}
				</TabsList>
			</Tabs>
			<QueryState query={q} isEmpty={(r) => r.days.every((d) => d.total.dau === 0)} empty="No players in this range yet.">
				{(r) => {
					const pick = (v: TrendValues | undefined) => (v ? v[spec.key] : null);
					const rows = r.days.map((d) => ({ date: d.date, total: pick(d.total), ...Object.fromEntries(r.sources.map((s) => [s, pick(d.bySource[s])])) }));
					if (!rows.some((row) => typeof row.total === "number" && row.total > 0)) {
						return (
							<EmptyState>
								{spec.key === "d1"
									? "No D1 values yet: a join day counts once the day after it is over."
									: `No ${spec.label.toLowerCase()} in this range yet.`}
							</EmptyState>
						);
					}
					const config: ChartConfig = {
						total: { label: "Total", color: "var(--foreground)" },
						...Object.fromEntries(r.sources.map((s) => [s, { label: SOURCE_LABELS[s] ?? s, color: SOURCE_COLORS[s] ?? "var(--chart-8)" }])),
					};
					return (
						<ChartContainer config={config} className="aspect-auto h-72 w-full">
							<LineChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
								<CartesianGrid vertical={false} />
								<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={28} tickFormatter={(d: string) => d.slice(5)} />
								<YAxis tickLine={false} axisLine={false} width={48} tickFormatter={(v: number) => spec.format(v)} />
								<ChartTooltip content={<ChartTooltipContent formatter={(v, name) => `${config[String(name)]?.label ?? name}: ${typeof v === "number" ? spec.format(v) : "–"}`} />} />
								<ChartLegend content={<ChartLegendContent />} />
								<Line dataKey="total" stroke="var(--color-total)" strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls={false} />
								{r.sources.map((s) => (
									<Line key={s} dataKey={s} stroke={`var(--color-${s})`} strokeWidth={1.5} dot={false} isAnimationActive={false} connectNulls={false} />
								))}
							</LineChart>
						</ChartContainer>
					);
				}}
			</QueryState>
		</Section>
	);
}

// The page ------------------------------------------------------------------------------------------------------------

export default function Roblox() {
	const filters = useNoRange();
	const [period, setPeriod] = useParam("period", "7");
	const days = [7, 14, 28].includes(Number(period)) ? Number(period) : 7;
	const [bench, setBench] = useState<Benchmarks>(() => loadBenchmarks());
	const [editing, setEditing] = useState(false);
	const q = useAnalytics("benchmarks", { days }, { filters });
	const save = (next: Benchmarks) => {
		setBench(next);
		saveBenchmarks(next);
	};
	return (
		<>
			<PageHeader
				title="Roblox overview"
				description={`Creator Hub's overview, from your own events: ${days}-day averages against the ${days} days before. The filter bar's branch, artifact, device, players and variant apply; its date range doesn't.`}
				actions={
					<>
						<ToggleGroup type="single" variant="outline" size="sm" value={String(days)} onValueChange={(v) => v && setPeriod(v)} aria-label="Period">
							{[7, 14, 28].map((d) => (
								<ToggleGroupItem key={d} value={String(d)} className="px-2.5 text-xs">
									{d} days
								</ToggleGroupItem>
							))}
						</ToggleGroup>
						<Popover open={editing} onOpenChange={setEditing}>
							<PopoverTrigger asChild>
								<Button variant="outline" size="sm">
									<SlidersHorizontal />
									Set benchmarks
								</Button>
							</PopoverTrigger>
							<PopoverContent align="end" className="w-[26rem]">
								<BenchmarkEditor value={bench} onSave={save} onClose={() => setEditing(false)} />
							</PopoverContent>
						</Popover>
					</>
				}
			/>
			<div className="grid gap-4 xl:grid-cols-[1fr_20rem]">
				<div className="space-y-4">
					<QueryState query={q} loadingRows={4}>
						{(r) =>
							r.current.players === 0 && r.previous.players === 0 ? (
								<EmptyState>No players in the last {2 * days} days.</EmptyState>
							) : (
								<div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
									{CARDS.map((spec) => (
										<BenchmarkCard
											key={spec.key}
											spec={spec}
											current={r.current}
											previous={r.previous}
											days={days}
											{...(bench[spec.key] ? { bench: bench[spec.key] } : {})}
											onSet={() => setEditing(true)}
										/>
									))}
								</div>
							)
						}
					</QueryState>
					<p className="text-xs text-muted-foreground">
						No genre benchmarks here: the percentile marker is estimated from the 50th and 90th you type in, by straight lines between them.
					</p>
				</div>
				<Realtime filters={filters} />
			</div>
			<Trends filters={filters} />
		</>
	);
}
