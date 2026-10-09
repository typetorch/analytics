/**
 * Plans/25: remote debug (watch -> heartbeat rd -> kernel long-poll -> results), its roles, limits, expiry and
 * memory-only answers, and the server page's read of one JobId. Tokens are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkCommand, RemoteDebugHub, RemoteDebugInputError, QUEUED_TTL_MS, RESULT_TTL_MS, SENT_TTL_MS, WATCH_MS } from "../src/fleet/remote-debug.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";

let h: Harness;
const JOB = "0b5c7d9e-1111-4a2b-9c3d-123456789abc";
/** A string that must never reach the disk: it rides in a result. */
const MARKER = "SECRET-RESULT-MARKER-7c1f";

const hb = (j: string, over: Record<string, unknown> = {}) => ({
	j,
	t: "public",
	b: "prod",
	c: "prod",
	a: "art-1",
	n: 3,
	m: 20,
	s: Math.floor((h.now() - 3_600_000) / 1000),
	u: Math.floor(h.now() / 1000),
	p: 1001,
	v: "0.5.0",
	q: 7,
	g: 2,
	h: "ok",
	sv: 2,
	...over,
});
const heartbeat = (j: string, over: Record<string, unknown> = {}) => h.call("/v1/fleet/heartbeat", post(API, hb(j, over)));
const admin = (path: string, init: RequestInit = {}) => h.call(path, { ...init, headers: { ...bearer(ADMIN), "content-type": "application/json", ...(init.headers as Record<string, string>) } });
const watch = (job = JOB) => admin(`/v1/fleet/servers/${job}/watch`, { method: "POST" });
const command = (op: unknown, args?: unknown, job = JOB) => admin(`/v1/fleet/servers/${job}/commands`, { method: "POST", body: JSON.stringify({ op, ...(args !== undefined ? { args } : {}) }) });
const read = (id: string, job = JOB) => admin(`/v1/fleet/servers/${job}/commands/${id}`);
const poll = (job = JOB, wait = 0, token = API) => h.call(`/v1/fleet/commands?wait=${wait}`, { headers: { ...bearer(token), "x-tt-job": job } });
const results = (job: string, list: unknown[], token = API) => h.call("/v1/fleet/results", post(token, { j: job, results: list }));

function filesUnder(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) out.push(...filesUnder(path));
		else out.push(path);
	}
	return out;
}

beforeAll(async () => {
	h = await harness({ TYPETORCH_PARTS: "fleet" });
});
afterAll(async () => {
	await h.close();
});

describe("the server page's reads", () => {
	test("a JobId of any age: unknown, live, closed, lost", async () => {
		expect(await asJson(await admin("/v1/fleet/servers/never-seen"))).toMatchObject({ server: null, state: "unknown", debug: { watched: false, connected: false } });
		await heartbeat("page-1");
		const live = await asJson(await admin("/v1/fleet/servers/page-1"));
		expect(live).toMatchObject({ state: "live", server: { job: "page-1", branch: "prod", closedAt: null, lostAt: null } });
		await h.call("/v1/fleet/closing", post(API, { ...hb("page-1"), closing: true }));
		expect(await asJson(await admin("/v1/fleet/servers/page-1"))).toMatchObject({ state: "closed", server: { closedAt: expect.any(String) } });
		await heartbeat("page-2");
		h.setNow(T0 + 120_000);
		expect(await asJson(await admin("/v1/fleet/servers/page-2"))).toMatchObject({ state: "lost" });
		h.setNow(T0);
		expect((await admin("/v1/fleet/servers/bad%20job")).status).toBe(400);
	});

	test("other routes under a server (the heartbeat-metrics /metrics) are left to the fleet routes", async () => {
		const { isRemoteDebugPath } = await import("../src/fleet/remote-debug-http.ts");
		expect(isRemoteDebugPath(`/v1/fleet/servers/${JOB}`)).toBe(true);
		expect(isRemoteDebugPath(`/v1/fleet/servers/${JOB}/watch`)).toBe(true);
		expect(isRemoteDebugPath(`/v1/fleet/servers/${JOB}/commands/abc`)).toBe(true);
		expect(isRemoteDebugPath(`/v1/fleet/servers/${JOB}/metrics`)).toBe(false);
		expect(isRemoteDebugPath("/v1/fleet/servers")).toBe(false);
	});

	test("watching a closed or unknown server is refused (nothing to debug)", async () => {
		expect((await watch("page-1")).status).toBe(409);
		expect((await watch("never-seen")).status).toBe(409);
	});
});

