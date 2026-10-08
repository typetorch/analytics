/**
 * Sign in with Roblox: the whole flow against a fake Roblox (discovery document, token endpoint, JWKS with a key pair made
 * here), and the owner list behind it (PUT /v1/access). Nothing leaves the process; every id, key and secret is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startApp } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, type Harness } from "./harness.ts";

const CLIENT_ID = "1234567890123456789";
const CLIENT_SECRET = "RBX-fake-client-secret-for-tests-0123456789";
const PUBLIC = "https://backend.example.com";
const ISSUER = "https://apis.roblox.com/oauth/";
const OWNER = 1001;
const OTHER = 2002;
const b64 = (bytes: ArrayBuffer | Uint8Array | string) => Buffer.from(typeof bytes === "string" ? bytes : new Uint8Array(bytes)).toString("base64url");

interface TestKey {
	kid: string;
	privateKey: CryptoKey;
	jwk: Record<string, unknown>;
}

async function makeKey(kid: string): Promise<TestKey> {
	const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
	return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "ES256", use: "sig" } };
}

async function signJwt(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
	const head = b64(JSON.stringify({ alg: "ES256", typ: "JWT", kid: key.kid, ...header }));
	const body = b64(JSON.stringify(claims));
	const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key.privateKey, new TextEncoder().encode(`${head}.${body}`));
	return `${head}.${body}.${b64(signature)}`;
}

/** A fake Roblox: records what it was asked and answers like the real endpoints do. */
class FakeRoblox {
	keys: TestKey[] = [];
	calls = { discovery: 0, jwks: 0, token: 0 };
	/** Code -> what the authorize request asked for and which ID token claims to hand out. */
	codes = new Map<string, { challenge: string; nonce: string; claims: (base: Record<string, unknown>) => Record<string, unknown>; signer?: TestKey; header?: Record<string, unknown> }>();
	tokenRequests: URLSearchParams[] = [];
	now = () => T0;

