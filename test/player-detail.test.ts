/**
 * The Players page's player detail: GET /v1/identity/<pid>/profile (the server looks the UserId up on Roblox's public APIs,
 * through a fake fetch here) and the player-stats query over HTTP. Roles, bounds, empty data, unlinked pids, Roblox
 * failures and timeouts. All tokens, UserIds and names are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ROBLOX_HEADSHOT_URL, ROBLOX_USERS_URL, RobloxProfiles } from "../src/server/roblox-profiles.ts";
import { ADMIN, API, T0, asJson, bearer, cookieOf, harness, json, type Harness } from "./harness.ts";

const XT = { "x-typetorch": "1" };
const LINKED = "pid-linked-0001";
const FAILING = "pid-failing-002";
const MISSING = "pid-missing-003";
const UNLINKED = "pid-unlinked-04";
const UID = 31_337;
const UID_FAILING = 42_042;
const UID_MISSING = 77_077;

/** A fake Roblox: users and headshots per UserId; `down` UserIds fail; every URL asked is recorded. */
function fakeRoblox(calls: string[], down: Set<number>) {
	return (async (input: string | URL | Request) => {
		const url = String(input);
		calls.push(url);
		const id = Number(/\/users\/(\d+)$/.exec(url)?.[1] ?? /userIds=(\d+)/.exec(url)?.[1]);
		if (down.has(id)) return new Response("upstream down", { status: 503 });
		if (url.startsWith(ROBLOX_USERS_URL)) {
			if (id === UID_MISSING) return new Response(JSON.stringify({ errors: [{ code: 3, message: "The user id is invalid." }] }), { status: 404 });
			return new Response(JSON.stringify({ id, name: `builder_${id}`, displayName: `Builder ${id}`, isBanned: false }), { status: 200 });
		}
		if (url.startsWith(ROBLOX_HEADSHOT_URL)) {
			return new Response(JSON.stringify({ data: [{ targetId: id, state: "Completed", imageUrl: `https://tr.rbxcdn.com/30DAY-AvatarHeadshot-${id}/150/150/AvatarHeadshot/Png/noFilter` }] }), { status: 200 });
		}
		return new Response("{}", { status: 404 });
	}) as typeof fetch;
}

const ev = (pid: string, sid: string, t: number, kind: string, name: string, props?: object) => ({
	v: 1,
	t,
	kind,
	name,
	pid,
	sid,
	job: "job-1",
	srv: "public",
	place: 1,
	art: "a1b2c3d-000001",
	seq: 1,
	branch: "prod",
	channel: "prod",
	dev: "phone",
	newp: sid === "s1",
	state: "zone:Lobby",
	exp: "{}",
	sexp: "",
	src: "server",
	...(props ? { props: JSON.stringify(props) } : {}),
});

