/**
 * Why a server needs a look: the backend's `reasons` (fleet/health.ts) for a server row, as short plain lines. The
 * badge opens a popover (click or tap, so it works on a phone) and carries the same lines as its hover title; the
 * server page lists them.
 */
import { cn } from "cn";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtNum } from "@/lib/format";
import type { FleetServer, HealthReason } from "@/lib/types";

/** The health words the kernel sends, plus "failing" from older backends. Color never carries the meaning alone. */
export const HEALTH_TONE: Record<string, string> = {
	ok: "bg-[var(--status-good)]",
	degraded: "bg-[var(--status-warning)]",
	unverified: "bg-[var(--status-warning)]",
	failed: "bg-[var(--status-critical)]",
	failing: "bg-[var(--status-critical)]",
};

const num = (v: number | string) => (typeof v === "number" ? fmtNum(v, Number.isInteger(v) ? 0 : 1) : v);
const withUnit = (v: number | string, unit: string | null) => (unit ? `${num(v)} ${unit}` : num(v));

/** One reason as a short line: "TPS 42.5, under 50", "Memory 3,400 MB, over 3,000 MB", "Kernel health degraded". */
export function reasonText(r: HealthReason): string {
	if (r.signal === "health") return `Kernel health ${r.value}`;
	if (r.signal === "heartbeat") return `Last heartbeat ${withUnit(r.value, r.unit)} ago, over ${withUnit(r.threshold, r.unit)}`;
	const word = r.op === "<" ? "under" : r.op === ">" ? "over" : "not";
	const unit = r.unit === r.label ? null : r.unit; // "TPS 42.5", not "TPS 42.5 TPS"
	return `${r.label} ${withUnit(r.value, unit)}, ${word} ${withUnit(r.threshold, unit)}`;
}

/** The lines for a server: its reasons, then the kernel's last error when the kernel's health is one of them. */
export function reasonLines(s: Pick<FleetServer, "reasons" | "lastError">): string[] {
	const reasons = s.reasons ?? [];
	const lines = reasons.map(reasonText);
	if (s.lastError && reasons.some((r) => r.signal === "health")) lines.push(`Last error: ${s.lastError}`);
	return lines;
}

function Dot({ tone, children }: { tone?: string; children: string }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-xs">
			<span className={cn("size-2 rounded-full", tone ?? "bg-muted-foreground")} aria-hidden />
			{children}
		</span>
	);
}

/** The health word with its dot; with reasons it is a button that opens them. */
export function HealthBadge({ server }: { server: Pick<FleetServer, "health" | "reasons" | "lastError"> }) {
	const word = server.health ?? "unknown";
	const lines = reasonLines(server);
	if (!lines.length)
		return (
			<span title={server.lastError ?? undefined}>
				<Dot tone={HEALTH_TONE[word]}>{word}</Dot>
			</span>
		);
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					type="button"
					className="inline-flex cursor-pointer items-center gap-1 rounded-sm underline decoration-dotted underline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
					title={lines.join("\n")}
					aria-label={`${word}: ${lines.length === 1 ? "1 reason" : `${lines.length} reasons`}, show why`}
				>
					<Dot tone={HEALTH_TONE[word]}>{word}</Dot>
				</button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-80 max-w-[calc(100vw-2rem)]">
				<div className="text-xs font-medium text-muted-foreground">Why</div>
				<ReasonList lines={lines} />
			</PopoverContent>
		</Popover>
	);
}

/** The reasons as a short list (the server page and the popover). */
export function ReasonList({ lines, className }: { lines: string[]; className?: string }) {
	return (
		<ul className={cn("space-y-1 text-sm", className)}>
			{lines.map((line) => (
				<li key={line} className="flex gap-2 break-words">
					<span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-[var(--status-warning)]" aria-hidden />
					<span className="min-w-0">{line}</span>
				</li>
			))}
		</ul>
	);
}
