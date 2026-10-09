/**
 * Runtime settings (the explorer's Settings page): roles, CSRF, secrets never returned or logged, validation and bounds,
 * the lockout guards, live application, persistence across a restart, the audit list. Every token, URL and address is
 * made up; the webhook receiver is a fake fetch.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { AUDIT_MAX, RUNTIME_SETTINGS_FILE, SETTINGS } from "../src/server/runtime-settings.ts";
import { ADMIN, API, T0, asJson, bearer, cookieOf, harness, type Harness } from "./harness.ts";

const HOOK = "https://hooks.example.test/webhooks/111/fake-webhook-secret-path-AAAA";
const HOOK_2 = "https://hooks.example.test/webhooks/222/fake-webhook-secret-path-BBBB";
const SECRET_MARKERS = ["fake-webhook-secret-path-AAAA", "fake-webhook-secret-path-BBBB", "hooks.example.test"];
const XT = { "x-typetorch": "1" };
const JSON_TYPE = { "content-type": "application/json" };

/** A fake webhook receiver: records every post, answers `status`. */
function receiver() {
	const posts: { url: string; body: Record<string, unknown> }[] = [];
	let status = 204;
	const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		// A receiver that is down: the runtime's error message names the URL; only the code may come back.
		if (url.includes("/unreachable/")) throw Object.assign(new Error(`Unable to connect to ${url}`), { code: "ConnectionRefused" });
		if (url.startsWith("https://hooks.example.test/")) {
			posts.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
			return new Response(null, { status });
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { posts, fetch: fakeFetch, setStatus: (s: number) => (status = s) };
}

type Setting = { key: string; source: string; value?: unknown; set?: boolean; fallbackSet?: boolean; min?: number; max?: number };
const settingOf = (body: Record<string, any>, key: string): Setting => (body.settings as Setting[]).find((s) => s.key === key) as Setting;

function api(h: Harness) {
	const get = (headers: Record<string, string> = bearer(ADMIN), ip?: string) => h.call("/v1/admin/settings", { headers, ...(ip ? { ip } : {}) });
	const patch = (body: unknown, headers: Record<string, string> = bearer(ADMIN), ip?: string) =>
		h.call("/v1/admin/settings", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body), headers: { ...JSON_TYPE, ...headers }, ...(ip ? { ip } : {}) });
	const testAlert = (headers: Record<string, string> = bearer(ADMIN), ip?: string) => h.call("/v1/admin/settings/test-alert", { method: "POST", headers, ...(ip ? { ip } : {}) });
	const login = async (ip?: string): Promise<string> => {
		const res = await h.call("/v1/auth/login", { method: "POST", body: JSON.stringify({ token: ADMIN }), headers: { ...JSON_TYPE, ...XT }, ...(ip ? { ip } : {}) });
		expect(res.status).toBe(200);
		return cookieOf(res) as string;
	};
	return { get, patch, testAlert, login };
}

