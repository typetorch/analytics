/**
 * The server page's simple tabs: one op each, shown as tables (Modules + Assets, Builds, Budget, Errors, Network) and
 * the audit of remote debug commands sent to this server.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, KeyValue, LoadingBlock } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { api } from "@/lib/api";
import { fmtAgo, fmtInt, fmtNum, fmtPct, fmtTime, shortId } from "@/lib/format";
import { useRemote } from "@/lib/remote-debug";
import type { DebugAuditEntry, RemoteAssets, RemoteBudget, RemoteBuilds, RemoteErrors, RemoteModules, RemoteNetwork } from "@/lib/types";
import { MEMORY_ONLY, RemoteBar, Tone, useDebug, useFirstFetch } from "./shared";

/** Kernel times are unix seconds; a few older fields are ms. Either way: epoch ms, or null. */
export function epochMs(value: number | null | undefined): number | null {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
	return value < 1e12 ? value * 1000 : value;
}

const list = (values: readonly string[] | undefined) => (values?.length ? values.join(", ") : "–");

// Modules and assets -------------------------------------------------------------------------------------------------

type ModuleRow = NonNullable<NonNullable<RemoteModules["state"]>["modules"]>[number];
type PersistRow = NonNullable<NonNullable<RemoteModules["state"]>["persist"]>[number];
type AssetRow = NonNullable<RemoteAssets["entries"]>[number];

const MODULE_COLUMNS: DataColumn<ModuleRow>[] = [
	{ id: "name", header: "Module", accessor: (m) => m.name, className: "font-mono text-xs" },
	{ id: "loadOrder", header: "Load order", type: "number", firstSort: "asc", accessor: (m) => m.loadOrder ?? null },
	{ id: "initMs", header: "Init", hint: "ms", type: "number", accessor: (m) => m.initMs ?? null, cell: (m) => fmtInt(m.initMs) },
	{ id: "dependencies", header: "Depends on", accessor: (m) => list(m.dependencies), className: "max-w-80 text-xs whitespace-normal" },
	{ id: "hooks", header: "Hooks", accessor: (m) => list(m.hooks), className: "max-w-60 text-xs whitespace-normal" },
];

const PERSIST_COLUMNS: DataColumn<PersistRow>[] = [
	{ id: "key", header: "Store", accessor: (p) => p.key, className: "font-mono text-xs" },
	{ id: "kind", header: "Kind", type: "enum", accessor: (p) => p.kind },
	{ id: "entries", header: "Entries", type: "number", accessor: (p) => p.entries },
	{ id: "preview", header: "Preview", accessor: (p) => p.preview, className: "max-w-96 font-mono text-xs whitespace-pre-wrap break-all" },
];

const ASSET_COLUMNS: DataColumn<AssetRow>[] = [
	{ id: "key", header: "Asset", accessor: (a) => a.key, className: "font-mono text-xs" },
	{
		id: "live",
		header: "State",
		type: "enum",
		order: ["failed", "old copy", "live"],
		accessor: (a) => (a.error ? (a.live ? "old copy" : "failed") : "live"),
		cell: (a) => (
			<span title={a.error}>
				<Tone tone={a.error ? (a.live ? "bg-[var(--status-warning)]" : "bg-[var(--status-critical)]") : "bg-[var(--status-good)]"}>{a.error ? (a.live ? "old copy" : "failed") : "live"}</Tone>
			</span>
		),
	},
	{ id: "version", header: "Version", type: "number", accessor: (a) => a.n ?? null, cell: (a) => (a.n !== undefined ? `v${a.n}` : "–") },
	{ id: "source", header: "Source", type: "enum", accessor: (a) => a.source ?? null, className: "text-xs" },
	{ id: "ms", header: "Load", hint: "ms", type: "number", accessor: (a) => a.ms ?? null, cell: (a) => fmtInt(a.ms) },
	{ id: "id", header: "Asset id", type: "text", accessor: (a) => String(a.id), className: "font-mono text-xs", defaultHidden: true },
	{ id: "error", header: "Error", accessor: (a) => a.error ?? null, className: "max-w-80 text-xs whitespace-normal text-[var(--status-critical)]" },
];

