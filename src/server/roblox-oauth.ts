/**
 * Sign in with Roblox (OpenID Connect): authorization code + PKCE (S256) + state + nonce, scopes `openid profile`.
 * Endpoints come from Roblox's discovery document (cached with the JWKS). The ID token is verified here (signature from
 * the JWKS, issuer, audience, expiry, nonce) and only its user id and profile claims are used: Roblox's access and
 * refresh tokens are dropped unread. The client secret and every token stay out of logs and error messages.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const ROBLOX_DISCOVERY_URL = "https://apis.roblox.com/oauth/.well-known/openid-configuration";
export const PENDING_TTL_MS = 10 * 60_000;
const DOCS_TTL_MS = 3_600_000;
const JWKS_REFETCH_MIN_MS = 60_000;
const CLOCK_SKEW_MS = 30_000;
const MAX_PENDING = 1000;
/** Sign-ins in progress per address: more push that address' own oldest out, not someone else's. */
export const MAX_PENDING_PER_ADDRESS = 5;
const HTTP_TIMEOUT_MS = 10_000;

/** The reason shown on the login page (a short code the page turns into a plain sentence). */
export type OAuthErrorCode = "state" | "denied" | "failed" | "not_owner";

export class OAuthError extends Error {
	constructor(
		readonly code: OAuthErrorCode,
		/** For the log only (no secrets, no tokens). */
		readonly detail: string,
	) {
		super(detail);
	}
}

export interface RobloxIdentity {
	userId: number;
	/** Roblox username when the profile claims have it, else the display name. */
	name: string;
	displayName?: string;
	/** An https URL on Roblox's CDN. */
	avatar?: string;
}

export interface RobloxOAuthOptions {
	clientId: string;
	clientSecret: string;
	/** `<public url>/v1/auth/roblox/callback` */
	redirectUri: string;
	fetch?: typeof fetch;
	clock?: () => number;
	discoveryUrl?: string;
}

interface Discovery {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	jwks_uri: string;
}

interface Jwk {
	kty: string;
	kid?: string;
	alg?: string;
	[key: string]: unknown;
}

interface Pending {
	verifier: string;
	nonce: string;
	created: number;
	/** Who started it (the client's address). */
	owner: string;
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");

function safeEqual(a: string, b: string): boolean {
	const ha = createHash("sha256").update(a).digest();
	const hb = createHash("sha256").update(b).digest();
	return timingSafeEqual(ha, hb);
}

function httpsUrl(value: unknown, what: string): string {
	if (typeof value !== "string") throw new OAuthError("failed", `discovery: ${what} missing`);
	let u: URL;
	try {
		u = new URL(value);
	} catch {
		throw new OAuthError("failed", `discovery: ${what} is not a URL`);
	}
	if (u.protocol !== "https:") throw new OAuthError("failed", `discovery: ${what} is not https`);
	return value;
}

export class RobloxOAuth {
	private readonly pending = new Map<string, Pending>();
	private readonly doFetch: (input: string, init?: RequestInit) => Promise<Response>;
	private readonly clock: () => number;
	private discovered: { at: number; doc: Discovery } | undefined;
	private keys: { at: number; keys: Jwk[]; fetchedAt: number } | undefined;

	constructor(private readonly o: RobloxOAuthOptions) {
		this.doFetch = o.fetch ?? ((input, init) => fetch(input, init));
		this.clock = o.clock ?? Date.now;
	}

	get redirectUri(): string {
		return this.o.redirectUri;
	}

	private async getJson(url: string, init?: RequestInit): Promise<unknown> {
		let response: Response;
		try {
			response = await this.doFetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
		} catch (error) {
			throw new OAuthError("failed", `${new URL(url).pathname} unreachable (${(error as Error).name})`);
		}
		if (!response.ok) throw new OAuthError("failed", `${new URL(url).pathname} answered ${response.status}`);
		try {
			return await response.json();
		} catch {
			throw new OAuthError("failed", `${new URL(url).pathname} did not answer JSON`);
		}
	}

