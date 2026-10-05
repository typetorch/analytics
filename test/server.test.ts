/** The analytics server end to end over HTTP: ingest, loader, nightly Parquet export, queries, erasure. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { startApp, type App } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { verifyRobloxSignature } from "../src/server/erasure.ts";
import { RemoteStore } from "../src/store/remote.ts";
import { Graph } from "../src/graph.ts";
import { DAY, NOW, generateFixture } from "./fixtures.ts";

const INGEST = "ingest-token-for-tests-0123456789";
const ADMIN = "admin-token-for-tests-0123456789ab";
const SECRET = "webhook-secret-for-tests";
const OC_KEY = "open-cloud-key-for-tests-000";

const fx = generateFixture();
// Two days of data: the day before NOW and NOW's day (before NOW).
const dayStart = Math.floor(NOW / DAY) * DAY;
const events = fx.events.filter((e) => e.t >= dayStart - DAY && e.t < NOW);
const recordings = fx.recordings.filter((r) => r.t >= dayStart - DAY && r.t < NOW);
// Two players with rows in the window: one erased through the webhook, one by pid.
const players = [...new Set(events.filter((e) => e.pid).map((e) => e.pid as string))];
const PID_WEBHOOK = players[0];
const PID_ADMIN = players[1];

let dir: string;
let now = NOW;
let app: App;
let base: string;
const ocCalls: string[] = [];

function config(extra: Record<string, string> = {}) {
	return loadConfig([], {
		TT_ANALYTICS_DATA: dir,
		TT_ANALYTICS_PORT: "0",
		TT_ANALYTICS_INGEST_TOKENS: `${INGEST},second-ingest-token-0123456789`,
		TT_ANALYTICS_ADMIN_TOKEN: ADMIN,
		TT_ANALYTICS_WEBHOOK_SECRET: SECRET,
		TT_ANALYTICS_OPENCLOUD_KEY: OC_KEY,
		TT_ANALYTICS_UNIVERSE_ID: "4242",
		TT_ANALYTICS_JOB_PER_MINUTE: "1000",
		TT_ANALYTICS_MEMORY_LIMIT: "256MB",
		TT_SERVER_PARTS: "analytics",
		...extra,
	});
}

const fakeOpenCloud = (async (input: string | URL | Request) => {
	const url = String(input);
	ocCalls.push(url);
	if (url.endsWith("/entries/p%2F1001")) return new Response(JSON.stringify({ value: { pid: PID_WEBHOOK, first: 1 } }), { status: 200 });
	return new Response("{}", { status: 404 });
}) as typeof fetch;

async function post(path: string, body: unknown, headers: Record<string, string> = {}, raw?: Uint8Array | string): Promise<Response> {
	return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw ?? JSON.stringify(body) });
}

const ingestHeaders = { authorization: `Bearer ${INGEST}`, "content-encoding": "gzip" };
const admin = { authorization: `Bearer ${ADMIN}` };
const gz = (body: unknown) => gzipSync(Buffer.from(JSON.stringify(body)));

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "tt-analytics-"));
	app = await startApp(config(), { clock: () => now, manualJobs: true, log: () => {}, fetch: fakeOpenCloud });
	base = `http://127.0.0.1:${app.port}`;
});
afterAll(async () => {
	await app.stop();
	rmSync(dir, { recursive: true, force: true });
});

describe("ingest", () => {
	test("refuses bad tokens, sizes and shapes", async () => {
		expect((await post("/v1/ingest", {}, {})).status).toBe(401);
		expect((await post("/v1/ingest", {}, { authorization: "Bearer wrong-token-0123456789abcdef" })).status).toBe(401);
		expect((await post("/v1/ingest", null, ingestHeaders, new Uint8Array([0x1f, 0x8b, 1, 2, 3]))).status).toBe(400);
		expect((await post("/v1/ingest", null, { authorization: `Bearer ${INGEST}` }, "{nope")).status).toBe(400);
		expect((await post("/v1/ingest", { events: {} }, { authorization: `Bearer ${INGEST}` })).status).toBe(400);
		const huge = new Uint8Array(3 * 1024 * 1024);
		expect((await post("/v1/ingest", null, { authorization: `Bearer ${INGEST}` }, huge)).status).toBe(413);
		// A gzip bomb: small on the wire, over the inflate cap.
		const bomb = gzipSync(Buffer.alloc(20 * 1024 * 1024, 32));
		expect((await post("/v1/ingest", null, ingestHeaders, bomb)).status).toBe(413);
		expect((await fetch(`${base}/v1/ingest`)).status).toBe(405);
	});

	test("accepts a gzip batch (202), counts bad rows, writes raw files first", async () => {
		const half = Math.floor(events.length / 2);
		const r1 = await post("/v1/ingest", null, ingestHeaders, gz({ events: [...events.slice(0, half), { v: 1, t: 5, kind: "x" }], recordings }));
		expect(r1.status).toBe(202);
		expect(await r1.json()).toMatchObject({ accepted: half + recordings.length, rejected: 1 });
		// The second token works too (rotation).
		const r2 = await post("/v1/ingest", null, { ...ingestHeaders, authorization: "Bearer second-ingest-token-0123456789" }, gz({ events: events.slice(half) }));
		expect(r2.status).toBe(202);
		const raw = readdirSync(join(dir, "raw", "incoming"));
		expect(raw.some((f) => f.startsWith("events-") && f.endsWith(".ndjson.open"))).toBe(true);
		expect(raw.some((f) => f.startsWith("recordings-"))).toBe(true);
	});

	test("the loader moves raw files into DuckDB and archives them", async () => {
		const { rows, files } = await app.load();
		expect(rows).toBe(events.length + recordings.length);
		expect(files).toBe(2); // one open file per table, both batches in it
		expect(readdirSync(join(dir, "raw", "incoming"))).toEqual([]);
		const archived = readdirSync(join(dir, "raw", "archive")).flatMap((d) => readdirSync(join(dir, "raw", "archive", d)));
		expect(archived.length).toBe(2);
		expect(archived.every((f) => f.endsWith(".ndjson.gz"))).toBe(true);
		expect(await app.warehouse?.liveRows()).toEqual({ events: events.length, recordings: recordings.length });
	});
});

describe("queries over HTTP", () => {
	test("admin token required; results; input errors are 400", async () => {
		expect((await post("/v1/query/overview", {})).status).toBe(401);
		expect((await post("/v1/query/overview", {}, { authorization: `Bearer ${INGEST}` })).status).toBe(401);
		const r = await post("/v1/query/overview", { filters: { from: dayStart - DAY } }, admin);
		expect(r.status).toBe(200);
		const { result } = (await r.json()) as { result: { events: number; players: number } };
		expect(result.events).toBe(events.length);
		expect(result.players).toBe(new Set(events.filter((e) => e.pid).map((e) => e.pid)).size);
		expect((await post("/v1/query/nope", {}, admin)).status).toBe(404);
		expect((await post("/v1/query/overview", { filters: { dev: "fridge" } }, admin)).status).toBe(400);
		const list = (await (await fetch(`${base}/v1/queries`, { headers: admin })).json()) as { queries: { name: string }[] };
		expect(list.queries.map((q) => q.name)).toContain("flow");
	});

	test("the remote store talks to it", async () => {
		const store = new RemoteStore({ url: base, token: ADMIN });
		const g = await store.query("flow", { from: dayStart - DAY }, { facet: "zone" });
		expect(g).toBeInstanceOf(Graph);
		expect(g.edges.length).toBeGreaterThan(0);
		const servers = await store.query("servers");
		expect(servers.servers.map((s) => s.job).sort()).toEqual(["job-1", "job-2", "job-4"]);
		await expect(new RemoteStore({ url: base, token: "wrong-token-0123456789abcdef" }).query("overview")).rejects.toThrow("401");
		expect(() => new RemoteStore({ url: "http://example.com", token: "x" })).toThrow("https");
	});
});

describe("nightly export", () => {
	let before: unknown;
	test("finished days go to Parquet, queries read them the same", async () => {
		before = ((await (await post("/v1/query/overview", { filters: { from: dayStart - DAY } }, admin)).json()) as { result: unknown }).result;
		now = NOW + DAY; // the next day
		const result = await app.nightly();
		const yesterday = new Date(dayStart - DAY).toISOString().slice(0, 10);
		const today = new Date(dayStart).toISOString().slice(0, 10);
		expect(result.days).toEqual([yesterday, today]);
		expect(existsSync(join(dir, "events", `${yesterday}.parquet`))).toBe(true);
		const recordingDays = [...new Set(recordings.map((r) => new Date(Math.floor(r.t / DAY) * DAY).toISOString().slice(0, 10)))];
		expect(recordingDays.length).toBeGreaterThan(0);
		for (const d of recordingDays) expect(existsSync(join(dir, "recordings", `${d}.parquet`))).toBe(true);
		expect(await app.warehouse?.liveRows()).toEqual({ events: 0, recordings: 0 });
		const after = ((await (await post("/v1/query/overview", { filters: { from: dayStart - DAY, to: NOW } }, admin)).json()) as { result: unknown }).result;
		expect({ ...(after as object), to: null }).toEqual({ ...(before as object), to: null });
	});

	test("rollups: daily numbers, players, edges", async () => {
		const daily = (await (await fetch(`${base}/v1/rollups/daily`, { headers: admin })).json()) as { rows: { players: number; sessions: number }[] };
		expect(daily.rows.length).toBeGreaterThan(0);
		const sessions = new Set(events.filter((e) => e.pid && e.sid).map((e) => e.sid)).size;
		expect(daily.rows.reduce((s, r) => s + Number(r.sessions), 0)).toBe(sessions);
		const one = (await (await fetch(`${base}/v1/rollups/players?pid=${PID_WEBHOOK}`, { headers: admin })).json()) as { rows: { pid: string }[] };
		expect(one.rows.map((r) => r.pid)).toEqual([PID_WEBHOOK]);
		const edges = (await (await fetch(`${base}/v1/rollups/edges?limit=5`, { headers: admin })).json()) as { rows: unknown[] };
		expect(edges.rows.length).toBe(5);
	});

	test("late rows for an exported day are merged into its file, not duplicated", async () => {
		const late = events.filter((e) => e.t < dayStart).slice(0, 10).map((e) => ({ ...e, name: "late", t: e.t + 1 }));
		expect((await post("/v1/ingest", null, ingestHeaders, gz({ events: late }))).status).toBe(202);
		await app.load();
		now = NOW + DAY + 7 * 3_600_000;
		await app.nightly();
		const r = (await (await post("/v1/query/top-events", { filters: { from: dayStart - DAY, to: dayStart } }, admin)).json()) as { result: { events: { name: string; count: number }[] } };
		expect(r.result.events.filter((e) => e.name === "late").reduce((sum, e) => sum + e.count, 0)).toBe(10);
		const total = (await (await post("/v1/query/overview", { filters: { from: dayStart - DAY, to: NOW } }, admin)).json()) as { result: { events: number } };
		expect(total.result.events).toBe(events.length + 10);
	});
});

describe("Right to Erasure", () => {
	test("signature checks", () => {
		const body = '{"a":1}';
		const t = Math.floor(NOW / 1000);
		const sig = createHmac("sha256", SECRET).update(`${t}.${body}`).digest("base64");
		expect(verifyRobloxSignature(`t=${t},v1=${sig}`, body, SECRET, NOW)).toEqual({ ok: true, t });
		expect(verifyRobloxSignature(`t=${t},v1=${sig}`, '{"a":2}', SECRET, NOW).ok).toBe(false);
		expect(verifyRobloxSignature(`t=${t - 3600},v1=${sig}`, body, SECRET, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("window") });
		expect(verifyRobloxSignature(`t=${t}`, body, SECRET, NOW)).toMatchObject({ ok: false, reason: expect.stringContaining("v1") });
		expect(verifyRobloxSignature(null, body, SECRET, NOW).ok).toBe(false);
	});

	function signed(body: unknown) {
		const text = JSON.stringify(body);
		const t = Math.floor(now / 1000);
		return { text, headers: { "roblox-signature": `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${text}`).digest("base64")}` } };
	}

	test("webhook: sample notification, bad signature, another game, unknown user", async () => {
		const sample = signed({ NotificationId: "n0", EventType: "SampleNotification", EventPayload: {} });
		expect(await (await post("/v1/erasure", null, sample.headers, sample.text)).json()).toMatchObject({ sample: true });
		expect((await post("/v1/erasure", null, { "roblox-signature": "t=1,v1=AAAA" }, sample.text)).status).toBe(401);
		const other = signed({ NotificationId: "n1", EventType: "RightToErasureRequest", EventPayload: { UserId: 1001, GameIds: [999] } });
		expect(await (await post("/v1/erasure", null, other.headers, other.text)).json()).toMatchObject({ ignored: "another game" });
		const unknown = signed({ NotificationId: "n2", EventType: "RightToErasureRequest", EventPayload: { UserId: 5, GameIds: [4242] } });
		expect(await (await post("/v1/erasure", null, unknown.headers, unknown.text)).json()).toMatchObject({ erased: 0 });
	});

	test("webhook: UserId -> pid through the DataStore, then every copy of the rows goes", async () => {
		const pid = PID_WEBHOOK;
		const has = async () => {
			const r = (await (await post("/v1/query/timeline", { filters: { from: dayStart - 30 * DAY, to: now }, options: { pid } }, admin)).json()) as { result: { events: unknown[] } };
			return r.result.events.length;
		};
		expect(await has()).toBeGreaterThan(0);
		const req = signed({ NotificationId: "n3", EventType: "RightToErasureRequest", EventTime: new Date(now).toISOString(), EventPayload: { UserId: 1001, GameIds: [4242] } });
		const r = await post("/v1/erasure", null, req.headers, req.text);
		expect(await r.json()).toMatchObject({ ok: true, erased: 1 });
		expect(ocCalls.at(-1)).toBe("https://apis.roblox.com/cloud/v2/universes/4242/data-stores/TypeTorchAnalytics/entries/p%2F1001");
		await app.warehouse?.rewriteErased();
		expect(await has()).toBe(0);
		// Raw archives and rollups are rewritten too.
		const archives = readdirSync(join(dir, "raw", "archive")).flatMap((d) => readdirSync(join(dir, "raw", "archive", d)).map((f) => join(dir, "raw", "archive", d, f)));
		for (const file of archives) expect(gunzipSync(readFileSync(file)).toString("utf8")).not.toContain(`"pid":"${pid}"`);
		const players = (await (await fetch(`${base}/v1/rollups/players?pid=${pid}`, { headers: admin })).json()) as { rows: unknown[] };
		expect(players.rows).toEqual([]);
		// Rows arriving later for that pid are dropped at load.
		await post("/v1/ingest", null, ingestHeaders, gz({ events: [{ ...events.find((e) => e.pid === pid), t: now - 1000 }] }));
		await app.load();
		expect(await has()).toBe(0);
		const log = readFileSync(join(dir, "erasure", "log.jsonl"), "utf8");
		expect(log).not.toContain("1001");
	});

	test("by pid with the admin token", async () => {
		const pid = PID_ADMIN;
		const r = await post("/v1/erasure", { pid }, admin);
		expect(r.status).toBe(200);
		await app.warehouse?.rewriteErased();
		const t = (await (await post("/v1/query/timeline", { filters: { from: dayStart - 30 * DAY, to: now }, options: { pid } }, admin)).json()) as { result: { events: unknown[] } };
		expect(t.result.events).toEqual([]);
		expect((await post("/v1/erasure", { pid: "x'; DROP" }, admin)).status).toBe(400);
	});
});

describe("settings and health", () => {
	test("live dials from data/settings.json", async () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ recordShare: 0.25, techEvery: 60, token: "never-served-0123456789", events: "x" }));
		expect((await fetch(`${base}/v1/settings`)).status).toBe(401);
		const r = await fetch(`${base}/v1/settings`, { headers: { authorization: `Bearer ${INGEST}` } });
		expect(await r.json()).toEqual({ recordShare: 0.25, techEvery: 60 });
	});

	test("healthz: public ok, details with the admin token", async () => {
		expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
		const h = (await (await fetch(`${base}/healthz`, { headers: admin })).json()) as { analytics: { loaderLagSeconds: number; loadedRows: number }; rssMb: number };
		expect(h.analytics.loaderLagSeconds).toBe(0);
		expect(h.analytics.loadedRows).toBeGreaterThan(0);
		expect(h.rssMb).toBeGreaterThan(0);
	});
});

test("a restart loads raw files the last run left open", async () => {
	const other = mkdtempSync(join(tmpdir(), "tt-analytics-restart-"));
	try {
		const incoming = join(other, "raw", "incoming");
		mkdirSync(incoming, { recursive: true });
		writeFileSync(join(incoming, `events-${NOW}-1.ndjson.open`), events.slice(0, 5).map((e) => `${JSON.stringify(e)}\n`).join(""));
		const cfg = { ...config(), dataDir: other };
		const second = await startApp(cfg, { clock: () => NOW, manualJobs: true, log: () => {} });
		expect((await second.load()).rows).toBe(5);
		await second.stop();
	} finally {
		rmSync(other, { recursive: true, force: true });
	}
});