describe("GET /v1/identity/<pid>/profile", () => {
	let h: Harness;
	const calls: string[] = [];
	const down = new Set<number>([UID_FAILING]);

	beforeAll(async () => {
		h = await harness({}, { fetch: fakeRoblox(calls, down) });
		const r = await h.call("/v1/identity", {
			method: "POST",
			...json({ identities: [{ pid: LINKED, uid: UID }, { pid: FAILING, uid: UID_FAILING }, { pid: MISSING, uid: UID_MISSING }] }),
			headers: { "content-type": "application/json", ...bearer(API) },
		});
		expect(r.status).toBe(202);
	});
	afterAll(() => h.close());

	const profile = (pid: string, init: RequestInit & { ip?: string } = { headers: bearer(ADMIN) }) => h.call(`/v1/identity/${pid}/profile`, init);

	test("admin only: no credentials and the API key get 401; a session cookie works for this GET", async () => {
		expect((await profile(LINKED, {})).status).toBe(401);
		expect((await profile(LINKED, { headers: bearer(API) })).status).toBe(401);
		const login = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", ...XT } });
		const cookie = cookieOf(login);
		expect(cookie).toBeDefined();
		expect((await profile(UNLINKED, { headers: { cookie: cookie as string } })).status).toBe(200);
		expect((await profile(LINKED, { method: "POST", headers: bearer(ADMIN) })).status).toBe(405);
		// Through the explorer's /api prefix too.
		expect((await h.call(`/api/v1/identity/${UNLINKED}/profile`, { headers: bearer(ADMIN) })).status).toBe(200);
	});

	test("a bad pid is refused before any lookup", async () => {
		const before = calls.length;
		expect((await profile("bad%20pid")).status).toBe(400);
		expect((await profile("x".repeat(65))).status).toBe(400);
		expect((await profile("a.b")).status).toBe(400);
		expect(calls.length).toBe(before);
	});

	test("a pid without a UserId: linked false, and Roblox is not asked", async () => {
		const before = calls.length;
		const r = await profile(UNLINKED);
		expect(r.status).toBe(200);
		expect(await r.json()).toEqual({ pid: UNLINKED, linked: false });
		expect(calls.length).toBe(before);
	});

	test("a linked pid: UserId, username, display name, avatar from the two fixed Roblox hosts; then from memory", async () => {
		const before = calls.length;
		const first = await asJson(await profile(LINKED));
		expect(first).toEqual({
			pid: LINKED,
			linked: true,
			uid: UID,
			roblox: "ok",
			cached: false,
			name: `builder_${UID}`,
			displayName: `Builder ${UID}`,
			avatar: `https://tr.rbxcdn.com/30DAY-AvatarHeadshot-${UID}/150/150/AvatarHeadshot/Png/noFilter`,
		});
		const asked = calls.slice(before);
		expect(asked.sort()).toEqual([`${ROBLOX_HEADSHOT_URL}?userIds=${UID}&size=150x150&format=Png&isCircular=false`, `${ROBLOX_USERS_URL}${UID}`].sort());
		const second = await asJson(await profile(LINKED));
		expect(second).toMatchObject({ roblox: "ok", cached: true, name: `builder_${UID}` });
		expect(calls.length).toBe(before + 2);
	});

	test("Roblox failing: the UserId still comes back, names null; the failure is remembered briefly", async () => {
		const r = await asJson(await profile(FAILING));
		expect(r).toEqual({ pid: FAILING, linked: true, uid: UID_FAILING, roblox: "unavailable", cached: false, name: null, displayName: null, avatar: null });
		const before = calls.length;
		expect(await asJson(await profile(FAILING))).toMatchObject({ roblox: "unavailable", cached: true });
		expect(calls.length).toBe(before);
		// After the short failure TTL it asks again; Roblox is back.
		down.delete(UID_FAILING);
		h.setNow(h.now() + 61_000);
		expect(await asJson(await profile(FAILING))).toMatchObject({ roblox: "ok", cached: false, name: `builder_${UID_FAILING}` });
	});

	test("an unknown UserId on Roblox: not-found", async () => {
		expect(await asJson(await profile(MISSING))).toMatchObject({ linked: true, uid: UID_MISSING, roblox: "not-found", name: null, avatar: null });
	});

	test("rate limited per address", async () => {
		let last = 0;
		for (let i = 0; i < 125; i++) last = (await profile(UNLINKED, { headers: bearer(ADMIN), ip: "203.0.113.9" })).status;
		expect(last).toBe(429);
		expect((await profile(UNLINKED, { headers: bearer(ADMIN), ip: "203.0.113.10" })).status).toBe(200);
	});

	test("no secret or token in the answer", async () => {
		const text = await (await profile(LINKED)).text();
		expect(text).not.toContain(ADMIN);
		expect(text).not.toContain(API);
	});
});

