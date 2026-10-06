/**
 * Experiment results per variant. Per player (`exp` column) or per server (`sexp`). Every metric is compared with the
 * control variant and said in plain words ("B keeps more players: 95% sure").
 */
import { PROP_KEYS } from "../schema.ts";
import { assertSafeKey, lit } from "../sql/dialect.ts";
import { bootstrapMeans, twoProportion, verdict, welch, type TestResult } from "../stats.ts";
import { dayOf, defineQuery, eventsTable, intOption, num, playerRows, ratio, round, SERVER_PURCHASE, str, where } from "./core.ts";

/** The group of servers that run no experiment pin (`sexp` = ""). */
export const SERVER_CONTROL = "(unpinned)";

export interface ExperimentOptions {
	/**
	 * Scope player: the experiment (a key of `exp`); without it, the query lists the experiments it finds.
	 * Scope server: the pinned artifact id to compare with unpinned servers; without it, every pin.
	 */
	experiment?: string;
	/**
	 * "player": variants from `exp` (default). "server": per-server A/B from `sexp` (the artifact id of a kernel
	 * experiment pin; servers without a pin are the "(unpinned)" group).
	 */
	scope: "player" | "server";
	/** The variant the others are compared with (default: "control", or "(unpinned)" for servers, else the first alphabetically). */
	control?: string;
	/** Most per-player values to pull for the bootstrap (beyond it: Welch's test from the aggregates). */
	maxValues: number;
	robuxKey: string;
	variantKey: string;
}

export interface VariantStats {
	variant: string;
	players: number;
	/** Players who played on 2 or more days in the range. */
	returned: { rate: number; count: number };
	payers: { rate: number; count: number };
	playtimeMinutes: number;
	robuxPerPlayer: number;
	sessionsPerPlayer: number;
}

export interface Comparison {
	variant: string;
	metric: "returned" | "payers" | "playtime" | "robux" | "sessions";
	control: number;
	value: number;
	diff: number;
	lift: number | null;
	sure: number;
	method: TestResult["method"];
	/** The plain sentence, e.g. "B keeps more players: 95% sure". */
	words: string;
}

export type ExperimentResult =
	| { experiment: null; experiments: { experiment: string; variant: string; players: number }[] }
	| {
			experiment: string;
			scope: "player" | "server";
			control: string | null;
			variants: VariantStats[];
			comparisons: Comparison[];
			/** Players seen in more than one variant (left out of the numbers). */
			mixedPlayers: number;
	  };