export function ModulesTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const modules = useRemote<RemoteModules>(call, "modules");
	const assets = useRemote<RemoteAssets>(call, "assets");
	const runModules = modules.run;
	useFirstFetch(active && ready, runModules);
	const rows = modules.data?.state?.modules ?? modules.data?.modules ?? [];
	const persist = modules.data?.state?.persist ?? [];
	const a = assets.data;
	return (
		<div className="space-y-6">
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Running modules</h2>
				<RemoteBar state={modules} onFetch={() => void runModules()} />
				{modules.data ? (
					<>
						<DataTable id="server-modules" label="Running modules" columns={MODULE_COLUMNS} data={rows} rowId={(m) => m.name} defaultSort={[{ id: "loadOrder", desc: false }]} empty={<EmptyState>No modules run.</EmptyState>} {...MEMORY_ONLY} />
						{persist.length ? <DataTable id="server-persist" label="Persist store" columns={PERSIST_COLUMNS} data={persist} rowId={(p) => p.key} {...MEMORY_ONLY} /> : null}
					</>
				) : null}
			</section>
			<section className="space-y-3">
				<h2 className="text-sm font-medium">Assets (the last hot-asset sync)</h2>
				<RemoteBar state={assets} onFetch={() => void assets.run()} />
				{a ? (
					<>
						<div className="flex flex-wrap gap-x-6 gap-y-1">
							<KeyValue label="Manifest">{`${a.manifest ?? "?"}${a.from ? ` (${a.from})` : ""}`}</KeyValue>
							<KeyValue label="Sync">{a.running ? "running" : a.timedOut ? "timed out (late loads still swap in)" : "done"}</KeyValue>
							<KeyValue label="Took">{a.ms !== undefined ? `${fmtInt(a.ms)} ms` : "–"}</KeyValue>
							<KeyValue label="Unmanaged">{fmtInt(a.unmanaged?.length ?? 0)}</KeyValue>
						</div>
						{a.errors?.length ? <p className="text-sm break-words text-[var(--status-critical)]">{a.errors.join("; ")}</p> : null}
						<DataTable id="server-assets" label="Assets" columns={ASSET_COLUMNS} data={a.entries ?? []} rowId={(e) => e.key} empty={<EmptyState>This build has no managed assets.</EmptyState>} {...MEMORY_ONLY} />
					</>
				) : null}
			</section>
		</div>
	);
}

// Builds ---------------------------------------------------------------------------------------------------------------

type BranchRow = NonNullable<RemoteBuilds["branches"]>[number];
type ArtifactRow = NonNullable<RemoteBuilds["artifacts"]>[number];
type ReportRow = NonNullable<RemoteBuilds["reports"]>[number];

const yes = (v: unknown) => (v ? "yes" : "no");

const BRANCH_COLUMNS: DataColumn<BranchRow>[] = [
	{ id: "name", header: "Branch", accessor: (b) => b.name, className: "font-mono text-xs" },
	{ id: "channel", header: "Channel", type: "enum", accessor: (b) => b.channel ?? null },
	{ id: "artifact", header: "Build", accessor: (b) => b.artifactId ?? null, className: "font-mono text-xs" },
	{ id: "seq", header: "Seq", type: "number", accessor: (b) => b.seq ?? null },
	{ id: "commit", header: "Commit", accessor: (b) => b.commit ?? null, cell: (b) => shortId(b.commit, 4), className: "font-mono text-xs" },
	{ id: "deployedAt", header: "Deployed", type: "date", accessor: (b) => epochMs(b.deployedAt), cell: (b) => fmtAgo(epochMs(b.deployedAt)), className: "text-xs" },
];