describe("roles", () => {
	test("explorer routes need the admin role; the API key reads nothing there", async () => {
		await heartbeat(JOB);
		for (const path of [`/v1/fleet/servers/${JOB}`, "/v1/fleet/debug/audit", `/v1/fleet/servers/${JOB}/commands/abc`]) {
			expect((await h.call(path)).status).toBe(401);
			expect((await h.call(path, { headers: bearer(API) })).status).toBe(401);
		}
		expect((await h.call(`/v1/fleet/servers/${JOB}/watch`, post(API, {}))).status).toBe(401);
		expect((await h.call(`/v1/fleet/servers/${JOB}/commands`, post(API, { op: "status" }))).status).toBe(401);
	});

	test("game routes need the API key; the admin token is not a game key", async () => {
		expect((await poll(JOB, 0, ADMIN)).status).toBe(401);
		expect((await h.call(`/v1/fleet/commands?wait=0`, { headers: { "x-tt-job": JOB } })).status).toBe(401);
		expect((await results(JOB, [], ADMIN)).status).toBe(401);
		expect((await h.call("/v1/fleet/commands?wait=0", { headers: bearer(API) })).status).toBe(400); // no JobId
	});
});

describe("watch, heartbeat reply, poll, results", () => {
	test("the heartbeat reply says rd only while the job is watched", async () => {
		expect(await asJson(await heartbeat(JOB))).toEqual({ ok: true });
		const w = await asJson(await watch());
		expect(w).toMatchObject({ job: JOB, watched: true, watchedUntil: T0 + WATCH_MS, connected: false });
		expect(await asJson(await heartbeat(JOB))).toEqual({ ok: true, rd: 1 });
		await heartbeat("other-1");
		expect(await asJson(await heartbeat("other-1"))).toEqual({ ok: true }); // another server
		h.setNow(T0 + WATCH_MS + 1);
		expect(await asJson(await heartbeat(JOB))).toEqual({ ok: true });
		h.setNow(T0);
	});

	test("commands need a watch, an allowed op and good args; no write op exists", async () => {
		await heartbeat("nowatch-1");
		expect((await command("status", undefined, "nowatch-1")).status).toBe(409);
		await watch();
		for (const op of ["kick", "ban", "reload", "rollback", "pin", "switch", "run", "luau", "dex.set", "explorer.destroy", "toString", "__proto__"]) {
			const res = await command(op);
			expect(res.status).toBe(400);
			expect((await asJson(res)).error).toContain("read-only");
		}
		expect((await command("status", { extra: 1 })).status).toBe(400);
		expect((await command("logs", { limit: 9999 })).status).toBe(400);
		expect((await command("player.logs", {})).status).toBe(400);
		expect((await command("state", { queries: [] })).status).toBe(400);
		expect((await command("dex.children", { nodes: [{ id: 0, limit: 500 }] })).status).toBe(400);
		expect((await command("status", "nope")).status).toBe(400);
	});

	test("the kernel polls, runs and answers; the answer is read back once, only by whoever asked", async () => {
		await watch();
		const queued = await command("logs", { since: 10, limit: 50 });
		expect(queued.status).toBe(202);
		const { id, state, expiresAt } = await asJson(queued);
		expect(state).toBe("queued");
		expect(expiresAt).toBe(T0 + QUEUED_TTL_MS);
		const got = await asJson(await poll());
		expect(got.watch).toBe(true);
		expect(got.commands).toEqual([{ id, op: "logs", args: { since: 10, limit: 50 }, by: { kind: "token" }, exp: T0 + SENT_TTL_MS }]);
		expect((await asJson(await poll())).commands).toEqual([]); // handed out once
		expect(await asJson(await read(id))).toMatchObject({ id, state: "sent" });
		expect((await asJson(await admin(`/v1/fleet/servers/${JOB}`))).debug).toMatchObject({ watched: true, connected: true, lastPollAt: T0 });
		// Another job can't answer it; a bad id is ignored; the right job answers once.
		expect(await asJson(await results("other-1", [{ id, ok: true, json: "[]" }]))).toEqual({ accepted: 0, ignored: 1 });
		const answer = { entries: [{ i: 11, text: MARKER }] };
		expect(await asJson(await results(JOB, [{ id, ok: true, json: JSON.stringify(answer), ms: 12, redacted: 1 }, { id: "nope", ok: true }]))).toEqual({ accepted: 1, ignored: 1 });
		expect(await asJson(await results(JOB, [{ id, ok: true, json: "{}" }]))).toEqual({ accepted: 0, ignored: 1 });
		expect(await asJson(await read(id))).toMatchObject({ id, op: "logs", state: "done", result: answer, ms: 12, redacted: 1 });
		expect((await read(id, "other-1")).status).toBe(404); // the right id under another job
	});

	test("a failed op comes back as failed with its (cleaned) reason", async () => {
		await watch();
		const { id } = await asJson(await command("modules"));
		await poll();
		await results(JOB, [{ id, ok: false, error: "not_supported: the running build's framework has no remote debug\u0007" }]);
		expect(await asJson(await read(id))).toMatchObject({ state: "failed", error: "not_supported: the running build's framework has no remote debug " });
	});

	test("unknown JobIds poll nothing and leave nothing behind", async () => {
		expect(await asJson(await poll("ghost-job-1", 2))).toEqual({ watch: false, commands: [] });
	});

	test("a held poll answers as soon as a command is queued", async () => {
		await watch();
		const started = Date.now();
		const held = poll(JOB, 3);
		await new Promise((r) => setTimeout(r, 150));
		const { id } = await asJson(await command("status"));
		const got = await asJson(await held);
		expect(got.commands.map((c: { id: string }) => c.id)).toEqual([id]);
		expect(Date.now() - started).toBeLessThan(2500);
		await results(JOB, [{ id, ok: true, json: "{}" }]);
	});

	test("an unanswered poll is held at most `wait` seconds and says the job is still watched", async () => {
		await watch();
		const started = Date.now();
		expect(await asJson(await poll(JOB, 1))).toEqual({ watch: true, commands: [] });
		expect(Date.now() - started).toBeGreaterThanOrEqual(900);
	});
});