describe("RobloxProfiles (the lookup behind it)", () => {
	const ok = (id: number, extra: Record<string, unknown> = {}) =>
		(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith(ROBLOX_USERS_URL)) return new Response(JSON.stringify({ id, name: "someone", displayName: "Some One", ...extra }));
			return new Response(JSON.stringify({ data: [{ targetId: id, state: "Completed", imageUrl: "https://tr.rbxcdn.com/abc/150/150/AvatarHeadshot/Png/noFilter" }] }));
		}) as typeof fetch;

	test("timeouts: a Roblox that never answers gives unavailable within the timeout", async () => {
		const hang = ((_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))))) as typeof fetch;
		const profiles = new RobloxProfiles({ fetch: hang, timeoutMs: 30 });
		const started = Date.now();
		const r = await profiles.get(5);
		expect(r).toEqual({ profile: { userId: 5, name: null, displayName: null, avatar: null }, status: "unavailable", cached: false });
		expect(Date.now() - started).toBeLessThan(2000);
	});

	test("only https avatars on Roblox's CDN; odd usernames and control characters are dropped; ids must match", async () => {
		const evil = (async (input: string | URL | Request) => {
			const url = String(input);
			if (url.startsWith(ROBLOX_USERS_URL)) return new Response(JSON.stringify({ id: 9, name: "<script>", displayName: "Hi\u0000‮ there" }));
			return new Response(JSON.stringify({ data: [{ targetId: 9, state: "Completed", imageUrl: "https://evil.example/x.png" }] }));
		}) as typeof fetch;
		const r = await new RobloxProfiles({ fetch: evil }).get(9);
		expect(r.profile).toEqual({ userId: 9, name: null, displayName: "Hi there", avatar: null });
		const http = (async (input: string | URL | Request) =>
			String(input).startsWith(ROBLOX_USERS_URL)
				? new Response(JSON.stringify({ id: 10, name: "ten" }))
				: new Response(JSON.stringify({ data: [{ targetId: 10, state: "Completed", imageUrl: "http://tr.rbxcdn.com/x" }] }))) as typeof fetch;
		expect((await new RobloxProfiles({ fetch: http }).get(10)).profile.avatar).toBeNull();
		// Someone else's record (wrong id) is not taken.
		expect((await new RobloxProfiles({ fetch: ok(11) }).get(12)).status).toBe("unavailable");
	});

	test("bodies over the cap and redirects count as failures", async () => {
		const huge = (async (_input: string | URL | Request) => new Response("x".repeat(70 * 1024))) as typeof fetch;
		expect((await new RobloxProfiles({ fetch: huge }).get(3)).status).toBe("unavailable");
		const seen: RequestInit[] = [];
		const watch = (async (_input: string | URL | Request, init?: RequestInit) => {
			seen.push(init ?? {});
			return new Response("{}", { status: 302, headers: { location: "https://evil.example/" } });
		}) as typeof fetch;
		expect((await new RobloxProfiles({ fetch: watch }).get(4)).status).toBe("unavailable");
		expect(seen.every((i) => i.redirect === "error" && i.signal !== undefined)).toBe(true);
	});

	test("a pending headshot is partial and asked again soon; an older good answer is served while Roblox is down", async () => {
		let now = T0;
		let mode: "pending" | "ok" | "down" = "pending";
		let calls = 0;
		const f = (async (input: string | URL | Request) => {
			calls++;
			if (mode === "down") throw new Error("network down");
			const url = String(input);
			if (url.startsWith(ROBLOX_USERS_URL)) return new Response(JSON.stringify({ id: 7, name: "seven", displayName: "Seven" }));
			return new Response(JSON.stringify({ data: [{ targetId: 7, state: mode === "pending" ? "Pending" : "Completed", imageUrl: mode === "pending" ? "" : "https://tr.rbxcdn.com/seven" }] }));
		}) as typeof fetch;
		const profiles = new RobloxProfiles({ fetch: f, clock: () => now, ttlMs: 3_600_000, failTtlMs: 60_000 });
		expect(await profiles.get(7)).toMatchObject({ status: "partial", profile: { name: "seven", avatar: null } });
		mode = "ok";
		now += 61_000;
		expect(await profiles.get(7)).toMatchObject({ status: "ok", cached: false, profile: { avatar: "https://tr.rbxcdn.com/seven" } });
		mode = "down";
		now += 3_600_001;
		expect(await profiles.get(7)).toMatchObject({ status: "ok", cached: true, profile: { name: "seven" } });
		const before = calls;
		expect(await profiles.get(7)).toMatchObject({ status: "ok", cached: true });
		expect(calls).toBe(before);
	});

	test("bounded: oldest UserIds go past maxEntries; lookups a minute are capped; one lookup per UserId at a time", async () => {
		let calls = 0;
		const counting = (async (input: string | URL | Request) => {
			calls++;
			return ok(Number(/(\d+)(?:&|$)/.exec(String(input))?.[1]))(input);
		}) as typeof fetch;
		const small = new RobloxProfiles({ fetch: counting, maxEntries: 3 });
		for (const id of [1, 2, 3, 4]) await small.get(id);
		expect(small.size).toBe(3);
		calls = 0;
		await small.get(1);
		expect(calls).toBe(2);
		const capped = new RobloxProfiles({ fetch: counting, perMinute: 2 });
		await capped.get(21);
		await capped.get(22);
		calls = 0;
		expect(await capped.get(23)).toMatchObject({ status: "unavailable", cached: false });
		expect(calls).toBe(0);
		const once = new RobloxProfiles({ fetch: counting });
		calls = 0;
		const [a, b] = await Promise.all([once.get(31), once.get(31)]);
		expect(a.status).toBe("ok");
		expect(b.status).toBe("ok");
		expect(calls).toBe(2);
		expect(() => once.get(-1)).toThrow();
	});
});