const ARTIFACT_COLUMNS: DataColumn<ArtifactRow>[] = [
	{ id: "branch", header: "Branch", type: "enum", accessor: (a) => a.branch ?? null, className: "font-mono text-xs" },
	{ id: "artifact", header: "Build", accessor: (a) => a.artifactId ?? null, className: "font-mono text-xs" },
	{ id: "seq", header: "Seq", type: "number", accessor: (a) => a.seq ?? null },
	{ id: "at", header: "Deployed", type: "date", accessor: (a) => epochMs(a.at), cell: (a) => fmtAgo(epochMs(a.at)), className: "text-xs" },
	{ id: "live", header: "Live head", type: "boolean", accessor: (a) => a.live === true, cell: (a) => yes(a.live) },
	{ id: "running", header: "Running here", type: "boolean", accessor: (a) => a.running === true, cell: (a) => (a.running ? <Badge variant="secondary">running</Badge> : "no") },
	{ id: "verified", header: "Signed", type: "boolean", accessor: (a) => Boolean(a.verified), cell: (a) => yes(a.verified) },
	{ id: "commit", header: "Commit", accessor: (a) => a.commit ?? null, cell: (a) => shortId(a.commit, 4), className: "font-mono text-xs", defaultHidden: true },
	{ id: "channel", header: "Channel", type: "enum", accessor: (a) => a.channel ?? null, defaultHidden: true },
];

const FAILED = new Set(["failed", "rolled_back"]);

const REPORT_COLUMNS: DataColumn<ReportRow>[] = [
	{ id: "at", header: "When (UTC)", type: "date", accessor: (r) => epochMs(r.t), cell: (r) => fmtTime(epochMs(r.t)), className: "font-mono text-xs tabular-nums" },
	{ id: "seq", header: "Seq", type: "number", accessor: (r) => r.s ?? null },
	{ id: "branch", header: "Branch", type: "enum", accessor: (r) => r.b ?? null, className: "font-mono text-xs" },
	{ id: "artifact", header: "Build", accessor: (r) => r.a ?? null, className: "font-mono text-xs" },
	{ id: "result", header: "Result", type: "enum", accessor: (r) => r.r ?? null, cell: (r) => <Badge variant={FAILED.has(r.r ?? "") ? "destructive" : "secondary"}>{r.r ?? "?"}</Badge> },
	{ id: "seconds", header: "Took", hint: "s", type: "number", accessor: (r) => r.d ?? null, cell: (r) => fmtNum(r.d, 1) },
	{ id: "error", header: "Error", accessor: (r) => r.e ?? null, className: "max-w-80 text-xs whitespace-normal" },
	{ id: "kernel", header: "Kernel", type: "enum", accessor: (r) => r.k ?? null, defaultHidden: true },
];

export function BuildsTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const builds = useRemote<RemoteBuilds>(call, "builds");
	const run = builds.run;
	useFirstFetch(active && ready, run);
	const d = builds.data;
	return (
		<div className="space-y-4">
			<RemoteBar state={builds} onFetch={() => void run()}>
				<span className="text-xs text-muted-foreground">One DataStore read on the server, like the dev menu.</span>
			</RemoteBar>
			{d ? (
				<>
					<h2 className="text-sm font-medium">Branch heads</h2>
					<DataTable id="server-branches" label="Branch heads" columns={BRANCH_COLUMNS} data={d.branches ?? []} rowId={(b) => b.name} empty={<EmptyState>No branch heads.</EmptyState>} {...MEMORY_ONLY} />
					<h2 className="text-sm font-medium">Known builds</h2>
					{d.artifactsError ? <p className="text-sm break-words text-destructive">Could not read the builds: {d.artifactsError}</p> : null}
					<DataTable
						id="server-artifacts"
						label="Known builds"
						columns={ARTIFACT_COLUMNS}
						data={d.artifacts ?? []}
						rowId={(a, i) => `${a.branch}-${a.artifactId}-${a.seq}-${i}`}
						defaultSort={[{ id: "at", desc: true }]}
						empty={<EmptyState>No builds known.</EmptyState>}
						{...MEMORY_ONLY}
					/>
					<h2 className="text-sm font-medium">This server's deploy reports</h2>
					<DataTable
						id="server-reports"
						label="This server's deploy reports"
						columns={REPORT_COLUMNS}
						data={d.reports ?? []}
						rowId={(r, i) => `${r.s}-${r.t}-${i}`}
						defaultSort={[{ id: "at", desc: true }]}
						empty={<EmptyState>No deploy reported here yet.</EmptyState>}
						{...MEMORY_ONLY}
					/>
				</>
			) : null}
		</div>
	);
}

