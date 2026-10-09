/**
 * Shared pieces of the server page (/servers/<JobId>, plans/25): the debug context every tab reads, the fetch bar, the
 * first-open fetch, and the log table. Answers stay in component state (page memory only): never the query cache,
 * localStorage or the URL. So every table here turns off the DataTable's saved view and URL sync too (a filter or a
 * search could hold a player's name).
 */
import { LoaderCircle, RefreshCw } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { Link } from "react-router";
import { cn } from "cn";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtTime, plural, shortId } from "@/lib/format";
import type { RemoteState, Runner } from "@/lib/remote-debug";
import type { RemoteLogEntry } from "@/lib/types";

export interface DebugContextValue {
	job: string;
	/** Queues one read-only op and resolves with its answer. */
	call: Runner;
	/** The server polls for commands: fetches can go. */
	ready: boolean;
	/** Why fetches are off (shown on the disabled buttons). */
	waitReason?: string;
}

export const DebugContext = createContext<DebugContextValue | null>(null);

export function useDebug(): DebugContextValue {
	const value = useContext(DebugContext);
	if (!value) throw new Error("useDebug outside the server page");
	return value;
}

/** DataTable props for answers: no saved view, nothing in the URL. */
export const MEMORY_ONLY = { persist: false, urlSync: false } as const;

/** Runs `run` once, the first time `go` is true (a tab's first open while the server is connected). */
export function useFirstFetch(go: boolean, run: () => unknown) {
	const done = useRef(false);
	useEffect(() => {
		if (go && !done.current) {
			done.current = true;
			void run();
		}
	}, [go, run]);
}

/** "12:03:04 UTC, 35 ms". */
export function answeredText(state: Pick<RemoteState<unknown>, "at" | "ms">): string {
	if (state.at === undefined) return "";
	const parts = [`${fmtTime(state.at).slice(11)} UTC`];
	if (state.ms !== undefined) parts.push(`${state.ms} ms on the server`);
	return `Answered ${parts.join(", ")}`;
}

/**
 * A fetch button with the op's state next to it: waiting, when the answer came and how long it took on the server, how
 * many secrets the kernel replaced, or why it failed (the previous answer stays on screen).
 */
export function RemoteBar({
	state,
	onFetch,
	label = "Fetch",
	disabled,
	children,
	className,
}: {
	state: RemoteState<unknown>;
	onFetch: () => void;
	label?: string;
	disabled?: boolean;
	children?: ReactNode;
	className?: string;
}) {
	const { ready, waitReason } = useDebug();
	const running = state.status === "running";
	const off = !ready || running || disabled;
	return (
		<div className={cn("space-y-1.5", className)}>
			<div className="flex flex-wrap items-center gap-2">
				<Button type="button" variant="outline" size="sm" onClick={onFetch} disabled={off} title={!ready ? waitReason : undefined}>
					{running ? <LoaderCircle className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
					{label}
				</Button>
				{children}
				<span className="text-xs text-muted-foreground" aria-live="polite">
					{running ? "Waiting for the server (up to 15 s)" : state.status === "done" || state.at !== undefined ? answeredText(state) : ""}
				</span>
				{state.redacted ? (
					<Badge variant="outline" title="The kernel replaced copies of secrets (keys, tokens) in this answer with <redacted>.">
						{plural(state.redacted, "secret")} redacted
					</Badge>
				) : null}
			</div>
			{state.status === "error" && state.error ? (
				<p role="alert" className="text-sm break-words text-destructive">
					{state.error}
				</p>
			) : null}
		</div>
	);
}

/** The page link for a JobId (Fleet tables, alerts, the stuck list). */
export function JobLink({ job, keep = 6, className }: { job: string; keep?: number; className?: string }) {
	return (
		<Link to={`/servers/${encodeURIComponent(job)}`} title={`${job}: open the server page`} className={cn("font-mono text-xs underline-offset-2 hover:underline", className)}>
			{shortId(job, keep)}
		</Link>
	);
}

const KIND_TONE: Record<string, string> = {
	error: "bg-[var(--status-critical)]",
	warning: "bg-[var(--status-warning)]",
	info: "bg-[var(--chart-1)]",
	output: "bg-muted-foreground",
};

/** A coloured dot plus the word (colour never carries the meaning alone). */
export function Tone({ tone, children }: { tone?: string; children: ReactNode }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs">
			<span className={cn("size-2 shrink-0 rounded-full", tone ?? "bg-muted-foreground")} aria-hidden />
			{children}
		</span>
	);
}

const LOG_COLUMNS: DataColumn<RemoteLogEntry>[] = [
	{ id: "i", header: "#", type: "number", accessor: (e) => e.i, className: "font-mono text-xs tabular-nums text-muted-foreground" },
	{
		id: "t",
		header: "Time (UTC)",
		type: "date",
		accessor: (e) => e.t * 1000,
		cell: (e) => fmtTime(e.t * 1000).slice(11),
		format: (_v, e) => fmtTime(e.t * 1000),
		className: "font-mono text-xs tabular-nums",
	},
	{
		id: "kind",
		header: "Kind",
		type: "enum",
		order: ["error", "warning", "info", "output"],
		options: ["error", "warning", "info", "output"],
		accessor: (e) => e.kind,
		cell: (e) => <Tone tone={KIND_TONE[e.kind]}>{e.kind}</Tone>,
	},
	{ id: "text", header: "Message", accessor: (e) => e.text, className: "min-w-64 max-w-[48rem] font-mono text-xs whitespace-pre-wrap break-words" },
];

/** A log ring (the server's or one player's), newest first. */
export function LogTable({ id, label, entries, empty }: { id: string; label: string; entries: readonly RemoteLogEntry[]; empty?: ReactNode }) {
	return (
		<DataTable
			id={id}
			label={label}
			columns={LOG_COLUMNS}
			data={entries}
			rowId={(e) => String(e.i)}
			defaultSort={[{ id: "i", desc: true }]}
			pageSize={100}
			density="compact"
			empty={empty}
			{...MEMORY_ONLY}
		/>
	);
}
