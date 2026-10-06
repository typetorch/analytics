/** A small per-day bar chart (one series; the card title names it). Days without data show as zero. */
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

export interface DayPoint {
	date: string;
	value: number;
}

/** Every UTC day from `from` to `to` (YYYY-MM-DD or ISO), with the values found and 0 elsewhere (at most 400 days). */
export function fillDays(points: DayPoint[], from: string, to: string): DayPoint[] {
	const byDate = new Map(points.map((p) => [p.date, p.value]));
	const start = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
	const end = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > 400 * 86_400_000) return points;
	const out: DayPoint[] = [];
	for (let t = start; t <= end; t += 86_400_000) {
		const date = new Date(t).toISOString().slice(0, 10);
		out.push({ date, value: byDate.get(date) ?? 0 });
	}
	return out;
}

export function DayBars({ data, label, decimals = 0, color = "var(--chart-1)" }: { data: DayPoint[]; label: string; decimals?: number; color?: string }) {
	const config: ChartConfig = { value: { label, color } };
	return (
		<ChartContainer config={config} className="aspect-auto h-40 w-full">
			<BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -12 }} barCategoryGap={2}>
				<CartesianGrid vertical={false} />
				<XAxis dataKey="date" tickLine={false} axisLine={false} tickMargin={6} minTickGap={24} tickFormatter={(d: string) => d.slice(5)} />
				<YAxis
					tickLine={false}
					axisLine={false}
					width={40}
					allowDecimals={decimals > 0}
					tickFormatter={(v: number) => (decimals ? v.toFixed(decimals) : String(v))}
				/>
				<ChartTooltip cursor={{ fillOpacity: 0.4 }} content={<ChartTooltipContent labelFormatter={(d) => String(d)} />} />
				<Bar dataKey="value" fill="var(--color-value)" radius={[4, 4, 0, 0]} maxBarSize={28} isAnimationActive={false} />
			</BarChart>
		</ChartContainer>
	);
}