	readonly fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url === "https://apis.roblox.com/oauth/.well-known/openid-configuration") {
			this.calls.discovery++;
			return reply({
				issuer: ISSUER,
				authorization_endpoint: "https://apis.roblox.com/oauth/v1/authorize",
				token_endpoint: "https://apis.roblox.com/oauth/v1/token",
				jwks_uri: "https://apis.roblox.com/oauth/v1/certs",
				userinfo_endpoint: "https://apis.roblox.com/oauth/v1/userinfo",
			});
		}
		if (url === "https://apis.roblox.com/oauth/v1/certs") {
			this.calls.jwks++;
			return reply({ keys: this.keys.map((k) => k.jwk) });
		}
		if (url === "https://apis.roblox.com/oauth/v1/token" && init?.method === "POST") {
			this.calls.token++;
			const form = new URLSearchParams(String(init.body));
			this.tokenRequests.push(form);
			const entry = this.codes.get(form.get("code") ?? "");
			if (form.get("grant_type") !== "authorization_code" || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET || !entry) return reply({ error: "invalid_grant" }, 400);
			if (form.get("redirect_uri") !== `${PUBLIC}/v1/auth/roblox/callback`) return reply({ error: "invalid_request" }, 400);
			// PKCE: the verifier must hash to the challenge sent with the authorize request.
			if (b64(createHash("sha256").update(form.get("code_verifier") ?? "").digest()) !== entry.challenge) return reply({ error: "invalid_grant" }, 400);
			this.codes.delete(form.get("code") as string);
			const claims = entry.claims({ iss: ISSUER, aud: CLIENT_ID, sub: String(OWNER), exp: Math.floor(this.now() / 1000) + 900, iat: Math.floor(this.now() / 1000), nonce: entry.nonce });
			const id_token = await signJwt(entry.signer ?? (this.keys[0] as TestKey), claims, entry.header);
			return reply({ access_token: "fake-access-token-never-kept", refresh_token: "fake-refresh-token-never-kept", token_type: "Bearer", expires_in: 900, id_token, scope: "openid profile" });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;

	/** What the user does at Roblox: the authorize URL goes in, a code for the callback comes out. */
	approve(authorizeUrl: string, claims: (base: Record<string, unknown>) => Record<string, unknown> = (c) => c, extra: { signer?: TestKey; header?: Record<string, unknown> } = {}): string {
		const q = new URL(authorizeUrl).searchParams;
		const code = `code-${this.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
		this.codes.set(code, { challenge: q.get("code_challenge") as string, nonce: q.get("nonce") as string, claims, ...extra });
		return code;
	}
}

interface Started {
	authorizeUrl: string;
	state: string;
	cookie: string;
	setCookie: string;
}

describe("Sign in with Roblox", () => {
	let h: Harness;
	let roblox: FakeRoblox;
	const env = { ROBLOX_OAUTH_CLIENT_ID: CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET: CLIENT_SECRET, TYPETORCH_PUBLIC_URL: PUBLIC };

	// A fresh address per call, so the per-address limits don't get in the way of the flows.
	let nextIp = 0;
	const freshIp = () => `10.20.${Math.floor(++nextIp / 250)}.${(nextIp % 250) + 1}`;
	async function start(ip = freshIp()): Promise<Started> {
		const res = await h.call("/v1/auth/roblox/start", { ip });
		expect(res.status).toBe(302);
		const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("tt_oauth=")) as string;
		const authorizeUrl = res.headers.get("location") as string;
		return { authorizeUrl, state: new URL(authorizeUrl).searchParams.get("state") as string, cookie: setCookie.split(";")[0] as string, setCookie };
	}
	const callback = (query: Record<string, string>, cookie?: string, ip = freshIp()) => h.call(`/v1/auth/roblox/callback?${new URLSearchParams(query)}`, { headers: cookie ? { cookie } : {}, ip });
	const sessionOf = (res: Response) => res.headers.getSetCookie().find((c) => c.startsWith("tt_session="));
	async function signIn(claims?: (c: Record<string, unknown>) => Record<string, unknown>, extra?: { signer?: TestKey }): Promise<Response> {
		const s = await start();
		const code = roblox.approve(s.authorizeUrl, claims, extra);
		return callback({ code, state: s.state }, s.cookie);
	}
	const putAccess = (seq: number, owners: number[], headers: Record<string, string> = bearer(ADMIN)) => h.call("/v1/access", { method: "PUT", ...json({ seq, owners }), headers: { "content-type": "application/json", ...headers } });

	beforeAll(async () => {
		roblox = new FakeRoblox();
		roblox.keys = [await makeKey("key-1")];
		h = await harness(env, { fetch: roblox.fetch });
		expect((await putAccess(1, [OWNER])).status).toBe(200);
	});
	afterAll(() => h.close());

	test("the login page learns that Roblox sign-in is on", async () => {
		expect((await asJson(await h.call("/v1/auth/check"))).login).toEqual({ token: true, roblox: true });
	});

	test("start: a redirect to Roblox with PKCE (S256), state, nonce and only openid profile; a short-lived HttpOnly Lax cookie holds the state", async () => {
		const s = await start();
		const url = new URL(s.authorizeUrl);
		expect(`${url.origin}${url.pathname}`).toBe("https://apis.roblox.com/oauth/v1/authorize");
		const q = url.searchParams;
		expect(q.get("response_type")).toBe("code");
		expect(q.get("client_id")).toBe(CLIENT_ID);
		expect(q.get("redirect_uri")).toBe(`${PUBLIC}/v1/auth/roblox/callback`);
		expect(q.get("scope")).toBe("openid profile");
		expect(q.get("code_challenge_method")).toBe("S256");
		expect(q.get("code_challenge")?.length).toBe(43);
		expect((q.get("state") as string).length).toBeGreaterThanOrEqual(43);
		expect((q.get("nonce") as string).length).toBeGreaterThanOrEqual(24);
		expect(s.authorizeUrl).not.toContain(CLIENT_SECRET);
		for (const part of ["HttpOnly", "SameSite=Lax", "Path=/v1/auth/roblox", "Max-Age=600", "Secure"]) expect(s.setCookie).toContain(part);
		expect(s.cookie).toBe(`tt_oauth=${q.get("state")}`);
		// Every start is fresh.
		expect((await start()).state).not.toBe(s.state);
	});

	test("an owner signs in: the code is exchanged with the secret and the PKCE verifier, the ID token is checked, a session starts", async () => {
		const before = roblox.tokenRequests.length;
		const res = await signIn((c) => ({ ...c, preferred_username: "OwnerName", nickname: "The Owner", picture: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png" }));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
		const session = sessionOf(res) as string;
		for (const part of ["HttpOnly", "SameSite=Strict", "Path=/", "Secure"]) expect(session).toContain(part);
		// The state cookie is spent.
		expect(res.headers.getSetCookie().find((c) => c.startsWith("tt_oauth="))).toContain("Max-Age=0");
		const sent = roblox.tokenRequests[before] as URLSearchParams;
		expect(sent.get("client_secret")).toBe(CLIENT_SECRET);
		expect(sent.get("code_verifier")?.length).toBeGreaterThanOrEqual(43);
		expect(sent.get("grant_type")).toBe("authorization_code");
		// Same session as the token login: it works on admin routes, with who is signed in.
		const cookie = session.split(";")[0] as string;
		const check = await asJson(await h.call("/v1/auth/check", { headers: { cookie } }));
		expect(check).toMatchObject({ ok: true, role: "admin", via: "cookie", user: { kind: "roblox", userId: OWNER, name: "OwnerName", displayName: "The Owner", avatar: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png" } });
		expect((await h.call("/v1/queries", { headers: { cookie } })).status).toBe(200);
		// Roblox's own tokens are not kept anywhere: not in the session, not in the log.
		expect(JSON.stringify(check)).not.toContain("never-kept");
		expect(h.logs.join("\n")).not.toContain("never-kept");
		expect(h.logs.join("\n")).not.toContain(CLIENT_SECRET);
	});

	test("discovery and the signing keys are fetched once and cached", () => {
		expect(roblox.calls.discovery).toBe(1);
		expect(roblox.calls.jwks).toBe(1);
	});

	test("an avatar that is not on Roblox's CDN is dropped; with no username the display name is the name", async () => {
		const res = await signIn((c) => ({ ...c, nickname: "Only Display", picture: "https://evil.example/track.png" }));
		const check = await asJson(await h.call("/v1/auth/check", { headers: { cookie: (sessionOf(res) as string).split(";")[0] as string } }));
		expect(check.user).toEqual({ kind: "roblox", userId: OWNER, name: "Only Display" });
	});

	test("a user who is not an owner is refused with a plain reason and gets no session", async () => {
		const res = await signIn((c) => ({ ...c, sub: String(OTHER) }));
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/?login_error=not_owner");
		expect(sessionOf(res)).toBeUndefined();
		expect(h.logs.some((l) => l.includes("not an owner") && l.includes(String(OTHER)))).toBe(true);
	});

	test("bad state: no cookie, a different cookie, an unknown state, a replay", async () => {
		const s = await start();
		const code = roblox.approve(s.authorizeUrl);
		const noCookie = await callback({ code, state: s.state });
		expect(noCookie.headers.get("location")).toBe("/?login_error=state");
		expect(sessionOf(noCookie)).toBeUndefined();
		// The state was spent by that attempt; even the right cookie can't use it now.
		const spent = await callback({ code, state: s.state }, s.cookie);
		expect(spent.headers.get("location")).toBe("/?login_error=state");
		const other = await start();
		const code2 = roblox.approve(other.authorizeUrl);
		const mismatch = await callback({ code: code2, state: other.state }, s.cookie);
		expect(mismatch.headers.get("location")).toBe("/?login_error=state");
		const forged = await callback({ code: code2, state: "forged-state-0123456789-0123456789-0123456789" }, "tt_oauth=forged-state-0123456789-0123456789-0123456789");
		expect(forged.headers.get("location")).toBe("/?login_error=state");
		expect((await callback({ code: code2 }, other.cookie)).headers.get("location")).toBe("/?login_error=state");
		// Replaying a finished sign-in fails the same way.
		const done = await start();
		const code3 = roblox.approve(done.authorizeUrl);
		expect(sessionOf(await callback({ code: code3, state: done.state }, done.cookie))).toBeDefined();
		const replay = await callback({ code: code3, state: done.state }, done.cookie);
		expect(replay.headers.get("location")).toBe("/?login_error=state");
		expect(sessionOf(replay)).toBeUndefined();
	});

	test("a state older than 10 minutes is refused", async () => {
		const s = await start();
		const code = roblox.approve(s.authorizeUrl);
		const start0 = h.now();
		h.setNow(start0 + 11 * 60_000);
		try {
			expect((await callback({ code, state: s.state }, s.cookie)).headers.get("location")).toBe("/?login_error=state");
		} finally {
			h.setNow(start0);
		}
	});

	test("ID token checks: nonce, audience, issuer, expiry, signature, algorithm, missing user id", async () => {
		const failed = async (res: Response) => {
			expect(res.headers.get("location")).toBe("/?login_error=failed");
			expect(sessionOf(res)).toBeUndefined();
		};
		await failed(await signIn((c) => ({ ...c, nonce: "another-nonce" })));
		await failed(await signIn((c) => ({ ...c, aud: "someone-elses-client-id" })));
		await failed(await signIn((c) => ({ ...c, aud: ["x", "y"] })));
		await failed(await signIn((c) => ({ ...c, iss: "https://evil.example/" })));
		await failed(await signIn((c) => ({ ...c, exp: Math.floor(T0 / 1000) - 3600 })));
		await failed(await signIn((c) => ({ ...c, exp: undefined })));
		await failed(await signIn((c) => ({ ...c, iat: Math.floor(T0 / 1000) + 3600 })));
		await failed(await signIn((c) => ({ ...c, sub: "not-a-number" })));
		await failed(await signIn((c) => ({ ...c, sub: undefined })));
		// Signed by a key that is not in Roblox's key set.
		const rogue = await makeKey("key-1");
		await failed(await signIn(undefined, { signer: rogue }));
		const rogueOtherKid = await makeKey("unknown-kid");
		await failed(await signIn(undefined, { signer: rogueOtherKid }));
		// Algorithms other than ES256 / RS256 are never accepted.
		const s = await start();
		const code = roblox.approve(s.authorizeUrl, undefined, { header: { alg: "none" } });
		await failed(await callback({ code, state: s.state }, s.cookie));
		const t = await start();
		const hs = roblox.approve(t.authorizeUrl, undefined, { header: { alg: "HS256" } });
		await failed(await callback({ code: hs, state: t.state }, t.cookie));
		// A code the token endpoint doesn't know, and a failing token endpoint.
		const u = await start();
		await failed(await callback({ code: "made-up-code", state: u.state }, u.cookie));
		const v = await start();
		await failed(await callback({ state: v.state }, v.cookie));
		// Nothing above made a session.
		expect(h.logs.some((l) => l.includes("ID token nonce"))).toBe(true);
		expect(h.logs.some((l) => l.includes("audience"))).toBe(true);
		expect(h.logs.join("\n")).not.toContain(CLIENT_SECRET);
	});

	test("an unknown key id makes one refetch of the key set, and a rotated key then works", async () => {
		const before = roblox.calls.jwks;
		roblox.keys = [await makeKey("key-1"), await makeKey("key-2")];
		const rotated = roblox.keys[1] as TestKey;
		// key-2 appeared after the cache was filled: the refetch finds it.
		h.setNow(h.now() + 120_000); // the refetch guard is a minute
		const res = await signIn(undefined, { signer: rotated });
		h.setNow(h.now() - 120_000);
		expect(sessionOf(res)).toBeDefined();
		expect(roblox.calls.jwks).toBe(before + 1);
	});

	test("Roblox answering with an error, or the user cancelling, shows a plain reason", async () => {
		const s = await start();
		const denied = await callback({ error: "access_denied", state: s.state }, s.cookie);
		expect(denied.headers.get("location")).toBe("/?login_error=denied");
		const t = await start();
		const failed = await callback({ error: "server_error", state: t.state }, t.cookie);
		expect(failed.headers.get("location")).toBe("/?login_error=failed");
		for (const r of [denied, failed]) expect(sessionOf(r)).toBeUndefined();
	});

	test("start and callback are rate limited per address", async () => {
		const ip = "198.51.100.200";
		let limited = 0;
		for (let i = 0; i < 25; i++) if ((await h.call("/v1/auth/roblox/start", { ip })).status === 429) limited++;
		expect(limited).toBeGreaterThanOrEqual(5);
		let blocked = 0;
		for (let i = 0; i < 25; i++) if ((await callback({ error: "access_denied", state: "x" }, "tt_oauth=x", ip)).status === 429) blocked++;
		expect(blocked).toBeGreaterThanOrEqual(5);
		// Another address is not affected.
		expect((await h.call("/v1/auth/roblox/start", { ip: "198.51.100.201" })).status).toBe(302);
	});

	test("an owner removed from the list loses a live session at once; one never listed gets none", async () => {
		expect((await putAccess(5, [OWNER, 3003])).status).toBe(200);
		const res = await signIn();
		const cookie = (sessionOf(res) as string).split(";")[0] as string;
		const token = (await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" } })).headers.getSetCookie().find((c) => c.startsWith("tt_session=")) as string;
		const tokenCookie = token.split(";")[0] as string;
		expect((await h.call("/v1/queries", { headers: { cookie } })).status).toBe(200);
		const sessionsBefore = h.app.sessionCount();
		// The owner list changes: OWNER is gone.
		const changed = await putAccess(6, [3003]);
		expect(changed.status).toBe(200);
		expect(await asJson(changed)).toMatchObject({ seq: 6, owners: [3003], changed: true, sessionsEnded: expect.any(Number) });
		expect((await h.call("/v1/queries", { headers: { cookie } })).status).toBe(401);
		expect(h.app.sessionCount()).toBeLessThan(sessionsBefore);
		// A token-login session is not an owner's and stays.
		expect((await h.call("/v1/queries", { headers: { cookie: tokenCookie } })).status).toBe(200);
		// Signing in again is refused.
		expect((await signIn()).headers.get("location")).toBe("/?login_error=not_owner");
		// Back on the list: a new sign-in works.
		expect((await putAccess(7, [OWNER])).status).toBe(200);
		expect(sessionOf(await signIn())).toBeDefined();
	});

	test("the owner list: admin token only, ordered seq, validated, readable, kept across a restart", async () => {
		// Not with the API key, not with a session (even an owner's), only the admin token.
		expect((await putAccess(10, [1], bearer(API))).status).toBe(401);
		expect((await putAccess(10, [1], {})).status).toBe(401);
		const login = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" } });
		const cookie = (login.headers.getSetCookie().find((c) => c.startsWith("tt_session=")) as string).split(";")[0] as string;
		const viaCookie = await putAccess(10, [1], { cookie, "x-typetorch": "1" });
		expect(viaCookie.status).toBe(403);
		expect((await asJson(viaCookie)).error).toContain("admin token");
		// Ordered: a lower seq is refused, the same seq only with the same list.
		expect((await putAccess(10, [OWNER, 77])).status).toBe(200);
		const stale = await putAccess(9, [OWNER]);
		expect(stale.status).toBe(409);
		expect(await asJson(stale)).toMatchObject({ seq: 10 });
		expect((await putAccess(10, [OWNER])).status).toBe(409);
		const same = await putAccess(10, [77, OWNER, OWNER]);
		expect(same.status).toBe(200);
		expect(await asJson(same)).toMatchObject({ seq: 10, owners: [77, OWNER], changed: false });
		// Validation.
		for (const bad of [{}, { seq: -1, owners: [] }, { seq: 1.5, owners: [] }, { seq: "1", owners: [] }, { seq: 11, owners: "x" }, { seq: 11, owners: [0] }, { seq: 11, owners: [-5] }, { seq: 11, owners: ["abc"] }, { seq: 11, owners: [1.5] }, { seq: 11, owners: new Array(201).fill(1).map((_, i) => i + 1) }]) {
			const r = await h.call("/v1/access", { method: "PUT", body: JSON.stringify(bad), headers: { "content-type": "application/json", ...bearer(ADMIN) } });
			expect([JSON.stringify(bad).slice(0, 40), r.status]).toEqual([JSON.stringify(bad).slice(0, 40), 400]);
		}
		expect((await h.call("/v1/access", { method: "PUT", body: "{nope", headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/access", { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(405);
		// Reading: the admin token or a session.
		expect(await asJson(await h.call("/v1/access", { headers: bearer(ADMIN) }))).toMatchObject({ seq: 10, owners: [77, OWNER] });
		expect((await h.call("/v1/access", { headers: { cookie } })).status).toBe(200);
		expect((await h.call("/v1/access", { headers: bearer(API) })).status).toBe(401);
		// A string UserId is taken as a number.
		expect((await putAccess(11, ["1001" as never, 5])).status).toBe(200);
		expect((await asJson(await h.call("/v1/access", { headers: bearer(ADMIN) }))).owners).toEqual([5, 1001]);
		// It survives a restart (the file is in the data folder).
		expect(existsSync(join(h.dir, "access.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(h.dir, "access.json"), "utf8"))).toMatchObject({ seq: 11, owners: [5, 1001] });
		const again = await startApp(loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: h.dir, PORT: "0", TYPETORCH_PARTS: "fleet", TYPETORCH_EXPLORER: "off", ...env }), { manualJobs: true, log: () => {}, fetch: roblox.fetch });
		try {
			expect(again.access.get()).toMatchObject({ seq: 11, owners: [5, 1001] });
			expect(again.access.isOwner(1001)).toBe(true);
			expect(again.access.isOwner(OTHER)).toBe(false);
		} finally {
			await again.stop().catch(() => {});
		}
	});
});

describe("Sign in with Roblox is off without its settings", () => {
	test("no client id or secret: the button is hidden and the routes say so", async () => {
		const h = await harness();
		try {
			expect((await asJson(await h.call("/v1/auth/check"))).login).toEqual({ token: true, roblox: false });
			expect((await h.call("/v1/auth/roblox/start")).status).toBe(404);
			expect((await h.call("/v1/auth/roblox/callback?code=x&state=y")).status).toBe(404);
		} finally {
			await h.close();
		}
	});

	test("only one of the two, or no public URL, keeps it off and says why", async () => {
		const only = loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, ROBLOX_OAUTH_CLIENT_ID: CLIENT_ID, TYPETORCH_PUBLIC_URL: PUBLIC, TYPETORCH_EXPLORER: "off" });
		expect(only.robloxOAuth).toBeUndefined();
		expect(only.warnings.join("\n")).toContain("ROBLOX_OAUTH_CLIENT_SECRET");
		const noUrl = loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, ROBLOX_OAUTH_CLIENT_ID: CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET: CLIENT_SECRET, TYPETORCH_EXPLORER: "off" });
		expect(noUrl.robloxOAuth).toBeUndefined();
		expect(noUrl.warnings.join("\n")).toContain("TYPETORCH_PUBLIC_URL");
		expect(noUrl.warnings.join("\n")).not.toContain(CLIENT_SECRET);
		const on = loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, ROBLOX_OAUTH_CLIENT_ID: CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET: CLIENT_SECRET, TYPETORCH_PUBLIC_URL: PUBLIC, TYPETORCH_EXPLORER: "off" });
		expect(on.robloxOAuth).toEqual({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
	});

	test("an unreachable Roblox sends the user back with a plain reason, not a stack", async () => {
		const broken = (async () => {
			throw new Error("getaddrinfo ENOTFOUND apis.roblox.com");
		}) as unknown as typeof fetch;
		const h = await harness({ ROBLOX_OAUTH_CLIENT_ID: CLIENT_ID, ROBLOX_OAUTH_CLIENT_SECRET: CLIENT_SECRET, TYPETORCH_PUBLIC_URL: PUBLIC }, { fetch: broken });
		try {
			const res = await h.call("/v1/auth/roblox/start");
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toBe("/?login_error=failed");
			expect(res.headers.getSetCookie()).toEqual([]);
		} finally {
			await h.close();
		}
	});
});