	private async discovery(): Promise<Discovery> {
		const now = this.clock();
		if (this.discovered && now - this.discovered.at < DOCS_TTL_MS) return this.discovered.doc;
		const raw = (await this.getJson(this.o.discoveryUrl ?? ROBLOX_DISCOVERY_URL)) as Record<string, unknown>;
		if (typeof raw.issuer !== "string") throw new OAuthError("failed", "discovery: issuer missing");
		const doc: Discovery = {
			issuer: raw.issuer,
			authorization_endpoint: httpsUrl(raw.authorization_endpoint, "authorization_endpoint"),
			token_endpoint: httpsUrl(raw.token_endpoint, "token_endpoint"),
			jwks_uri: httpsUrl(raw.jwks_uri, "jwks_uri"),
		};
		this.discovered = { at: now, doc };
		return doc;
	}

	private async jwks(force: boolean): Promise<Jwk[]> {
		const now = this.clock();
		if (this.keys && !force && now - this.keys.at < DOCS_TTL_MS) return this.keys.keys;
		// An unknown kid may refetch, but not more than once a minute.
		if (this.keys && force && now - this.keys.fetchedAt < JWKS_REFETCH_MIN_MS) return this.keys.keys;
		const doc = await this.discovery();
		const raw = (await this.getJson(doc.jwks_uri)) as { keys?: unknown };
		const keys = Array.isArray(raw.keys) ? (raw.keys.filter((k) => typeof k === "object" && k !== null) as Jwk[]) : [];
		this.keys = { at: now, keys, fetchedAt: now };
		return keys;
	}

	/** Pending states held per owner (address), oldest first. */
	private held(): Map<string, string[]> {
		const by = new Map<string, string[]>();
		for (const [state, p] of this.pending) {
			const list = by.get(p.owner) ?? [];
			list.push(state);
			by.set(p.owner, list);
		}
		return by;
	}

	/**
	 * Step 1: where to send the browser, and the state that goes into the short-lived cookie. `owner` is the client's
	 * address: each holds at most MAX_PENDING_PER_ADDRESS sign-ins in progress, and when the table is full the address
	 * holding the most loses its oldest, so starting sign-ins over and over can't push out someone else's.
	 */
	async start(owner = ""): Promise<{ url: string; state: string }> {
		const doc = await this.discovery();
		const now = this.clock();
		for (const [state, p] of this.pending) if (now - p.created > PENDING_TTL_MS) this.pending.delete(state);
		const mine = [...this.pending].filter(([, p]) => p.owner === owner).map(([state]) => state);
		while (mine.length >= MAX_PENDING_PER_ADDRESS) this.pending.delete(mine.shift() as string);
		while (this.pending.size >= MAX_PENDING) {
			let most: string[] = [];
			for (const list of this.held().values()) if (list.length > most.length) most = list;
			this.pending.delete(most[0] as string);
		}
		const state = b64url(randomBytes(32));
		const verifier = b64url(randomBytes(32));
		const nonce = b64url(randomBytes(24));
		this.pending.set(state, { verifier, nonce, created: now, owner });
		const url = new URL(doc.authorization_endpoint);
		url.searchParams.set("response_type", "code");
		url.searchParams.set("client_id", this.o.clientId);
		url.searchParams.set("redirect_uri", this.o.redirectUri);
		url.searchParams.set("scope", "openid profile");
		url.searchParams.set("state", state);
		url.searchParams.set("nonce", nonce);
		url.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
		url.searchParams.set("code_challenge_method", "S256");
		return { url: url.toString(), state };
	}

