/** Small HTTP helpers shared by the analytics and fleet routes: JSON answers, bearer tokens, rate limits. */
import { createHash, timingSafeEqual } from "node:crypto";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

export function bearer(req: Request): string | undefined {
	const header = req.headers.get("authorization") ?? "";
	const match = /^Bearer\s+(\S+)$/i.exec(header);
	return match?.[1];
}

function digest(value: string): Buffer {
	return createHash("sha256").update(value).digest();
}

/** Constant-time check of a token against a list (hashes first, so lengths don't leak). */
export function tokenIn(given: string | undefined, accepted: readonly (string | undefined)[]): boolean {
	if (!given) return false;
	const g = digest(given);
	let ok = false;
	for (const token of accepted) if (token && timingSafeEqual(g, digest(token))) ok = true;
	return ok;
}

/** The client's IP: the TCP peer, or with trustProxy the last X-Forwarded-For hop (what Caddy appends). */
export function clientIp(req: Request, peer: string, trustProxy: boolean): string {
	if (trustProxy) {
		const forwarded = req.headers.get("x-forwarded-for");
		const last = forwarded?.split(",").at(-1)?.trim();
		if (last) return last;
	}
	return peer;
}

/** Token buckets per key: `perMinute` requests, refilled continuously. Idle keys are dropped. */
export class RateLimiter {
	private buckets = new Map<string, { tokens: number; at: number }>();
	private sweeps = 0;

	constructor(
		readonly perMinute: number,
		private readonly clock: () => number = Date.now,
	) {}

	/** True when the request may go ahead; false = 429. */
	take(key: string, cost = 1): boolean {
		const now = this.clock();
		if (++this.sweeps % 10_000 === 0) this.sweep(now);
		const bucket = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
		bucket.tokens = Math.min(this.perMinute, bucket.tokens + ((now - bucket.at) / 60_000) * this.perMinute);
		bucket.at = now;
		this.buckets.set(key, bucket);
		if (bucket.tokens < cost) return false;
		bucket.tokens -= cost;
		return true;
	}

	/** Seconds until `cost` tokens are back. */
	retryAfter(key: string, cost = 1): number {
		const bucket = this.buckets.get(key);
		if (!bucket) return 0;
		return Math.max(1, Math.ceil(((cost - bucket.tokens) / this.perMinute) * 60));
	}

	private sweep(now: number): void {
		for (const [key, bucket] of this.buckets) if (now - bucket.at > 120_000) this.buckets.delete(key);
	}

	get size(): number {
		return this.buckets.size;
	}
}

export function tooMany(seconds: number): Response {
	return json(429, { error: "rate limited" }, { "retry-after": String(seconds) });
}

/** Reads a request body as bytes, refusing more than `max`. */
export async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > max) return null;
	const body = new Uint8Array(await req.arrayBuffer());
	return body.length > max ? null : body;
}
