/** A player's progress through a funnel: a bar with the percentage over it, and the furthest step in its tooltip. */
import { cn } from "cn";
import { fmtPct } from "@/lib/format";
import type { FunnelProgress } from "@/lib/types";

export function FunnelProgressBar({ progress, className }: { progress: FunnelProgress | undefined; className?: string }) {
	if (!progress) {
		return (
			<div className={cn("relative h-5 w-full min-w-24 rounded bg-muted/60 text-center text-[11px] leading-5 text-muted-foreground", className)} title="Not started">
				not started
			</div>
		);
	}
	const width = Math.max(0, Math.min(1, progress.share)) * 100;
	const done = progress.reached >= progress.of;
	const title = `Step ${progress.reached} of ${progress.of}${progress.label ? `: ${progress.label}` : ""}`;
	return (
		<div
			className={cn("relative h-5 w-full min-w-24 overflow-hidden rounded bg-muted", className)}
			role="progressbar"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(width)}
			aria-label={`${progress.funnel}: ${title}`}
			title={title}
		>
			<div className={cn("h-full", done ? "bg-[var(--status-good)]" : "bg-[var(--chart-1)]")} style={{ width: `${width}%` }} />
			<span className="absolute inset-0 flex items-center justify-center text-[11px] font-medium text-foreground tabular-nums [text-shadow:0_0_3px_var(--background)]">
				{fmtPct(progress.share)}
			</span>
		</div>
	);
}