// Budget ---------------------------------------------------------------------------------------------------------------

interface LimitRow {
	kind: string;
	name: string;
	used: number;
	limit: number;
	left?: number;
}

/** The budget's per-kind rows as one list (DataStore read, write...; HTTP requests; ...). */
export function limitRows(b: RemoteBudget | undefined): LimitRow[] {
	const out: LimitRow[] = [];
	for (const [kind, entry] of Object.entries(b?.kinds ?? {})) for (const row of entry.rows ?? []) out.push({ kind, ...row });
	return out;
}

const LIMIT_COLUMNS: DataColumn<LimitRow>[] = [
	{ id: "kind", header: "Service", type: "enum", accessor: (r) => r.kind },
	{ id: "name", header: "Request", accessor: (r) => r.name },
	{ id: "used", header: "Used", hint: "/ min", type: "number", accessor: (r) => r.used, cell: (r) => fmtNum(r.used, 1) },
	{ id: "limit", header: "Limit", hint: "/ min", type: "number", accessor: (r) => r.limit, cell: (r) => fmtInt(r.limit) },
	{
		id: "share",
		header: "Share",
		type: "number",
		accessor: (r) => (r.limit > 0 ? r.used / r.limit : null),
		cell: (r) => {
			const share = r.limit > 0 ? r.used / r.limit : null;
			return share !== null && share >= 0.8 ? <Tone tone="bg-[var(--status-warning)]">{fmtPct(share, 0)}</Tone> : fmtPct(share, 0);
		},
	},
	{ id: "left", header: "Budget left", type: "number", accessor: (r) => r.left ?? null, cell: (r) => fmtInt(r.left), title: "DataStore request budget left (shared with the game)" },
];

type DetailRow = NonNullable<RemoteBudget["detail"]>[number];
const DETAIL_COLUMNS: DataColumn<DetailRow>[] = [
	{ id: "caller", header: "Caller", type: "enum", accessor: (d) => d.caller },
	{ id: "kind", header: "Service", type: "enum", accessor: (d) => d.kind },
	{ id: "op", header: "Request", accessor: (d) => d.op, className: "font-mono text-xs" },
	{ id: "perMinute", header: "Per minute", type: "number", accessor: (d) => d.perMinute, cell: (d) => fmtNum(d.perMinute, 1) },
	{ id: "total", header: "Total", type: "number", accessor: (d) => d.total },
];

type TagRow = { name: string; mb: number };
const TAG_COLUMNS: DataColumn<TagRow>[] = [
	{ id: "name", header: "Memory tag", accessor: (t) => t.name },
	{ id: "mb", header: "MB", type: "number", accessor: (t) => t.mb, cell: (t) => fmtNum(t.mb, 1) },
];