describe("expiry, memory only, audit", () => {
	test("a command nobody picks up expires after 30 s; a late answer is ignored; answers go after 3 minutes", async () => {
		const job = "expiry-1";
		await heartbeat(job);
		await watch(job);
		const { id } = await asJson(await command("budget", undefined, job));
		h.setNow(T0 + QUEUED_TTL_MS + 1);
		expect(await asJson(await read(id, job))).toMatchObject({ state: "expired", error: "the server never picked it up" });
		expect((await asJson(await poll(job))).commands).toEqual([]);
		// Picked up, then no answer in time.
		await watch(job);
		const second = (await asJson(await command("budget", undefined, job))).id;
		await poll(job);
		h.setNow(T0 + QUEUED_TTL_MS + 1 + SENT_TTL_MS + 1);
		expect(await asJson(await read(second, job))).toMatchObject({ state: "expired", error: "the server didn't answer in time" });
		expect(await asJson(await results(job, [{ id: second, ok: true, json: "{}" }]))).toEqual({ accepted: 0, ignored: 1 });
		h.setNow(T0 + QUEUED_TTL_MS + 1 + SENT_TTL_MS + 1 + RESULT_TTL_MS + 1);
		expect((await read(second, job)).status).toBe(404);
		expect((await read(id, job)).status).toBe(404);
		h.setNow(T0);
	});

	test("answers are dropped from memory after 3 minutes and never reach the disk; the audit has no answers and no player ids", async () => {
		await watch();
		const { id } = await asJson(await command("player.logs", { userId: 424242424 }));
		await poll();
		await results(JOB, [{ id, ok: true, json: JSON.stringify({ logs: [{ text: `${MARKER} Rider` }] }) }]);
		expect((await asJson(await read(id))).result.logs[0].text).toContain(MARKER);
		for (const file of filesUnder(h.dir)) {
			const text = readFileSync(file).toString("latin1");
			expect(text.includes(MARKER)).toBe(false);
		}
		const auditFile = join(h.dir, "audit", "remote-debug.jsonl");
		const lines = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const entry = lines.find((l) => l.id === id);
		expect(entry).toMatchObject({ who: "token", op: "player.logs", job: JOB, args: "one player" });
		expect(readFileSync(auditFile, "utf8")).not.toContain("424242424");
		expect(h.logs.some((l) => l.includes("remote debug: token player.logs (one player) on"))).toBe(true);
		expect(h.logs.join("\n")).not.toContain(MARKER);
		const audit = await asJson(await admin("/v1/fleet/debug/audit?limit=5"));
		expect(audit.entries[0]).toMatchObject({ op: "player.logs", who: "token" });
		h.setNow(T0 + RESULT_TTL_MS + 1);
		expect((await read(id)).status).toBe(404);
		const health = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		expect(health.remoteDebug).toMatchObject({ resultBytes: expect.any(Number), commands: expect.any(Number) });
		expect(JSON.stringify(health)).not.toContain(MARKER);
		h.setNow(T0);
	});

	test("results bodies are capped", async () => {
		expect((await results(JOB, [{ id: "x", ok: true, json: "x".repeat(600 * 1024) }])).status).toBe(413);
	});
});