describe("player-stats over HTTP", () => {
	let h: Harness;
	const PID = "pid-stats-0001";
	const t = T0 - 3 * 3_600_000;

	beforeAll(async () => {
		h = await harness({}, { fetch: fakeRoblox([], new Set()) });
		const events = [
			ev(PID, "s1", t, "session", "join"),
			ev(PID, "s1", t + 60_000, "purchase", "product", { product: 1234, robux: 99, where: "shop" }),
			ev(PID, "s1", t + 600_000, "session", "leave", { secs: 600, why: "left" }),
			ev(PID, "s2", t + 3_600_000, "session", "join"),
			ev(PID, "s2", t + 3_900_000, "session", "leave", { secs: 300, why: "left" }),
		];
		const r = await h.call("/v1/ingest", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ events, identities: [{ pid: PID, uid: UID, t }] }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(r.status).toBe(202);
		expect(await r.json()).toMatchObject({ accepted: 5, rejected: 0 });
		await h.app.load();
	});
	afterAll(() => h.close());

	const stats = (body: unknown, headers: Record<string, string> = bearer(ADMIN)) =>
		h.call("/v1/query/player-stats", { method: "POST", ...json(body), headers: { "content-type": "application/json", ...headers } });

	test("admin only", async () => {
		expect((await stats({ options: { pid: PID } }, {})).status).toBe(401);
		expect((await stats({ options: { pid: PID } }, bearer(API))).status).toBe(401);
	});

	test("today's range (hourly), by pid or by UserId; the result carries the UserId", async () => {
		const today = new Date(T0).toISOString().slice(0, 10);
		const r = await asJson(await stats({ filters: { from: today }, options: { pid: PID } }));
		expect(r.result).toMatchObject({ pid: PID, uid: UID, window: { bucket: "hour", days: 1 } });
		expect(r.result.totals).toMatchObject({ sessions: 2, playtimeMinutes: 15, avgSessionMinutes: 7.5, medianSessionMinutes: 7.5, robux: 99, purchases: 1, activeDays: 1 });
		expect(r.result.series.length).toBe(12);
		expect(r.result.purchases).toEqual([{ time: new Date(t + 60_000).toISOString(), t: t + 60_000, kind: "product", product: "1234", robux: 99, where: "shop", sid: "s1" }]);
		expect(r.result.sessions.map((s: { sid: string; minutes: number }) => [s.sid, s.minutes])).toEqual([
			["s2", 5],
			["s1", 10],
		]);
		const byUid = await asJson(await stats({ filters: { from: today }, options: { uid: String(UID) } }));
		expect(byUid.result.pid).toBe(PID);
	});

	test("bounds and bad input: 400; an unknown UserId: 404 with a plain message", async () => {
		expect((await stats({ options: {} })).status).toBe(400);
		expect((await stats({ options: { pid: "x' OR 1=1 --" } })).status).toBe(400);
		expect((await stats({ options: { pid: PID, sessions: 100_000 } })).status).toBe(400);
		expect((await stats({ filters: { from: "2026-10-09", to: "2026-10-01" }, options: { pid: PID } })).status).toBe(400);
		const unknown = await stats({ options: { uid: 999 } });
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ error: "no pid known for UserId 999" });
		const wide = await asJson(await stats({ filters: { from: "2020-01-01" }, options: { pid: PID } }));
		expect(wide.result.window.clamped).toBe(true);
	});

	test("a pid with no rows in the range: zeros, no error", async () => {
		const r = await asJson(await stats({ filters: { from: "2026-09-01", to: "2026-09-07" }, options: { pid: "pid-nobody-0001" } }));
		expect(r.result.totals).toMatchObject({ sessions: 0, robux: 0, firstSeen: null });
		expect(r.result.series.length).toBe(7);
		expect(r.result.uid).toBeUndefined();
	});
});