describe("runtime settings: roles and CSRF", () => {
	let h: Harness;
	let a: ReturnType<typeof api>;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet" });
		a = api(h);
	});
	afterAll(() => h.close());

	test("anonymous and the game API key are refused on every route; the admin token and a session get in", async () => {
		for (const headers of [{}, bearer(API), bearer("wrong-token-0123456789abcdef0123456789")]) {
			expect((await a.get(headers, "10.1.0.1")).status).toBe(401);
			expect((await a.patch({ ipPerMinute: 5000 }, headers, "10.1.0.2")).status).toBe(401);
			expect((await a.testAlert(headers, "10.1.0.3")).status).toBe(401);
		}
		expect((await a.get()).status).toBe(200);
		const cookie = await a.login();
		expect((await a.get({ cookie })).status).toBe(200);
		// Nothing was changed by the refused requests.
		expect(settingOf(await asJson(await a.get()), "ipPerMinute")).toMatchObject({ value: 6000, source: "default" });
		expect((await h.call("/v1/admin/settings", { method: "DELETE", headers: bearer(ADMIN) })).status).toBe(405);
		expect((await h.call("/v1/admin/settings/test-alert", { headers: bearer(ADMIN) })).status).toBe(405);
	});

	test("a session needs the X-TypeTorch header and a same-site Origin to change anything; the Bearer token doesn't", async () => {
		const cookie = await a.login();
		const noHeader = await a.patch({ ipPerMinute: 5000 }, { cookie });
		expect(noHeader.status).toBe(403);
		expect((await asJson(noHeader)).error).toContain("x-typetorch");
		expect((await a.patch({ ipPerMinute: 5000 }, { cookie, ...XT, origin: "https://evil.example" })).status).toBe(403);
		expect((await a.testAlert({ cookie })).status).toBe(403);
		expect(settingOf(await asJson(await a.get()), "ipPerMinute").source).toBe("default");
		const ok = await a.patch({ ipPerMinute: 5000 }, { cookie, ...XT, origin: "http://backend.test" });
		expect(ok.status).toBe(200);
		expect(settingOf(await asJson(ok), "ipPerMinute")).toMatchObject({ value: 5000, source: "dashboard" });
		expect((await a.patch({ ipPerMinute: null })).status).toBe(200);
		// The body must be JSON with a JSON content type.
		expect((await h.call("/v1/admin/settings", { method: "PATCH", body: "ipPerMinute=5000", headers: { ...bearer(ADMIN), "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
	});
});

describe("runtime settings: values, validation, secrets, audit", () => {
	let h: Harness;
	let a: ReturnType<typeof api>;
	const hook = receiver();
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_JOB_PER_MINUTE: "90" }, { fetch: hook.fetch });
		a = api(h);
	});
	afterAll(() => h.close());

	test("GET lists every editable key with its value, source and bounds, and the env-only names", async () => {
		const body = await asJson(await a.get());
		expect(body.enabled).toBe(true);
		expect((body.settings as Setting[]).map((s) => s.key)).toEqual(SETTINGS.map((s) => s.key));
		expect(settingOf(body, "jobPerMinute")).toMatchObject({ value: 90, source: "env", min: 10, max: 100_000 });
		expect(settingOf(body, "ipPerMinute")).toMatchObject({ value: 6000, source: "default", min: 100, max: 1_000_000 });
		expect(settingOf(body, "keepDays")).toMatchObject({ value: 400, zero: "forever", min: 7 });
		expect(settingOf(body, "alertWebhookUrl")).toMatchObject({ set: false, fallbackSet: false, source: "default" });
		expect(settingOf(body, "alertWebhookUrl")).not.toHaveProperty("value");
		expect(settingOf(body, "tokenLogin")).toMatchObject({ value: true, source: "default" });
		expect(settingOf(body, "adminAllowIps")).toMatchObject({ value: [], source: "default" });
		expect(body.envOnly).toEqual(expect.arrayContaining(["TYPETORCH_API_KEY", "TYPETORCH_API_KEY_PREVIOUS", "TYPETORCH_ADMIN_TOKEN", "ROBLOX_OAUTH_CLIENT_ID", "ROBLOX_OAUTH_CLIENT_SECRET", "TYPETORCH_PUBLIC_URL", "TYPETORCH_TRUST_PROXY", "TYPETORCH_TRUSTED_PROXIES", "TYPETORCH_DATA_DIR", "PORT", "HOST"]));
		expect(body.you).toEqual({ ip: "127.0.0.1", roblox: false });
		expect(body.robloxSignIn).toBe(false);
		expect(body.audit).toEqual([]);
	});

	test("strict validation: unknown keys, wrong types, out-of-bounds numbers; all or nothing", async () => {
		const bad: unknown[] = [
			{ nope: 1 },
			'{"__proto__": 1, "ipPerMinute": 5000}',
			{ ipPerMinute: 99 },
			{ ipPerMinute: 1_000_001 },
			{ ipPerMinute: 150.5 },
			{ ipPerMinute: "5000" },
			{ jobPerMinute: 9 },
			{ errorsIpPerMinute: 59 },
			{ fleetNewJobsPerMinute: 99 },
			{ keepDays: 6 },
			{ keepDays: -1 },
			{ errorKeepDays: 0 },
			{ errorMaxKinds: 99 },
			{ errorRowsPerDay: 9_999 },
			{ tokenLogin: "off" },
			{ tokenLogin: 0 },
			{ alertWebhookFormat: "teams" },
			{ alertWebhookLevels: [] },
			{ alertWebhookLevels: ["critical", "panic"] },
			{ alertWebhookLevels: "critical" },
			{ adminAllowIps: ["10.0.0.0/33"] },
			{ adminAllowIps: ["not-an-ip"] },
			{ adminAllowIps: [5] },
			{ adminAllowIps: Array.from({ length: 65 }, (_, i) => `10.0.${i}.1`) },
			{ adminAllowIps: 5 },
			{ alertWebhookUrl: 5 },
			{ alertWebhookUrl: "ftp://hooks.example.test/x" },
			{},
			[],
			"text",
			null,
		];
		for (const body of bad) {
			const res = await a.patch(body);
			expect([JSON.stringify(body)?.slice(0, 60), res.status]).toEqual([JSON.stringify(body)?.slice(0, 60), 400]);
		}
		expect((await a.patch("{nope")).status).toBe(400);
		expect((await a.patch(JSON.stringify({ adminAllowIps: "x".repeat(20_000) }))).status).toBe(413);
		// One bad key spoils the whole change.
		const mixed = await a.patch({ ipPerMinute: 5000, jobPerMinute: 5 });
		expect(mixed.status).toBe(400);
		const mixedBody = await asJson(mixed);
		expect(mixedBody).toMatchObject({ key: "jobPerMinute" });
		expect(mixedBody.error).toContain("10 to 100000");
		const body = await asJson(await a.get());
		expect(settingOf(body, "ipPerMinute").source).toBe("default");
		expect(body.audit).toEqual([]);
		// The edges and 0 = forever where it means that.
		const edges = await a.patch({ ipPerMinute: 100, jobPerMinute: 100_000, keepDays: 0, rawKeepDays: 0, alertWebhookLevels: ["info", "critical", "info"], alertWebhookFormat: "slack", adminAllowIps: "127.0.0.1, 10.0.0.0/8\n2001:db8::/32" });
		expect(edges.status).toBe(200);
		const after = await asJson(edges);
		expect(settingOf(after, "keepDays")).toMatchObject({ value: 0, source: "dashboard" });
		expect(settingOf(after, "alertWebhookLevels").value).toEqual(["critical", "info"]);
		expect(settingOf(after, "adminAllowIps").value).toEqual(["127.0.0.1", "10.0.0.0/8", "2001:db8::/32"]);
		expect(after.changed.sort()).toEqual(["adminAllowIps", "alertWebhookFormat", "alertWebhookLevels", "ipPerMinute", "jobPerMinute", "keepDays", "rawKeepDays"]);
		// null puts each back to the environment's value (or the default).
		const reset = await asJson(await a.patch({ ipPerMinute: null, jobPerMinute: null, keepDays: null, rawKeepDays: null, alertWebhookLevels: null, alertWebhookFormat: null, adminAllowIps: null }));
		expect(settingOf(reset, "jobPerMinute")).toMatchObject({ value: 90, source: "env" });
		expect(settingOf(reset, "keepDays")).toMatchObject({ value: 400, source: "default" });
		expect(settingOf(reset, "adminAllowIps")).toMatchObject({ value: [], source: "default" });
		// The same value again changes nothing (no audit line).
		const auditBefore = (await asJson(await a.get())).audit.length;
		await a.patch({ errorKeepDays: 20 });
		const again = await asJson(await a.patch({ errorKeepDays: 20 }));
		expect(again.changed).toEqual([]);
		expect(again.audit.length).toBe(auditBefore + 1);
		await a.patch({ errorKeepDays: null });
	});

	test("the webhook URL is never returned, echoed or logged: only set / not set and the source", async () => {
		const res = await a.patch({ alertWebhookUrl: HOOK, alertWebhookLevels: ["critical", "warning"] });
		expect(res.status).toBe(200);
		const answers = [await res.text(), await (await a.get()).text(), await (await h.call("/healthz", { headers: bearer(ADMIN) })).text()];
		const body = JSON.parse(answers[0] as string);
		expect(settingOf(body, "alertWebhookUrl")).toMatchObject({ set: true, fallbackSet: false, source: "dashboard" });
		// A wrong value is refused without being repeated.
		const refused = await a.patch({ alertWebhookUrl: "http://hooks.example.test/webhooks/9/fake-webhook-secret-path-AAAA" });
		expect(refused.status).toBe(400);
		answers.push(await refused.text());
		const refusedSpace = await a.patch({ alertWebhookUrl: "https://hooks.example.test/fake-webhook-secret-path-AAAA with space" });
		expect(refusedSpace.status).toBe(400);
		answers.push(await refusedSpace.text());
		for (const text of [...answers, h.logs.join("\n"), JSON.stringify(h.app.settings.view()), JSON.stringify(h.app.settings.audit())]) {
			for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
		}
		// The value lives in the data folder's file only (0600 where the OS has modes).
		const file = join(h.dir, RUNTIME_SETTINGS_FILE);
		expect(readFileSync(file, "utf8")).toContain(HOOK);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(existsSync(`${file}.tmp`)).toBe(false);
	});

	test("the test alert goes to the current webhook (and to a new one at once); 3 a minute; never the URL in the answer", async () => {
		hook.posts.length = 0;
		const sent = await a.testAlert();
		expect(sent.status).toBe(200);
		const text = await sent.text();
		expect(JSON.parse(text)).toEqual({ ok: true, status: 204 });
		expect(hook.posts.map((p) => p.url)).toEqual([HOOK]);
		expect(JSON.stringify(hook.posts[0]?.body)).toContain("test_alert");
		// Replace the webhook: the next one goes to the new URL, nothing to the old.
		expect((await a.patch({ alertWebhookUrl: HOOK_2 })).status).toBe(200);
		hook.setStatus(500);
		const failed = await a.testAlert();
		expect(failed.status).toBe(502);
		const failedText = await failed.text();
		expect(JSON.parse(failedText)).toMatchObject({ ok: false, status: 500 });
		expect(hook.posts.map((p) => p.url)).toEqual([HOOK, HOOK_2]);
		hook.setStatus(204);
		expect((await a.testAlert()).status).toBe(200);
		// The fourth in a minute is refused.
		const limited = await a.testAlert();
		expect(limited.status).toBe(429);
		expect(hook.posts.length).toBe(3);
		for (const t of [text, failedText, h.logs.join("\n"), JSON.stringify((await asJson(await a.get())).audit)]) for (const marker of SECRET_MARKERS) expect(t).not.toContain(marker);
		const audit = (await asJson(await a.get())).audit as { action: string; result?: string }[];
		expect(audit.filter((e) => e.action === "test-alert").map((e) => e.result)).toEqual(["sent (HTTP 204)", "failed: the webhook answered HTTP 500", "sent (HTTP 204)"]);
		h.setNow(h.now() + 60_000);
	});

	test("real alerts follow the saved webhook and levels; Clear stops them, Reset goes back to the environment's (none)", async () => {
		hook.posts.length = 0;
		const alert = (code: string, level: string) => h.call("/v1/fleet/alert", { method: "POST", body: JSON.stringify({ level, code, message: "m", j: "cli", b: "prod" }), headers: { ...JSON_TYPE, ...bearer(API) } });
		expect((await alert("first_warning", "warning")).status).toBe(202);
		await h.app.bus.idle();
		await h.app.notifier.flush();
		expect(hook.posts.map((p) => p.url)).toEqual([HOOK_2]);
		expect(JSON.stringify(hook.posts[0]?.body)).toContain("first_warning");
		// Back to critical only: the warning is skipped.
		await a.patch({ alertWebhookLevels: ["critical"] });
		await alert("second_warning", "warning");
		await h.app.bus.idle();
		await h.app.notifier.flush();
		expect(hook.posts.length).toBe(1);
		// Clear: "" means no webhook even if the environment had one.
		const cleared = await asJson(await a.patch({ alertWebhookUrl: "" }));
		expect(settingOf(cleared, "alertWebhookUrl")).toMatchObject({ set: false, source: "dashboard" });
		await alert("after_clear", "critical");
		await h.app.bus.idle();
		await h.app.notifier.flush();
		expect(hook.posts.length).toBe(1);
		expect((await a.testAlert()).status).toBe(409);
		const reset = await asJson(await a.patch({ alertWebhookUrl: null, alertWebhookLevels: null }));
		expect(settingOf(reset, "alertWebhookUrl")).toMatchObject({ set: false, source: "default" });
	});

	test("a webhook that can't be reached: the test alert says why with the error code, never the URL", async () => {
		expect((await a.patch({ alertWebhookUrl: "https://hooks.example.test/unreachable/fake-webhook-secret-path-AAAA" })).status).toBe(200);
		const res = await a.testAlert();
		expect(res.status).toBe(502);
		const text = await res.text();
		expect(JSON.parse(text)).toEqual({ ok: false, error: "the webhook could not be reached (ConnectionRefused)" });
		for (const t of [text, h.logs.join("\n")]) for (const marker of [...SECRET_MARKERS, "unreachable"]) expect(t).not.toContain(marker);
		await a.patch({ alertWebhookUrl: null });
	});

	test("rate limits and retention apply to the next request", async () => {
		// Ingest per address: the next requests are counted against the new limit.
		expect((await a.patch({ ipPerMinute: 100 })).status).toBe(200);
		const identity = () => h.call("/v1/identity", { method: "POST", body: JSON.stringify({ identities: [] }), headers: { ...JSON_TYPE, ...bearer(API) }, ip: "203.0.113.50" });
		const statuses: number[] = [];
		for (let i = 0; i < 101; i++) statuses.push((await identity()).status);
		expect(statuses.filter((s) => s === 202).length).toBe(100);
		expect(statuses.at(-1)).toBe(429);
		await a.patch({ ipPerMinute: null });
		// Error log reads are clamped to the error retention.
		await a.patch({ errorKeepDays: 2 });
		const read = await asJson(await h.call("/v1/errors?window=30d", { headers: bearer(ADMIN) }));
		expect(Date.parse(read.window.from)).toBe(h.now() - 2 * 86_400_000);
		// The error row budget shows the new number.
		await a.patch({ errorRowsPerDay: 50_000 });
		expect((await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }))).errors.rowsPerDay).toBe(50_000);
		await a.patch({ errorKeepDays: null, errorRowsPerDay: null });
		expect(h.app.settings.get("errorRowsPerDay")).toBe(2_000_000);
	});

	test("every change is an audit line (who, which keys, never values), newest first, at most 50", async () => {
		const audit = (await asJson(await a.get())).audit as { at: string; who: string; via: string; action: string; set?: string[]; reset?: string[] }[];
		expect(audit.length).toBeGreaterThan(5);
		expect(audit[0]).toMatchObject({ who: "admin token", via: "bearer", action: "change", reset: ["errorKeepDays", "errorRowsPerDay"] });
		expect(audit.every((e) => !("values" in e) && !("value" in e))).toBe(true);
		const cookie = await a.login();
		await a.patch({ errorMaxKinds: 4000 }, { cookie, ...XT });
		const first = ((await asJson(await a.get())).audit as typeof audit)[0];
		expect(first).toMatchObject({ who: "admin token", via: "session", action: "change", set: ["errorMaxKinds"] });
		// The log line names the keys, not the values.
		const line = h.logs.find((l) => l.includes("set errorMaxKinds")) as string;
		expect(line).toContain("runtime settings changed by admin token (session)");
		expect(line).not.toContain("4000");
		for (let i = 0; i < AUDIT_MAX + 5; i++) await a.patch({ errorMaxKinds: 4001 + i });
		expect(((await asJson(await a.get())).audit as unknown[]).length).toBe(AUDIT_MAX);
		await a.patch({ errorMaxKinds: null });
	});
});

