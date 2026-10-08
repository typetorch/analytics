import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { cn } from "cn";
import { EmptyState, KeyValue, Metric, PageHeader, QueryState, Section } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtNum, fmtTime, plural, shortId } from "@/lib/format";
import { useParam } from "@/lib/hooks";
import type { FleetAlert, FleetReports, FleetServers, ServerBudget } from "@/lib/types";

type StreamState = "connecting" | "live" | "retrying";

interface LiveEvent {
	at: number;
	type: string;
	text: string;
}

const LEVEL_TONE: Record<string, string> = {
	critical: "bg-[var(--status-critical)]",
	warning: "bg-[var(--status-warning)]",
	info: "bg-muted-foreground",
};
const HEALTH_TONE: Record<string, string> = { ok: "bg-[var(--status-good)]", degraded: "bg-[var(--status-warning)]", failing: "bg-[var(--status-critical)]" };

/** A colored dot plus its word (color never carries the meaning alone). */
function Status({ tone, children }: { tone?: string; children: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs">
			<span className={cn("size-2 rounded-full", tone ?? "bg-muted-foreground")} aria-hidden />
			{children}
		</span>
	);
}

function describe(type: string, data: Record<string, unknown>): string {
	if (type === "server") {
		const s = data.server as { job?: string; players?: number; health?: string } | undefined;
		return `server ${shortId(s?.job, 6)} ${String(data.change)} (${plural(s?.players ?? 0, "player")}, ${s?.health ?? "?"})`;
	}
	if (type === "alert") {
		const a = data.alert as FleetAlert | undefined;
		return `${a?.level ?? ""} alert ${a?.code ?? ""}: ${a?.message ?? ""}`;
	}
	if (type === "report") return `deploy #${String(data.seq)}: ${shortId(String(data.job), 6)} ${String(data.result)}`;
	if (type === "deploy") return `deploy #${String(data.seq)} started on ${String(data.branch)} (${String(data.artifact)})`;
	if (type === "alert_ack") return `alert ${String(data.id)} acknowledged`;
	return type;
}

/** Live updates over the SSE stream: refetches what changed and keeps a short log. */
function useFleetStream(branch: string): { state: StreamState; log: LiveEvent[] } {
	const client = useQueryClient();
	const [state, setState] = useState<StreamState>("connecting");
	const [log, setLog] = useState<LiveEvent[]>([]);
	useEffect(() => {
		const source = new EventSource(api.streamUrl(branch ? { branch } : {}));
		const push = (type: string, raw: string) => {
			let data: Record<string, unknown> = {};
			try {
				data = JSON.parse(raw) as Record<string, unknown>;
			} catch {
				// keep the type
			}
			setLog((current) => [{ at: Date.now(), type, text: describe(type, data) }, ...current].slice(0, 50));
			if (type === "server") void client.invalidateQueries({ queryKey: ["fleet", "servers"] });
			if (type === "alert" || type === "alert_ack") void client.invalidateQueries({ queryKey: ["fleet", "alerts"] });
			if (type === "report" || type === "deploy") void client.invalidateQueries({ queryKey: ["fleet", "report"] });
		};
		source.addEventListener("hello", () => setState("live"));
		for (const type of ["server", "alert", "alert_ack", "report", "deploy"]) source.addEventListener(type, (e) => push(type, (e as MessageEvent<string>).data));
		source.onerror = () => setState(source.readyState === EventSource.CLOSED ? "retrying" : "connecting");
		source.onopen = () => setState("live");
		return () => source.close();
	}, [branch, client]);
	return { state, log };
}

/** Kernel 0.4.0 heartbeat `bu`, one short line: TypeTorch's DataStore reads and HTTP requests a minute against the limits, memory. */
export function budgetText(b: ServerBudget | null | undefined): string {
	if (!b) return "–";
	const parts: string[] = [];
	if (b.ds) parts.push(`DS ${b.ds.r ?? 0}/${b.ds.lr ?? "?"}`);
	if (b.h) parts.push(`HTTP ${b.h.r ?? 0}/${b.h.l ?? "?"}`);
	if (b.mem?.t !== undefined) parts.push(`${Math.round(b.mem.t)} MB`);
	return parts.length ? parts.join(" · ") : "–";
}

const CALLERS: Record<string, string> = { k: "kernel", d: "devtools", a: "analytics", g: "game", f: "framework" };

