/**
 * Rolling deploys (Coolify starts the new container while the old one still runs, both on one volume): a server whose
 * DuckDB files are held by another process starts in handover (healthz 200, fleet and error logs work, analytics 503 +
 * Retry-After) and takes the folder over once the other one lets go; SIGTERM closes DuckDB within seconds.
 *
 * DuckDB's file locks are per process on Linux (a second holder inside the test process wouldn't conflict there), so the
 * other holder is always a real process: test/hold-duckdb.ts, or the backend itself (src/server/main.ts).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import { handleShutdown } from "../src/server/lifecycle.ts";
import { DataFolderLocked, isLockConflict } from "../src/duckdb/lock.ts";
import { openDuckDbStore } from "../src/store/duckdb.ts";
import { ADMIN, API, bearer, post } from "./harness.ts";

const root = join(import.meta.dir, "..");
const HOLDER = join(import.meta.dir, "hold-duckdb.ts");
const MAIN = join(root, "src", "server", "main.ts");

type Proc = ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;

/** A child process whose output can be waited on. */
function watch(proc: Proc) {
	let out = "";
	const waiters = new Set<{ re: RegExp; done: (m: RegExpMatchArray) => void }>();
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			out += decoder.decode(chunk, { stream: true });
			for (const w of [...waiters]) {
				const m = w.re.exec(out);
				if (m) {
					waiters.delete(w);
					w.done(m);
				}
			}
		}
	};
	void pump(proc.stdout);
	void pump(proc.stderr);
	return {
		proc,
		get output() {
			return out;
		},
		waitFor(re: RegExp, ms = 20_000): Promise<RegExpMatchArray> {
			const now = re.exec(out);
			if (now) return Promise.resolve(now);
			return new Promise((done, fail) => {
				const w = {
					re,
					done: (m: RegExpMatchArray) => {
						clearTimeout(timer);
						done(m);
					},
				};
				const timer = setTimeout(() => {
					waiters.delete(w);
					fail(new Error(`timed out waiting for ${re} in:\n${out}`));
				}, ms);
				waiters.add(w);
			});
		},
	};
}
type Watched = ReturnType<typeof watch>;

const children: Watched[] = [];
const dirs: string[] = [];
const apps: App[] = [];
afterEach(async () => {
	for (const app of apps.splice(0)) await app.stop().catch(() => {});
	for (const child of children.splice(0)) {
		child.proc.kill();
		await child.proc.exited;
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "tt-handover-"));
	dirs.push(dir);
	return dir;
}

