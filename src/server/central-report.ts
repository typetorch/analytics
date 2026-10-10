/**
 * The origin report (plans typetorch-dev-login "Project identity"): the backend tells the broker where it lives, and
 * proves it. `POST <issuer>/report` with `{ fingerprint, public_key, origin, label, iat, signature }`, the signature
 * (Ed25519, the instance key) over the canonical JSON `{"fingerprint","origin","label","iat"}` in that order, no
 * whitespace. When the origin is new the broker answers 202 `{ challenge, retry_after }`: the token is served at
 * `<origin>/api/typetorch/challenge/<token>` for 60 seconds while this polls with a fresh report until the broker
 * answers 200 `{ ok, origin, access_token, expires_in }`. The access token (one hour, in memory only) may stand in for
 * the signature on later reports in that hour. Failures are logged at most once an hour and are never fatal.
 */
import type { InstanceKey } from "./instance-key.ts";

/** How long a challenge token is served. */
export const CHALLENGE_TTL_MS = 60_000;
const HTTP_TIMEOUT_MS = 10_000;
const FAILURE_LOG_EVERY_MS = 3_600_000;
const TOKEN_MAX_LIFE_MS = 3_600_000;
/** Reports sent while a challenge is pending (the broker asks every 2 to 10 s; 60 s in all). */
const MAX_POLLS = 30;
const CHALLENGE_PATTERN =/^[A-Za-z0-9_-]{16,128}$/;

export type ReportResult = "ok" | "failed";

export interface CentralReporterOptions {
	issuer: string;
	key: InstanceKey;
	/** This backend's public origin (TYPETORCH_PUBLIC_URL). */
	origin: string;
	/** Shown on typetorch.dev (untrusted text there), at most 64 characters. */
	label: string;
	fetch?: typeof fetch;
	clock?: () => number;
	log?: (line: string) => void;
	/** Waits between challenge polls (tests pass a fast one). */
	sleep?: (ms: number) => Promise<void>;
}

/** The exact bytes the instance key signs. */
export function canonicalReport(r: { fingerprint: string; origin: string; label: string; iat: number }): string {
	return JSON.stringify({ fingerprint: r.fingerprint, origin: r.origin, label: r.label, iat: r.iat });
}

export class CentralReporter {
	private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	private readonly log: (line: string) => void;
	private readonly sleep: (ms: number) => Promise<void>;
	private challenge: { token: string; until: number } | undefined;
	private accessToken: { value: string; until: number } | undefined;
	private running: Promise<ReportResult> | undefined;
	private lastFailureLog = -Infinity;
	/** For the admin view of /healthz: when the last report finished and how. */
	last: { at: number; result: ReportResult; status?: number } | undefined;

	constructor(private readonly o: CentralReporterOptions) {
		this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
		this.clock = o.clock ?? Date.now;
		this.log = o.log ?? (() => {});
		this.sleep = o.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
	}

	/** The body to serve at /api/typetorch/challenge/<token>, only while that challenge is pending. */
	challengeAnswer(token: string): string | undefined {
		const c = this.challenge;
		if (!c || this.clock() > c.until || token.length !== c.token.length) return undefined;
		return token === c.token ? c.token : undefined;
	}

	/** One report (a second call while one runs joins it). Never throws. */
	report(): Promise<ReportResult> {
		this.running ??= this.run()
			.catch((error) => {
				this.failed(`unexpected error (${(error as Error).name})`);
				return "failed" as const;
			})
			.finally(() => (this.running = undefined));
		return this.running;
	}

	private body(signed: boolean): Record<string, unknown> {
		const iat = Math.floor(this.clock() / 1000);
		const base = { fingerprint: this.o.key.fingerprint, origin: this.o.origin, label: this.o.label, iat };
		if (!signed) return base;
		return {
			fingerprint: base.fingerprint,
			public_key: this.o.key.publicKey.toString("base64"),
			origin: base.origin,
			label: base.label,
			iat,
			signature: this.o.key.sign(canonicalReport(base)).toString("base64"),
		};
	}

	private async send(signed: boolean): Promise<{ status: number; body: Record<string, unknown> }> {
		const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
		if (!signed && this.accessToken) headers.authorization = `Bearer ${this.accessToken.value}`;
		const response = await this.doFetch(new URL("/report", this.o.issuer).toString(), {
			method: "POST",
			headers,
			body: JSON.stringify(this.body(signed)),
			redirect: "manual",
			signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
		});
		let body: Record<string, unknown> = {};
		if (response.status === 200 || response.status === 202) {
			try {
				const text = await response.text();
				const parsed = text.length <= 16_384 ? (JSON.parse(text) as unknown) : undefined;
				if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
			} catch {}
		} else await response.body?.cancel().catch(() => {});
		return { status: response.status, body };
	}

	private async run(): Promise<ReportResult> {
		const now = this.clock();
		// The hour-long token from an earlier report stands in for the signature; a refusal falls back to signing.
		let signed = !(this.accessToken && this.accessToken.until - 60_000 > now);
		let answer: { status: number; body: Record<string, unknown> };
		try {
			answer = await this.send(signed);
			if (!signed && answer.status === 401) {
				this.accessToken = undefined;
				signed = true;
				answer = await this.send(true);
			}
			const started = this.clock();
			let polls = 0;
			while (answer.status === 202) {
				if (++polls > MAX_POLLS) return this.failed("the origin challenge did not pass");
				const token = answer.body.challenge;
				if (typeof token !== "string" || !CHALLENGE_PATTERN.test(token)) return this.failed("the challenge answer is malformed");
				if (this.challenge?.token !== token) this.challenge = { token, until: this.clock() + CHALLENGE_TTL_MS };
				if (this.clock() - started > CHALLENGE_TTL_MS) return this.failed("the origin challenge did not pass within 60 s");
				const retry = typeof answer.body.retry_after === "number" && Number.isFinite(answer.body.retry_after) ? answer.body.retry_after : 2;
				await this.sleep(Math.min(10, Math.max(1, retry)) * 1000);
				answer = await this.send(true);
			}
		} catch (error) {
			return this.failed(`typetorch.dev unreachable (${(error as Error).name})`);
		} finally {
			// A challenge is served only while its report is pending.
			this.challenge = undefined;
		}
		if (answer.status !== 200 || answer.body.ok !== true) return this.failed(`typetorch.dev answered ${answer.status}`, answer.status);
		const token = answer.body.access_token;
		const life = typeof answer.body.expires_in === "number" && answer.body.expires_in > 0 ? Math.min(answer.body.expires_in * 1000, TOKEN_MAX_LIFE_MS) : 0;
		this.accessToken = typeof token === "string" && token.length >= 16 && token.length <= 512 && /^[\x21-\x7e]+$/.test(token) && life ? { value: token, until: this.clock() + life } : undefined;
		const first = this.last?.result !== "ok";
		this.last = { at: this.clock(), result: "ok", status: 200 };
		if (first) this.log(`typetorch.dev: reported ${this.o.origin} for ${this.o.key.fingerprint}`);
		return "ok";
	}

	private failed(why: string, status?: number): ReportResult {
		const now = this.clock();
		this.last = { at: now, result: "failed", ...(status !== undefined ? { status } : {}) };
		if (now - this.lastFailureLog >= FAILURE_LOG_EVERY_MS) {
			this.lastFailureLog = now;
			this.log(`typetorch.dev report failed: ${why} (the typetorch.dev login may not reach this backend until a report lands; retrying)`);
		}
		return "failed";
	}
}