export const experiment = defineQuery<ExperimentOptions, ExperimentResult>({
	name: "experiment",
	summary: "experiment results per variant with how sure each difference is; no experiment: the list",
	defaultDays: 30,
	options: (input = {}) => {
		const scope = input.scope ?? "player";
		if (scope !== "player" && scope !== "server") throw new Error('scope must be "player" or "server"');
		const out: ExperimentOptions = {
			scope,
			maxValues: intOption(input.maxValues, "maxValues", 20_000, 0, 200_000),
			robuxKey: assertSafeKey(input.robuxKey ?? PROP_KEYS.purchaseRobux, "robuxKey"),
			variantKey: assertSafeKey(input.variantKey ?? PROP_KEYS.experimentVariant, "variantKey"),
		};
		if (input.experiment) out.experiment = assertSafeKey(input.experiment, "experiment");
		if (input.control) out.control = String(input.control).slice(0, 128);
		return out;
	},
	statements(ctx, f, o) {
		const d = ctx.dialect;
		const lim = d.limit;
		const table = eventsTable(ctx, f);
		if (!o.experiment && o.scope === "player") {
			return {
				list:
					`SELECT experiment, variant, COUNT(DISTINCT pid) AS players FROM (SELECT e.name AS experiment, ${d.jsonText("e.props", o.variantKey)} AS variant, e.pid AS pid ` +
					`FROM ${table} e WHERE ${where(f, ctx)} AND e.kind = 'experiment') x GROUP BY experiment, variant ORDER BY experiment, variant ${lim(1000)}`,
			};
		}
		const variantExpr =
			o.scope === "server" ? `CASE WHEN e.sexp IS NULL OR e.sexp = '' THEN ${lit(SERVER_CONTROL)} ELSE e.sexp END` : d.jsonText("e.exp", o.experiment as string);
		const serverPrefix = o.scope === "server" && o.experiment ? ` AND (e.sexp IS NULL OR e.sexp = '' OR e.sexp = ${lit(o.experiment)})` : "";
		const base =
			`ev AS (SELECT e.pid AS pid, e.sid AS sid, e.t AS t, e.kind AS kind, e.props AS props, e.src AS esrc, ${variantExpr} AS variant FROM ${table} e WHERE ${playerRows(f, ctx)}${serverPrefix}), ` +
			`pe AS (SELECT pid, sid, t, kind, props, esrc, variant FROM ev WHERE variant IS NOT NULL AND variant <> ''), ` +
			`pv AS (SELECT pid, MIN(variant) AS variant, COUNT(DISTINCT variant) AS nvar FROM pe GROUP BY pid), ` +
			`s AS (SELECT sid, MIN(pid) AS pid, MAX(t) - MIN(t) AS len FROM pe GROUP BY sid), ` +
			`sp AS (SELECT pid, SUM(len) AS playtime, COUNT(*) AS sessions FROM s GROUP BY pid), ` +
			`dp AS (SELECT pid, COUNT(DISTINCT day) AS days FROM (SELECT pid, ${dayOf("t")} AS day FROM pe) dd GROUP BY pid), ` +
			`pu AS (SELECT pid, SUM(COALESCE(robux, 0)) AS robux FROM (SELECT pid, ${d.jsonNumber("props", o.robuxKey)} AS robux FROM pe WHERE kind = 'purchase' AND ${SERVER_PURCHASE}) q GROUP BY pid), ` +
			`pp AS (SELECT pv.pid AS pid, pv.variant AS variant, COALESCE(sp.playtime, 0) AS playtime, COALESCE(sp.sessions, 0) AS sessions, ` +
			`COALESCE(dp.days, 0) AS days, COALESCE(pu.robux, 0) AS robux, CASE WHEN pu.pid IS NULL THEN 0 ELSE 1 END AS payer ` +
			`FROM pv LEFT JOIN sp ON sp.pid = pv.pid LEFT JOIN dp ON dp.pid = pv.pid LEFT JOIN pu ON pu.pid = pv.pid WHERE pv.nvar = 1)`;
		const statements: Record<string, string> = {
			variants:
				`WITH ${base} SELECT variant, COUNT(*) AS players, SUM(CASE WHEN days >= 2 THEN 1 ELSE 0 END) AS returned, SUM(payer) AS payers, ` +
				`AVG(playtime) AS playtime_mean, VAR_SAMP(playtime) AS playtime_var, AVG(robux) AS robux_mean, VAR_SAMP(robux) AS robux_var, ` +
				`AVG(sessions) AS sessions_mean, VAR_SAMP(sessions) AS sessions_var FROM pp GROUP BY variant ORDER BY variant ${lim(1000)}`,
			mixed: `WITH ${base} SELECT COUNT(*) AS mixed FROM pv WHERE nvar > 1 ${lim(1)}`,
		};
		if (o.maxValues > 0) statements.values = `WITH ${base} SELECT variant, playtime, robux, sessions FROM pp ${lim(o.maxValues)}`;
		return statements;
	},
	shape(rows, _ctx, _f, o) {
		if (rows.list) {
			return { experiment: null, experiments: rows.list.map((r) => ({ experiment: str(r.experiment), variant: str(r.variant), players: num(r.players) })) };
		}
		const variants = rows.variants.map((r) => ({
			row: r,
			stats: {
				variant: str(r.variant),
				players: num(r.players),
				returned: { rate: ratio(num(r.returned), num(r.players)), count: num(r.returned) },
				payers: { rate: ratio(num(r.payers), num(r.players)), count: num(r.payers) },
				playtimeMinutes: round(num(r.playtime_mean) / 60_000, 2),
				robuxPerPlayer: round(num(r.robux_mean), 2),
				sessionsPerPlayer: round(num(r.sessions_mean), 2),
			} satisfies VariantStats,
		}));
		const names = variants.map((v) => v.stats.variant);
		const control =
			o.control && names.includes(o.control) ? o.control : names.includes("control") ? "control" : names.includes(SERVER_CONTROL) ? SERVER_CONTROL : (names[0] ?? null);
		// Per-player values for the bootstrap, when we got all of them.
		const totalPlayers = variants.reduce((s, v) => s + v.stats.players, 0);
		const values = rows.values && rows.values.length === totalPlayers ? rows.values : undefined;
		const valuesOf = (variant: string, key: string) => (values ?? []).filter((r) => str(r.variant) === variant).map((r) => num(r[key]));
		const comparisons: Comparison[] = [];
		const base = variants.find((v) => v.stats.variant === control);
		if (base) {
			for (const v of variants) {
				if (v.stats.variant === control) continue;
				const minPlayers = Math.min(base.stats.players, v.stats.players);
				const add = (metric: Comparison["metric"], test: TestResult) =>
					comparisons.push({
						variant: v.stats.variant,
						metric,
						control: round(test.a, 4),
						value: round(test.b, 4),
						diff: round(test.diff, 4),
						lift: test.lift === null ? null : round(test.lift, 4),
						sure: round(test.sure, 4),
						method: test.method,
						words: verdict(v.stats.variant, metric, test, minPlayers),
					});
				add("returned", twoProportion(base.stats.returned.count, base.stats.players, v.stats.returned.count, v.stats.players));
				add("payers", twoProportion(base.stats.payers.count, base.stats.players, v.stats.payers.count, v.stats.players));
				for (const [metric, key, scale] of [
					["playtime", "playtime", 60_000],
					["robux", "robux", 1],
					["sessions", "sessions", 1],
				] as const) {
					let test: TestResult;
					if (values) {
						test = bootstrapMeans(valuesOf(control as string, key).map((x) => x / scale), valuesOf(v.stats.variant, key).map((x) => x / scale));
					} else {
						const a = base.row;
						const b = v.row;
						test = welch(
							num(a[`${key}_mean`]) / scale,
							num(a[`${key}_var`]) / (scale * scale),
							base.stats.players,
							num(b[`${key}_mean`]) / scale,
							num(b[`${key}_var`]) / (scale * scale),
							v.stats.players,
						);
					}
					add(metric, test);
				}
			}
		}
		return {
			experiment: o.experiment ?? "(server)",
			scope: o.scope,
			control,
			variants: variants.map((v) => v.stats),
			comparisons,
			mixedPlayers: num(rows.mixed[0]?.mixed),
		};
	},
});