	/**
	 * Step 2: the browser came back. `cookieState` is the state cookie it carries. Single use: the state is spent whatever
	 * happens next. Throws OAuthError.
	 */
	async complete(query: { code?: string | null; state?: string | null; error?: string | null }, cookieState: string | undefined): Promise<RobloxIdentity> {
		const state = query.state ?? "";
		const pending = state ? this.pending.get(state) : undefined;
		if (state) this.pending.delete(state);
		if (!state || !cookieState || !safeEqual(state, cookieState)) throw new OAuthError("state", "state does not match the cookie");
		if (!pending || this.clock() - pending.created > PENDING_TTL_MS) throw new OAuthError("state", "state unknown or expired");
		if (query.error) throw new OAuthError(query.error === "access_denied" ? "denied" : "failed", `Roblox answered error=${query.error.slice(0, 40).replace(/[^\w.-]/g, "_")}`);
		if (!query.code || query.code.length > 4096) throw new OAuthError("failed", "no code");

		const doc = await this.discovery();
		const token = (await this.getJson(doc.token_endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: query.code,
				redirect_uri: this.o.redirectUri,
				client_id: this.o.clientId,
				client_secret: this.o.clientSecret,
				code_verifier: pending.verifier,
			}).toString(),
		})) as Record<string, unknown>;
		// Only the ID token is used; the access and refresh tokens are never kept.
		if (typeof token.id_token !== "string") throw new OAuthError("failed", "the token answer has no id_token");
		return this.verifyIdToken(token.id_token, pending.nonce, doc);
	}

	private async verifyIdToken(jwt: string, nonce: string, doc: Discovery): Promise<RobloxIdentity> {
		const parts = jwt.split(".");
		if (parts.length !== 3 || jwt.length > 16_384) throw new OAuthError("failed", "ID token is not a JWT");
		let header: { alg?: unknown; kid?: unknown };
		let claims: Record<string, unknown>;
		try {
			header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
			claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		} catch {
			throw new OAuthError("failed", "ID token is not JSON");
		}
		const alg = header.alg;
		if (alg !== "ES256" && alg !== "RS256") throw new OAuthError("failed", `ID token alg ${typeof alg === "string" ? alg.slice(0, 12) : "?"} is not accepted`);
		const kid = typeof header.kid === "string" ? header.kid : undefined;
		const pick = (keys: Jwk[]) => keys.find((k) => (kid ? k.kid === kid : true) && k.kty === (alg === "ES256" ? "EC" : "RSA") && (!k.alg || k.alg === alg));
		let jwk = pick(await this.jwks(false));
		if (!jwk) jwk = pick(await this.jwks(true));
		if (!jwk) throw new OAuthError("failed", "no signing key for the ID token");
		const signature = Buffer.from(parts[2], "base64url");
		const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
		let valid = false;
		try {
			const algorithm = alg === "ES256" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
			const key = await crypto.subtle.importKey("jwk", { ...jwk, key_ops: ["verify"] } as never, algorithm, false, ["verify"]);
			valid = await crypto.subtle.verify(alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" }, key, signature, data);
		} catch {
			valid = false;
		}
		if (!valid) throw new OAuthError("failed", "ID token signature is not valid");

		if (claims.iss !== doc.issuer) throw new OAuthError("failed", "ID token issuer is wrong");
		const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
		if (!aud.includes(this.o.clientId)) throw new OAuthError("failed", "ID token audience is not this app");
		if (typeof claims.exp !== "number" || claims.exp * 1000 + CLOCK_SKEW_MS < this.clock()) throw new OAuthError("failed", "ID token expired");
		if (typeof claims.iat === "number" && claims.iat * 1000 - CLOCK_SKEW_MS > this.clock()) throw new OAuthError("failed", "ID token is from the future");
		if (typeof claims.nonce !== "string" || !safeEqual(claims.nonce, nonce)) throw new OAuthError("failed", "ID token nonce does not match");
		if (typeof claims.sub !== "string" || !/^\d{1,16}$/.test(claims.sub)) throw new OAuthError("failed", "ID token has no user id");
		const userId = Number(claims.sub);
		if (!Number.isSafeInteger(userId) || userId <= 0) throw new OAuthError("failed", "ID token has no user id");

		const text = (v: unknown, max = 64) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
		const username = text(claims.preferred_username);
		const display = text(claims.nickname) ?? text(claims.name);
		const identity: RobloxIdentity = { userId, name: username ?? display ?? `Roblox user ${userId}` };
		if (display && display !== identity.name) identity.displayName = display;
		const picture = text(claims.picture, 512);
		if (picture) {
			try {
				const u = new URL(picture);
				if (u.protocol === "https:" && (u.hostname.endsWith(".rbxcdn.com") || u.hostname === "rbxcdn.com")) identity.avatar = u.toString();
			} catch {}
		}
		return identity;
	}
}
