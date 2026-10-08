/**
 * Error log reads (admin):
 *   GET /v1/errors?window=24h|from=&to=&branch=&build=&realm=&q=&limit=&bucket=   -> kinds with counts, players, sparkline
 *   GET /v1/errors/<fp>?window=|from=&to=&branch=&build=&realm=&bucket=             -> one kind: sample stack, series, where
 * `window` is a number and a unit (30m, 6h, 7d); without `from` the window ends now. Times are unix ms or ISO.
 */
import { ErrorInputError, FP_PATTERN } from "./parse.ts";
import { chooseBucket, type ErrorFilter, type ErrorStore, type ErrorWindow } from "./store.ts";

const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

function timeParam(value: string | null, name: string): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value) < 1e11 ? Number(value) * 1000 : Number(value);
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new ErrorInputError(`${name} must be unix ms or an ISO time`);
	return ms;
}

export function parseWindow(q: URLSearchParams, now: number, keepDays: number): ErrorWindow {
	const keepMs = keepDays * 86_400_000;
	let to = timeParam(q.get("to"), "to") ?? now;
	to = Math.min(to, now + 60_000);
	let from = timeParam(q.get("from"), "from");
	if (from === undefined) {
		const raw = q.get("window") ?? "24h";
		const m = /^(\d{1,4})([mhd])$/.exec(raw);
		if (!m) throw new ErrorInputError("window is a number and m, h or d (e.g. 30m, 24h, 7d)");
		from = to - Number(m[1]) * (UNITS[m[2] as string] as number);
	}
	if (from >= to) throw new ErrorInputError("from must be before to");
	from = Math.max(from, now - keepMs, to - keepMs);
	const bucketText = q.get("bucket");
	let requested: number | undefined;
	if (bucketText) {
		requested = Number(bucketText);
		if (!Number.isFinite(requested) || requested < 60 || requested > 86_400) throw new ErrorInputError("bucket is seconds from 60 to 86400");
	}
	return { from, to, bucketSeconds: chooseBucket(to - from, requested) };
}

export function parseFilter(q: URLSearchParams): ErrorFilter {
	const filter: ErrorFilter = {};
	for (const key of ["branch", "build"] as const) {
		const v = q.get(key);
		if (v) {
			if (v.length > 64) throw new ErrorInputError(`${key} is at most 64 characters`);
			filter[key] = v === "(unknown)" ? "" : v;
		}
	}
	const realm = q.get("realm");
	if (realm) {
		if (realm !== "server" && realm !== "client") throw new ErrorInputError('realm is "server" or "client"');
		filter.realm = realm;
	}
	return filter;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

export async function handleErrorReads(store: ErrorStore, url: URL, o: { now: number; keepDays: number }): Promise<Response> {
	const q = url.searchParams;
	try {
		const window = parseWindow(q, o.now, o.keepDays);
		const filter = parseFilter(q);
		const one = /^\/v1\/errors\/([^/]+)$/.exec(url.pathname);
		if (one) {
			let fp: string;
			try {
				fp = decodeURIComponent(one[1] as string);
			} catch {
				return json(400, { error: "bad fingerprint" });
			}
			if (!FP_PATTERN.test(fp)) return json(400, { error: "bad fingerprint" });
			const detail = await store.detail(fp, window, filter);
			return detail ? json(200, detail) : json(404, { error: "no such error kind" });
		}
		const limitText = q.get("limit");
		const limit = limitText ? Number(limitText) : 100;
		if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ErrorInputError("limit is a whole number from 1 to 500");
		const search = q.get("q") ?? undefined;
		if (search && search.length > 100) throw new ErrorInputError("q is at most 100 characters");
		return json(200, await store.list(window, filter, { limit, ...(search ? { search } : {}) }));
	} catch (error) {
		if (error instanceof ErrorInputError) return json(400, { error: error.message });
		throw error;
	}
}
