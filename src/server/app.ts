/**
 * The TypeTorch analytics server: the DuckDB analytics API and/or the SQLite fleet API in one process.
 *
 *   POST /v1/ingest                 game servers: gzip JSON { events, recordings }, ingest token -> 202 after the raw write
 *   POST /v1/query/<name>           { filters, options } -> { result }       admin token
 *   GET  /v1/queries                the query list                           admin token
 *   GET  /v1/rollups/<daily|players|edges>?from=&to=&pid=&limit=             admin token
 *   POST /v1/sql                    { sql, limit? } -> { columns, rows, truncated }: one read-only SELECT   admin token
 *   POST /v1/identity               { identities: [{ pid, uid, t }] } (Basin games, via the fleet API's url)   ingest token
 *   GET  /v1/identity?pid=|uid=     pid <-> UserId; no parameter: count and whether a backfill is possible   admin token
 *   POST /v1/identity/backfill      fill pid <-> UserId from the game's DataStore links (Open Cloud key)   admin token
 *   GET  /v1/storage                bytes and files per part of the data folder, rows, growth (cached 30 s)  admin token
 *   GET  /v1/settings               live dials from data/settings.json       ingest or admin token
 *   POST /v1/erasure                Roblox Right to Erasure webhook (signed), or { pid | pids } with the admin token
 *   GET  /healthz                   { ok }; with the admin token: loader lag, memory, counts
 *   /v1/fleet/...                   the fleet API (fleet/http.ts)
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DAY_MS } from "../sql/dialect.ts";
import { dataLayout, dayFiles, pathLit } from "../duckdb/layout.ts";
import { openSqlite } from "../fleet/db.ts";
import { IdentityStore, parseIdentities, parseUid, PID_PATTERN } from "../fleet/identity.ts";
import { FLEET_LIMITS, handleFleet, NewJobLimiter } from "../fleet/http.ts";
import { createNotifier, type Notifier } from "../fleet/notify.ts";
import { FleetService } from "../fleet/service.ts";
import { describeQueries, isQueryName, renderQuery } from "../queries/index.ts";
import { runtimeName, serve, type Served } from "../runtime.ts";
import { validateSettings } from "../settings.ts";
import { BatchShapeError, validateBatch } from "../validate.ts";
import type { ServerConfig } from "./config.ts";
import { logErasure, lookupPid, parseErasureBody, verifyRobloxSignature } from "./erasure.ts";
import { RateLimiter, bearer, clientIp, json, readCapped, tokenIn, tooMany } from "./http.ts";
import { SqlInputError, SqlSandbox } from "./sql.ts";
import { measureStorage, type StorageReport } from "./storage.ts";
import { backfillIdentities } from "./identities.ts";
import { Warehouse } from "./warehouse.ts";

export interface AppOptions {
	clock?: () => number;
	log?: (line: string) => void;
	/** Don't start the loader / nightly / sweep timers (tests drive them). */
	manualJobs?: boolean;
	fetch?: typeof fetch;
	backend?: "bun" | "node";
}

export interface App {
	readonly port: number;
	readonly warehouse?: Warehouse;
	readonly fleet?: FleetService;
	readonly notifier?: Notifier;
	handle(req: Request, ip?: string): Promise<Response>;
	/** One loader tick. */
	load(): Promise<{ files: number; rows: number }>;
	nightly(): Promise<{ days: string[]; pruned: number; compacted: boolean }>;
	stop(): Promise<void>;
}

const LIVE_DIALS = ["flushSeconds", "recordShare", "techEvery", "experiments"] as const;

