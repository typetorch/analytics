/**
 * A Performance number flagged as a possible problem (lib/perf-thresholds.ts): a tinted pill, orange for a warning and red for
 * critical, with the reason as its tooltip and a screen-reader word (colour never carries the meaning alone). The app's
 * status tokens, so it reads in light and dark.
 */
import type { ReactNode } from "react";
import { cn } from "cn";
import type { Flag, FlagLevel } from "@/lib/perf-thresholds";

const TONE: Record<FlagLevel, string> = {
	warning: "bg-[var(--status-serious)]/20 text-foreground ring-[var(--status-serious)]/60",
	critical: "bg-[var(--status-critical)]/15 text-[var(--status-critical)] ring-[var(--status-critical)]/60",
};

export function PerfFlag({ flag, children }: { flag: Pick<Flag, "level" | "why">; children: ReactNode }) {
	return (
		<span className={cn("inline-block rounded px-1.5 py-0.5 font-medium tabular-nums ring-1 ring-inset", TONE[flag.level])} title={flag.why} data-flag={flag.level}>
			{children}
			<span className="sr-only"> ({flag.level})</span>
		</span>
	);
}
