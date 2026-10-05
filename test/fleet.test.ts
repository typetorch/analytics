/** The fleet API: ingest from kernels and the CLI, live reads, server-side alerts, webhooks, the SSE stream. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFleetClient, FleetApiError } from "../src/fleet/client.ts";
import { openSqlite } from "../src/fleet/db.ts";
import { alertText, createNotifier, detectFormat, webhookBody } from "../src/fleet/notify.ts";
import { FleetService, type FleetEvent } from "../src/fleet/service.ts";
import { startApp, type App } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";

const INGEST = "fleet-ingest-token-0123456789abc";
const ADMIN = "fleet-admin-token-0123456789abcd";
const ACCESS_CODE = "PRIVATE-ACCESS-CODE-777";
const T0 = Date.UTC(2026, 9, 5, 12, 0, 0);

let now = T0;
let dir: string;
let app: App;
let base: string;
const hooks: { url: string; body: unknown }[] = [];
const hookFetch = (async (input: string | URL | Request, init?: RequestInit) => {
	hooks.push({ url: String(input), body: JSON.parse(String(init?.body)) });
	return new Response("", { status: 204 });
}) as typeof fetch;

const ingest = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base}/v1/fleet/${path}`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

/** The kernel's heartbeat (kernel Fleet.luau / fleetStatus): t = server type, s and u in unix seconds, sv = 2. */
const hb = (j: string, over: Record<string, unknown> = {}) => ({ j, t: "public", b: "prod", c: "prod", a: "art-41", n: 10, m: 20, s: Math.floor((T0 - 3_600_000) / 1000), u: Math.floor(now / 1000), p: 1001, v: "0.3.2", q: 41, g: 3, h: "ok", sv: 2, ...over });

