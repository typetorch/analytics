/**
 * The read-only `web` role over the routes: a viewer's session reads everything the explorer shows and is refused (403)
 * on everything that changes something or is for owners. The viewer sign-in itself is in oauth.test.ts; here the session
 * is made directly (sessions.create with the web role), with no Roblox in the loop. Every token is made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, post, type Harness } from "./harness.ts";

const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };
const JOB = "web-role-job-1";
const VIEWER = 4004;

describe("the web role", () => {
	let h: Harness;
	let web: Record<string, string>;

	beforeAll(async () => {
		h = await harness({ TYPETORCH_WEB_VIEWERS: String(VIEWER) });
		web = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "ViewerName" }, "web")}` };
		// One live server, so the fleet routes have something to show.
		expect((await h.call("/v1/fleet/heartbeat", post(API, { j: JOB, pv: 1, players: 3, tps: 60, mem: 100, up: 10 }))).status).toBe(202);
	});
	afterAll(() => h.close());

	test("the config reads the viewer list; a bad entry stops the start", () => {
		const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/tmp/never-used", TYPETORCH_EXPLORER: "off" };
		expect(() => loadConfig([], { ...base, TYPETORCH_WEB_VIEWERS: "12, abc" })).toThrow(/TYPETORCH_WEB_VIEWERS: entries are Roblox UserIds/);
		expect(loadConfig([], { ...base, TYPETORCH_WEB_VIEWERS: "30, 10,10 20" }).webViewers).toEqual([10, 20, 30]);
		expect(loadConfig([], base).webViewers).toEqual([]);
	});

	test("GET /v1/auth/check says role web; no token logs in as web (the admin token stays admin)", async () => {
		expect(await asJson(await h.call("/v1/auth/check", { headers: web }))).toMatchObject({ ok: true, role: "web", via: "cookie", user: { kind: "roblox", userId: VIEWER } });
		const res = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { ...JSON_TYPE, ...XT } });
		expect(await asJson(res)).toMatchObject({ role: "admin" });
		// Sign-out ends a web session like any other.
		const gone = { cookie: `tt_session=${h.app.sessions.create({ kind: "roblox", userId: VIEWER, name: "ViewerName" }, "web")}` };
		expect((await h.call("/v1/auth/logout", { method: "POST", headers: { ...gone, ...XT } })).status).toBe(200);
		expect((await h.call("/v1/queries", { headers: gone })).status).toBe(401);
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
		expect((await h.call("/v1/query/overview", { method: "POST", ...json({ filters: { from: T0 - 86_400_000, to: T0 } }), headers: { ...JSON_TYPE, ...web, ...XT } })).status).toBe(200);
		expect((await h.call("/v1/sql", { method: "POST", ...json({ sql: "select 1 as one" }), headers: { ...JSON_TYPE, ...web, ...XT } })).status).toBe(200);
		// The live stream opens (and is closed here at once).
		const live = await h.call("/v1/live", { headers: web });
		expect(live.status).toBe(200);
		await live.body?.cancel();
	});

	test("changes and owner routes answer 403 read-only", async () => {
		const session = { ...web, ...XT, origin: "http://backend.test" };
		const refused = async (path: string, init: RequestInit) => {
			const res = await h.call(path, { ...init, headers: { ...(init.headers as Record<string, string>), ...session } });
			expect(`${path} ${res.status}`).toBe(`${path} 403`);
			expect((await asJson(res)).error).toContain("read-only");
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
		const res = await h.call("/v1/fleet/alerts/1/ack", { method: "POST", ...json({}), headers: { ...JSON_TYPE, ...web } });
		expect(res.status).toBe(403);
		expect((await asJson(res)).error).toContain("x-typetorch");
	});

	test("the viewer list is a runtime setting: validated, saved from the dashboard, shown with its bounds; the env list is the default", async () => {
		const patch = (body: unknown) => h.call("/v1/admin/settings", { method: "PATCH", ...json(body), headers: { ...JSON_TYPE, ...bearer(ADMIN) } });
		const view = await asJson(await h.call("/v1/admin/settings", { headers: bearer(ADMIN) }));
		expect(view.settings.find((s: { key: string }) => s.key === "webViewers")).toMatchObject({ kind: "users", group: "access", maxEntries: 200, value: [VIEWER], source: "env" });
		for (const bad of [{ webViewers: "x" }, { webViewers: [0] }, { webViewers: [-1] }, { webViewers: [1.5] }, { webViewers: { a: 1 } }, { webViewers: new Array(201).fill(0).map((_, i) => i + 1) }]) {
			const res = await patch(bad);
			expect(res.status).toBe(400);
			expect((await asJson(res)).key).toBe("webViewers");
		}
		const ok = await patch({ webViewers: ["42", 7, 42, VIEWER] });
		expect(ok.status).toBe(200);
		expect((await asJson(ok)).settings.find((s: { key: string }) => s.key === "webViewers")).toMatchObject({ value: [7, 42, VIEWER], source: "dashboard" });
		expect((await h.call("/v1/queries", { headers: web })).status).toBe(200);
		// Off the list (the dashboard's list wins over the env one): the session ends at once.
		const removed = await patch({ webViewers: "7, 9" });
		expect((await asJson(removed)).sessionsEnded).toBeGreaterThanOrEqual(1);
		expect((await h.call("/v1/queries", { headers: web })).status).toBe(401);
		expect((await patch({ webViewers: null })).status).toBe(200);
	});
});