describe("limits", () => {
	test("at most 8 commands wait per job", async () => {
		const job = "busy-1";
		await heartbeat(job);
		await watch(job);
		for (let i = 0; i < 8; i++) expect((await command("status", undefined, job)).status).toBe(202);
		const ninth = await command("status", undefined, job);
		expect(ninth.status).toBe(429);
		expect((await asJson(ninth)).error).toContain("8 commands waiting");
		// Answered ones make room.
		const sent = (await asJson(await poll(job))).commands as { id: string }[];
		await results(job, sent.map((c) => ({ id: c.id, ok: true, json: "{}" })));
		expect((await command("status", undefined, job)).status).toBe(202);
	});

	test("a known JobId's polls are limited (90 a minute); made-up JobIds never reach the per-JobId limiters", async () => {
		h.setNow(T0 + 7_200_000);
		const job = "poll-rate-1";
		await heartbeat(job);
		let refused = 0;
		for (let i = 0; i < 95; i++) if ((await poll(job)).status === 429) refused++;
		expect(refused).toBeGreaterThanOrEqual(1);
		// More polls and result posts than either limit from a JobId without a heartbeat: answered, nothing kept, never 429.
		for (let i = 0; i < 125; i++) {
			expect((await poll("ghost-rate-1")).status).toBe(200);
			const res = await results("ghost-rate-1", [{ id: "x", ok: true, json: "{}" }]);
			expect(res.status).toBe(202);
			expect(await asJson(res)).toEqual({ accepted: 0, ignored: 1 });
		}
		h.setNow(T0);
	});

	test("30 commands a minute per explorer user, 30 watches a minute", async () => {
		h.setNow(T0 + 3_600_000);
		const job = "rate-1";
		await heartbeat(job);
		await watch(job);
		let refused = 0;
		for (let i = 0; i < 31; i++) {
			const res = await command("status", undefined, job);
			if (res.status === 429) refused++;
			const sent = (await asJson(await poll(job))).commands as { id: string }[];
			await results(job, sent.map((c) => ({ id: c.id, ok: true, json: "{}" })));
		}
		expect(refused).toBeGreaterThanOrEqual(1);
		let watchRefused = 0;
		for (let i = 0; i < 31; i++) if ((await watch(job)).status === 429) watchRefused++;
		expect(watchRefused).toBeGreaterThanOrEqual(1);
		h.setNow(T0);
	});
});

