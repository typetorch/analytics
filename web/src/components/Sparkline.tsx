/** A tiny trend line with a filled area (plain SVG, so a table of fifty of them stays cheap). */

/** SVG path data for `values` in a `width` x `height` box: the line, and the same closed down to the baseline. */
export function sparkPaths(values: number[], width: number, height: number, pad = 2): { line: string; area: string; max: number } {
	const max = Math.max(0, ...values);
	if (!values.length) return { line: "", area: "", max };
	const usable = height - pad * 2;
	const step = values.length > 1 ? width / (values.length - 1) : 0;
	const points = values.map((v, i) => [Math.round(i * step * 10) / 10, Math.round((pad + usable - (max > 0 ? (v / max) * usable : 0)) * 10) / 10] as const);
	const line = points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
	const baseline = height - pad;
	const area = `${line} L${points[points.length - 1]?.[0] ?? 0} ${baseline} L${points[0]?.[0] ?? 0} ${baseline} Z`;
	return { line, area, max };
}

export function Sparkline({ values, width = 120, height = 28, label = "trend" }: { values: number[]; width?: number; height?: number; label?: string }) {
	const { line, area, max } = sparkPaths(values, width, height);
	return (
		<svg role="img" aria-label={`${label}, peak ${max}`} viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="text-[var(--chart-1)]">
			<title>{`${label}: peak ${max} per bucket`}</title>
			{area ? <path d={area} fill="currentColor" fillOpacity={0.15} stroke="none" /> : null}
			{line ? <path d={line} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /> : null}
		</svg>
	);
}
