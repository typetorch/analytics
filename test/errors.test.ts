/** Error logs: POST /v1/errors, the store (kinds, per-minute counts, players), the admin reads, the live stream. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { ERROR_LIMITS, ErrorInputError, parseErrorBatch } from "../src/errors/parse.ts";
import { chooseBucket, spreadCount } from "../src/errors/store.ts";
import { ADMIN, API, T0, asJson, bearer, harness, json, post, type Harness } from "./harness.ts";

const MIN = 60_000;
const item = (over: Record<string, unknown> = {}) => ({
	fp: "fp-boom",
	template: "Script <player.name> failed: attempt to index nil",
	stack: "Workspace.Game.Round:42\nWorkspace.Game.Main:7",
	count: 3,
	firstAt: T0 - 2 * MIN,
	lastAt: T0 - MIN,
	branch: "prod",
	build: "a1b2c3d-000042",
	realm: "server",
	pids: ["p1", "p2"],
	...over,
});

describe("parseErrorBatch", () => {
	test("a good batch; seconds become ms; the bare array works; unknown fields are dropped", () => {
		const b = parseErrorBatch({ v: 1, j: "job-1", errors: [item({ firstAt: Math.floor((T0 - MIN) / 1000), lastAt: Math.floor(T0 / 1000), extra: "x" })] }, T0);
		expect(b).toMatchObject({ job: "job-1", rejected: 0, total: 3 });
		expect(b.items[0]).toMatchObject({ fp: "fp-boom", firstAt: T0 - MIN, lastAt: T0, realm: "server", branch: "prod", build: "a1b2c3d-000042", pids: ["p1", "p2"] });
		expect(b.items[0]).not.toHaveProperty("extra");
		expect(parseErrorBatch([item()], T0).items.length).toBe(1);
		expect(parseErrorBatch({ errors: [] }, T0)).toMatchObject({ job: null, items: [], total: 0 });
		const minimal = parseErrorBatch({ errors: [{ fp: "a", template: "t", count: 1, firstAt: T0, lastAt: T0, realm: "client" }] }, T0).items[0];
		expect(minimal).toMatchObject({ stack: null, branch: null, build: null, pids: [] });
	});

	test("the body itself must have the right shape (400)", () => {
		for (const bad of [null, "text", 5, {}, { errors: {} }, { errors: "x" }, { j: 5, errors: [] }, { j: "x".repeat(65), errors: [] }]) {
			expect(() => parseErrorBatch(bad, T0)).toThrow(ErrorInputError);
		}
		expect(() => parseErrorBatch({ errors: new Array(ERROR_LIMITS.items + 1).fill(item()) }, T0)).toThrow("at most 200");
		expect(parseErrorBatch({ errors: new Array(ERROR_LIMITS.items).fill(item()) }, T0).items.length).toBe(200);
	});

	test("bad items are dropped and counted, with the first few reasons", () => {
		const bad = [
			item({ fp: "" }),
			item({ fp: "has space" }),
			item({ fp: "x".repeat(65) }),
			item({ template: "" }),
			item({ template: "t".repeat(ERROR_LIMITS.template + 1) }),
			item({ stack: "s".repeat(ERROR_LIMITS.stack + 1) }),
			item({ template: "nul\0inside" }),
			item({ count: 0 }),
			item({ count: 1.5 }),
			item({ count: ERROR_LIMITS.count + 1 }),
			item({ count: "3" }),
			item({ firstAt: T0, lastAt: T0 - MIN }),
			item({ firstAt: T0 - 8 * 86_400_000, lastAt: T0 - 8 * 86_400_000 + 1000 }),
			item({ firstAt: T0, lastAt: T0 + 3_600_000 }),
			item({ firstAt: "now", lastAt: T0 }),
			item({ realm: "studio" }),
			item({ realm: undefined }),
			item({ branch: "b".repeat(65) }),
			item({ pids: "p1" }),
			"not an object",
			null,
		];
		const b = parseErrorBatch({ errors: [...bad, item()] }, T0);
		expect(b.items.length).toBe(1);
		expect(b.rejected).toBe(bad.length);
		expect(b.errors.length).toBe(5);
		expect(b.errors[0]).toContain("errors[0]");
	});

	test("limits of the pid list: at most 50, bad ids dropped", () => {
		const pids = [...Array.from({ length: 70 }, (_, i) => `p${i}`), "bad id", "x".repeat(65), 5];
		const out = parseErrorBatch({ errors: [item({ pids })] }, T0).items[0]?.pids as string[];
		expect(out.length).toBe(50);
		expect(out.every((p) => /^[A-Za-z0-9_-]{1,64}$/.test(p))).toBe(true);
	});

	test("counts are spread over the minutes an item covers", () => {
		expect(spreadCount(10, T0, T0)).toEqual([{ minute: Math.floor(T0 / MIN), n: 10 }]);
		expect(spreadCount(10, T0 - 3 * MIN, T0)).toEqual([
			{ minute: Math.floor(T0 / MIN) - 3, n: 2 },
			{ minute: Math.floor(T0 / MIN) - 2, n: 2 },
			{ minute: Math.floor(T0 / MIN) - 1, n: 2 },
			{ minute: Math.floor(T0 / MIN), n: 4 },
		]);
		// Longer than an hour: all in the last minute.
		expect(spreadCount(10, T0 - 3 * 3_600_000, T0)).toEqual([{ minute: Math.floor(T0 / MIN), n: 10 }]);
		expect(spreadCount(2, T0 - 3 * MIN, T0).reduce((s, x) => s + x.n, 0)).toBe(2);
		expect(chooseBucket(3_600_000)).toBe(60);
		expect(chooseBucket(24 * 3_600_000)).toBe(1800);
		expect(chooseBucket(30 * 86_400_000)).toBe(43200);
		expect(chooseBucket(3_600_000, 300)).toBe(300);
		expect(chooseBucket(30 * 86_400_000, 60)).toBeGreaterThan(60);
	});
});

describe("POST /v1/errors", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	test("accepts a batch with the API key; the admin token and anonymous callers are refused", async () => {
		const ok = await h.call("/v1/errors", post(API, { v: 1, j: "job-e1", errors: [item(), item({ fp: "fp-other", template: "other <player.user_id>", count: 1, pids: [] })] }));
		expect(ok.status).toBe(202);
		expect(await asJson(ok)).toEqual({ accepted: 2, rejected: 0 });
		expect((await h.call("/v1/errors", post(ADMIN, { errors: [] }))).status).toBe(401);
		expect((await h.call("/v1/errors", post(undefined, { errors: [] }))).status).toBe(401);
		expect((await h.call("/v1/errors", { method: "PUT", ...json({ errors: [] }), headers: { ...bearer(API) } })).status).toBe(401);
	});

	test("strict sizes like /v1/ingest: shape 400, body 413, inflated 413, bad rows counted", async () => {
		expect((await h.call("/v1/errors", post(API, { errors: "nope" }))).status).toBe(400);
		expect((await h.call("/v1/errors", { method: "POST", body: "{nope", headers: bearer(API) })).status).toBe(400);
		expect((await h.call("/v1/errors", { method: "POST", body: new Uint8Array([0x1f, 0x8b, 1, 2, 3]), headers: { ...bearer(API), "content-encoding": "gzip" } })).status).toBe(400);
		expect((await h.call("/v1/errors", { method: "POST", body: new Uint8Array(600 * 1024), headers: bearer(API) })).status).toBe(413);
		const bomb = gzipSync(Buffer.alloc(5 * 1024 * 1024, 32));
		expect((await h.call("/v1/errors", { method: "POST", body: bomb, headers: { ...bearer(API), "content-encoding": "gzip" } })).status).toBe(413);
		expect((await h.call("/v1/errors", post(API, { errors: new Array(201).fill(item()) }))).status).toBe(400);
		const mixed = await h.call("/v1/errors", post(API, { errors: [item({ fp: "fp-mixed" }), item({ count: -1 }), item({ realm: "x" })] }));
		expect(mixed.status).toBe(202);
		expect(await asJson(mixed)).toMatchObject({ accepted: 1, rejected: 2 });
		const gz = await h.call("/v1/errors", { method: "POST", body: gzipSync(Buffer.from(JSON.stringify({ errors: [item({ fp: "fp-gz" })] }))), headers: { ...bearer(API), "content-encoding": "gzip" } });
		expect(gz.status).toBe(202);
	});

	test("rate limit per JobId", async () => {
		let limited = 0;
		for (let i = 0; i < 40; i++) if ((await h.call("/v1/errors", post(API, { j: "job-flood", errors: [] }))).status === 429) limited++;
		expect(limited).toBeGreaterThan(0);
		expect((await h.call("/v1/errors", post(API, { j: "job-other", errors: [] }))).status).toBe(202);
	});
});

describe("error kinds, counts and the admin reads", () => {
	let h: Harness;
	const get = async (path: string) => asJson(await h.call(path, { headers: bearer(ADMIN) }));
	beforeAll(async () => {
		h = await harness({ TYPETORCH_ERROR_MAX_KINDS: "10" });
		const send = async (...items: Record<string, unknown>[]) => expect((await h.call("/v1/errors", post(API, { j: "job-a", errors: items }))).status).toBe(202);
		// Three minutes of one server error on prod build A, two players...
		await send(item({ count: 4, firstAt: T0 - 3 * MIN, lastAt: T0 - 3 * MIN, pids: ["p1", "p2"] }));
		await send(item({ count: 6, firstAt: T0 - 2 * MIN, lastAt: T0 - 2 * MIN, pids: ["p2", "p3"], stack: "a different later stack" }));
		// ...the same kind on dev build B (client),
		await send(item({ count: 2, firstAt: T0 - MIN, lastAt: T0 - MIN, branch: "dev", build: "b2-000043", realm: "client", pids: ["p4"] }));
		// ...and a second kind, once, two hours ago.
		await send({ fp: "fp-two", template: "HTTP 429 from <url>", count: 1, firstAt: T0 - 2 * 3_600_000, lastAt: T0 - 2 * 3_600_000, branch: "prod", build: "a1b2c3d-000042", realm: "server", pids: [] });
		await h.app.bus.idle();
	});
	afterAll(() => h.close());

	test("the list: kinds in a window with counts, players, a sparkline and the sample stack's first line", async () => {
		const r = await get("/v1/errors?window=1h");
		expect(r.window).toMatchObject({ bucketSeconds: 60, buckets: 60 });
		expect(r.kinds.map((k: { fp: string }) => k.fp)).toEqual(["fp-boom"]); // fp-two is two hours old
		const k = r.kinds[0];
		expect(k).toMatchObject({ fp: "fp-boom", count: 12, players: 4, total: 12, realm: "server", topFrame: "Workspace.Game.Round:42" });
		expect(k.template).toContain("<player.name>");
		expect(k.spark.length).toBe(60);
		expect(k.spark.reduce((a: number, b: number) => a + b, 0)).toBe(12);
		expect(k.spark.slice(-4)).toEqual([0, 4, 6, 2]); // T0-4m, T0-3m, T0-2m, T0-1m: the window ends at T0, exclusive
		expect(r.totals).toEqual({ count: 12, kinds: 1, players: 4 });
		const wide = await get("/v1/errors?window=24h");
		expect(wide.kinds.map((x: { fp: string }) => x.fp)).toEqual(["fp-boom", "fp-two"]);
		expect(wide.totals).toMatchObject({ count: 13, kinds: 2 });
		expect(wide.window.bucketSeconds).toBe(1800);
		expect(wide.kinds[0].spark.length).toBe(wide.window.buckets);
	});

	test("filters: branch, build, realm, text; limit", async () => {
		const dev = await get("/v1/errors?window=1h&branch=dev");
		expect(dev.kinds[0]).toMatchObject({ fp: "fp-boom", count: 2, players: 1 });
		expect((await get("/v1/errors?window=1h&build=a1b2c3d-000042")).kinds[0]).toMatchObject({ count: 10, players: 3 });
		expect((await get("/v1/errors?window=1h&realm=client")).kinds[0]).toMatchObject({ count: 2 });
		expect((await get("/v1/errors?window=24h&q=HTTP%20429")).kinds.map((x: { fp: string }) => x.fp)).toEqual(["fp-two"]);
		expect((await get("/v1/errors?window=24h&q=fp-two")).kinds.length).toBe(1);
		expect((await get("/v1/errors?window=24h&q=%25")).kinds.length).toBe(0); // % is text, not a wildcard
		const one = await get("/v1/errors?window=24h&limit=1");
		expect(one.kinds.length).toBe(1);
		expect(one.more).toBe(1);
		expect((await get("/v1/errors?window=1h&branch=nowhere")).kinds).toEqual([]);
	});

	test("one kind: the first sample stack is kept, series, where it happens", async () => {
		const d = await get("/v1/errors/fp-boom?window=1h");
		expect(d.kind).toMatchObject({ fp: "fp-boom", stack: "Workspace.Game.Round:42\nWorkspace.Game.Main:7", realm: "server", total: 12 });
		expect(d.kind.firstAt).toBe(new Date(T0 - 3 * MIN).toISOString());
		expect(d.kind.lastAt).toBe(new Date(T0 - MIN).toISOString());
		expect(d).toMatchObject({ count: 12, players: 4 });
		expect(d.series.length).toBe(60);
		expect(d.series.reduce((s: number, p: { n: number }) => s + p.n, 0)).toBe(12);
		expect(d.series.at(-1)).toEqual({ t: new Date(Math.floor((T0 - MIN) / MIN) * MIN).toISOString(), n: 2 });
		expect(d.series.at(-2)).toEqual({ t: new Date(Math.floor((T0 - 2 * MIN) / MIN) * MIN).toISOString(), n: 6 });
		expect(d.byBuild).toEqual([
			{ build: "a1b2c3d-000042", n: 10 },
			{ build: "b2-000043", n: 2 },
		]);
		expect(d.byBranch).toEqual([
			{ branch: "prod", n: 10 },
			{ branch: "dev", n: 2 },
		]);
		expect(d.byRealm).toEqual([
			{ realm: "server", n: 10 },
			{ realm: "client", n: 2 },
		]);
		expect((await get("/v1/errors/fp-boom?window=1h&branch=dev")).count).toBe(2);
		expect((await h.call("/v1/errors/nope", { headers: bearer(ADMIN) })).status).toBe(404);
		expect((await h.call("/v1/errors/bad%20fp", { headers: bearer(ADMIN) })).status).toBe(400);
	});

	test("bad parameters are 400", async () => {
		for (const q of ["window=5x", "window=0m", "from=yesterday", "bucket=10", "bucket=999999", "limit=0", "limit=501", "realm=moon", "from=2026-10-09T13:00:00Z&to=2026-10-09T12:00:00Z"]) {
			expect([q, (await h.call(`/v1/errors?${q}`, { headers: bearer(ADMIN) })).status]).toEqual([q, 400]);
		}
		// Explicit from / to and a bucket work.
		const r = await get(`/v1/errors?from=${T0 - 10 * MIN}&to=${T0}&bucket=300`);
		expect(r.window.bucketSeconds).toBe(300);
		expect(r.kinds[0].count).toBe(12);
	});

	test("stats and the kind cap: kinds past the limit are dropped and counted", async () => {
		const many = Array.from({ length: 15 }, (_, i) => item({ fp: `fp-many-${i}`, count: 1, pids: [] }));
		const res = await h.call("/v1/errors", post(API, { j: "job-b", errors: many }));
		expect(res.status).toBe(202);
		await h.app.bus.idle();
		const stats = h.app.errors.stats;
		expect(stats.kinds).toBe(10);
		expect(stats.droppedKinds).toBe(7); // 2 kinds existed, room for 8 more, 15 sent
		const detail = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		expect(detail.errors).toMatchObject({ kinds: 10, droppedKinds: 7 });
		// A known kind still counts when the table is full.
		await h.call("/v1/errors", post(API, { j: "job-b", errors: [item({ count: 5 })] }));
		expect((await get("/v1/errors?window=1h")).kinds.find((k: { fp: string }) => k.fp === "fp-boom").count).toBe(17);
	});

	test("old counts and kinds are pruned", async () => {
		h.setNow(T0 + 40 * 86_400_000);
		expect(await h.app.errors.prune()).toBeGreaterThan(0);
		expect((await get("/v1/errors?window=30d")).kinds).toEqual([]);
		expect(h.app.errors.stats.kinds).toBe(0);
		h.setNow(T0);
	});
});

describe("GET /v1/live", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness();
	});
	afterAll(() => h.close());

	/** Reads SSE frames from a response until `until` says stop (or the timeout). */
	async function frames(res: Response, until: (events: { event: string; data: any }[]) => boolean, ms = 4000) {
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const decoder = new TextDecoder();
		const events: { event: string; data: any }[] = [];
		let buffer = "";
		const stop = Date.now() + ms;
		// One read stays pending between rounds: dropping it would lose its chunk.
		let pending: Promise<{ done: boolean; value?: Uint8Array }> | undefined;
		while (Date.now() < stop && !until(events)) {
			pending ??= reader.read();
			const next = await Promise.race([pending, new Promise<undefined>((r) => setTimeout(() => r(undefined), 200))]);
			if (!next) continue;
			pending = undefined;
			if (next.done) break;
			if (next.value) buffer += decoder.decode(next.value);
			for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
				const raw = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				const event = /^event: (.*)$/m.exec(raw)?.[1];
				const data = /^data: (.*)$/m.exec(raw)?.[1];
				if (event && data) events.push({ event, data: JSON.parse(data) });
			}
		}
		await reader.cancel().catch(() => {});
		return events;
	}

	test("admin only; topics are checked", async () => {
		expect((await h.call("/v1/live")).status).toBe(401);
		expect((await h.call("/v1/live", { headers: bearer(API) })).status).toBe(401);
		const bad = await h.call("/v1/live?topics=events,nope", { headers: bearer(ADMIN) });
		expect(bad.status).toBe(400);
		expect((await asJson(bad)).error).toContain("nope");
		const ok = await h.call("/v1/live?topics=error", { headers: bearer(ADMIN) });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type")).toBe("text/event-stream");
		await ok.body?.cancel();
	});

	test("errors, alerts, deploys and summed-up events and heartbeats arrive; other topics are filtered out", async () => {
		const res = await h.call("/v1/live", { headers: bearer(ADMIN) });
		const only = await h.call("/v1/live?topics=alert", { headers: bearer(ADMIN) });
		const started = frames(res, (e) => ["hello", "error", "alert", "deploy", "events", "heartbeat"].every((n) => e.some((x) => x.event === n)));
		const alertsOnly = frames(only, (e) => e.some((x) => x.event === "alert"));
		await Bun.sleep(50);
		await h.call("/v1/errors", post(API, { j: "job-l", errors: [item({ fp: "fp-live", template: "live <player.name>" })] }));
		await h.call("/v1/fleet/alert", post(API, { level: "warning", code: "live_test", message: "hello", j: "job-l", b: "prod" }));
		await h.call("/v1/fleet/report", post(API, { s: 7, b: "prod", a: "art-7", j: "job-l", r: "swapped" }));
		await h.call("/v1/fleet/deploy", post(API, { s: 8, b: "prod", a: "art-8" }));
		await h.call("/v1/fleet/heartbeat", post(API, { j: "job-l", b: "prod", a: "art-7", n: 5, h: "ok" }));
		await h.call("/v1/ingest", { method: "POST", ...json({ events: [{ v: 1, t: T0, kind: "custom", name: "x", job: "job-l", art: "art-7", pid: "p1", sid: "s1" }] }), headers: { "content-type": "application/json", ...bearer(API) } });
		const events = await started;
		const by = (name: string) => events.filter((e) => e.event === name);
		expect(by("hello")[0]?.data.topics).toEqual(["events", "heartbeat", "deploy", "alert", "error"]);
		expect(by("error")[0]?.data).toMatchObject({ total: 3, rejected: 0, kinds: [{ fp: "fp-live", count: 3, realm: "server" }] });
		expect(by("alert")[0]?.data.alert).toMatchObject({ code: "live_test", level: "warning", source: "game" });
		expect(by("deploy").map((e) => e.data.kind).sort()).toEqual(["report", "start"]);
		expect(by("events")[0]?.data).toMatchObject({ batches: 1, events: 1, rejected: 0, kinds: { custom: 1 } });
		expect(by("heartbeat")[0]?.data.servers[0]).toMatchObject({ job: "job-l", branch: "prod", players: 5, health: "ok" });
		const filtered = await alertsOnly;
		expect(filtered.filter((e) => e.event !== "hello" && e.event !== "alert")).toEqual([]);
		expect(filtered.some((e) => e.event === "alert")).toBe(true);
	});

	test("a limit on open streams, and stats in /healthz", async () => {
		const g = await harness({ TYPETORCH_LIVE_MAX_CLIENTS: "2" });
		try {
			const a = await g.call("/v1/live", { headers: bearer(ADMIN) });
			const b = await g.call("/v1/live", { headers: bearer(ADMIN) });
			const c = await g.call("/v1/live", { headers: bearer(ADMIN) });
			expect([a.status, b.status, c.status]).toEqual([200, 200, 429]);
			expect((await asJson(await g.call("/healthz", { headers: bearer(ADMIN) }))).live).toMatchObject({ clients: 2 });
			await a.body?.cancel();
			await b.body?.cancel();
			await Bun.sleep(20);
			expect(g.app.live.stats.clients).toBe(0);
		} finally {
			await g.close();
		}
	});

	test("over a real connection too (Bun.serve), and a browser's session cookie works", async () => {
		const login = await h.call("/v1/auth/login", { method: "POST", ...json({ token: ADMIN }), headers: { "content-type": "application/json", "x-typetorch": "1" } });
		const cookie = (login.headers.getSetCookie().find((c) => c.startsWith("tt_session=")) as string).split(";")[0] as string;
		const res = await fetch(`${h.base}/api/v1/live?topics=error`, { headers: { cookie } });
		expect(res.status).toBe(200);
		const got = frames(res, (e) => e.some((x) => x.event === "error"));
		await Bun.sleep(50);
		await h.call("/v1/errors", post(API, { j: "job-net", errors: [item({ fp: "fp-net" })] }));
		expect((await got).some((e) => e.event === "error" && e.data.kinds[0].fp === "fp-net")).toBe(true);
	});
});