export async function startApp(config: ServerConfig, options: AppOptions = {}): Promise<App> {
	const clock = options.clock ?? Date.now;
	const log = options.log ?? ((line: string) => console.log(`[analytics] ${line}`));
	const warehouse = config.parts.has("analytics")
		? await Warehouse.open({
				dataDir: config.dataDir,
				memoryLimit: config.memoryLimit,
				threads: config.threads,
				keepDays: config.keepDays,
				rawKeepDays: config.rawKeepDays,
				compactMb: config.compactMb,
				queryTimeoutSeconds: config.queryTimeoutSeconds,
				queryConcurrency: config.queryConcurrency,
				fsyncMs: config.fsyncMs,
				clock,
				log,
			})
		: undefined;
	const notifier = config.fleetWebhookUrl
		? createNotifier({ url: config.fleetWebhookUrl, ...(config.fleetWebhookFormat ? { format: config.fleetWebhookFormat } : {}), levels: config.fleetWebhookLevels, clock, log, ...(options.fetch ? { fetch: options.fetch } : {}) })
		: undefined;
	// One SQLite file for the fleet tables and pid <-> UserId (identities live here for DuckDB and Basin games alike).
	const sqlite = await openSqlite(config.fleetDb);
	const identities = await IdentityStore.open(sqlite);
	const fleet = config.parts.has("fleet") ? await FleetService.open({ db: sqlite, clock, log, ...(notifier ? { notifier } : {}) }) : undefined;

	const ipLimiter = new RateLimiter(config.ipPerMinute, clock);
	const jobLimiter = new RateLimiter(config.jobPerMinute, clock);
	const fleetLimiters = Object.fromEntries(Object.entries(FLEET_LIMITS).map(([k, n]) => [k, new RateLimiter(n, clock)])) as Record<keyof typeof FLEET_LIMITS, RateLimiter>;
	const newFleetJobs = new NewJobLimiter(config.fleetNewJobsPerMinute, clock);
	const isAdmin = (req: Request) => tokenIn(bearer(req), [config.adminToken]);
	const isIngest = (req: Request) => tokenIn(bearer(req), config.ingestTokens);
	const keepOpen = new WeakMap<Request, () => void>();

	let settingsCache: { mtime: number; value: Record<string, unknown> } | undefined;
	function liveDials(): Record<string, unknown> {
		const file = join(config.dataDir, "settings.json");
		if (!existsSync(file)) return {};
		const mtime = statSync(file).mtimeMs;
		if (settingsCache?.mtime === mtime) return settingsCache.value;
		const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
		const picked = Object.fromEntries(LIVE_DIALS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
		// Same checks as writeSettings (a dummy endpoint stands in for the fields that don't apply here).
		const checked = validateSettings({ backend: "duckdb", events: "https://dials.invalid", ...picked }) as unknown as Record<string, unknown>;
		const value = Object.fromEntries(LIVE_DIALS.filter((k) => checked[k] !== undefined).map((k) => [k, checked[k]]));
		settingsCache = { mtime, value };
		return value;
	}

	async function ingest(req: Request, ip: string): Promise<Response> {
		if (!warehouse) return json(404, { error: "the analytics part is off on this server" });
		if (!config.ingestTokens.length) return json(503, { error: "ingest is not configured (TT_ANALYTICS_INGEST_TOKENS)" });
		if (!isIngest(req)) return json(401, { error: "ingest token required" });
		if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
		const body = await readCapped(req, config.maxBodyBytes);
		if (!body) return json(413, { error: `body over ${config.maxBodyBytes} bytes` });
		let bytes: Uint8Array = body;
		if (req.headers.get("content-encoding") === "gzip" || (body[0] === 0x1f && body[1] === 0x8b)) {
			try {
				bytes = gunzipSync(body, { maxOutputLength: config.maxInflateBytes });
			} catch (error) {
				if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || (error as Error).name === "RangeError") return json(413, { error: `inflated body over ${config.maxInflateBytes} bytes` });
				return json(400, { error: "body is not valid gzip" });
			}
			if (bytes.length > config.maxInflateBytes) return json(413, { error: `inflated body over ${config.maxInflateBytes} bytes` });
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8"));
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		let batch;
		try {
			batch = validateBatch(parsed);
		} catch (error) {
			if (error instanceof BatchShapeError) return json(400, { error: error.message });
			throw error;
		}
		const job = batch.events[0]?.job ?? batch.recordings[0]?.job;
		if (job && !jobLimiter.take(`job:${job}`)) return tooMany(jobLimiter.retryAfter(`job:${job}`));
		// Identity rows (pid -> UserId) go to the identity table, never into the events.
		const who = parseIdentities(isRecordLike(parsed) ? parsed.identities : undefined, clock());
		const known = who.rows.filter((r) => !warehouse.isErased(r.pid));
		if (known.length) await identities.upsert(known);
		const rt = clock();
		if (batch.events.length) await warehouse.raw.append("events", batch.events.map((r) => `${JSON.stringify({ ...r, rt })}\n`).join(""));
		if (batch.recordings.length) await warehouse.raw.append("recordings", batch.recordings.map((r) => `${JSON.stringify({ ...r, rt })}\n`).join(""));
		return json(202, {
			accepted: batch.events.length + batch.recordings.length,
			rejected: batch.rejected,
			...(batch.errors.length ? { errors: batch.errors } : {}),
			...(who.rows.length || who.rejected ? { identities: known.length, identitiesRejected: who.rejected } : {}),
		});
	}

	/** POST /v1/identity (ingest token): identity rows from Basin games (the framework posts them to the fleet API). */
	async function postIdentity(req: Request, ip: string): Promise<Response> {
		if (!config.ingestTokens.length) return json(503, { error: "ingest is not configured (TT_ANALYTICS_INGEST_TOKENS)" });
		if (!isIngest(req)) return json(401, { error: "ingest token required" });
		if (!ipLimiter.take(ip)) return tooMany(ipLimiter.retryAfter(ip));
		const raw = await readCapped(req, 256 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: unknown;
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8"));
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		const list = isRecordLike(body) && Array.isArray(body.identities) ? body.identities : body;
		const who = parseIdentities(list, clock());
		const known = who.rows.filter((r) => !warehouse?.isErased(r.pid));
		if (known.length) await identities.upsert(known);
		return json(202, { accepted: known.length, rejected: who.rejected });
	}

	/** GET /v1/identity (admin): ?pid= or ?uid=, or the count and whether a backfill can run. */
	async function getIdentity(url: URL): Promise<Response> {
		const pid = url.searchParams.get("pid");
		const uidText = url.searchParams.get("uid");
		if (pid) {
			if (!PID_PATTERN.test(pid)) return json(400, { error: "bad pid" });
			const found = await identities.byPid(pid);
			return json(200, { identities: found ? [found] : [] });
		}
		if (uidText) {
			const uid = parseUid(uidText);
			if (uid === undefined) return json(400, { error: "uid must be a UserId (digits)" });
			return json(200, { identities: await identities.byUid(uid) });
		}
		return json(200, { count: await identities.count(), backfill: Boolean(config.openCloudKey && config.universeId) });
	}

	/** POST /v1/identity/backfill (admin): pid <-> UserId for players who joined before identity rows existed. */
	async function backfill(req: Request): Promise<Response> {
		if (!config.openCloudKey || !config.universeId) {
			return json(409, { error: "no DataStore access: set TT_ANALYTICS_OPENCLOUD_KEY (universe-datastores.objects:list and :read) and TT_ANALYTICS_UNIVERSE_ID" });
		}
		const raw = await readCapped(req, 16 * 1024);
		let body: { pageToken?: unknown; maxEntries?: unknown } = {};
		try {
			body = raw && raw.length ? JSON.parse(Buffer.from(raw).toString("utf8")) : {};
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		try {
			const result = await backfillIdentities({
				apiKey: config.openCloudKey,
				universeId: config.universeId,
				store: identities,
				clock,
				...(typeof body.pageToken === "string" ? { pageToken: body.pageToken } : {}),
				...(typeof body.maxEntries === "number" ? { maxEntries: body.maxEntries } : {}),
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
			return json(200, result);
		} catch (error) {
			return json(502, { error: `backfill failed: ${((error as Error).message ?? String(error)).slice(0, 300)}` });
		}
	}

	async function query(req: Request, name: string): Promise<Response> {
		if (!warehouse) return json(404, { error: "the analytics part is off on this server" });
		if (!isQueryName(name)) return json(404, { error: `unknown query ${JSON.stringify(name)}` });
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: { filters?: object; options?: object } = {};
		if (raw.length) {
			try {
				body = JSON.parse(Buffer.from(raw).toString("utf8"));
			} catch {
				return json(400, { error: "body is not JSON" });
			}
		}
		// pid <-> UserId from the identity table: a UserId instead of a pid, or a UserId as a players search.
		const queryOptions: Record<string, unknown> = { ...(isRecordLike(body.options) ? body.options : {}) };
		if ((name === "timeline" || name === "player-graph" || name === "events") && queryOptions.pid === undefined && queryOptions.uid !== undefined) {
			const uid = parseUid(queryOptions.uid);
			if (uid === undefined) return json(400, { error: "uid must be a UserId (digits)" });
			const known = await identities.byUid(uid);
			if (!known.length) return json(404, { error: `no pid known for UserId ${uid}: only players who joined after the identity update (or a backfill) are mapped` });
			queryOptions.pid = known[0].pid;
		}
		delete queryOptions.uid;
		if (name === "players" && typeof queryOptions.search === "string" && /^\d{1,16}$/.test(queryOptions.search)) {
			const known = await identities.byUid(Number(queryOptions.search));
			const given = Array.isArray(queryOptions.pids) ? (queryOptions.pids as unknown[]) : [];
			if (known.length) queryOptions.pids = [...given, ...known.map((k) => k.pid)].slice(0, 50);
		}
		try {
			renderQuery(warehouse.context(), name, body.filters, queryOptions); // input errors -> 400
		} catch (error) {
			return json(400, { error: (error as Error).message });
		}
		try {
			const started = performance.now();
			let result = await warehouse.query(name, body.filters, queryOptions);
			// A Graph answers through its toJSON; as plain data it can carry the uid too.
			const asJson = result as { toJSON?: () => unknown };
			if (typeof asJson.toJSON === "function") result = asJson.toJSON();
			if (name === "players") {
				const players = (result as { players: { pid: string; uid?: number }[] }).players;
				const uids = await identities.uids(players.map((p) => p.pid));
				for (const p of players) {
					const uid = uids.get(p.pid);
					if (uid !== undefined) p.uid = uid;
				}
			}
			if (name === "timeline" || name === "player-graph") {
				const r = result as { pid?: string; uid?: number };
				const found = r.pid ? await identities.byPid(r.pid) : undefined;
				if (found) r.uid = found.uid;
			}
			return json(200, { result, ms: Math.round(performance.now() - started) });
		} catch (error) {
			const message = (error as Error).message ?? String(error);
			if (/interrupt/i.test(message)) return json(504, { error: `query took longer than ${config.queryTimeoutSeconds} s` });
			log(`query ${name} failed: ${message.slice(0, 300)}`);
			return json(500, { error: "query failed", detail: message.slice(0, 300) });
		}
	}

	const STORAGE_CACHE_SECONDS = 30;
	let storageCache: { at: number; report: Promise<StorageReport> } | undefined;

	/** The storage report, measured at most every 30 s (the explorer polls it). */
	function storage(): Promise<StorageReport> {
		const now = clock();
		if (storageCache && now - storageCache.at < STORAGE_CACHE_SECONDS * 1000) return storageCache.report;
		const w = warehouse;
		const report = measureStorage({
			layout: w?.layout ?? dataLayout(config.dataDir),
			...(fleet ? { fleetDb: config.fleetDb } : {}),
			...(w ? { sql: (s: string) => w.sql(s), liveRows: () => w.liveRows() } : {}),
			clock,
			cacheSeconds: STORAGE_CACHE_SECONDS,
		});
		storageCache = { at: now, report };
		report.catch(() => (storageCache = undefined));
		return report;
	}

	let sandbox: Promise<SqlSandbox> | undefined;

	async function adhocSql(req: Request): Promise<Response> {
		if (!warehouse) return json(404, { error: "the analytics part is off on this server" });
		if (!config.sql) return json(404, { error: "ad-hoc SQL is off on this server (TT_ANALYTICS_SQL=0)" });
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		let body: { sql?: unknown; limit?: unknown };
		try {
			body = JSON.parse(Buffer.from(raw).toString("utf8") || "{}");
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		const w = warehouse;
		sandbox ??= SqlSandbox.open({
			layout: w.layout,
			memoryLimit: config.sqlMemoryLimit,
			timeoutSeconds: config.queryTimeoutSeconds,
			snapshot: (tables) => w.snapshotLive(tables),
		});
		let box: SqlSandbox;
		try {
			box = await sandbox;
		} catch (error) {
			sandbox = undefined;
			log(`sql sandbox failed to open: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
			return json(500, { error: "the SQL sandbox failed to open" });
		}
		const started = performance.now();
		try {
			const result = await box.run(body.sql, typeof body.limit === "number" ? body.limit : undefined);
			return json(200, { ...result, ms: Math.round(performance.now() - started) });
		} catch (error) {
			const message = ((error as Error).message ?? String(error)).slice(0, 500);
			if (/interrupt/i.test(message)) return json(504, { error: `query took longer than ${config.queryTimeoutSeconds} s` });
			// Parser, binder and permission errors are the query's own; answer them as input errors.
			return json(400, { error: error instanceof SqlInputError ? message : `query failed: ${message}` });
		}
	}

	async function rollups(url: URL, kind: string): Promise<Response> {
		if (!warehouse) return json(404, { error: "the analytics part is off on this server" });
		const q = url.searchParams;
		const limit = Math.min(10_000, Math.max(1, Number(q.get("limit") ?? 1000) || 1000));
		const pid = q.get("pid");
		if (pid && !/^[A-Za-z0-9_-]{1,64}$/.test(pid)) return json(400, { error: "bad pid" });
		const dir = join(warehouse.layout.rollups, kind === "players" ? "" : kind);
		let source: string;
		if (kind === "players") {
			const file = join(warehouse.layout.rollups, "players.parquet");
			if (!existsSync(file)) return json(200, { rows: [] });
			source = `read_parquet(${pathLit(file)})`;
		} else {
			const from = q.get("from") ? Math.floor(Date.parse(`${q.get("from")}T00:00:00Z`) / DAY_MS) : -Infinity;
			const to = q.get("to") ? Math.floor(Date.parse(`${q.get("to")}T00:00:00Z`) / DAY_MS) : Infinity;
			const files = dayFiles(dir).filter((f) => f.day >= from && f.day <= to);
			if (!files.length) return json(200, { rows: [] });
			source = `read_parquet([${files.map((f) => pathLit(f.path)).join(", ")}])`;
		}
		const where = pid && kind !== "daily" ? ` WHERE pid = '${pid}'` : "";
		const rows = await warehouse.sql(`SELECT * FROM ${source}${where} LIMIT ${limit}`);
		return json(200, { rows: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString().slice(0, 10) : v]))) });
	}

	async function erasure(req: Request): Promise<Response> {
		if (!warehouse) return json(404, { error: "the analytics part is off on this server" });
		const raw = await readCapped(req, 64 * 1024);
		if (!raw) return json(413, { error: "body too large" });
		const text = Buffer.from(raw).toString("utf8");
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return json(400, { error: "body is not JSON" });
		}
		if (bearer(req) && isAdmin(req)) {
			const b = body as { pid?: unknown; pids?: unknown };
			const pids = (Array.isArray(b.pids) ? b.pids : [b.pid]).filter((p): p is string => typeof p === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p));
			if (!pids.length) return json(400, { error: "give pid or pids" });
			const { liveRows } = await warehouse.erase(pids);
			await identities.deletePids(pids);
			void warehouse.rewriteErased().catch((e) => log(`erasure rewrite failed: ${(e as Error).message}`));
			logErasure(warehouse.layout.erasure, { source: "admin", pids: pids.length, liveRows });
			return json(200, { erased: pids.length, liveRows, files: "rewriting in the background" });
		}
		if (!config.webhookSecret) return json(401, { error: "erasure webhook secret not configured" });
		const check = verifyRobloxSignature(req.headers.get("roblox-signature"), text, config.webhookSecret, clock());
		if (!check.ok) return json(401, { error: check.reason });
		const request = parseErasureBody(body);
		if (request.eventType === "SampleNotification") return json(200, { ok: true, sample: true });
		if (request.eventType !== "RightToErasureRequest") return json(200, { ok: true, ignored: request.eventType });
		if (config.universeId && request.gameIds.length && !request.gameIds.includes(config.universeId)) {
			logErasure(warehouse.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "another game" });
			return json(200, { ok: true, ignored: "another game" });
		}
		if (!request.userId) return json(400, { error: "no UserId in the payload" });
		// UserId -> pids: the identity table first, then the DataStore link (which also deletes it when configured).
		const pids = (await identities.byUid(request.userId)).map((i) => i.pid);
		if (config.openCloudKey && config.universeId) {
			try {
				const linked = await lookupPid({ apiKey: config.openCloudKey, universeId: config.universeId, deleteLink: config.erasureDeleteLink, ...(options.fetch ? { fetch: options.fetch } : {}) }, request.userId);
				if (linked && !pids.includes(linked)) pids.push(linked);
			} catch (error) {
				if (!pids.length) {
					logErasure(warehouse.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: `lookup failed: ${(error as Error).message.slice(0, 200)}` });
					return json(502, { error: "pid lookup failed; Roblox will retry" });
				}
			}
		} else if (!pids.length) {
			logErasure(warehouse.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "no identity row and no Open Cloud key for the DataStore lookup" });
			return json(202, { ok: true, pending: "no pid known for this UserId: configure TT_ANALYTICS_OPENCLOUD_KEY and TT_ANALYTICS_UNIVERSE_ID, or erase by pid with the admin token" });
		}
		if (!pids.length) {
			logErasure(warehouse.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "no pid link (already anonymous)" });
			return json(200, { ok: true, erased: 0 });
		}
		const { liveRows } = await warehouse.erase(pids);
		// The rows first, then the link between the UserId and its pids.
		await identities.deleteUid(request.userId);
		await identities.deletePids(pids);
		void warehouse.rewriteErased().catch((e) => log(`erasure rewrite failed: ${(e as Error).message}`));
		logErasure(warehouse.layout.erasure, { source: "webhook", notification: request.notificationId, outcome: "erased", pids: pids.length, liveRows });
		return json(200, { ok: true, erased: pids.length });
	}

	async function health(req: Request): Promise<Response> {
		if (!isAdmin(req)) return json(200, { ok: true });
		const memory = process.memoryUsage();
		const out: Record<string, unknown> = { ok: true, runtime: runtimeName(), uptimeSeconds: Math.round(process.uptime()), rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576) };
		if (warehouse) {
			const oldest = warehouse.raw.oldestPending();
			out.analytics = {
				...warehouse.stats,
				loaderLagSeconds: oldest === undefined ? 0 : Math.round((clock() - oldest) / 100) / 10,
				pendingBytes: warehouse.raw.pendingBytes(),
				live: await warehouse.liveRows(),
			};
		}
		if (fleet) out.fleet = { ...(await fleet.counts()), streams: fleet.subscribers, ...(notifier ? { webhook: notifier.stats } : {}) };
		return json(200, out);
	}

	async function handle(req: Request, peer = ""): Promise<Response> {
		const url = new URL(req.url);
		const ip = clientIp(req, peer, config.trustProxy);
		const path = url.pathname;
		try {
			if (path === "/healthz" && req.method === "GET") return await health(req);
			if (path === "/v1/ingest") return req.method === "POST" ? await ingest(req, ip) : json(405, { error: "POST only" });
			if (path === "/v1/identity" && req.method === "POST") return await postIdentity(req, ip);
			if (path.startsWith("/v1/fleet/")) {
				if (!fleet) return json(404, { error: "the fleet part is off on this server" });
				// Per-JobId limits and a cap on never-seen JobIds, no per-IP limit: many game servers can share one egress IP.
				return (
					(await handleFleet(req, url, { service: fleet, isAdmin, isIngest, limiters: fleetLimiters, newJobs: newFleetJobs, keepOpen: (r) => keepOpen.get(r)?.() }, ip)) ??
					json(404, { error: "not found" })
				);
			}
			if (path === "/v1/erasure") return req.method === "POST" ? await erasure(req) : json(405, { error: "POST only" });
			if (path === "/v1/settings" && req.method === "GET") {
				if (!isAdmin(req) && !isIngest(req)) return json(401, { error: "token required" });
				return json(200, liveDials());
			}
			if (!isAdmin(req)) return json(path.startsWith("/v1/") ? 401 : 404, { error: path.startsWith("/v1/") ? "admin token required" : "not found" });
			if (path === "/v1/queries" && req.method === "GET") return json(200, { queries: describeQueries() });
			if (path === "/v1/sql") return req.method === "POST" ? await adhocSql(req) : json(405, { error: "POST only" });
			if (path === "/v1/storage" && req.method === "GET") return json(200, await storage());
			if (path === "/v1/identity" && req.method === "GET") return await getIdentity(url);
			if (path === "/v1/identity/backfill") return req.method === "POST" ? await backfill(req) : json(405, { error: "POST only" });
			const q = /^\/v1\/query\/([A-Za-z-]+)$/.exec(path);
			if (q) return req.method === "POST" ? await query(req, q[1]) : json(405, { error: "POST only" });
			const r = /^\/v1\/rollups\/(daily|players|edges|player_days)$/.exec(path);
			if (r && req.method === "GET") return await rollups(url, r[1]);
			return json(404, { error: "not found" });
		} catch (error) {
			log(`${req.method} ${path} failed: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
			return json(500, { error: "internal error" });
		}
	}

	const served: Served = await serve({
		hostname: config.host,
		port: config.port,
		// Twice the ingest cap, so a body a bit over it gets a clear 413 from readCapped instead of a reset connection.
		maxRequestBodySize: config.maxBodyBytes * 2 + 64 * 1024,
		...(options.backend ? { backend: options.backend } : {}),
		fetch: (req, ctx) => {
			keepOpen.set(req, () => ctx.timeout(0));
			return handle(req, ctx.ip);
		},
		error: () => json(500, { error: "internal error" }),
	});

	// Jobs: the loader every loadSeconds, the nightly export when the UTC day changes (and every 6 h for late rows), the
	// fleet sweep every 10 s, the erasure rewrite after each erasure and at start.
	const timers: ReturnType<typeof setInterval>[] = [];
	let lastNightlyDay = -1;
	let lastNightlyAt = 0;
	if (!options.manualJobs) {
		if (warehouse) {
			let loading = false;
			timers.push(
				setInterval(() => {
					if (loading) return;
					loading = true;
					warehouse
						.load()
						.catch((e) => log(`loader failed: ${(e as Error).message}`))
						.finally(() => (loading = false));
				}, config.loadSeconds * 1000),
			);
			const nightlyCheck = () => {
				const now = clock();
				const day = Math.floor(now / DAY_MS);
				if (day === lastNightlyDay && now - lastNightlyAt < 6 * 3_600_000) return;
				// Five minutes past midnight, so the day's last batches are in.
				if (now - day * DAY_MS < 5 * 60_000 && lastNightlyDay !== -1) return;
				lastNightlyDay = day;
				lastNightlyAt = now;
				warehouse.nightly().catch((e) => log(`nightly failed: ${(e as Error).message}`));
			};
			timers.push(setInterval(nightlyCheck, 60_000));
			nightlyCheck();
			void warehouse.rewriteErased().catch((e) => log(`erasure rewrite failed: ${(e as Error).message}`));
		}
		if (fleet) timers.push(setInterval(() => void fleet.sweep().catch((e) => log(`fleet sweep failed: ${(e as Error).message}`)), 10_000));
		for (const t of timers) t.unref?.();
	}

	return {
		port: served.port,
		...(warehouse ? { warehouse } : {}),
		...(fleet ? { fleet } : {}),
		...(notifier ? { notifier } : {}),
		handle,
		load: () => (warehouse ? warehouse.load() : Promise.resolve({ files: 0, rows: 0 })),
		nightly: () => (warehouse ? warehouse.nightly() : Promise.resolve({ days: [], pruned: 0, compacted: false })),
		async stop() {
			for (const t of timers) clearInterval(t);
			await served.stop();
			if (sandbox) await (await sandbox.catch(() => undefined))?.close();
			if (warehouse) {
				await warehouse.load().catch(() => {});
				await warehouse.close();
			}
			await notifier?.flush();
			if (fleet) await fleet.close();
			else await sqlite.close();
		},
	};
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
