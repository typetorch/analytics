import { DayBars, fillDays } from "@/components/DayBars";
import { StorageCard } from "@/components/StorageCard";
import { Metric, PageHeader, QueryState, Section } from "@/components/common";
import { describeRange } from "@/lib/filters";
import { fmtInt, fmtMinutes, fmtNum } from "@/lib/format";
import { useAnalytics, useFilters } from "@/lib/hooks";
import type { OverviewResult } from "@/lib/types";

const CHARTS: { key: "players" | "newPlayers" | "sessions" | "playtimeHours"; label: string; decimals?: number }[] = [
	{ key: "players", label: "Players" },
	{ key: "newPlayers", label: "New players" },
	{ key: "sessions", label: "Sessions" },
	{ key: "playtimeHours", label: "Playtime (hours)", decimals: 1 },
];

function Body({ data }: { data: OverviewResult }) {
	return (
		<>
			<div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
				<Metric label="Players" value={fmtInt(data.players)} />
				<Metric label="New players" value={fmtInt(data.newPlayers)} />
				<Metric label="Returning" value={fmtInt(data.returningPlayers)} />
				<Metric label="Sessions" value={fmtInt(data.sessions)} />
				<Metric label="Events" value={fmtInt(data.events)} />
				<Metric label="Playtime" value={`${fmtNum(data.playtimeHours, 1)} h`} />
				<Metric label="Avg session" value={fmtMinutes(data.avgSessionMinutes)} />
				<Metric label="Playtime per player" value={fmtMinutes(data.playtimePerPlayerMinutes)} />
			</div>
			<div className="grid gap-3 lg:grid-cols-2">
				{CHARTS.map((c) => (
					<Section key={c.key} title={c.label} description="per day (UTC), by the day a session started">
						<DayBars
							label={c.label}
							decimals={c.decimals}
							data={fillDays(
								data.days.map((d) => ({ date: d.date, value: d[c.key] })),
								data.from,
								data.to,
							)}
						/>
					</Section>
				))}
			</div>
		</>
	);
}

export default function Overview() {
	const { state } = useFilters();
	const q = useAnalytics("overview");
	return (
		<>
			<PageHeader title="Overview" description={`Players, sessions and playtime, ${describeRange(state)}. Session length = first to last event.`} />
			<QueryState query={q} loadingRows={6}>
				{(data) => <Body data={data} />}
			</QueryState>
			<StorageCard />
		</>
	);
}