describe("the hub", () => {
	test("Roblox callers: the game sees the UserId; another caller can't read the answer", async () => {
		let now = T0;
		const hub = new RemoteDebugHub({ clock: () => now, newId: (() => { let n = 0; return () => `c${++n}`; })() });
		const owner = { kind: "roblox", userId: 1234 } as const;
		hub.watch("j1", owner);
		const view = hub.enqueue("j1", "status", undefined, owner);
		expect(view).toMatchObject({ id: "c1", state: "queued" });
		const got = await hub.poll("j1", 0);
		expect(got.commands[0].by).toEqual({ kind: "roblox", userId: 1234 });
		hub.complete("j1", [{ id: "c1", ok: true, json: "{\"a\":1}" }]);
		expect(hub.get("c1", owner)).toMatchObject({ state: "done", result: { a: 1 } });
		expect(hub.get("c1", { kind: "roblox", userId: 99 })).toBeUndefined();
		expect(hub.get("c1", { kind: "token" })).toBeUndefined();
		now += WATCH_MS + 1;
		expect(hub.enqueue("j1", "status", undefined, owner)).toBe("not_watched");
	});

	test("a command keeps the job watched 60 s from then (the kernel keeps polling while the owner works)", () => {
		let now = T0;
		const hub = new RemoteDebugHub({ clock: () => now });
		hub.watch("j2", { kind: "token" });
		now += 50_000;
		hub.enqueue("j2", "status", undefined, { kind: "token" });
		now += 50_000;
		expect(hub.isWatched("j2")).toBe(true);
		expect(hub.heartbeatReply("j2")).toEqual({ rd: 1 });
		now += 11_000;
		expect(hub.isWatched("j2")).toBe(false);
	});

	test("at most 32 jobs are watched; the oldest watch goes", () => {
		let now = T0;
		const hub = new RemoteDebugHub({ clock: () => now });
		for (let i = 0; i < 33; i++) {
			now += 10;
			hub.watch(`job-${i}`, { kind: "token" });
		}
		expect(hub.isWatched("job-0")).toBe(false);
		expect(hub.isWatched("job-32")).toBe(true);
		expect(hub.memory.watched).toBe(32);
	});

	test("checkCommand: the allow-list and argument bounds", () => {
		expect(checkCommand("dex.children", { nodes: [{ id: 0 }, { id: 5, offset: 200, limit: 200 }] }).args).toEqual({ nodes: [{ id: 0 }, { id: 5, offset: 200, limit: 200 }] });
		expect(checkCommand("state", { queries: [{ root: "", path: [], page: 0 }] }).args).toEqual({ queries: [{ side: "server", root: "", path: [], page: 0 }] });
		expect(() => checkCommand("state", { queries: [{ root: "X", path: Array(25).fill("s") }] })).toThrow(RemoteDebugInputError);
		expect(() => checkCommand("dex.children", { nodes: Array(9).fill({ id: 1 }) })).toThrow(RemoteDebugInputError);
		expect(() => checkCommand("logs", { since: -1 })).toThrow(RemoteDebugInputError);
		expect(() => checkCommand("hasOwnProperty", {})).toThrow(RemoteDebugInputError);
		expect(() => checkCommand("status", { pad: "x".repeat(20_000) })).toThrow(RemoteDebugInputError);
	});
});
