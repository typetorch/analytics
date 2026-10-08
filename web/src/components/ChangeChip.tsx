/** Small shared bits for metric cards: the period-over-period change chip and an info icon with a definition. */
import { ArrowDown, ArrowUp, Info, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Change } from "@/lib/benchmarks";
import { fmtPct } from "@/lib/format";

/** "+12%" with an arrow; green when it's an improvement, red when it's worse (the arrow and sign say it too). */
export function ChangeChip({ change, against }: { change: Change; against: string }) {
	const Icon = change.direction === "up" ? ArrowUp : change.direction === "down" ? ArrowDown : Minus;
	const text =
		change.relative === null ? (change.direction === "up" ? "new" : "–") : change.relative === 0 ? "0%" : `${change.relative > 0 ? "+" : ""}${fmtPct(change.relative, Math.abs(change.relative) < 0.1 ? 1 : 0)}`;
	return (
		<span
			className={cn(
				"inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums",
				change.good === true && "bg-[var(--status-good)]/12 text-[var(--status-good)]",
				change.good === false && "bg-[var(--status-critical)]/12 text-[var(--status-critical)]",
				change.good === null && "bg-muted text-muted-foreground",
			)}
			title={`vs ${against}`}
		>
			<Icon className="size-3" />
			{text}
		</span>
	);
}

export function InfoTip({ children, label = "What this is" }: { children: ReactNode; label?: string }) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<button type="button" className="inline-flex text-muted-foreground hover:text-foreground" aria-label={label}>
					<Info className="size-3.5" />
				</button>
			</TooltipTrigger>
			<TooltipContent className="max-w-72 text-xs leading-snug">{children}</TooltipContent>
		</Tooltip>
	);
}