describe("runtime settings: the admin allow list", () => {
	let h: Harness;
	let a: ReturnType<typeof api>;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet" });
		a = api(h);
	});
	afterAll(() => h.close());

	test("a list that leaves out the caller's own address is refused (lockout guard); nothing changes", async () => {
		const res = await a.patch({ adminAllowIps: ["198.51.100.0/24"] }, bearer(ADMIN), "10.0.0.7");
		expect(res.status).toBe(409);
		const body = await asJson(res);
		expect(body).toMatchObject({ key: "adminAllowIps", guard: "allow-list" });
		expect(body.error).toContain("10.0.0.7");
		expect(h.app.settings.get("adminAllowIps")).toEqual([]);
		// Everyone still gets in.
		expect((await a.get(bearer(ADMIN), "198.51.100.9")).status).toBe(200);
	});

	test("a list with the caller's address applies to the very next request; reset opens it again", async () => {
		const ok = await a.patch({ adminAllowIps: ["10.0.0.0/24", "198.51.100.9"] }, bearer(ADMIN), "10.0.0.7");
		expect(ok.status).toBe(200);
		// Other addresses: the admin side doesn't exist for them; game routes stay open.
		expect((await a.get(bearer(ADMIN), "203.0.113.1")).status).toBe(404);
		expect((await h.call("/v1/auth/check", { ip: "203.0.113.1" })).status).toBe(404);
		expect((await h.call("/v1/identity", { method: "POST", body: JSON.stringify({ identities: [] }), headers: { ...JSON_TYPE, ...bearer(API) }, ip: "203.0.113.1" })).status).toBe(202);
		expect((await a.get(bearer(ADMIN), "10.0.0.99")).status).toBe(200);
		expect((await a.get(bearer(ADMIN), "198.51.100.9")).status).toBe(200);
		// The caller's own address is checked as the server sees it: here a narrower list without 10.0.0.99 is refused.
		expect((await a.patch({ adminAllowIps: ["10.0.0.7"] }, bearer(ADMIN), "10.0.0.99")).status).toBe(409);
		// Back to the environment (no list): everyone again.
		expect((await a.patch({ adminAllowIps: null }, bearer(ADMIN), "10.0.0.7")).status).toBe(200);
		expect((await a.get(bearer(ADMIN), "203.0.113.1")).status).toBe(200);
	});
});