let client: ReturnType<typeof createFleetClient>;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tt-fleet-"));
	const config = loadConfig([], {
		TT_ANALYTICS_DATA: dir,
		TT_ANALYTICS_PORT: "0",
		TT_SERVER_PARTS: "fleet",
		TT_ANALYTICS_INGEST_TOKENS: INGEST,
		TT_ANALYTICS_ADMIN_TOKEN: ADMIN,
		TT_FLEET_WEBHOOK_URL: "https://discord.com/api/webhooks/1/abc",
	});
	app = await startApp(config, { clock: () => now, manualJobs: true, log: () => {}, fetch: hookFetch });
	base = `http://127.0.0.1:${app.port}`;
	client = createFleetClient({ url: base, token: ADMIN, ingestToken: INGEST });
});
afterAll(async () => {
	await app.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("ingest", () => {
	test("tokens, shapes, sizes", async () => {
		expect((await ingest("heartbeat", hb("job-1"), { authorization: `Bearer ${ADMIN}` })).status).toBe(401);
		expect((await ingest("heartbeat", { t: 1 })).status).toBe(400); // no JobId
		expect((await ingest("report", { s: 1, j: "job-1", r: "exploded" })).status).toBe(400);
		expect((await ingest("alert", { level: "panic", code: "x", message: "m" })).status).toBe(400);
		expect((await ingest("heartbeat", { j: "job-1", pad: "x".repeat(20_000) })).status).toBe(413);
		expect((await fetch(`${base}/v1/fleet/servers`)).status).toBe(401);
		expect((await fetch(`${base}/v1/fleet/servers`, { headers: { authorization: `Bearer ${INGEST}` } })).status).toBe(401);
	});

	test("heartbeats upsert one row per JobId; the access code is never stored or returned", async () => {
		for (const j of ["job-1", "job-2", "job-3"]) expect((await ingest("heartbeat", hb(j, j === "job-2" ? { k: ACCESS_CODE } : {}))).status).toBe(202);
		// The JobId may also come in a header.
		const { j: _j, ...noJob } = hb("job-4");
		expect((await ingest("heartbeat", noJob, { "x-tt-job": "job-4" })).status).toBe(202);
		expect((await ingest("heartbeat", hb("job-1", { n: 12 }))).status).toBe(202);
		const started = performance.now();
		const list = await client.servers();
		const ms = performance.now() - started;
		expect(list.servers.map((s) => s.job).sort()).toEqual(["job-1", "job-2", "job-3", "job-4"]);
		expect(list.players).toBe(42);
		expect(list.servers.find((s) => s.job === "job-1")?.players).toBe(12);
		expect(JSON.stringify(list)).not.toContain(ACCESS_CODE);
		expect(ms).toBeLessThan(200);
		expect((await client.servers({ branch: "dev" })).servers).toEqual([]);
	});

	test("rate limit per JobId", async () => {
		let limited = 0;
		for (let i = 0; i < 45; i++) if ((await ingest("heartbeat", hb("job-9"))).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
		const closing = await ingest("closing", { j: "job-9", t: now });
		expect(closing.status).toBe(202);
	});
});

describe("deploys, reports, stuck servers", () => {
	test("reports: results, errors, servers behind", async () => {
		await client.deployStarted({ s: 42, b: "prod", a: "art-42", ch: "prod" });
		await ingest("report", { s: 42, b: "prod", a: "art-42", j: "job-1", r: "swapped", d: 1.2, t: now, g: 4, k: "0.3.2", p: 12 });
		await ingest("heartbeat", hb("job-1", { q: 42, a: "art-42", g: 4 }));
		await ingest("report", { s: 42, b: "prod", a: "art-42", j: "job-2", r: "failed", e: "swap failed: boom", d: 0.4, t: now, g: 3, k: "0.3.2", p: 10 });
		const r = await client.reports({ seq: 42 });
		expect(r).toMatchObject({ seq: 42, branch: "prod", artifact: "art-42", reported: 2 });
		expect(r.results).toEqual([
			{ result: "swapped", servers: 1, players: 12, medianSeconds: 1.2, maxSeconds: 1.2 },
			{ result: "failed", servers: 1, players: 10, medianSeconds: 0.4, maxSeconds: 0.4 },
		]);
		expect(r.errors).toEqual([{ error: "swap failed: boom", servers: 1, exampleJob: "job-2" }]);
		expect(r.behind.map((s) => s.job)).toEqual(["job-2", "job-3", "job-4"]);
		expect(r.stuck).toEqual([]); // not 3 minutes yet
		expect((await client.reports()).seq).toBe(42);
		expect((await client.reports({ artifact: "art-42" })).seq).toBe(42);
	});

	test("server_stuck after 3 minutes lists the JobIds with no report (a warning, not a verdict on the build)", async () => {
		now += 3 * 60_000 + 1000;
		for (const j of ["job-1", "job-2", "job-3", "job-4"]) await ingest("heartbeat", hb(j, j === "job-1" ? { q: 42 } : {}));
		const swept = await app.fleet?.sweep();
		expect(swept?.stuck).toBe(2);
		const alerts = await client.alerts({ level: "warning" });
		const stuck = alerts.find((a) => a.code === "server_stuck");
		expect(stuck?.details).toEqual({ jobs: ["job-3", "job-4"], count: 2 });
		expect(stuck?.message).toContain("still below seq 42");
		expect(stuck?.message).not.toMatch(/bad|broken|fail/i);
		expect((await client.reports({ seq: 42 })).stuck).toEqual(["job-3", "job-4"]);
		// Once per deploy.
		expect((await app.fleet?.sweep())?.stuck).toBe(0);
	});
});

describe("alerts", () => {
	test("server_lost after 90 s without a closing message; closing servers are not lost", async () => {
		await ingest("closing", { j: "job-4", t: now });
		now += 91_000;
		await ingest("heartbeat", hb("job-1", { q: 42 }));
		const swept = await app.fleet?.sweep();
		expect(swept?.lost).toBe(2); // job-2 and job-3; job-4 closed
		const lost = (await client.alerts()).find((a) => a.code === "server_lost");
		expect(lost).toMatchObject({ level: "warning", branch: "prod", source: "server" });
		expect((lost?.details as { jobs: string[] }).jobs.sort()).toEqual(["job-2", "job-3"]);
		expect((await client.servers()).servers.map((s) => s.job)).toEqual(["job-1"]);
		// Three at once is critical.
		for (const j of ["job-5", "job-6", "job-7"]) await ingest("heartbeat", hb(j, { b: "dev" }));
		now += 91_000;
		await ingest("heartbeat", hb("job-1", { q: 42 }));
		await app.fleet?.sweep();
		expect((await client.alerts({ level: "critical" })).find((a) => a.code === "server_lost")?.branch).toBe("dev");
	});

	test("game and CLI alerts, ack, filters", async () => {
		const id = await client.alert({ level: "critical", code: "auto_rollback", message: "rolled prod back to seq 41 after 3 failed swaps", b: "prod", a: "art-42", s: 42 });
		const a = (await client.alerts({ unacked: true })).find((x) => x.id === id);
		expect(a).toMatchObject({ code: "auto_rollback", source: "cli", level: "critical" });
		const game = await ingest("alert", { level: "warning", code: "swap_slow", message: "swap took 12 s", j: "job-1", b: "prod", a: "art-42", s: 42, t: now, g: 4, k: "0.3.2" });
		expect(game.status).toBe(202);
		expect(await client.ack(id, "dev-pc")).toBe(true);
		expect(await client.ack(id)).toBe(false);
		expect((await client.alerts({ unacked: true })).some((x) => x.id === id)).toBe(false);
		expect((await client.alerts({ since: now + 1 })).length).toBe(0);
		await expect(client.alerts({ level: "nope" as never })).rejects.toBeInstanceOf(FleetApiError);
	});

	test("critical alerts reach the webhook (Discord format), deduped per (code, branch, artifact)", async () => {
		await app.notifier?.flush();
		const sent = hooks.map((h) => (h.body as { content: string }).content);
		expect(sent.some((c) => c.startsWith("CRITICAL: auto_rollback (prod, art-42, seq 42)"))).toBe(true);
		expect(sent.some((c) => c.includes("server_lost (dev"))).toBe(true);
		expect(sent.some((c) => c.includes("swap_slow"))).toBe(false); // warnings aren't sent by default
		const before = hooks.length;
		await client.alert({ level: "critical", code: "auto_rollback", message: "again", b: "prod", a: "art-42" });
		await app.notifier?.flush();
		expect(hooks.length).toBe(before);
		expect(app.notifier?.stats.deduped).toBeGreaterThan(0);
	});
});

test("SSE stream: live changes and new alerts", async () => {
	const seen: FleetEvent["type"][] = [];
	const got = new Promise<void>((done) => {
		const s = client.stream((event) => {
			if (event.type === "hello") {
				void ingest("heartbeat", hb("job-1", { q: 42, n: 3 }));
				return;
			}
			seen.push(event.type);
			if (event.type === "server") {
				expect(JSON.stringify(event)).not.toContain(ACCESS_CODE);
				void client.alert({ level: "warning", code: "test_alert", message: "hello" });
			}
			if (event.type === "alert") {
				s.close();
				done();
			}
		});
	});
	await got;
	expect(seen).toEqual(["server", "alert"]);
});

describe("the kernel's and the CLI's shapes", () => {
	test("servers: long names, seconds -> ISO, x -> experiment, sv -> serverVersion", async () => {
		await ingest("heartbeat", hb("job-k", { x: 1, t: "reserved", b: "kernel-shape" }));
		const [s] = (await client.servers({ branch: "kernel-shape" })).servers;
		expect(s).toMatchObject({ job: "job-k", serverType: "reserved", experiment: true, serverVersion: 2, appliedSeq: 41, kernel: "0.3.2", health: "ok" });
		expect(s.startedAt).toBe(new Date(Math.floor((T0 - 3_600_000) / 1000) * 1000).toISOString());
	});

	test("closing with the heartbeat body plus closing = true (BindToClose)", async () => {
		expect((await ingest("closing", { ...hb("job-k", { b: "kernel-shape", n: 0 }), closing: true })).status).toBe(202);
		expect((await client.servers({ branch: "kernel-shape" })).servers).toEqual([]);
	});

	test("GET reports carries { reports: [...] } rows; alerts carry at (ms) and acked", async () => {
		const body = (await (await fetch(`${base}/v1/fleet/reports?seq=42`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { reports: { seq: number; job: string; result: string; at: number }[] };
		expect(body.reports.map((r) => [r.seq, r.job, r.result])).toEqual([
			[42, "job-1", "swapped"],
			[42, "job-2", "failed"],
		]);
		expect(typeof body.reports[0].at).toBe("number");
		const latest = (await (await fetch(`${base}/v1/fleet/reports?latest`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { seq: number };
		expect(latest.seq).toBe(42);
		const cli = await ingest("alert", { level: "warning", code: "server_stuck", message: "2 servers below #42 [job-3, job-4]", j: "cli", b: "prod", s: 42, t: Math.floor(now / 1000) });
		expect(cli.status).toBe(202);
		const alerts = (await (await fetch(`${base}/v1/fleet/alerts?since=0&level=warning`, { headers: { authorization: `Bearer ${ADMIN}` } })).json()) as { alerts: { code: string; at: number; acked: boolean; source: string; job: string | null }[] };
		const stuck = alerts.alerts.find((a) => a.code === "server_stuck" && a.source === "cli");
		expect(stuck).toMatchObject({ acked: false, job: null });
		expect(typeof stuck?.at).toBe("number");
	});
});

describe("notifier and storage units", () => {
	test("formats", () => {
		expect(detectFormat("https://discord.com/api/webhooks/1/x")).toBe("discord");
		expect(detectFormat("https://hooks.slack.com/services/x")).toBe("slack");
		expect(detectFormat("https://example.com/hook")).toBe("json");
		const alert = { id: 1, level: "critical" as const, code: "server_lost", message: "3 servers ...", job: null, branch: "prod", artifact: "a", seq: null, generation: null, kernel: null, source: "server" as const, details: null, createdAt: "", at: 0, acked: false, ackedAt: null, ackedBy: null };
		expect(alertText(alert)).toBe("CRITICAL: server_lost (prod, a): 3 servers ...");
		expect(webhookBody(alert, "slack")).toEqual({ text: "CRITICAL: server_lost (prod, a): 3 servers ..." });
		expect(webhookBody(alert, "json")).toEqual({ alert });
		expect(() => createNotifier({ url: "http://insecure.example.com" })).toThrow("https");
	});

	test("throttle", async () => {
		const posts: unknown[] = [];
		const n = createNotifier({ url: "https://example.com/h", perMinute: 2, fetch: (async (_u: unknown, init?: RequestInit) => (posts.push(init?.body), new Response(""))) as unknown as typeof fetch, clock: () => T0 });
		for (let i = 0; i < 5; i++) n.notify({ id: i, level: "critical", code: `c${i}`, message: "m", job: null, branch: null, artifact: null, seq: null, generation: null, kernel: null, source: "game", details: null, createdAt: "", at: 0, acked: false, ackedAt: null, ackedBy: null });
		await n.flush();
		expect(posts.length).toBe(2);
		expect(n.stats.throttled).toBe(3);
	});

	test("the service works on its own over an in-memory SQLite", async () => {
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => T0 });
		await service.heartbeat({ j: "a", b: "prod", q: 1 });
		expect((await service.servers()).servers.length).toBe(1);
		await service.close();
	});
});
