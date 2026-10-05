/**
 * Filters every logical query accepts, and their SQL. Values are checked and rendered as literals (Basin's SQL API
 * takes one query string, so there are no bind parameters anywhere).
 */
import { DEVICES, type Device } from "../schema.ts";
import { DAY_MS, assertSafeKey, int, lit, type Dialect } from "./dialect.ts";

export interface Filters {
	/** Start (inclusive): unix ms, an ISO time, or a date ("2026-10-01" = that day's 00:00 UTC). */
	from?: number | string;
	/** End: unix ms or an ISO time (exclusive), or a date (inclusive: "2026-10-05" includes that whole day). */
	to?: number | string;
	/** Artifact id(s). */
	art?: string | string[];
	branch?: string | string[];
	channel?: string | string[];
	dev?: Device | Device[];
	/** "new": first-ever sessions only (`newp`); "returning": every other session. */
	players?: "new" | "returning";
	/** Players in an experiment variant (read from the `exp` column). */
	variant?: { experiment: string; variant: string | string[] };
	/** Server experiment(s) (`sexp`). */
	sexp?: string | string[];
	place?: number;
}

/** Filters after checking, with the time range resolved to ms. */
export interface NormalizedFilters extends Omit<Filters, "from" | "to" | "art" | "branch" | "channel" | "dev" | "sexp"> {
	from: number;
	to: number;
	art?: string[];
	branch?: string[];
	channel?: string[];
	dev?: Device[];
	sexp?: string[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseTime(value: number | string, what: string, endOfDay: boolean): number {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) throw new Error(`${what} must be unix milliseconds`);
		return value;
	}
	const text = value.trim();
	if (/^\d{12,14}$/.test(text)) return Number(text);
	const ms = Date.parse(DATE_ONLY.test(text) ? `${text}T00:00:00Z` : text);
	if (!Number.isFinite(ms)) throw new Error(`${what} is not a date or time: ${JSON.stringify(value)}`);
	return DATE_ONLY.test(text) && endOfDay ? ms + DAY_MS : ms;
}

function list<T extends string>(value: T | T[] | undefined, what: string, check?: (v: string) => void): T[] | undefined {
	if (value === undefined) return undefined;
	const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== "");
	if (values.length === 0) return undefined;
	if (values.length > 50) throw new Error(`${what}: at most 50 values`);
	for (const v of values) {
		if (typeof v !== "string" || v.length > 128) throw new Error(`${what} values must be strings of at most 128 characters`);
		check?.(v);
	}
	return values;
}

/**
 * Checks filters and resolves the time range. Without `from`, the range starts `defaultDays` before `to` (default:
 * now). Basin bills by data scanned, so every query has a range.
 */
export function normalizeFilters(filters: Filters = {}, options: { now: number; defaultDays: number }): NormalizedFilters {
	const to = filters.to !== undefined ? parseTime(filters.to, "to", true) : options.now;
	const from = filters.from !== undefined ? parseTime(filters.from, "from", false) : to - options.defaultDays * DAY_MS;
	if (from >= to) throw new Error("from must be before to");
	const out: NormalizedFilters = { from, to };
	out.art = list(filters.art, "art");
	out.branch = list(filters.branch, "branch");
	out.channel = list(filters.channel, "channel");
	out.sexp = list(filters.sexp, "sexp");
	out.dev = list(filters.dev, "dev", (d) => {
		if (!(DEVICES as readonly string[]).includes(d)) throw new Error(`dev must be one of ${DEVICES.join(", ")}`);
	});
	if (filters.players !== undefined) {
		if (filters.players !== "new" && filters.players !== "returning") throw new Error('players must be "new" or "returning"');
		out.players = filters.players;
	}
	if (filters.variant !== undefined) {
		assertSafeKey(filters.variant.experiment, "experiment");
		const variants = list(filters.variant.variant, "variant");
		if (!variants) throw new Error("variant.variant is required");
		out.variant = { experiment: filters.variant.experiment, variant: variants };
	}
	if (filters.place !== undefined) {
		if (!Number.isSafeInteger(filters.place)) throw new Error("place must be an integer");
		out.place = filters.place;
	}
	for (const key of Object.keys(out) as (keyof NormalizedFilters)[]) if (out[key] === undefined) delete out[key];
	return out;
}

function inList(column: string, values: readonly string[]): string {
	return values.length === 1 ? `${column} = ${lit(values[0])}` : `${column} IN (${values.map(lit).join(", ")})`;
}

export interface WhereOptions {
	/** Column prefix, e.g. "e." */
	prefix?: string;
	/** Leave out the time range (the caller adds its own). */
	noTime?: boolean;
	/** Only the filters that exist on the recordings table (time, art). */
	recordings?: boolean;
}

/** The filters as one SQL condition (never empty: "TRUE" when nothing applies). */
export function whereSql(f: NormalizedFilters, dialect: Dialect, options: WhereOptions = {}): string {
	const p = options.prefix ?? "";
	const parts: string[] = [];
	if (!options.noTime) parts.push(`${p}t >= ${int(f.from)}`, `${p}t < ${int(f.to)}`);
	if (f.art) parts.push(inList(`${p}art`, f.art));
	if (!options.recordings) {
		if (f.branch) parts.push(inList(`${p}branch`, f.branch));
		if (f.channel) parts.push(inList(`${p}channel`, f.channel));
		if (f.dev) parts.push(inList(`${p}dev`, f.dev));
		if (f.sexp) parts.push(inList(`${p}sexp`, f.sexp));
		if (f.place !== undefined) parts.push(`${p}place = ${int(f.place)}`);
		if (f.players === "new") parts.push(`${p}newp = TRUE`);
		if (f.players === "returning") parts.push(`(${p}newp IS NULL OR ${p}newp = FALSE)`);
		if (f.variant) parts.push(inList(dialect.jsonText(`${p}exp`, f.variant.experiment), f.variant.variant as string[]));
	}
	return parts.length ? parts.join(" AND ") : "TRUE";
}
