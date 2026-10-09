/**
 * When the Performance page flags a number as a possible problem (orange: warning, red: critical). Every line is here, so
 * tuning them later is one file:
 *
 *   1. Absolute lines on a metric's worst-case percentile, direction-aware (fps and TPS are bad when LOW, memory and ping when
 *      HIGH): `ABSOLUTE_RULES`. Frame rate and TPS are judged at p10; ping and memory at p90 and p99 (the page's p90 / p99
 *      are on the bad side, so for the high-is-bad metrics they are the 90th and 99th percentile). A live server's single
 *      reading uses the same lines. The server TPS warning line (50) and the server memory one (3,000 MB) are the Fleet table's
 *      (`LOW_TPS`, `HIGH_MEMORY_MB`; a test keeps them equal).
 *   2. Regressions in Compare, older -> newer build or before -> after: worse by more than `REGRESSION_PCT.warning` % is
 *      orange, by more than `REGRESSION_PCT.critical` % red (higher memory / ping = worse, lower fps / TPS = worse).
 *
 * Neither kind is flagged from fewer than `MIN_SAMPLES` samples (a percentile of a handful of samples is noise); Compare
 * says "few samples" instead.
 */
import { delta, fmtMetric, METRICS, type Percentile } from "./perf";

export type PerfSide = "client" | "server";
export type FlagLevel = "warning" | "critical";

/** A number worth a second look: how bad, and why (the cell's tooltip). */
export interface Flag {
	level: FlagLevel;
	why: string;
}

/** Fewer samples than this: nothing is flagged. */
export const MIN_SAMPLES = 20;

/** A change in Compare is a regression when it is worse by more than this many percent. */
export const REGRESSION_PCT = { warning: 10, critical: 25 } as const;

export interface AbsoluteRule {
	/** The percentiles judged: the metric's worst-case ones. */
	percentiles: readonly Percentile[];
	/** Low is bad (fps, TPS), else high is bad (ping, memory). */
	higherIsBetter: boolean;
	/** Past this (under it when higherIsBetter, over it otherwise): orange. */
	warning: number;
	/** Past this: red. */
	critical: number;
}

export const ABSOLUTE_RULES: Record<PerfSide, Record<string, AbsoluteRule>> = {
	client: {
		fps: { percentiles: ["p10"], higherIsBetter: true, warning: 30, critical: 20 },
		ping: { percentiles: ["p90", "p99"], higherIsBetter: false, warning: 150, critical: 250 },
		mem: { percentiles: ["p90", "p99"], higherIsBetter: false, warning: 2000, critical: 3000 },
	},
	server: {
		tps: { percentiles: ["p10"], higherIsBetter: true, warning: 50, critical: 40 },
		physFps: { percentiles: ["p10"], higherIsBetter: true, warning: 50, critical: 40 },
		mem: { percentiles: ["p90", "p99"], higherIsBetter: false, warning: 3000, critical: 5000 },
	},
};

/** A metric's name for people ("Server memory" for the server side's `mem`). */
export function metricName(side: PerfSide, key: string): string {
	return side === "server" && key === "mem" ? "Server memory" : (METRICS[key]?.label ?? key);
}

const isNumber = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);

/** Whether a rule judges this metric at this percentile (`null`: a single live reading). */
export function isJudged(side: PerfSide, metric: string, percentile: Percentile | null): boolean {
	const rule = ABSOLUTE_RULES[side][metric];
	return !!rule && (percentile === null || rule.percentiles.includes(percentile));
}

/** The lines of a judged metric as text ("flagged under 30 fps (orange) and 20 fps (red)"), else null. For header tooltips. */
export function thresholdText(side: PerfSide, metric: string, percentile: Percentile | null): string | null {
	const rule = ABSOLUTE_RULES[side][metric];
	if (!rule || !isJudged(side, metric, percentile)) return null;
	const word = rule.higherIsBetter ? "under" : "over";
	return `flagged ${word} ${fmtMetric(metric, rule.warning)} (orange) and ${word} ${fmtMetric(metric, rule.critical)} (red)`;
}

/**
 * The flag for one value, or null: no rule for the metric, the percentile isn't a judged one, no value, too few samples
 * (`samples` given), or the value is within the lines. `percentile` null is a live reading (no percentile).
 */
export function absoluteFlag(side: PerfSide, metric: string, percentile: Percentile | null, value: number | null | undefined, samples?: number): Flag | null {
	const rule = ABSOLUTE_RULES[side][metric];
	if (!rule || !isNumber(value) || !isJudged(side, metric, percentile)) return null;
	if (samples !== undefined && samples < MIN_SAMPLES) return null;
	const past = (line: number) => (rule.higherIsBetter ? value < line : value > line);
	const level: FlagLevel | null = past(rule.critical) ? "critical" : past(rule.warning) ? "warning" : null;
	if (!level) return null;
	const word = rule.higherIsBetter ? "under" : "over";
	const what = `${metricName(side, metric)}${percentile ? ` ${percentile}` : ""}`;
	const more = level === "warning" ? ` (${word} ${fmtMetric(metric, rule.critical)} is critical)` : "";
	return { level, why: `${what} is ${fmtMetric(metric, value)}: ${word} the ${fmtMetric(metric, rule[level])} ${level} line${more}` };
}

/** What a change between two periods says (null: nothing worth saying). */
export type Regression =
	| { kind: "few"; why: string }
	| { kind: "worse"; level: FlagLevel | null; why: string }
	| { kind: "better"; why: string };

const oneDecimal = (n: number) => String(Math.round(n * 10) / 10);

/** The verdict on a change from `base` to `value`, with the samples behind each side (too few: "few"). */
export function regression(base: number | null | undefined, value: number | null | undefined, higherIsBetter: boolean, baseSamples: number, valueSamples: number): Regression | null {
	const d = delta(base, value, higherIsBetter);
	if (!d) return null;
	if (Math.min(baseSamples, valueSamples) < MIN_SAMPLES) {
		return { kind: "few", why: `Fewer than ${MIN_SAMPLES} samples on one side (${baseSamples} and ${valueSamples}): too few to judge the change.` };
	}
	if (d.better === null) return null;
	const size = Math.abs(d.pct);
	if (d.better) return { kind: "better", why: `${oneDecimal(size)}% better` };
	const level: FlagLevel | null = size > REGRESSION_PCT.critical ? "critical" : size > REGRESSION_PCT.warning ? "warning" : null;
	return {
		kind: "worse",
		level,
		why: `${oneDecimal(size)}% worse (over ${REGRESSION_PCT.warning}% is a warning, over ${REGRESSION_PCT.critical}% is critical)`,
	};
}
