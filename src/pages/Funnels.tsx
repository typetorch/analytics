import { TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { EmptyState, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtInt, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics, useParam } from "@/lib/hooks";
import type { FunnelResult } from "@/lib/types";

type Steps = Extract<FunnelResult, { steps: unknown }>;

function StepBars({ data }: { data: Steps }) {
	const drop = data.biggestDrop;
	return (
		<Section
			title={`${data.funnel}: ${plural(data.players, "player")} started`}
			description="Reached = players whose furthest step is at least this one. Time = median from their first step."
		>
			<div className="space-y-3">
				{data.steps.map((s) => {
					const isDrop = drop?.step === s.step;
					return (
						<div key={s.step} className={cn("rounded-lg border p-3", isDrop && "border-[var(--status-critical)]")}>
							<div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
								<div className="font-medium">
									<span className="text-muted-foreground">Step {s.step}</span> {s.label ?? ""}
								</div>
								<div className="flex flex-wrap gap-4 text-xs text-muted-foreground tabular-nums">
									<span>
										<span className="font-medium text-foreground">{fmtInt(s.reached)}</span> reached
									</span>
									<span>{fmtPct(s.ofStart)} of start</span>
									<span>{fmtPct(s.fromPrevious)} from previous</span>
									<span>{s.medianSecondsFromStart === null ? "–" : `${fmtNum(s.medianSecondsFromStart, 1)} s`} median</span>
								</div>
							</div>
							<ShareBar share={s.ofStart} className="mt-2" tone={isDrop ? "alert" : "default"} />
							{isDrop && drop ? (
								<div className="mt-2 flex items-center gap-1.5 text-xs font-medium text-[var(--status-critical)]">
									<TriangleAlert className="size-3.5" />
									Biggest drop: {plural(drop.lost, "player")} ({fmtPct(drop.share)}) stopped before this step
								</div>
							) : null}
						</div>
					);
				})}
			</div>
			{!drop && data.steps.length > 0 ? <p className="mt-3 text-xs text-muted-foreground">No drop between steps yet.</p> : null}
		</Section>
	);
}

function FunnelDetail({ name }: { name: string }) {
	const q = useAnalytics("funnel", { funnel: name });
	return (
		<QueryState query={q} isEmpty={(d) => d.funnel === null || d.steps.length === 0} empty="Nobody reached a step of this funnel in this range.">
			{(data) => (data.funnel === null ? null : <StepBars data={data} />)}
		</QueryState>
	);
}

export default function Funnels() {
	const list = useAnalytics("funnel", {});
	const [picked, setPicked] = useParam("funnel");
	const funnels = list.data && list.data.funnel === null ? list.data.funnels : [];
	const name = picked || funnels[0]?.name || "";
	return (
		<>
			<PageHeader
				title="Funnels"
				description="Step-by-step funnels the game logs (funnel rows: step index i, step name)."
				actions={
					funnels.length ? (
						<Select value={name} onValueChange={setPicked}>
							<SelectTrigger size="sm" className="w-56" aria-label="Funnel">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{funnels.map((f) => (
									<SelectItem key={f.name} value={f.name}>
										{f.name} ({plural(f.players, "player")})
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null
				}
			/>
			<QueryState query={list} isEmpty={(d) => d.funnel === null && d.funnels.length === 0} empty="No funnel rows in this range.">
				{() => (name ? <FunnelDetail name={name} /> : <EmptyState />)}
			</QueryState>
		</>
	);
}
