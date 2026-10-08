/**
 * `POST /v1/errors`: error logs from game servers (kernel and framework). The game already templated the message (player
 * names, display names and UserIds became <player.name>, <player.display_name>, <player.user_id>) and fingerprinted it,
 * so one kind is one fingerprint. A body is `{ v?: 1, j: JobId, errors: [item, ...] }`; `j` is required (1-64 visible
 * characters, the server's JobId; the X-TT-Job header may carry it instead, which also allows the bare array of items):
 *
 *   { fp, template, stack?, count, firstAt, lastAt, branch?, build?, realm, pids? }
 *
 * `fp` 1-64 characters [A-Za-z0-9_.:-]; `template` 1-1000; `stack` up to 4000 (a sample, kept from the first report);
 * `count` 1 to 1,000,000; `firstAt` <= `lastAt` in unix ms (below 1e11 = seconds); `realm` "server" or "client";
 * `branch` and `build` up to 64; `pids` up to 10 analytics ids (the pseudonymous `pid`, never a UserId or a name; more
 * are ignored). An item covering more than 10 minutes (lastAt - firstAt) is counted in its last minute only.
 * Shape problems of the whole body are an error (400); a bad item is dropped and counted, like /v1/ingest does for rows.
 */

export const ERROR_LIMITS = {
	/** Items in one batch. */
	items: 200,
	pids: 10,
	fp: 64,
	template: 1000,
	stack: 4000,
	label: 64,
	count: 1_000_000,
	/** A batch's time range may not reach further back than this, or past a little clock skew ahead. */
	maxAgeMs: 7 * 86_400_000,
	skewMs: 10 * 60_000,
	/** An item covering longer than this is counted in its last minute only (so one item is at most 11 count rows). */
	spreadMs: 10 * 60_000,
} as const;

export const FP_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const PID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** A JobId: 1-64 characters, no control characters (Roblox JobIds are 36-character GUIDs). */
export const ERROR_JOB_PATTERN = /^[^\x00-\x1f\x7f]{1,64}$/;

export type ErrorRealm = "server" | "client";

export interface ErrorItem {
	fp: string;
	template: string;
	stack: string | null;
	count: number;
	firstAt: number;
	lastAt: number;
	branch: string | null;
	build: string | null;
	realm: ErrorRealm;
	pids: string[];
}

export interface ErrorBatch {
	/** The sender's JobId (required). */
	job: string;
	items: ErrorItem[];
	/** Items dropped, and the first few reasons. */
	rejected: number;
	errors: string[];
	/** Sum of `count` over the kept items. */
	total: number;
}

export class ErrorInputError extends Error {
	override name = "ErrorInputError";
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Unix seconds or milliseconds -> milliseconds. */
function toMs(value: number): number {
	return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

function clean(value: unknown, max: number, what: string, required: boolean): string | null {
	if (value === undefined || value === null || value === "") {
		if (required) throw new ErrorInputError(`${what} is required`);
		return null;
	}
	if (typeof value !== "string" || value.length > max || value.includes("\0")) throw new ErrorInputError(`${what} must be a string of at most ${max} characters`);
	return value;
}

function parseItem(raw: unknown, now: number): ErrorItem {
	if (!isRecord(raw)) throw new ErrorInputError("item must be an object");
	const fp = clean(raw.fp, ERROR_LIMITS.fp, "fp", true) as string;
	if (!FP_PATTERN.test(fp)) throw new ErrorInputError("fp may hold letters, digits and _ . : - only");
	const template = clean(raw.template, ERROR_LIMITS.template, "template", true) as string;
	const stack = clean(raw.stack, ERROR_LIMITS.stack, "stack", false);
	const count = raw.count;
	if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1 || count > ERROR_LIMITS.count) throw new ErrorInputError(`count must be a whole number from 1 to ${ERROR_LIMITS.count}`);
	const times = [raw.firstAt, raw.lastAt];
	if (times.some((t) => typeof t !== "number" || !Number.isFinite(t) || t <= 0)) throw new ErrorInputError("firstAt and lastAt must be unix times");
	const firstAt = toMs(raw.firstAt as number);
	const lastAt = toMs(raw.lastAt as number);
	if (firstAt > lastAt) throw new ErrorInputError("firstAt is after lastAt");
	if (firstAt < now - ERROR_LIMITS.maxAgeMs || lastAt > now + ERROR_LIMITS.skewMs) throw new ErrorInputError("the times are outside the last 7 days");
	const realm = raw.realm;
	if (realm !== "server" && realm !== "client") throw new ErrorInputError('realm must be "server" or "client"');
	let pids: string[] = [];
	if (raw.pids !== undefined && raw.pids !== null) {
		if (!Array.isArray(raw.pids)) throw new ErrorInputError("pids must be an array");
		pids = raw.pids.filter((p): p is string => typeof p === "string" && PID_PATTERN.test(p)).slice(0, ERROR_LIMITS.pids);
	}
	return {
		fp,
		template,
		stack,
		count,
		firstAt,
		lastAt,
		branch: clean(raw.branch, ERROR_LIMITS.label, "branch", false),
		build: clean(raw.build, ERROR_LIMITS.label, "build", false),
		realm,
		pids,
	};
}

/**
 * Checks a request body (already JSON-decoded). `jobHeader` is the X-TT-Job header, used when the body has no `j`.
 * Throws ErrorInputError when the body itself is the wrong shape or has no JobId.
 */
export function parseErrorBatch(body: unknown, now: number, jobHeader?: string | null): ErrorBatch {
	let list: unknown;
	let raw: unknown;
	if (Array.isArray(body)) list = body;
	else if (isRecord(body)) {
		list = body.errors;
		raw = body.j;
	} else throw new ErrorInputError("body must be { j, errors: [...] } or an array");
	if (raw === undefined || raw === null || raw === "") raw = jobHeader || undefined;
	if (raw === undefined) throw new ErrorInputError("j (the JobId) is required");
	if (typeof raw !== "string" || !ERROR_JOB_PATTERN.test(raw)) throw new ErrorInputError("j must be a JobId string of 1 to 64 characters");
	const job = raw;
	if (!Array.isArray(list)) throw new ErrorInputError("errors must be an array");
	if (list.length > ERROR_LIMITS.items) throw new ErrorInputError(`at most ${ERROR_LIMITS.items} errors per request`);
	const items: ErrorItem[] = [];
	const errors: string[] = [];
	let rejected = 0;
	let total = 0;
	list.forEach((raw, index) => {
		try {
			const item = parseItem(raw, now);
			items.push(item);
			total += item.count;
		} catch (error) {
			if (!(error instanceof ErrorInputError)) throw error;
			rejected++;
			if (errors.length < 5) errors.push(`errors[${index}]: ${error.message}`);
		}
	});
	return { job, items, rejected, errors, total };
}
