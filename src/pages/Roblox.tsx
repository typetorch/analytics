import { useState } from "react";
import { Metric, PageHeader, QueryState } from "@/components/common";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fmtInt, fmtMinutes, fmtNum, fmtPct, plural } from "@/lib/format";
import { useAnalytics } from "@/lib/hooks";
import type { Rate, RobloxResult } from "@/lib/types";

/** A rate tile: the share, "count of base", or "no data yet" when the base is 0. */
function RateMetric({ label, rate, unit, hint }: { label: string; rate: Rate; unit: string; hint: string }) {
	return rate.of > 0 ? (
		<Metric label={label} value={fmtPct(rate.rate)} sub={`${fmtInt(rate.count)} of ${fmtInt(rate.of)} ${unit}`} hint={hint} />
	) : (
		<Metric label={label} value="n/a" tone="muted" sub={`no ${unit} to count yet`} hint={hint} />
	);
}

function Body({ data }: { data: RobloxResult }) {
	return (
		<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
			<RateMetric
				label="First-play bounce"
				rate={data.firstPlayBounce}
				unit="first sessions"
				hint={`New players whose first session lasted under ${data.firstPlayBounce.seconds} s (sessions still running are left out).`}
			/>
			<RateMetric
				label="Qualified plays"
				rate={data.qualifiedPlays}
				unit="sessions"
				hint={`Sessions that lasted ${data.qualifiedPlays.minutes} min or longer.`}
			/>
			<RateMetric
				label="D1 retention"
				rate={data.d1Retention}
				unit="new players"
				hint="New players who played again 1 day after joining (only cohorts whose day 1 is over)."
			/>
			<RateMetric
				label="D7 retention"
				rate={data.d7Retention}
				unit="new players"
				hint="New players who played again 7 days after joining (only cohorts whose day 7 is over)."
			/>
			<Metric
				label="Playtime per user"
				value={fmtMinutes(data.playtimePerUserMinutes)}
				sub={plural(data.players, "player")}
				hint="Total session time divided by players."
			/>
			<Metric label="Play days per user" value={fmtNum(data.playDaysPerUser)} hint="Distinct days played, averaged over players." />
			<RateMetric label="Payer conversion" rate={data.payerConversion} unit="players" hint="Players with at least one purchase." />
			<Metric
				label="Robux per user"
				value={fmtNum(data.robuxPerUser)}
				sub={`${fmtInt(data.purchases)} purchases`}
				hint="Robux from purchases divided by all players."
			/>
			<Metric
				label="Robux per payer"
				value={data.payerConversion.count ? fmtNum(data.robuxPerPayer) : "n/a"}
				tone={data.payerConversion.count ? undefined : "muted"}
				hint="Robux from purchases divided by paying players."
			/>
		</div>
	);
}

export default function Roblox() {
	const [qualifiedMinutes, setQualified] = useState(5);
	const [bounceSeconds, setBounce] = useState(60);
	const q = useAnalytics("roblox", { qualifiedMinutes, bounceSeconds });
	return (
		<>
			<PageHeader
				title="Roblox numbers"
				description="The numbers Roblox's own dashboards and discovery look at, from your events."
				actions={
					<>
						<Label className="text-xs text-muted-foreground">
							Qualified play (min)
							<Input
								type="number"
								min={1}
								max={240}
								className="h-8 w-20"
								value={qualifiedMinutes}
								onChange={(e) => setQualified(Math.max(1, Number(e.target.value) || 5))}
							/>
						</Label>
						<Label className="text-xs text-muted-foreground">
							Bounce under (s)
							<Input
								type="number"
								min={5}
								max={3600}
								className="h-8 w-20"
								value={bounceSeconds}
								onChange={(e) => setBounce(Math.max(5, Number(e.target.value) || 60))}
							/>
						</Label>
					</>
				}
			/>
			<QueryState query={q} loadingRows={4}>
				{(data) => <Body data={data} />}
			</QueryState>
		</>
	);
}