export function BudgetTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const budget = useRemote<RemoteBudget>(call, "budget");
	const run = budget.run;
	useFirstFetch(active && ready, run);
	const b = budget.data;
	return (
		<div className="space-y-4">
			<RemoteBar state={budget} onFetch={() => void run()} />
			{b?.missing ? <EmptyState>This server's kernel has no budget view (kernel 0.4.0+).</EmptyState> : null}
			{b && !b.missing ? (
				<>
					<div className="flex flex-wrap gap-x-6 gap-y-1">
						<KeyValue label="Players">{fmtInt(b.players)}</KeyValue>
						<KeyValue label="Window">{b.window !== undefined ? `${b.window} s` : "–"}</KeyValue>
						<KeyValue label="Memory">{b.memory?.total !== undefined ? `${fmtNum(b.memory.total, 0)} MB` : "–"}</KeyValue>
						<KeyValue label="Lua heap">{b.memory?.luaHeap !== undefined ? `${fmtNum(b.memory.luaHeap, 1)} MB` : b.memory?.heapKb !== undefined ? `${fmtNum(b.memory.heapKb / 1024, 1)} MB` : "–"}</KeyValue>
						<KeyValue label="Refused">{fmtInt(b.refused ?? 0)}</KeyValue>
					</div>
					<DataTable id="server-budget" label="Requests against Roblox's limits" columns={LIMIT_COLUMNS} data={limitRows(b)} rowId={(r) => `${r.kind}-${r.name}`} {...MEMORY_ONLY} />
					<h2 className="text-sm font-medium">By caller</h2>
					<DataTable
						id="server-budget-detail"
						label="Requests by caller"
						columns={DETAIL_COLUMNS}
						data={b.detail ?? []}
						rowId={(d) => `${d.caller}-${d.kind}-${d.op}`}
						defaultSort={[{ id: "perMinute", desc: true }]}
						empty={<EmptyState>No requests in the window.</EmptyState>}
						{...MEMORY_ONLY}
					/>
					{b.memory?.tags?.length ? (
						<>
							<h2 className="text-sm font-medium">Memory by tag</h2>
							<DataTable id="server-memory-tags" label="Memory by tag" columns={TAG_COLUMNS} data={b.memory.tags} rowId={(t) => t.name} defaultSort={[{ id: "mb", desc: true }]} {...MEMORY_ONLY} />
						</>
					) : null}
				</>
			) : null}
		</div>
	);
}

// Errors ---------------------------------------------------------------------------------------------------------------

type TopRow = NonNullable<RemoteErrors["top"]>[number];
const TOP_COLUMNS: DataColumn<TopRow>[] = [
	{ id: "template", header: "Error", accessor: (t) => t.template, className: "max-w-[32rem] font-mono text-xs whitespace-normal break-words" },
	{ id: "realm", header: "Where", type: "enum", options: ["server", "client"], accessor: (t) => t.realm },
	{ id: "total", header: "Count", type: "number", accessor: (t) => t.total },
	{ id: "fp", header: "Fingerprint", accessor: (t) => t.fp, className: "font-mono text-xs", defaultHidden: true },
];

export function ErrorsTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const errors = useRemote<RemoteErrors>(call, "errors");
	const run = errors.run;
	useFirstFetch(active && ready, run);
	const e = errors.data;
	return (
		<div className="space-y-4">
			<RemoteBar state={errors} onFetch={() => void run()}>
				<span className="text-xs text-muted-foreground">Counters and the busiest templates since the server started (never a raw message).</span>
			</RemoteBar>
			{e?.missing ? <EmptyState>This server's kernel has no error reports (kernel 0.4.0+).</EmptyState> : null}
			{e && !e.missing ? (
				<>
					<div className="flex flex-wrap gap-x-6 gap-y-1">
						<KeyValue label="Reports">{e.enabled ? "on" : "off"}</KeyValue>
						<KeyValue label="Seen">{`${fmtInt(e.seen?.server ?? 0)} server, ${fmtInt(e.seen?.client ?? 0)} client`}</KeyValue>
						<KeyValue label="Kinds">{fmtInt(e.kinds)}</KeyValue>
						<KeyValue label="Waiting">{fmtInt(e.waiting)}</KeyValue>
						<KeyValue label="Sent">{fmtInt(e.sent)}</KeyValue>
						<KeyValue label="Failed posts">{fmtInt(e.failed)}</KeyValue>
						<KeyValue label="Last sent">{e.lastOkAt ? fmtAgo(epochMs(e.lastOkAt)) : "–"}</KeyValue>
					</div>
					{e.lastError ? <p className="text-sm break-words text-muted-foreground">Last post error: {e.lastError}</p> : null}
					<DataTable id="server-errors" label="Busiest errors" columns={TOP_COLUMNS} data={e.top ?? []} rowId={(t) => t.fp} defaultSort={[{ id: "total", desc: true }]} empty={<EmptyState>No errors on this server.</EmptyState>} {...MEMORY_ONLY} />
				</>
			) : null}
		</div>
	);
}

