/**
 * The read-only `web` role: the web token (a Bearer, or the explorer's token login) reads everything the explorer shows
 * and is refused (403) on everything that changes something or is for owners. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API, T0, asJson, bearer, cookieOf, harness, json, post, type Harness } from "./harness.ts";

const WEB = "web-token-for-tests-0123456789abcdef0123";
const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };
const JOB = "web-role-job-1";

describe("the web role", () => {
	let h: Harness;
	const web = bearer(WEB);
	const login = (token: string) => h.call("/v1/auth/login", { method: "POST", ...json({ token }), headers: { ...JSON_TYPE, ...XT } });

	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_TOKEN: WEB });
		// One live server, so the fleet routes have something to show.
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: JOB, pv: 1, players: 3, tps: 60, mem: 100, up: 10 }))).status).toBe(202);
	});
	afterAll(() => h.close());

	test("the config refuses a web token that equals the admin token or the API key, or is short", () => {
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off" };
		expect(() => loadConfig([], { ...base, TYPETORCH_WEB_TOKEN: ADMIN })).toThrow(/TYPETORCH_WEB_TOKEN must differ from TYPETORCH_ADMIN_TOKEN/);
		expect(() => loadConfig([], { ...base, TYPETORCH_WEB_TOKEN: API })).toThrow(/equals TYPETORCH_WEB_TOKEN/);
		expect(() => loadConfig([], { ...base, TYPETORCH_WEB_TOKEN: "short" })).toThrow(/TYPETORCH_WEB_TOKEN must be at least 32/);
		expect(() => loadConfig([], { ...base, TYPETORCH_WEB_VIEWERS: "12, abc" })).toThrow(/TYPETORCH_WEB_VIEWERS: entries are Roblox UserIds/);
		const config = loadConfig([], { ...base, TYPETORCH_WEB_TOKEN: WEB, TYPETORCH_WEB_VIEWERS: "30, 10,10 20" });
		expect(config.webToken).toBe(WEB);
		expect(config.webViewers).toEqual([10, 20, 30]);
		// Without the variable there is no web token and nobody is a viewer.
		const none = loadConfig([], base);
		expect(none.webToken).toBeUndefined();
		expect(none.webViewers).toEqual([]);
	});

	test("GET /v1/auth/check says role web for the token; the login makes a web session; sign-out ends it", async () => {
		expect(await asJson(await h.call("/v1/auth/check", { headers: web }))).toMatchObject({ ok: true, role: "web", via: "bearer", user: { kind: "token" } });
		const res = await login(WEB);
		expect(res.status).toBe(200);
		expect(await asJson(res)).toMatchObject({ ok: true, role: "web", via: "cookie", user: { kind: "token" } });
		const cookie = cookieOf(res) as string;
		expect(await asJson(await h.call("/v1/auth/check", { headers: { cookie } }))).toMatchObject({ role: "web", via: "cookie" });
		expect((await h.call("/v1/queries", { headers: { cookie } })).status).toBe(200);
		expect((await h.call("/v1/auth/logout", { method: "POST", headers: { cookie, ...XT } })).status).toBe(200);
		expect((await h.call("/v1/queries", { headers: { cookie } })).status).toBe(401);
		// The admin token still logs in as admin: the same box, the backend tells them apart.
		expect(await asJson(await login(ADMIN))).toMatchObject({ role: "admin" });
	});

	test("reads work: queries, SQL, storage, identity, errors, the live stream, fleet lists and a server's view", async () => {
		expect((await h.call("/v1/queries", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/settings", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/identity", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/errors", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/fleet/servers", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/fleet/alerts", { headers: web })).status).toBe(200);
		expect(await asJson(await h.call(`/v1/fleet/servers/${JOB}`, { headers: web }))).toMatchObject({ state: "live", debug: { watched: false } });
		expect((await h.call("/v1/fleet/debug/audit", { headers: web })).status).toBe(200);
		expect((await h.call(`/v1/fleet/servers/${JOB}/commands/nope`, { headers: web })).status).toBe(404);
		expect((await h.call("/v1/storage", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/rollups/daily?from=2026-10-01&to=2026-10-09", { headers: web })).status).toBe(200);
		expect((await h.call("/v1/query/overview", { ...post(WEB, { filters: { from: T0 - 86_400_000, to: T0 } }) })).status).toBe(200);
		expect((await h.call("/v1/sql", { ...post(WEB, { sql: "select 1 as one" }) })).status).toBe(200);
		// The live stream opens (and is closed here at once).
		const live = await h.call("/v1/live", { headers: web });
		expect(live.status).toBe(200);
		await live.body?.cancel();
	});

	test("changes and owner routes answer 403 read-only, for the Bearer and for a web session", async () => {
		const cookie = cookieOf(await login(WEB)) as string;
		const session = { cookie, ...XT, origin: "http://backend.test" };
		const refused = async (path: string, init: RequestInit) => {
			for (const headers of [web, session]) {
				const res = await h.call(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...headers } });
				expect(`${path} ${res.status}`).toBe(`${path} 403`);
				expect((await asJson(res)).error).toContain("read-only");
			}
		};
		await refused("/v1/admin/settings", {});
		await refused("/v1/admin/settings", { method: "PATCH", ...json({ ipPerMinute: 5000 }), headers: JSON_TYPE });
		await refused("/v1/admin/settings/test-alert", { method: "POST" });
		await refused("/v1/access", {});
		await refused("/v1/access", { method: "PUT", ...json({ seq: 1, owners: [1] }), headers: JSON_TYPE });
		await refused("/v1/identity/backfill", { method: "POST", ...json({}), headers: JSON_TYPE });
		await refused("/v1/fleet/alerts/1/ack", { method: "POST", ...json({}), headers: JSON_TYPE });
		await refused(`/v1/fleet/servers/${JOB}/watch`, { method: "POST" });
		await refused(`/v1/fleet/servers/${JOB}/commands`, { method: "POST", ...json({ op: "status" }), headers: JSON_TYPE });
		await refused("/v1/erasure", { method: "POST", ...json({ pid: "p1" }), headers: JSON_TYPE });
		// Nothing changed: no watch was opened, the settings are untouched.
		expect(await asJson(await h.call(`/v1/fleet/servers/${JOB}`, { headers: web }))).toMatchObject({ debug: { watched: false } });
		expect((await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }))).settings.find((s: { key: string }) => s.key === "ipPerMinute")).toMatchObject({ source: "default" });
		// /healthz gives the web role the plain answer, not the admin view.
		expect(await asJson(await h.call("/healthz", { headers: web }))).toEqual({ ok: true });
	});

	test("a web session still needs the X-TypeTorch header on a change (it is refused by the role either way)", async () => {
		const cookie = cookieOf(await login(WEB)) as string;
		const res = await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...json({}), headers: { ...JSON_TYPE, cookie } });
		expect(res.status).toBe(403);
		expect((await asJson(res)).error).toContain("x-typetorch");
	});

	test("the token login off (the setting) refuses the web token too; the Bearer still works", async () => {
		// The guard: only a Roblox session on a server with Roblox sign-in may turn it off; this harness has neither, so
		// the environment turns it off instead.
		const off = await harness({ TYPETORCH_WEB_TOKEN: WEB, TYPETORCH_PARTS: "fleet", TYPETORCH_TOKEN_LOGIN: "off" });
		try {
			expect((await off.call("/v1/auth/login", { method: "POST", ...json({ token: WEB }), headers: { ...JSON_TYPE, ...XT } })).status).toBe(404);
			expect(await asJson(await off.call("/v1/auth/check", { headers: web }))).toMatchObject({ role: "web" });
			expect((await off.call("/v1/queries", { headers: web })).status).toBe(200);
		} finally {
			await off.close();
		}
	});

	test("without TYPETORCH_WEB_TOKEN nothing accepts the web token; a wrong token counts toward the lockout", async () => {
		const plain = await harness({ TYPETORCH_PARTS: "fleet" });
		try {
			expect((await plain.call("/v1/queries", { headers: web })).status).toBe(401);
			expect((await plain.call("/v1/auth/login", { method: "POST", ...json({ token: WEB }), headers: { ...JSON_TYPE, ...XT } })).status).toBe(401);
			expect(plain.logs.some((l) => l.includes("token login failed from"))).toBe(true);
			expect(plain.logs.join("\n")).not.toContain(WEB);
		} finally {
			await plain.close();
		}
	});

	test("the viewer list is a runtime setting: validated, saved from the dashboard, shown with its bounds", async () => {
		const patch = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", ...json(body), headers: { ...JSON_TYPE, ...bearer(ADMIN) } });
		const view = await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }));
		expect(view.settings.find((s: { key: string }) => s.key === "webViewers")).toMatchObject({ kind: "users", group: "access", maxEntries: 200, value: [], source: "default" });
		expect(view.envOnly).toContain("TYPETORCH_WEB_TOKEN");
		for (const bad of [{ webViewers: "x" }, { webViewers: [0] }, { webViewers: [-1] }, { webViewers: [1.5] }, { webViewers: { a: 1 } }, { webViewers: new Array(201).fill(0).map((_, i) => i + 1) }]) {
			const res = await patch(bad);
			expect(res.status).toBe(400);
			expect((await asJson(res)).key).toBe("webViewers");
		}
		const ok = await patch({ webViewers: ["42", 7, 42] });
		expect(ok.status).toBe(200);
		expect((await asJson(ok)).settings.find((s: { key: string }) => s.key === "webViewers")).toMatchObject({ value: [7, 42], source: "dashboard" });
		const again = await patch({ webViewers: "7, 9" });
		expect((await asJson(again)).settings.find((s: { key: string }) => s.key === "webViewers")).toMatchObject({ value: [7, 9] });
		expect((await patch({ webViewers: null })).status).toBe(200);
	});
});