describe("runtime settings: the allow list guard sees the address through the trusted proxy", () => {
	test("X-Forwarded-For from the trusted proxy is the caller; a reset to an env list that leaves the caller out is refused", async () => {
		const h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_TRUST_PROXY: "1", TYPETORCH_TRUSTED_PROXIES: "172.16.0.0/12", TYPETORCH_ADMIN_ALLOW_IPS: "198.51.100.0/24" });
		const a = api(h);
		try {
			const viaProxy = (ip: string) => ({ ...bearer(ADMIN), "x-forwarded-for": ip });
			// The env list: only 198.51.100.0/24 gets in.
			expect((await a.get(viaProxy("203.0.113.5"), "172.16.0.2")).status).toBe(404);
			const view = await asJson(await a.get(viaProxy("198.51.100.4"), "172.16.0.2"));
			expect(settingOf(view, "adminAllowIps")).toMatchObject({ value: ["198.51.100.0/24"], source: "env" });
			expect(view.you.ip).toBe("198.51.100.4");
			// A list for the caller's real address passes; the proxy's own address doesn't count.
			expect((await a.patch({ adminAllowIps: ["172.16.0.2"] }, viaProxy("198.51.100.4"), "172.16.0.2")).status).toBe(409);
			expect((await a.patch({ adminAllowIps: ["198.51.100.4", "203.0.113.0/24"] }, viaProxy("198.51.100.4"), "172.16.0.2")).status).toBe(200);
			expect((await a.get(viaProxy("203.0.113.5"), "172.16.0.2")).status).toBe(200);
			// From 203.0.113.5, going back to the env list would lock this caller out: refused.
			const back = await a.patch({ adminAllowIps: null }, viaProxy("203.0.113.5"), "172.16.0.2");
			expect(back.status).toBe(409);
			expect(await asJson(back)).toMatchObject({ guard: "allow-list" });
			expect((await a.patch({ adminAllowIps: null }, viaProxy("198.51.100.4"), "172.16.0.2")).status).toBe(200);
		} finally {
			await h.close();
		}
	});
});