// Network --------------------------------------------------------------------------------------------------------------

type RemoteRow = RemoteNetwork["remotes"][number];
const NETWORK_COLUMNS: DataColumn<RemoteRow>[] = [
	{ id: "path", header: "Remote", accessor: (r) => r.path, className: "font-mono text-xs" },
	{ id: "inbound", header: "In", type: "number", accessor: (r) => r.inbound },
	{ id: "outbound", header: "Out", type: "number", accessor: (r) => r.outbound },
	{ id: "rejected", header: "Rejected", type: "number", accessor: (r) => r.rejected },
	{ id: "errors", header: "Errors", type: "number", accessor: (r) => r.errors },
];

export function NetworkTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const network = useRemote<RemoteNetwork>(call, "network");
	const run = network.run;
	useFirstFetch(active && ready, run);
	const n = network.data;
	return (
		<div className="space-y-4">
			<RemoteBar state={network} onFetch={() => void run()}>
				<span className="text-xs text-muted-foreground">Counters per remote since the generation started (no packet capture).</span>
			</RemoteBar>
			{n && !n.supported ? <EmptyState>This build doesn't count its remotes.</EmptyState> : null}
			{n?.supported ? (
				<DataTable
					id="server-network"
					label="Remotes"
					columns={NETWORK_COLUMNS}
					data={n.remotes ?? []}
					rowId={(r) => r.path}
					defaultSort={[{ id: "inbound", desc: true }]}
					empty={<EmptyState>No remote traffic yet.</EmptyState>}
					{...MEMORY_ONLY}
				/>
			) : null}
		</div>
	);
}

// Audit ----------------------------------------------------------------------------------------------------------------

const AUDIT_COLUMNS: DataColumn<DebugAuditEntry>[] = [
	{ id: "at", header: "When (UTC)", type: "date", accessor: (a) => a.at, cell: (a) => fmtTime(a.at), className: "font-mono text-xs tabular-nums" },
	{ id: "who", header: "Who", type: "enum", accessor: (a) => a.who, cell: (a) => (a.who === "token" ? "admin token" : a.who), className: "font-mono text-xs" },
	{ id: "op", header: "Op", type: "enum", accessor: (a) => a.op, className: "font-mono text-xs" },
	{ id: "args", header: "Args", accessor: (a) => a.args || null, className: "text-xs" },
	{ id: "ip", header: "From", accessor: (a) => a.ip || null, className: "font-mono text-xs" },
	{ id: "id", header: "Command", accessor: (a) => a.id, className: "font-mono text-xs", defaultHidden: true },
];

/** The remote debug commands sent to this server (the backend's audit: who, op, an args summary; never an answer). */
export function AuditTab({ active, job }: { active: boolean; job: string }) {
	const audit = useQuery({
		queryKey: ["fleet", "debug-audit"],
		queryFn: ({ signal }) => api.debugAudit(500, signal),
		enabled: active,
		refetchInterval: active ? 30_000 : false,
	});
	const rows = (audit.data ?? []).filter((a) => a.job === job);
	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" size="sm" onClick={() => void audit.refetch()} disabled={audit.isFetching}>
					Refresh
				</Button>
				<span className="text-xs text-muted-foreground">Every command queued for this server (kept in the backend's audit file; the last 500 in memory).</span>
			</div>
			{audit.isPending && active ? (
				<LoadingBlock rows={3} />
			) : audit.isError ? (
				<ErrorState error={audit.error} title="Could not load the audit" />
			) : audit.data ? (
				<DataTable id="server-audit" label="Remote debug audit" columns={AUDIT_COLUMNS} data={rows} rowId={(a) => a.id} defaultSort={[{ id: "at", desc: true }]} empty={<EmptyState>No commands for this server yet.</EmptyState>} />
			) : null}
		</div>
	);
}