/** Holds a data folder's DuckDB files from another process until `release()`. */
async function hold(dir: string, onlyLive = false) {
	const child = watch(Bun.spawn(["bun", HOLDER, dir, ...(onlyLive ? ["--only-live"] : [])], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as Proc);
	children.push(child);
	await child.waitFor(/^held$/m);
	return {
		async release() {
			(child.proc.stdin as unknown as { write(s: string): void; flush(): void }).write("release\n");
			(child.proc.stdin as unknown as { flush(): void }).flush();
			await child.waitFor(/^released$/m);
			await child.proc.exited;
		},
	};
}

/** Whether another process can take the folder's DuckDB files right now. */
async function canHold(dir: string): Promise<boolean> {
	const child = watch(Bun.spawn(["bun", HOLDER, dir], { cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as Proc);
	children.push(child);
	const held = await Promise.race([child.waitFor(/^held$/m).then(() => true), child.proc.exited.then(() => false)]);
	return held;
}

const ENV = {
	TYPETORCH_API_KEY: API,
	TYPETORCH_ADMIN_TOKEN: ADMIN,
	PORT: "0",
	HOST: "127.0.0.1",
	TYPETORCH_MEMORY_LIMIT: "256MB",
	TYPETORCH_EXPLORER: "off",
	TYPETORCH_JOB_PER_MINUTE: "1000",
};
const config = (dir: string, extra: Record<string, string> = {}) => loadConfig([], { ...ENV, TYPETORCH_DATA_DIR: dir, ...extra });

async function start(dir: string, extra: Record<string, string> = {}, options: Parameters<typeof startApp>[1] = {}) {
	const logs: string[] = [];
	const app = await startApp(config(dir, extra), { manualJobs: true, log: (l) => logs.push(l), handoverRetryMs: 200, ...options });
	apps.push(app);
	const call = (path: string, init: RequestInit = {}) => app.handle(new Request(`http://backend.test${path}`, init), "127.0.0.1");
	return { app, logs, call };
}

const event = (name: string) => ({ v: 1, t: Date.now(), kind: "custom", name, job: "job-handover", art: "art-1", pid: "pid-handover", sid: "sid-handover" });
const batch = (...names: string[]) => ({ events: names.map(event), recordings: [] });
const heartbeat = (j: string) => ({ j, t: "public", b: "prod", c: "prod", a: "art-1", n: 3, m: 20, s: Math.floor(Date.now() / 1000) - 60, u: Math.floor(Date.now() / 1000), p: 1001, v: "0.4.2", q: 1, g: 1, h: "ok", sv: 2 });
const errorBatch = (j: string) => ({ j, errors: [{ fp: "fp-handover", template: "boom", count: 1, firstAt: Date.now() - 1000, lastAt: Date.now(), branch: "prod", build: "a1b2c3d-000001", realm: "server", pids: [] }] });

async function until(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<number> {
	const started = Date.now();
	while (!(await check())) {
		if (Date.now() - started > ms) throw new Error(`not within ${ms} ms: ${what}`);
		await Bun.sleep(50);
	}
	return Date.now() - started;
}

describe("lock conflicts", () => {
	test("DuckDB's messages on Linux and Windows count as held by another process; other IO errors don't", () => {
		expect(isLockConflict(new Error('IO Error: Could not set lock on file "/data/live.duckdb": Conflicting lock is held in PID 0. See also https://duckdb.org/docs/connect/concurrency'))).toBe(true);
		expect(isLockConflict(new Error('IO Error: Cannot open file "C:\\data\\live.duckdb": The process cannot access the file because it is being used by another process.\n\nFile is already open in \nC:\\bun.exe (PID 1)'))).toBe(true);
		expect(isLockConflict(new Error('IO Error: Cannot open file "/data/live.duckdb": Permission denied'))).toBe(false);
		expect(isLockConflict(new Error("Catalog Error: Table with name x does not exist"))).toBe(false);
	});
});

describe("handover (DuckDB held by another process)", () => {
	test("starts anyway: healthz 200, fleet and error logs work, analytics 503 + Retry-After; takes over when the holder lets go", async () => {
		const dir = tempDir();
		const holder = await hold(dir);
		const { app, logs, call } = await start(dir);
		expect(app.state).toBe("handover");
		expect(app.warehouse).toBeUndefined();
		expect(logs.filter((l) => l.startsWith("handover:"))).toHaveLength(1);
		expect(logs[0]).toMatch(/lock\.duckdb is held by another process/);

		// The container health check: the plain answer, no state for anyone without the admin token.
		const plain = await call("/healthz");
		expect(plain.status).toBe(200);
		expect(await plain.json()).toEqual({ ok: true });
		const full = (await (await call("/healthz", { headers: bearer(ADMIN) })).json()) as Record<string, any>;
		expect(full).toMatchObject({ ok: true, state: "handover", analytics: { state: "handover", giveUpSeconds: 600 } });

		// SQLite parts work.
		expect((await call("/v1/fleet/heartbeat", post(API, heartbeat("job-h1")))).status).toBe(202);
		const servers = (await (await call("/v1/fleet/servers", { headers: bearer(ADMIN) })).json()) as { servers: { job: string }[] };
		expect(servers.servers.map((s) => s.job)).toContain("job-h1");
		expect((await call("/v1/errors", post(API, errorBatch("job-h1")))).status).toBe(202);
		expect((await call("/v1/auth/check", { headers: bearer(ADMIN) })).status).toBe(200);

		// DuckDB routes: 503 + Retry-After, after the credentials are checked.
		expect((await call("/v1/ingest", post(undefined, batch("a")))).status).toBe(401);
		const refused = await call("/v1/ingest", post(API, batch("a")));
		expect(refused.status).toBe(503);
		expect(refused.headers.get("retry-after")).toBe("5");
		expect(((await refused.json()) as { error: string }).error).toMatch(/handover/);
		expect((await call("/v1/query/overview", post(undefined, {}))).status).toBe(401);
		for (const [path, init] of [
			["/v1/query/overview", post(ADMIN, {})],
			["/v1/sql", post(ADMIN, { sql: "SELECT 1" })],
			["/v1/rollups/daily", { headers: bearer(ADMIN) }],
			["/v1/storage", { headers: bearer(ADMIN) }],
			["/v1/erasure", post(ADMIN, { pid: "pid-x" })],
			["/v1/identity", post(API, { identities: [] })],
		] as const) {
			const res = await call(path, init);
			expect([path, res.status, res.headers.get("retry-after")]).toEqual([path, 503, "5"]);
		}

		await holder.release();
		const ms = await until(() => app.state === "ready", 5000, "the handover ends");
		expect(ms).toBeLessThan(5000);
		expect(logs.some((l) => /^handover: DuckDB is open after [\d.]+ s; analytics is on$/.test(l))).toBe(true);
		expect(app.warehouse).toBeDefined();
		expect((await call("/v1/ingest", post(API, batch("a", "b")))).status).toBe(202);
		expect((await app.load()).rows).toBe(2);
		expect(await (await call("/healthz", { headers: bearer(ADMIN) })).json()).toMatchObject({ state: "ready", analytics: { live: { events: 2 } } });
		expect((await call("/v1/query/overview", post(ADMIN, {}))).status).toBe(200);
	}, 30_000);

	test("waits for a server from before the owner lock too (only live.duckdb held)", async () => {
		const dir = tempDir();
		const holder = await hold(dir, true);
		const { app, logs } = await start(dir);
		expect(app.state).toBe("handover");
		expect(logs[0]).toMatch(/live\.duckdb is held by another process/);
		await holder.release();
		await until(() => app.state === "ready", 5000, "the handover ends");
	}, 30_000);

	test("gives up after TYPETORCH_HANDOVER_SECONDS with a clear error (main.ts then exits 1)", async () => {
		const dir = tempDir();
		const holder = await hold(dir);
		const fatal: Error[] = [];
		const { app, logs, call } = await start(dir, { TYPETORCH_HANDOVER_SECONDS: "1" }, { onFatal: (e) => fatal.push(e) });
		await until(() => fatal.length > 0, 5000, "onFatal");
		expect(fatal[0].message).toMatch(/^gave up after \d+ s waiting for .*lock\.duckdb: another process still holds it/);
		expect(logs.some((l) => l.startsWith("error: gave up after"))).toBe(true);
		expect(app.state).toBe("failed");
		const refused = await call("/v1/ingest", post(API, batch("a")));
		expect([refused.status, refused.headers.get("retry-after")]).toEqual([503, "60"]);
		expect(await (await call("/healthz")).json()).toEqual({ ok: true });
		// Given up means no more tries: it stays without DuckDB after the holder lets go.
		await holder.release();
		await Bun.sleep(600);
		expect(app.warehouse).toBeUndefined();
	}, 30_000);

	test("a stop during the handover ends the retries at once", async () => {
		const dir = tempDir();
		const holder = await hold(dir);
		const { app, logs } = await start(dir);
		const started = Date.now();
		await app.stop();
		expect(Date.now() - started).toBeLessThan(3000);
		expect(app.state).toBe("stopping");
		await holder.release();
		await Bun.sleep(600);
		expect(app.warehouse).toBeUndefined();
		expect(logs.some((l) => l.includes("DuckDB is open"))).toBe(false);
	}, 30_000);
});

describe("shutdown (SIGTERM)", () => {
	test("closes DuckDB: the WAL is folded in and another process can open the files at once", async () => {
		const dir = tempDir();
		const { app, call } = await start(dir);
		expect((await call("/v1/ingest", post(API, batch("a", "b", "c")))).status).toBe(202);
		expect((await app.load()).rows).toBe(3);
		expect(existsSync(join(dir, "live.duckdb.wal"))).toBe(true);
		expect(await canHold(dir)).toBe(false);
		const exits: number[] = [];
		const lines: string[] = [];
		const shutdown = handleShutdown({ stop: () => app.stop(), log: (l) => lines.push(l), exit: (code) => exits.push(code), signals: ["SIGTERM"] });
		try {
			process.emit("SIGTERM" as never);
			await until(() => exits.length > 0, 10_000, "exit");
		} finally {
			shutdown.dispose();
		}
		expect(exits).toEqual([0]);
		expect(lines[0]).toBe("SIGTERM: stopping (closing DuckDB and SQLite, then exiting)");
		expect(lines[1]).toMatch(/^stopped in [\d.]+ s$/);
		expect(existsSync(join(dir, "live.duckdb.wal"))).toBe(false);
		expect(await canHold(dir)).toBe(true);
		// While stopping, every request is refused with a retry hint.
		const late = await call("/v1/ingest", post(API, batch("d")));
		expect([late.status, late.headers.get("retry-after")]).toEqual([503, "5"]);
	}, 30_000);

	test("a second signal exits at once; a stop that hangs exits 1 at the deadline", async () => {
		const exits: number[] = [];
		const slow = handleShutdown({ stop: () => Bun.sleep(300), log: () => {}, exit: (code) => exits.push(code), signals: ["SIGTERM"] });
		try {
			process.emit("SIGTERM" as never);
			process.emit("SIGTERM" as never);
			expect(exits).toEqual([1]);
			await Bun.sleep(400);
			expect(exits).toEqual([1]);
		} finally {
			slow.dispose();
		}
		const hung: number[] = [];
		const stuck = handleShutdown({ stop: () => new Promise(() => {}), log: () => {}, exit: (code) => hung.push(code), deadlineMs: 100, signals: [] });
		void stuck.shutdown("test");
		await until(() => hung.length > 0, 2000, "the deadline");
		expect(hung).toEqual([1]);
	});
});

describe("two servers on one data folder (a rolling deploy)", () => {
	test("the new one starts in handover, the old one stops through the SIGTERM path, the new one takes over within seconds and loads the old one's raw files", async () => {
		const dir = tempDir();
		// The old server: has accepted rows (in raw files, not loaded yet) and a heartbeat.
		const old = await start(dir);
		expect((await old.call("/v1/ingest", post(API, batch("o1", "o2", "o3")))).status).toBe(202);
		expect((await old.call("/v1/fleet/heartbeat", post(API, heartbeat("job-old")))).status).toBe(202);

		// The new server: a real process (src/server/main.ts), its loader every 0.5 s.
		const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TYPETORCH_|ROBLOX_|OPENCLOUD_|TT_)/.test(k)));
		const next = watch(
			Bun.spawn(["bun", MAIN], {
				cwd: root,
				env: { ...env, ...ENV, TYPETORCH_DATA_DIR: dir, TYPETORCH_LOAD_SECONDS: "0.5" },
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
			}) as unknown as Proc,
		);
		children.push(next);
		const port = (await next.waitFor(/listening on 127\.0\.0\.1:(\d+)/))[1];
		expect(next.output).toMatch(/handover: .*lock\.duckdb is held by another process/);
		const base = `http://127.0.0.1:${port}`;
		const get = (path: string, token?: string) => fetch(`${base}${path}`, { headers: token ? bearer(token) : {} });
		const send = (path: string, token: string, body: unknown) => fetch(`${base}${path}`, post(token, body));

		expect(await (await get("/healthz")).json()).toEqual({ ok: true });
		expect(await (await get("/healthz", ADMIN)).json()).toMatchObject({ state: "handover" });
		expect((await send("/v1/fleet/heartbeat", API, heartbeat("job-new"))).status).toBe(202);
		const refused = await send("/v1/ingest", API, batch("n0"));
		expect([refused.status, refused.headers.get("retry-after")]).toEqual([503, "5"]);

		// The old server gets SIGTERM (Coolify stops it once the new one is healthy).
		const exits: number[] = [];
		const shutdown = handleShutdown({ stop: () => old.app.stop(), log: () => {}, exit: (code) => exits.push(code), signals: ["SIGTERM"] });
		try {
			process.emit("SIGTERM" as never);
			await until(() => exits.length > 0, 10_000, "the old server exits");
		} finally {
			shutdown.dispose();
		}
		expect(exits).toEqual([0]);

		const ms = await until(async () => ((await (await get("/healthz", ADMIN)).json()) as { state: string }).state === "ready", 5000, "the new server takes over");
		expect(ms).toBeLessThan(5000);
		await next.waitFor(/handover: DuckDB is open after [\d.]+ s; analytics is on/);
		expect((await send("/v1/ingest", API, batch("n1", "n2"))).status).toBe(202);
		// Nothing accepted is lost: the old server's 3 rows (from its raw files) and the new one's 2.
		await until(async () => ((await (await get("/healthz", ADMIN)).json()) as { analytics?: { live?: { events: number } } }).analytics?.live?.events === 5, 10_000, "5 rows loaded");
		// Both servers wrote to the same SQLite file.
		const servers = (await (await get("/v1/fleet/servers", ADMIN)).json()) as { servers: { job: string }[] };
		expect(servers.servers.map((s) => s.job).sort()).toEqual(["job-new", "job-old"]);

		// The new server stops on a real SIGTERM where there are signals (Windows only has TerminateProcess).
		if (process.platform !== "win32") {
			next.proc.kill("SIGTERM");
			expect(await next.proc.exited).toBe(0);
			expect(next.output).toMatch(/SIGTERM: stopping/);
			expect(next.output).toMatch(/stopped in [\d.]+ s/);
		} else {
			next.proc.kill();
			await next.proc.exited;
		}
		expect(await canHold(dir)).toBe(true);
	}, 60_000);
});

test("a local read-only store refuses a folder a server holds (no second handle next to it), and opens it once free", async () => {
	const dir = tempDir();
	const holder = await hold(dir);
	const refused = await openDuckDbStore({ dataDir: dir, memoryLimit: "128MB", threads: 1 }).then(
		() => undefined,
		(error: unknown) => error,
	);
	expect(refused).toBeInstanceOf(DataFolderLocked);
	expect((refused as Error).message).toMatch(/^a running backend holds .*lock\.duckdb: query it over HTTP/);
	await holder.release();
	const store = await openDuckDbStore({ dataDir: dir, memoryLimit: "128MB", threads: 1 });
	await store.close();
}, 30_000);

test("DataFolderLocked names the file and keeps DuckDB's words", () => {
	const error = new DataFolderLocked("/data/live.duckdb", "IO Error: Could not set lock");
	expect(error.message).toBe("/data/live.duckdb is held by another process");
	expect(error.detail).toBe("IO Error: Could not set lock");
});