/** The full summary for the cell's tooltip. */
export function budgetTitle(b: ServerBudget | null | undefined): string | undefined {
	if (!b) return undefined;
	const lines = [
		`DataStore a minute: read ${b.ds?.r ?? 0}/${b.ds?.lr ?? "?"}, write ${b.ds?.w ?? 0}/${b.ds?.lw ?? "?"}${b.ds?.br !== undefined ? `, budget left ${b.ds.br} read / ${b.ds.bw ?? "?"} write` : ""}`,
		`MemoryStore units ${b.ms?.u ?? 0}/${b.ms?.l ?? "?"}, HTTP ${b.h?.r ?? 0}/${b.h?.l ?? "?"}, publishes ${b.mg?.p ?? 0}/${b.mg?.lp ?? "?"}`,
		`by ${Object.entries(b.by ?? {}).map(([k, v]) => `${CALLERS[k] ?? k} ${v}`).join(", ") || "-"}`,
	];
	if (b.mem) lines.push(`memory ${b.mem.t ?? "?"} MB, LuaHeap ${b.mem.h ?? "?"} MB`);
	return lines.join(" | ");
}

function Servers({ data }: { data: FleetServers }) {
	if (!data.servers.length)
		return <EmptyState>No live servers (a server shows up within 30 s of its first heartbeat, and leaves 90 s after its last).</EmptyState>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>Job</TableHead>
					<TableHead>Type</TableHead>
					<TableHead>Branch</TableHead>
					<TableHead>Artifact</TableHead>
					<TableHead className="text-right">Seq</TableHead>
					<TableHead className="text-right">Players</TableHead>
					<TableHead>Health</TableHead>
					<TableHead>Kernel</TableHead>
					<TableHead>Budget</TableHead>
					<TableHead>Up since</TableHead>
					<TableHead>Seen</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.servers.map((s) => (
					<TableRow key={s.job}>
						<TableCell className="font-mono text-xs" title={s.job}>
							{shortId(s.job, 6)}
						</TableCell>
						<TableCell>{s.serverType ?? "–"}</TableCell>
						<TableCell>{s.branch ?? "–"}</TableCell>
						<TableCell className="font-mono text-xs">
							{s.artifact ?? "–"} {s.experiment ? <Badge variant="secondary">A/B pin</Badge> : null}
						</TableCell>
						<TableCell className="text-right tabular-nums">{s.appliedSeq ?? "–"}</TableCell>
						<TableCell className="text-right tabular-nums">
							{fmtInt(s.players)} / {fmtInt(s.maxPlayers)}
						</TableCell>
						<TableCell title={s.lastError ?? undefined}>
							<Status tone={HEALTH_TONE[s.health ?? ""]}>{s.health ?? "unknown"}</Status>
						</TableCell>
						<TableCell className="text-xs">{s.kernel ?? "–"}</TableCell>
						<TableCell className="font-mono text-xs" title={budgetTitle(s.budget)}>
							{budgetText(s.budget)}
						</TableCell>
						<TableCell className="text-xs">{fmtAgo(s.startedAt)}</TableCell>
						<TableCell className="text-xs">{s.ageSeconds !== undefined ? `${s.ageSeconds}s ago` : fmtAgo(s.lastSeen)}</TableCell>
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

function Report({ data }: { data: FleetReports }) {
	if (data.seq === null) return <EmptyState>No deploy reported yet.</EmptyState>;
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap gap-x-6 gap-y-1">
				<KeyValue label="seq">#{data.seq}</KeyValue>
				<KeyValue label="branch">{data.branch ?? "–"}</KeyValue>
				<KeyValue label="artifact">{data.artifact ?? "–"}</KeyValue>
				<KeyValue label="started">{fmtTime(data.startedAt)}</KeyValue>
				<KeyValue label="servers reported">{fmtInt(data.reported)}</KeyValue>
			</div>
			<div className="flex flex-wrap gap-2">
				{data.results.map((r) => (
					<Badge key={r.result} variant={r.result === "failed" || r.result === "rolled_back" ? "destructive" : "secondary"}>
						{r.result}: {plural(r.servers, "server")}, {plural(r.players, "player")}, median {fmtNum(r.medianSeconds, 1)} s
					</Badge>
				))}
			</div>
			{data.errors.length ? (
				<ul className="space-y-1 text-sm">
					{data.errors.map((e) => (
						<li key={e.error} className="text-[var(--status-critical)]">
							{e.error} ({e.servers} server{e.servers === 1 ? "" : "s"}, e.g. {shortId(e.exampleJob, 6)})
						</li>
					))}
				</ul>
			) : null}
			<p className="text-xs text-muted-foreground">
				{data.behind.length ? `${data.behind.length} live server(s) still below #${data.seq}.` : "Every live server on the branch has it."}
				{data.stuck.length ? ` Stuck (no report 3+ min after the deploy): ${data.stuck.map((j) => shortId(j, 6)).join(", ")}.` : ""}
			</p>
		</div>
	);
}

function Alerts({ alerts }: { alerts: FleetAlert[] }) {
	if (!alerts.length) return <EmptyState>No alerts.</EmptyState>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					<TableHead>When (UTC)</TableHead>
					<TableHead>Level</TableHead>
					<TableHead>Code</TableHead>
					<TableHead>Message</TableHead>
					<TableHead>Where</TableHead>
					<TableHead>Acked</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{[...alerts]
					.sort((a, b) => b.at - a.at)
					.map((a) => (
						<TableRow key={a.id}>
							<TableCell className="font-mono text-xs tabular-nums">{fmtTime(a.at)}</TableCell>
							<TableCell>
								<Status tone={LEVEL_TONE[a.level]}>{a.level}</Status>
							</TableCell>
							<TableCell className="font-mono text-xs">{a.code}</TableCell>
							<TableCell className="max-w-96 whitespace-normal">{a.message}</TableCell>
							<TableCell className="text-xs text-muted-foreground">{[a.branch, a.artifact, a.seq ? `#${a.seq}` : null].filter(Boolean).join(" · ")}</TableCell>
							<TableCell className="text-xs">{a.acked ? "yes" : "no"}</TableCell>
						</TableRow>
					))}
			</TableBody>
		</Table>
	);
}

export default function Fleet() {
	const [branch, setBranch] = useParam("branch");
	const [text, setText] = useState(branch);
	useEffect(() => setText(branch), [branch]);
	const servers = useQuery({
		queryKey: ["fleet", "servers", branch],
		queryFn: ({ signal }) => api.fleetServers(branch || undefined, signal),
		refetchInterval: 30_000,
	});
	const report = useQuery({ queryKey: ["fleet", "report", branch], queryFn: ({ signal }) => api.fleetReport(branch ? { branch } : {}, signal) });
	const alerts = useQuery({ queryKey: ["fleet", "alerts"], queryFn: ({ signal }) => api.fleetAlerts({ limit: 100 }, signal) });
	const stream = useFleetStream(branch);
	const streamTone =
		stream.state === "live" ? "bg-[var(--status-good)]" : stream.state === "retrying" ? "bg-[var(--status-critical)]" : "bg-[var(--status-warning)]";
	return (
		<>
			<PageHeader
				title="Fleet"
				description="Live game servers, the latest deploy and alerts, from the fleet API (updates over its event stream)."
				actions={
					<>
						<Input
							aria-label="Branch"
							placeholder="any branch"
							className="h-8 w-36"
							value={text}
							onChange={(e) => setText(e.target.value)}
							onBlur={() => setBranch(text.trim())}
							onKeyDown={(e) => e.key === "Enter" && setBranch(text.trim())}
						/>
						<Status tone={streamTone}>{stream.state === "live" ? "live" : stream.state === "retrying" ? "stream lost, retrying" : "connecting"}</Status>
					</>
				}
			/>
			<QueryState query={servers}>
				{(data) => (
					<>
						<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
							<Metric label="Live servers" value={fmtInt(data.servers.length)} />
							<Metric label="Players" value={fmtInt(data.players)} />
							<Metric
								label="Artifacts running"
								value={fmtInt(data.byArtifact.length)}
								sub={data.byArtifact.map((a) => `${a.artifact} (${a.servers})`).join(", ") || "none"}
							/>
							<Metric
								label="Health"
								value={
									Object.entries(data.byHealth)
										.map(([h, n]) => `${n} ${h}`)
										.join(", ") || "–"
								}
							/>
						</div>
						<Section title="Servers">
							<Servers data={data} />
						</Section>
					</>
				)}
			</QueryState>
			<div className="grid gap-4 xl:grid-cols-2">
				<Section title="Latest deploy">
					<QueryState query={report}>{(data) => <Report data={data} />}</QueryState>
				</Section>
				<Section title="Live events" description="Changes pushed by the server since this page opened.">
					{stream.log.length ? (
						<ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
							{stream.log.map((e, i) => (
								<li key={`${e.at}-${i}`} className="flex gap-2">
									<span className="font-mono text-muted-foreground tabular-nums">{fmtTime(e.at).slice(11)}</span>
									<span>{e.text}</span>
								</li>
							))}
						</ul>
					) : (
						<p className="text-sm text-muted-foreground">Nothing yet. Server joins, leaves, deploy reports and alerts show up here as they happen.</p>
					)}
				</Section>
			</div>
			<Section title="Alerts" description="Newest first (kept 90 days).">
				<QueryState query={alerts}>{(data) => <Alerts alerts={data} />}</QueryState>
			</Section>
		</>
	);
}