describe("runtime settings: the token login guard without Roblox sign-in", () => {
	test("turning the token login off is refused when Sign in with Roblox isn't configured, from the token or a token session", async () => {
		const h = await harness({ TYPETORCH_PARTS: "fleet" });
		const a = api(h);
		try {
			const viaBearer = await a.patch({ tokenLogin: false });
			expect(viaBearer.status).toBe(409);
			const refusal = await asJson(viaBearer);
			expect(refusal).toMatchObject({ key: "tokenLogin", guard: "token-login" });
			expect(refusal.error).toContain("Sign in with Roblox");
			const cookie = await a.login();
			expect((await a.patch({ tokenLogin: false }, { cookie, ...XT })).status).toBe(409);
			expect(h.app.settings.get("tokenLogin")).toBe(true);
			expect((await asJson(await h.call("/v1/auth/check"))).login).toEqual({ token: true, roblox: false });
			// Turning it on (or pinning on) is always fine.
			expect((await a.patch({ tokenLogin: true })).status).toBe(200);
		} finally {
			await h.close();
		}
	});

	test("with TYPETORCH_TOKEN_LOGIN=off in the env, the dashboard may turn it on; a reset back to off is guarded", async () => {
		const h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_TOKEN_LOGIN: "off" });
		const a = api(h);
		try {
			expect((await h.call("/v1/auth/login", { method: "POST", body: JSON.stringify({ token: ADMIN }), headers: { ...JSON_TYPE, ...XT } })).status).toBe(404);
			expect(settingOf(await asJson(await a.get()), "tokenLogin")).toMatchObject({ value: false, source: "env" });
			expect((await a.patch({ tokenLogin: true })).status).toBe(200);
			// Applied live: the login works now.
			expect((await asJson(await h.call("/v1/auth/check"))).login.token).toBe(true);
			await a.login();
			// Going back to the env's "off" is turning it off: guarded like false.
			expect((await a.patch({ tokenLogin: null })).status).toBe(409);
		} finally {
			await h.close();
		}
	});
});

