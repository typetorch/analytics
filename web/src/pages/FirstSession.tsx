import type { ReactNode } from "react";
import { Metric, PageHeader, QueryState, Section, ShareBar } from "@/components/common";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtInt, fmtNum, fmtPct } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { ConfusionResult } from "@/lib/types";

interface Column<T> {
	label: string;
	cell(row: T): ReactNode;
	right?: boolean;
}

function SignalTable<T>({ rows, columns, empty }: { rows: T[]; columns: Column<T>[]; empty: string }) {
	if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
	return (
		<Table>
			<TableHeader>
				<TableRow>
					{columns.map((c) => (
						<TableHead key={c.label} className={c.right ? "text-right" : undefined}>
							{c.label}
						</TableHead>
					))}
				</TableRow>
			</TableHeader>
			<TableBody>
				{rows.map((row, i) => (
					<TableRow key={i}>
						{columns.map((c) => (
							<TableCell key={c.label} className={c.right ? "text-right tabular-nums" : "whitespace-normal"}>
								{c.cell(row)}
							</TableCell>
						))}
					</TableRow>
				))}
			</TableBody>
		</Table>
	);
}

const share = (value: number) => (
	<div className="flex items-center justify-end gap-2">
		<ShareBar share={value} className="w-20" tone={value >= 0.5 ? "alert" : "default"} />
		<span className="w-12 text-right">{fmtPct(value)}</span>
	</div>
);

function Body({ data }: { data: ConfusionResult }) {
	const rec = data.recordings;
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
				<Metric label="First sessions" value={fmtInt(data.firstSessions)} />
				<Metric label="Players" value={fmtInt(data.players)} />
				<Metric
					label="Recorded sessions"
					value={rec.available ? fmtInt(rec.sessions ?? 0) : "none"}
					tone={rec.available ? undefined : "muted"}
					sub={rec.available ? `${fmtInt(rec.failedSessions ?? 0)} failed to decode` : rec.reason}
				/>
				<Metric label="Early leaves" value={fmtInt(data.earlyLeave.reduce((s, z) => s + z.early, 0))} sub="first sessions under 2 min" />
			</div>
			<div className="grid gap-4 xl:grid-cols-2">
				<Section title="Early leaves by zone" description="Zone the first session ended in; early = under 2 minutes.">
					<SignalTable
						rows={data.earlyLeave}
						empty="No finished first session in this range."
						columns={[
							{ label: "Zone", cell: (r) => r.zone },
							{ label: "Sessions", cell: (r) => fmtInt(r.sessions), right: true },
							{ label: "Early", cell: (r) => fmtInt(r.early), right: true },
							{ label: "Share", cell: (r) => share(r.share), right: true },
						]}
					/>
				</Section>
				<Section title="Screen loops" description="Screens opened 3+ times in one first session.">
					<SignalTable
						rows={data.screenLoops}
						empty="No screens opened in first sessions."
						columns={[
							{ label: "Screen", cell: (r) => r.screen },
							{ label: "Sessions", cell: (r) => fmtInt(r.sessions), right: true },
							{ label: "Opens", cell: (r) => fmtInt(r.opens), right: true },
							{ label: "Looped", cell: (r) => share(r.share), right: true },
						]}
					/>
				</Section>
				<Section title="Back and forth" description="Two zones walked between 3+ times in one first session.">
					<SignalTable
						rows={data.backAndForth}
						empty="No zone changes in first sessions."
						columns={[
							{ label: "Zones", cell: (r) => `${r.a} / ${r.b}` },
							{ label: "Sessions", cell: (r) => fmtInt(r.sessions), right: true },
							{ label: "Flagged", cell: (r) => share(r.share), right: true },
						]}
					/>
				</Section>
				<Section title="From recordings" description="Idle 10 s+, camera spins (360 degrees in 6 s, not moving), 3 presses of one button in 2 s.">
					{rec.available ? (
						<div className="space-y-4">
							<SignalTable
								rows={rec.idle ?? []}
								empty="No idle spots."
								columns={[
									{ label: "Idle in zone", cell: (r) => r.zone },
									{ label: "Times", cell: (r) => fmtInt(r.count), right: true },
									{ label: "Avg", cell: (r) => `${fmtNum(r.avgSeconds, 1)} s`, right: true },
								]}
							/>
							<SignalTable
								rows={rec.cameraSpin ?? []}
								empty="No camera spins."
								columns={[
									{ label: "Camera spins in zone", cell: (r) => r.zone },
									{ label: "Times", cell: (r) => fmtInt(r.count), right: true },
								]}
							/>
							<SignalTable
								rows={rec.repeatedClicks ?? []}
								empty="No repeated clicks."
								columns={[
									{ label: "Button pressed again and again", cell: (r) => <span className="font-mono text-xs">{r.button}</span> },
									{ label: "Times", cell: (r) => fmtInt(r.count), right: true },
									{ label: "Avg presses", cell: (r) => fmtNum(r.avgPresses, 1), right: true },
								]}
							/>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">No recordings: {rec.reason ?? "none in this range"}.</p>
					)}
				</Section>
			</div>
		</>
	);
}

export default function FirstSession() {
	const q = useAnalytics("confusion");
	return (
		<>
			<PageHeader title="First session" description="Signs that new players got lost in their first session, per zone and button." />
			<QueryState query={q} isEmpty={(d) => d.firstSessions === 0} empty="No first sessions in this range.">
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
