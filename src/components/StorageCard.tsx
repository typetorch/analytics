/** What the analytics server keeps on disk (GET /v1/storage), refreshed every 30 s. */
import { useQuery } from "@tanstack/react-query";
import { ChangeChip, InfoTip } from "@/components/ChangeChip";
import { KeyValue, QueryState, Section } from "@/components/common";
import { api } from "@/lib/api";
import { change } from "@/lib/benchmarks";
import { fmtAgo, fmtBytes, fmtInt } from "@/lib/format";
import type { StoragePart, StorageReport } from "@/lib/types";

/** Each part keeps its color (fixed categorical order). */
const PART_COLORS: Record<string, string> = {
	live: "var(--chart-1)",
	events: "var(--chart-2)",
	recordings: "var(--chart-3)",
	rawArchive: "var(--chart-4)",
	rawIncoming: "var(--chart-5)",
	rollups: "var(--chart-6)",
	fleet: "var(--chart-7)",
	sql: "var(--chart-8)",
	tmp: "var(--muted-foreground)",
};

function Breakdown({ parts, total }: { parts: StoragePart[]; total: number }) {
	const shown = parts.filter((p) => p.bytes > 0).sort((a, b) => b.bytes - a.bytes);
	if (!total) return null;
	return (
		<div className="space-y-2">
			<div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-muted" role="img" aria-label="Disk use by part">
				{shown.map((p) => (
					<div key={p.key} style={{ width: `${(p.bytes / total) * 100}%`, backgroundColor: PART_COLORS[p.key] ?? "var(--muted-foreground)" }} title={`${p.label}: ${fmtBytes(p.bytes)}`} />
				))}
			</div>
			<ul className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
				{shown.map((p) => (
					<li key={p.key} className="flex items-center gap-1.5">
						<span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: PART_COLORS[p.key] ?? "var(--muted-foreground)" }} aria-hidden />
						<span>{p.label}</span>
						<span className="ml-auto text-muted-foreground tabular-nums">
							{fmtBytes(p.bytes)} · {fmtInt(p.files)} file{p.files === 1 ? "" : "s"}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

function Body({ r }: { r: StorageReport }) {
	const part = (key: string) => r.parts.find((p) => p.key === key);
	const live = part("live");
	const events = part("events");
	const recordings = part("recordings");
	const history = (events?.bytes ?? 0) + (recordings?.bytes ?? 0);
	const g = r.growth;
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap gap-x-8 gap-y-2">
				<div>
					<div className="text-xs text-muted-foreground">On disk</div>
					<div className="text-2xl font-semibold tabular-nums">{fmtBytes(r.totalBytes)}</div>
				</div>
				<div>
					<div className="text-xs text-muted-foreground">DuckDB live (today)</div>
					<div className="text-2xl font-semibold tabular-nums">{fmtBytes(live?.bytes)}</div>
				</div>
				<div>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						Parquet history
						<InfoTip>One file per finished UTC day (events and recordings), written each night.</InfoTip>
					</div>
					<div className="text-2xl font-semibold tabular-nums">{fmtBytes(history)}</div>
					<div className="text-xs text-muted-foreground">
						{events?.days ? `${fmtInt(events.days)} day${events.days === 1 ? "" : "s"}, ${events.oldest} to ${events.newest}` : "no finished day yet"}
					</div>
				</div>
				{r.disk ? (
					<div>
						<div className="text-xs text-muted-foreground">Disk free</div>
						<div className="text-2xl font-semibold tabular-nums">{fmtBytes(r.disk.freeBytes)}</div>
						<div className="text-xs text-muted-foreground">of {fmtBytes(r.disk.totalBytes)}</div>
					</div>
				) : null}
			</div>
			<Breakdown parts={r.parts} total={r.totalBytes} />
			<div className="flex flex-wrap gap-x-6 gap-y-1">
				{r.rows ? (
					<>
						<KeyValue label="live rows">{fmtInt(r.rows.liveEvents + r.rows.liveRecordings)}</KeyValue>
						<KeyValue label="Parquet events">{fmtInt(r.rows.parquetEvents)}</KeyValue>
						<KeyValue label="Parquet recording chunks">{fmtInt(r.rows.parquetRecordings)}</KeyValue>
					</>
				) : null}
				{g ? (
					<div className="flex items-center gap-1.5 text-sm">
						<span className="text-muted-foreground">today's raw batches</span>
						<span className="font-medium tabular-nums">{fmtBytes(g.todayBytes)}</span>
						<span className="text-muted-foreground">{g.avgPerDayBytes === null ? "(no earlier day yet)" : `vs ${fmtBytes(g.avgPerDayBytes)} a day before`}</span>
						{g.avgPerDayBytes !== null ? <ChangeChip change={change(g.todayBytes, g.avgPerDayBytes, true)} against="the 7-day average (today isn't over)" /> : null}
						<InfoTip>The gzip NDJSON archive of accepted batches per UTC day: today so far against the average of up to 7 days before.</InfoTip>
					</div>
				) : null}
			</div>
			<p className="text-[11px] text-muted-foreground">Measured {fmtAgo(r.at)}; the server measures at most every {r.cacheSeconds} s.</p>
		</div>
	);
}

export function StorageCard() {
	const q = useQuery({ queryKey: ["storage"], queryFn: ({ signal }) => api.storage(signal), refetchInterval: 30_000 });
	return (
		<Section title="Storage" description="What the analytics server keeps on disk. Not filtered.">
			<QueryState query={q} loadingRows={3}>
				{(r) => <Body r={r} />}
			</QueryState>
		</Section>
	);
}