describe("runtime settings: persistence", () => {
	const dirs: string[] = [];
	afterAll(() => {
		for (const d of dirs) rmSync(d, { recursive: true, force: true });
	});
	const env = (dir: string, extra: Record<string, string> = {}) => loadConfig([], { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: dir, PORT: "0", TYPETORCH_PARTS: "fleet", TYPETORCH_EXPLORER: "off", TYPETORCH_IP_PER_MINUTE: "7000", ...extra });
	const call = (app: App, path: string, init: RequestInit = {}, ip = "127.0.0.1") => app.handle(new Request(`http://backend.test${path}`, init), ip);
	const patch = (app: App, body: unknown) => call(app, "/v1/admin/settings", { method: "PATCH", body: JSON.stringify(body), headers: { ...JSON_TYPE, ...bearer(ADMIN) } });

	test("saved values and the audit list survive a restart; they win over the environment; reset goes back to it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-runtime-"));
		dirs.push(dir);
		const logs: string[] = [];
		const first = await startApp(env(dir), { clock: () => T0, manualJobs: true, log: (l) => logs.push(l) });
		try {
			expect((await patch(first, { ipPerMinute: 8000, alertWebhookUrl: HOOK, adminAllowIps: ["127.0.0.1"], errorKeepDays: 9 })).status).toBe(200);
		} finally {
			await first.stop();
		}
		const second = await startApp(env(dir), { clock: () => T0 + 1000, manualJobs: true, log: (l) => logs.push(l) });
		try {
			const body = await asJson(await call(second, "/v1/admin/settings", { headers: bearer(ADMIN) }));
			expect(settingOf(body, "ipPerMinute")).toMatchObject({ value: 8000, source: "dashboard", fallback: 7000, fallbackSource: "env" } as never);
			expect(settingOf(body, "alertWebhookUrl")).toMatchObject({ set: true, source: "dashboard" });
			expect(settingOf(body, "adminAllowIps")).toMatchObject({ value: ["127.0.0.1"], source: "dashboard" });
			expect(settingOf(body, "errorKeepDays")).toMatchObject({ value: 9, source: "dashboard" });
			expect(body.audit[0]).toMatchObject({ who: "admin token", action: "change", set: ["alertWebhookUrl", "adminAllowIps", "ipPerMinute", "errorKeepDays"] });
			// Applied after the restart too: the allow list keeps other addresses out.
			expect((await call(second, "/v1/admin/settings", { headers: bearer(ADMIN) }, "203.0.113.1")).status).toBe(404);
			expect(second.settings.overridden()).toEqual(["alertWebhookUrl", "adminAllowIps", "ipPerMinute", "errorKeepDays"]);
			// Reset: back to the environment's value, and the file loses the key.
			const reset = await asJson(await patch(second, { ipPerMinute: null, alertWebhookUrl: null, adminAllowIps: null, errorKeepDays: null }));
			expect(settingOf(reset, "ipPerMinute")).toMatchObject({ value: 7000, source: "env" });
			const saved = JSON.parse(readFileSync(join(dir, RUNTIME_SETTINGS_FILE), "utf8"));
			expect(saved.values).toEqual({});
			expect(saved.audit.length).toBe(2);
		} finally {
			await second.stop();
		}
		for (const marker of SECRET_MARKERS) expect(logs.join("\n")).not.toContain(marker);
	});

	test("TYPETORCH_RUNTIME_SETTINGS=off ignores the file (kept as it is) and refuses changes: the way back in after a lockout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-runtime-"));
		dirs.push(dir);
		const file = join(dir, RUNTIME_SETTINGS_FILE);
		writeFileSync(file, JSON.stringify({ version: 1, values: { adminAllowIps: ["198.51.100.1"], ipPerMinute: 8000 }, audit: [] }));
		const before = readFileSync(file, "utf8");
		const logs: string[] = [];
		const app = await startApp(env(dir, { TYPETORCH_RUNTIME_SETTINGS: "off" }), { clock: () => T0, manualJobs: true, log: (l) => logs.push(l) });
		try {
			const body = await asJson(await call(app, "/v1/admin/settings", { headers: bearer(ADMIN) }, "203.0.113.1"));
			expect(body.enabled).toBe(false);
			expect(settingOf(body, "ipPerMinute")).toMatchObject({ value: 7000, source: "env" });
			expect(settingOf(body, "adminAllowIps").value).toEqual([]);
			const refused = await patch(app, { ipPerMinute: 9000 });
			expect(refused.status).toBe(409);
			expect((await asJson(refused)).error).toContain("TYPETORCH_RUNTIME_SETTINGS=off");
			expect(readFileSync(file, "utf8")).toBe(before);
			expect(logs.join("\n")).toContain("TYPETORCH_RUNTIME_SETTINGS=off");
		} finally {
			await app.stop();
		}
	});

	test("a stored value that no longer passes the checks, or an unknown key, is ignored with a log line (no value in it)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-runtime-"));
		dirs.push(dir);
		writeFileSync(join(dir, RUNTIME_SETTINGS_FILE), JSON.stringify({ version: 1, values: { ipPerMinute: 5, alertWebhookUrl: "http://hooks.example.test/fake-webhook-secret-path-AAAA", sneaky: 1, jobPerMinute: 70 }, audit: [{ at: "x", who: "admin token", via: "bearer", action: "change", set: ["jobPerMinute", "notAKey"] }, "junk"] }));
		const logs: string[] = [];
		const app = await startApp(env(dir), { clock: () => T0, manualJobs: true, log: (l) => logs.push(l) });
		try {
			expect(app.settings.get("ipPerMinute")).toBe(7000);
			expect(app.settings.get("jobPerMinute")).toBe(70);
			expect(app.settings.get("alertWebhookUrl")).toBe("");
			expect(app.settings.audit()).toEqual([{ at: "x", who: "admin token", via: "bearer", action: "change", set: ["jobPerMinute"] }]);
			const text = logs.join("\n");
			expect(text).toContain("ignored the stored ipPerMinute");
			expect(text).toContain("ignored the stored alertWebhookUrl");
			expect(text).toContain('ignored the stored "sneaky"');
			for (const marker of SECRET_MARKERS) expect(text).not.toContain(marker);
		} finally {
			await app.stop();
		}
		// A file that isn't JSON: the environment applies.
		writeFileSync(join(dir, RUNTIME_SETTINGS_FILE), "{broken");
		const again = await startApp(env(dir), { clock: () => T0, manualJobs: true, log: (l) => logs.push(l) });
		try {
			expect(again.settings.get("jobPerMinute")).toBe(60);
			expect(logs.some((l) => l.includes("could not be read"))).toBe(true);
		} finally {
			await again.stop();
		}
	});

	test("an http:// webhook in the environment stops the start, without the value in the message", () => {
		let message = "";
		try {
			env("data", { TYPETORCH_ALERT_WEBHOOK_URL: "http://hooks.example.test/fake-webhook-secret-path-AAAA" });
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("TYPETORCH_ALERT_WEBHOOK_URL must be an https:// URL");
		for (const marker of SECRET_MARKERS) expect(message).not.toContain(marker);
	});
});
