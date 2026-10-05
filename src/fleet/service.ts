/**
 * The fleet API: live game-server status, deploy outcomes and alerts, with near-zero query latency (SQLite, one row
 * per server, upserted). Game kernels post to it directly (not through the analytics engine), so it works even when a
 * game's code is broken. Works for Basin games too: run only this part of the server.
 *
 * Portable by design: no Node APIs here (storage through FleetDb, time through `clock`, outgoing webhooks through
 * `fetch`), so it can move to a Cloudflare Worker + D1 later. The timers that call `sweep()` live in the host.
 *
 * `k` in a heartbeat is a private server's access code: accepted, never stored, never returned.
 */
import { DEPLOY_RESULTS } from "../schema.ts";
import { toMs, type ServerInfo } from "../queries/fleet.ts";
import type { FleetDb, SqlValue } from "./db.ts";
import type { Notifier } from "./notify.ts";

export const LOST_AFTER_MS = 90_000;
export const STUCK_AFTER_MS = 3 * 60_000;
/** Stop looking for stuck servers this long after a deploy started. */
export const STUCK_WINDOW_MS = 30 * 60_000;
export const KEEP_REPORTS_MS = 30 * 86_400_000;
export const KEEP_ALERTS_MS = 90 * 86_400_000;
export const KEEP_GONE_SERVERS_MS = 86_400_000;

/** The kernel sends critical and warning; the CLI may also post info. */
export type AlertLevel = "critical" | "warning" | "info";
export const ALERT_LEVELS: readonly AlertLevel[] = ["critical", "warning", "info"];

export interface Alert {
	id: number;
	level: AlertLevel;
	code: string;
	message: string;
	job: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	kernel: string | null;
	/** "game" (a kernel), "cli" (e.g. auto_rollback), or "server" (server_lost, server_stuck). */
	source: "game" | "cli" | "server";
	/** Extra data, e.g. { jobs: [...] } for server_lost / server_stuck. */
	details: Record<string, unknown> | null;
	createdAt: string;
	/** createdAt as unix ms (what the CLI reads). */
	at: number;
	acked: boolean;
	ackedAt: string | null;
	ackedBy: string | null;
}

/** One deploy report as stored (long names; the CLI also reads the kernel's short ones). */
export interface ReportItem {
	seq: number;
	branch: string | null;
	artifact: string | null;
	job: string;
	result: string;
	error: string | null;
	seconds: number | null;
	/** When the server sent it (unix ms; the kernel's `t`), else when it arrived. */
	at: number;
	generation: number | null;
	kernel: string | null;
	players: number | null;
}

export interface FleetReport {
	seq: number | null;
	branch: string | null;
	artifact: string | null;
	/** When the deploy started (POST /v1/fleet/deploy, else its first report). */
	startedAt: string | null;
	firstReport: string | null;
	lastReport: string | null;
	reported: number;
	results: { result: string; servers: number; players: number; medianSeconds: number | null; maxSeconds: number | null }[];
	errors: { error: string; servers: number; exampleJob: string }[];
	/** Live servers on the branch still below the seq (with or without a report). */
	behind: ServerInfo[];
	/** JobIds below the seq with no report, 3+ minutes after the deploy started. */
	stuck: string[];
	/** Every report for the seq, oldest first (a retried swap may report twice; `results` counts each server's newest). */
	reports: ReportItem[];
}

export type FleetEvent =
	| { type: "server"; change: "new" | "update" | "lost" | "closed" | "back"; server: ServerInfo }
	| { type: "report"; seq: number; job: string; result: string; branch: string | null }
	| { type: "deploy"; seq: number; branch: string | null; artifact: string | null }
	| { type: "alert"; alert: Alert }
	| { type: "alert_ack"; id: number };

export class FleetInputError extends Error {
	override name = "FleetInputError";
}

// Input checks ------------------------------------------------------------------------------------------------------------

type Body = Record<string, unknown>;

function asBody(value: unknown): Body {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new FleetInputError("body must be a JSON object");
	return value as Body;
}

function text(b: Body, key: string, max: number, required = false): string | null {
	const v = b[key];
	if (v === undefined || v === null || v === "") {
		if (required) throw new FleetInputError(`${key} is required`);
		return null;
	}
	if (typeof v !== "string" || v.length > max || v.includes("\0")) throw new FleetInputError(`${key} must be a string of at most ${max} characters`);
	return v;
}

function number(b: Body, key: string, required = false): number | null {
	const v = b[key];
	if (v === undefined || v === null) {
		if (required) throw new FleetInputError(`${key} is required`);
		return null;
	}
	if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 9e15) throw new FleetInputError(`${key} must be a number`);
	return v;
}

function int(b: Body, key: string, required = false): number | null {
	const v = number(b, key, required);
	if (v !== null && !Number.isSafeInteger(v)) throw new FleetInputError(`${key} must be an integer`);
	return v;
}

const JOB = 64;

/** A number sent as a number or a numeric string (`sv`, `x`); anything else is null. */
function loose(b: Body, key: string): number | null {
	const v = b[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
	return null;
}

// Rows -> API shapes ------------------------------------------------------------------------------------------------------

interface ServerRow {
	job: string;
	server_type: string | null;
	branch: string | null;
	channel: string | null;
	artifact: string | null;
	players: number | null;
	max_players: number | null;
	started_at: number | null;
	last_write: number | null;
	place_id: number | null;
	experiment: number | null;
	kernel: string | null;
	applied_seq: number | null;
	generation: number | null;
	health: string | null;
	last_error: string | null;
	server_version: number | null;
	first_seen: number;
	last_seen: number;
	closed_at: number | null;
	lost_at: number | null;
}

/** Columns read for servers. The access code is not among them because it is never stored. */
const SERVER_COLUMNS =
	"job, server_type, branch, channel, artifact, players, max_players, started_at, last_write, place_id, experiment, kernel, applied_seq, generation, health, last_error, server_version, first_seen, last_seen, closed_at, lost_at";

const iso = (ms: number | null | undefined) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

function serverInfo(r: ServerRow, now: number): ServerInfo {
	return {
		job: r.job,
		serverType: r.server_type,
		lastSeen: new Date(r.last_seen).toISOString(),
		ageSeconds: Math.max(0, Math.round((now - r.last_seen) / 1000)),
		branch: r.branch,
		channel: r.channel,
		artifact: r.artifact,
		players: r.players,
		maxPlayers: r.max_players,
		startedAt: iso(r.started_at),
		lastWrite: iso(r.last_write),
		placeId: r.place_id,
		experiment: r.experiment === 1,
		kernel: r.kernel,
		appliedSeq: r.applied_seq,
		generation: r.generation,
		health: r.health,
		lastError: r.last_error,
		serverVersion: r.server_version,
	};
}

interface AlertRow {
	id: number;
	level: AlertLevel;
	code: string;
	message: string;
	job: string | null;
	branch: string | null;
	artifact: string | null;
	seq: number | null;
	generation: number | null;
	kernel: string | null;
	source: Alert["source"];
	details: string | null;
	created: number;
	acked_at: number | null;
	acked_by: string | null;
}

function alertOf(r: AlertRow): Alert {
	let details: Record<string, unknown> | null = null;
	if (r.details) {
		try {
			details = JSON.parse(r.details);
		} catch {}
	}
	return {
		id: r.id,
		level: r.level,
		code: r.code,
		message: r.message,
		job: r.job,
		branch: r.branch,
		artifact: r.artifact,
		seq: r.seq,
		generation: r.generation,
		kernel: r.kernel,
		source: r.source,
		details,
		createdAt: new Date(r.created).toISOString(),
		at: r.created,
		acked: r.acked_at !== null,
		ackedAt: iso(r.acked_at),
		ackedBy: r.acked_by,
	};
}

function median(values: number[]): number | null {
	if (!values.length) return null;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS servers (
	job TEXT PRIMARY KEY, server_type TEXT, branch TEXT, channel TEXT, artifact TEXT, players INTEGER, max_players INTEGER, started_at INTEGER,
	last_write INTEGER, place_id INTEGER, experiment INTEGER, kernel TEXT, applied_seq INTEGER, generation INTEGER, health TEXT,
	last_error TEXT, server_version INTEGER, sent_at INTEGER, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
	closed_at INTEGER, lost_at INTEGER);
CREATE INDEX IF NOT EXISTS servers_branch ON servers (branch, last_seen);
CREATE INDEX IF NOT EXISTS servers_seen ON servers (last_seen);
CREATE TABLE IF NOT EXISTS reports (
	id INTEGER PRIMARY KEY AUTOINCREMENT, seq INTEGER NOT NULL, branch TEXT, artifact TEXT, job TEXT NOT NULL, result TEXT NOT NULL,
	error TEXT, seconds REAL, t INTEGER, generation INTEGER, kernel TEXT, players INTEGER, received INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reports_seq ON reports (seq, job);
CREATE INDEX IF NOT EXISTS reports_artifact ON reports (artifact);
CREATE INDEX IF NOT EXISTS reports_received ON reports (received);
CREATE TABLE IF NOT EXISTS alerts (
	id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT NOT NULL, code TEXT NOT NULL, message TEXT NOT NULL, job TEXT, branch TEXT,
	artifact TEXT, seq INTEGER, t INTEGER, generation INTEGER, kernel TEXT, source TEXT NOT NULL, details TEXT, created INTEGER NOT NULL,
	acked_at INTEGER, acked_by TEXT);
CREATE INDEX IF NOT EXISTS alerts_created ON alerts (created);
CREATE TABLE IF NOT EXISTS deploys (
	seq INTEGER PRIMARY KEY, branch TEXT, artifact TEXT, channel TEXT, t INTEGER, received INTEGER NOT NULL, stuck_at INTEGER);
CREATE INDEX IF NOT EXISTS deploys_received ON deploys (received);
`;

export interface FleetServiceOptions {
	db: FleetDb;
	clock?: () => number;
	notifier?: Notifier;
	log?: (line: string) => void;
}

export class FleetService {
	private readonly db: FleetDb;
	private readonly clock: () => number;
	private readonly listeners = new Set<(event: FleetEvent) => void>();
	private lastRetention = 0;

	private constructor(private readonly options: FleetServiceOptions) {
		this.db = options.db;
		this.clock = options.clock ?? Date.now;
	}

	static async open(options: FleetServiceOptions): Promise<FleetService> {
		const service = new FleetService(options);
		await options.db.exec(SCHEMA);
		return service;
	}

	// Events (Server-Sent Events) ---------------------------------------------------------------------------------------

	subscribe(listener: (event: FleetEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get subscribers(): number {
		return this.listeners.size;
	}

	private emit(event: FleetEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {}
		}
	}

	// Ingest (game kernels; the CLI for deploy and auto_rollback) -------------------------------------------------------

	/**
	 * The kernel's fleet status plus j = JobId (kernel src/server/Fleet.luau): { t = server type, b, c?, a?, n, m,
	 * s = start (unix s), u = now (unix s), p, x = 1?, v, q, g, h, e?, sv = 2 }. `k` (an access code) is ignored. The
	 * JobId may also come in the X-TT-Job header.
	 */
	async heartbeat(raw: unknown, jobHeader?: string | null): Promise<void> {
		const b = asBody(raw);
		const job = text(b, "j", JOB) ?? (jobHeader ? text({ j: jobHeader }, "j", JOB) : null);
		if (!job) throw new FleetInputError("j (the JobId) is required");
		const now = this.clock();
		// `t` is the server type (a string); a number there is taken as the send time.
		const serverType = typeof b.t === "string" ? text(b, "t", 16) : null;
		const sentAt = typeof b.t === "number" ? toMs(int(b, "t")) : null;
		const row: SqlValue[] = [
			job,
			serverType,
			text(b, "b", 64),
			text(b, "c", 16),
			text(b, "a", 64),
			int(b, "n"),
			int(b, "m"),
			toMs(int(b, "s")),
			toMs(int(b, "u")),
			int(b, "p"),
			loose(b, "x") === 1 ? 1 : 0,
			text(b, "v", 32),
			int(b, "q"),
			int(b, "g"),
			text(b, "h", 16),
			text(b, "e", 500),
			loose(b, "sv"),
			sentAt,
			now,
			now,
		];
		const before = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		await this.db.run(
			`INSERT INTO servers (job, server_type, branch, channel, artifact, players, max_players, started_at, last_write, place_id, experiment, kernel, applied_seq, generation, health, last_error, server_version, sent_at, first_seen, last_seen) ` +
				`VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(job) DO UPDATE SET server_type = excluded.server_type, branch = excluded.branch, channel = excluded.channel, ` +
				`artifact = excluded.artifact, players = excluded.players, max_players = excluded.max_players, started_at = excluded.started_at, ` +
				`last_write = excluded.last_write, place_id = excluded.place_id, experiment = excluded.experiment, kernel = excluded.kernel, ` +
				`applied_seq = excluded.applied_seq, generation = excluded.generation, health = excluded.health, last_error = excluded.last_error, ` +
				`server_version = excluded.server_version, sent_at = excluded.sent_at, last_seen = excluded.last_seen, closed_at = NULL, lost_at = NULL`,
			row,
		);
		if (!this.listeners.size) return;
		const after = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		if (!after) return;
		let change: "new" | "update" | "back" | undefined;
		if (!before || before.closed_at !== null) change = "new";
		else if (before.lost_at !== null) change = "back";
		else {
			const keys: (keyof ServerRow)[] = ["branch", "artifact", "players", "applied_seq", "generation", "health", "last_error", "kernel", "experiment"];
			if (keys.some((k) => before[k] !== after[k])) change = "update";
		}
		if (change) this.emit({ type: "server", change, server: serverInfo(after, now) });
	}

	/** `{s,b,a,j,r,e?,d?,t,g,k,p}` (k here is the kernel version). */
	async report(raw: unknown): Promise<void> {
		const b = asBody(raw);
		const seq = int(b, "s", true) as number;
		const job = text(b, "j", JOB, true) as string;
		const result = text(b, "r", 32, true) as string;
		if (!(DEPLOY_RESULTS as readonly string[]).includes(result)) throw new FleetInputError(`r must be one of ${DEPLOY_RESULTS.join(", ")}`);
		const branch = text(b, "b", 64);
		const artifact = text(b, "a", 64);
		const now = this.clock();
		await this.db.run(
			"INSERT INTO reports (seq, branch, artifact, job, result, error, seconds, t, generation, kernel, players, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[seq, branch, artifact, job, result, text(b, "e", 500), number(b, "d"), int(b, "t"), int(b, "g"), text(b, "k", 32), int(b, "p"), now],
		);
		// A report also tells us a deploy happened (the CLI's POST /v1/fleet/deploy may not have come).
		await this.db.run("INSERT OR IGNORE INTO deploys (seq, branch, artifact, channel, t, received) VALUES (?, ?, ?, NULL, NULL, ?)", [seq, branch, artifact, now]);
		this.emit({ type: "report", seq, job, result, branch });
	}

	/** `{s, b, a, ch, t}` from the CLI when a deploy starts: gives stuck detection a start time. */
	async deploy(raw: unknown): Promise<void> {
		const b = asBody(raw);
		const seq = int(b, "s", true) as number;
		const branch = text(b, "b", 64, true);
		const artifact = text(b, "a", 64);
		const now = this.clock();
		await this.db.run(
			"INSERT INTO deploys (seq, branch, artifact, channel, t, received) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(seq) DO UPDATE SET branch = excluded.branch, " +
				"artifact = COALESCE(excluded.artifact, deploys.artifact), channel = excluded.channel, t = excluded.t, received = MIN(deploys.received, excluded.received)",
			[seq, branch, artifact, text(b, "ch", 16), int(b, "t"), now],
		);
		this.emit({ type: "deploy", seq, branch, artifact });
	}

	/**
	 * The server is shutting down (no "server lost" alert for it). The kernel sends its heartbeat body plus
	 * `closing = true` from BindToClose; `{ j, t }` alone works too.
	 */
	async closing(raw: unknown, jobHeader?: string | null): Promise<void> {
		const b = asBody(raw);
		const job = text(b, "j", JOB) ?? (jobHeader ? text({ j: jobHeader }, "j", JOB) : null);
		if (!job) throw new FleetInputError("j (the JobId) is required");
		if (Object.keys(b).some((k) => !["j", "t", "closing"].includes(k))) await this.heartbeat(b, jobHeader);
		const now = this.clock();
		await this.db.run("UPDATE servers SET closed_at = ?, last_seen = ? WHERE job = ?", [now, now, job]);
		const row = await this.db.first<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE job = ?`, [job]);
		if (row) this.emit({ type: "server", change: "closed", server: serverInfo(row, now) });
	}

	/** `{level, code, message, j, b, a, s, t, g, k}` from a kernel (source game) or the CLI (source cli, e.g. auto_rollback). */
	async alert(raw: unknown, source: "game" | "cli" = "game"): Promise<Alert> {
		const b = asBody(raw);
		const level = text(b, "level", 16, true);
		if (!(ALERT_LEVELS as readonly string[]).includes(level ?? "")) throw new FleetInputError("level must be critical, warning or info");
		const code = text(b, "code", 64, true) as string;
		if (!/^[a-z0-9_.-]+$/.test(code)) throw new FleetInputError("code must be lowercase letters, digits, _ . -");
		// The CLI posts with j = "cli" (cli/src/fleet.ts alertBody); auto_rollback only ever comes from the CLI.
		const fromCli = source === "cli" || code === "auto_rollback" || b.j === "cli";
		return this.addAlert({
			level: level as AlertLevel,
			code,
			message: text(b, "message", 500, true) as string,
			job: b.j === "cli" ? null : text(b, "j", JOB),
			branch: text(b, "b", 64),
			artifact: text(b, "a", 64),
			seq: int(b, "s"),
			t: int(b, "t"),
			generation: int(b, "g"),
			kernel: text(b, "k", 32),
			source: fromCli ? "cli" : "game",
			details: null,
		});
	}

	private async addAlert(a: Omit<Alert, "id" | "createdAt" | "at" | "acked" | "ackedAt" | "ackedBy" | "details"> & { t?: number | null; details: Record<string, unknown> | null }): Promise<Alert> {
		const now = this.clock();
		const { lastId } = await this.db.run(
			"INSERT INTO alerts (level, code, message, job, branch, artifact, seq, t, generation, kernel, source, details, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
			[a.level, a.code, a.message, a.job, a.branch, a.artifact, a.seq, a.t ?? null, a.generation, a.kernel, a.source, a.details ? JSON.stringify(a.details) : null, now],
		);
		const alert = alertOf((await this.db.first<AlertRow>("SELECT * FROM alerts WHERE id = ?", [lastId])) as AlertRow);
		this.emit({ type: "alert", alert });
		this.options.notifier?.notify(alert);
		return alert;
	}

	// Reads (admin) -----------------------------------------------------------------------------------------------------

	async servers(options: { branch?: string; maxAgeSeconds?: number } = {}): Promise<{ servers: ServerInfo[]; players: number; byArtifact: { artifact: string; servers: number; players: number }[]; byHealth: Record<string, number> }> {
		const now = this.clock();
		const since = now - (options.maxAgeSeconds ?? LOST_AFTER_MS / 1000) * 1000;
		const params: SqlValue[] = [since];
		let sql = `SELECT ${SERVER_COLUMNS} FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ?`;
		if (options.branch) {
			sql += " AND branch = ?";
			params.push(options.branch);
		}
		const rows = await this.db.all<ServerRow>(`${sql} ORDER BY last_seen DESC, job`, params);
		const servers = rows.map((r) => serverInfo(r, now));
		const art = new Map<string, { servers: number; players: number }>();
		const byHealth: Record<string, number> = {};
		for (const s of servers) {
			const key = s.artifact ?? "(unknown)";
			const a = art.get(key) ?? { servers: 0, players: 0 };
			a.servers++;
			a.players += s.players ?? 0;
			art.set(key, a);
			byHealth[s.health ?? "(unknown)"] = (byHealth[s.health ?? "(unknown)"] ?? 0) + 1;
		}
		return {
			servers,
			players: servers.reduce((sum, s) => sum + (s.players ?? 0), 0),
			byArtifact: [...art].map(([artifact, v]) => ({ artifact, ...v })).sort((a, b) => b.servers - a.servers),
			byHealth,
		};
	}

	async reports(options: { seq?: number; artifact?: string; latest?: boolean; branch?: string } = {}): Promise<FleetReport> {
		const now = this.clock();
		let seq: number | null = options.seq ?? null;
		if (seq === null && options.artifact) {
			seq = (await this.db.first<{ s: number | null }>("SELECT MAX(seq) AS s FROM (SELECT seq FROM reports WHERE artifact = ? UNION ALL SELECT seq FROM deploys WHERE artifact = ?)", [options.artifact, options.artifact]))?.s ?? null;
		}
		if (seq === null) {
			const branch = options.branch ?? null;
			seq =
				(await this.db.first<{ s: number | null }>("SELECT MAX(seq) AS s FROM (SELECT seq, branch FROM reports UNION ALL SELECT seq, branch FROM deploys) WHERE ? IS NULL OR branch = ?", [branch, branch]))?.s ?? null;
		}
		const empty: FleetReport = { seq, branch: options.branch ?? null, artifact: null, startedAt: null, firstReport: null, lastReport: null, reported: 0, results: [], errors: [], behind: [], stuck: [], reports: [] };
		if (seq === null) return empty;
		const deploy = await this.db.first<{ branch: string | null; artifact: string | null; received: number }>("SELECT branch, artifact, received FROM deploys WHERE seq = ?", [seq]);
		const latest = await this.db.all<{ job: string; result: string; error: string | null; seconds: number | null; players: number | null; received: number; branch: string | null; artifact: string | null }>(
			"SELECT r.job, r.result, r.error, r.seconds, r.players, r.received, r.branch, r.artifact FROM reports r JOIN (SELECT job, MAX(id) AS id FROM reports WHERE seq = ? GROUP BY job) l ON l.id = r.id",
			[seq],
		);
		const branch = options.branch ?? deploy?.branch ?? latest.find((r) => r.branch)?.branch ?? null;
		const all = await this.db.all<{ seq: number; branch: string | null; artifact: string | null; job: string; result: string; error: string | null; seconds: number | null; t: number | null; received: number; generation: number | null; kernel: string | null; players: number | null }>(
			"SELECT seq, branch, artifact, job, result, error, seconds, t, received, generation, kernel, players FROM reports WHERE seq = ? ORDER BY id",
			[seq],
		);
		const groups = new Map<string, { servers: number; players: number; seconds: number[] }>();
		const errors = new Map<string, { servers: number; exampleJob: string }>();
		for (const r of latest) {
			const g = groups.get(r.result) ?? { servers: 0, players: 0, seconds: [] };
			g.servers++;
			g.players += r.players ?? 0;
			if (r.seconds !== null) g.seconds.push(r.seconds);
			groups.set(r.result, g);
			if (r.error) {
				const e = errors.get(r.error) ?? { servers: 0, exampleJob: r.job };
				e.servers++;
				errors.set(r.error, e);
			}
		}
		const order = (r: string) => {
			const i = (DEPLOY_RESULTS as readonly string[]).indexOf(r);
			return i < 0 ? 99 : i;
		};
		const params: SqlValue[] = [now - LOST_AFTER_MS, seq];
		let sql = `SELECT ${SERVER_COLUMNS} FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ? AND (applied_seq IS NULL OR applied_seq < ?)`;
		if (branch) {
			sql += " AND branch = ?";
			params.push(branch);
		}
		const behindRows = await this.db.all<ServerRow>(`${sql} ORDER BY job`, params);
		const reported = new Set(latest.map((r) => r.job));
		const started = deploy?.received ?? (latest.length ? Math.min(...latest.map((r) => r.received)) : null);
		const stuck = started !== null && now - started >= STUCK_AFTER_MS ? behindRows.filter((r) => !reported.has(r.job)).map((r) => r.job) : [];
		const times = latest.map((r) => r.received);
		const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);
		return {
			seq,
			branch,
			artifact: deploy?.artifact ?? latest.find((r) => r.artifact)?.artifact ?? null,
			startedAt: iso(started),
			firstReport: times.length ? iso(Math.min(...times)) : null,
			lastReport: times.length ? iso(Math.max(...times)) : null,
			reported: latest.length,
			results: [...groups]
				.map(([result, g]) => ({ result, servers: g.servers, players: g.players, medianSeconds: round1(median(g.seconds)), maxSeconds: round1(g.seconds.length ? Math.max(...g.seconds) : null) }))
				.sort((a, b) => order(a.result) - order(b.result)),
			errors: [...errors].map(([error, e]) => ({ error, ...e })).sort((a, b) => b.servers - a.servers),
			behind: behindRows.map((r) => serverInfo(r, now)),
			stuck,
			reports: all.map((r) => ({
				seq: r.seq,
				branch: r.branch,
				artifact: r.artifact,
				job: r.job,
				result: r.result,
				error: r.error,
				seconds: r.seconds,
				at: toMs(r.t) ?? r.received,
				generation: r.generation,
				kernel: r.kernel,
				players: r.players,
			})),
		};
	}

	async alerts(options: { since?: number; level?: AlertLevel; unacked?: boolean; limit?: number } = {}): Promise<Alert[]> {
		const where: string[] = ["created >= ?"];
		const params: SqlValue[] = [options.since ?? 0];
		if (options.level) {
			where.push("level = ?");
			params.push(options.level);
		}
		if (options.unacked) where.push("acked_at IS NULL");
		params.push(Math.min(Math.max(1, options.limit ?? 200), 1000));
		return (await this.db.all<AlertRow>(`SELECT * FROM alerts WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`, params)).map(alertOf);
	}

	async ack(id: number, by?: string): Promise<boolean> {
		const { changes } = await this.db.run("UPDATE alerts SET acked_at = ?, acked_by = ? WHERE id = ? AND acked_at IS NULL", [this.clock(), by ? by.slice(0, 64) : null, id]);
		if (changes) this.emit({ type: "alert_ack", id });
		return changes > 0;
	}

	// Server-side alerts and upkeep (the host calls this every ~10 s) ---------------------------------------------------

	async sweep(): Promise<{ lost: number; stuck: number }> {
		const now = this.clock();
		// server_lost: no heartbeat for 90 s and no closing message.
		const lostRows = await this.db.all<ServerRow>(`SELECT ${SERVER_COLUMNS} FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen < ?`, [now - LOST_AFTER_MS]);
		const groups = new Map<string, ServerRow[]>();
		for (const r of lostRows) {
			await this.db.run("UPDATE servers SET lost_at = ? WHERE job = ?", [now, r.job]);
			this.emit({ type: "server", change: "lost", server: serverInfo({ ...r, lost_at: now }, now) });
			const key = `${r.branch ?? ""}\u0000${r.artifact ?? ""}`;
			groups.set(key, [...(groups.get(key) ?? []), r]);
		}
		for (const rows of groups.values()) {
			const { branch, artifact } = rows[0];
			const n = rows.length;
			await this.addAlert({
				level: n >= 3 ? "critical" : "warning",
				code: "server_lost",
				message: `${n} server${n === 1 ? "" : "s"}${branch ? ` on ${branch}` : ""} stopped sending heartbeats for 90 s without closing`,
				job: n === 1 ? rows[0].job : null,
				branch,
				artifact,
				seq: null,
				generation: null,
				kernel: null,
				source: "server",
				details: { jobs: rows.slice(0, 50).map((r) => r.job), count: n },
			});
		}
		// server_stuck: 3+ minutes after a deploy started, live servers still below its seq and with no report for it.
		let stuck = 0;
		const deploys = await this.db.all<{ seq: number; branch: string | null; artifact: string | null; received: number }>(
			"SELECT seq, branch, artifact, received FROM deploys WHERE stuck_at IS NULL AND received <= ? AND received >= ?",
			[now - STUCK_AFTER_MS, now - STUCK_WINDOW_MS],
		);
		for (const d of deploys) {
			if (!d.branch) continue;
			const rows = await this.db.all<{ job: string }>(
				"SELECT s.job FROM servers s WHERE s.closed_at IS NULL AND s.lost_at IS NULL AND s.last_seen >= ? AND s.branch = ? AND (s.applied_seq IS NULL OR s.applied_seq < ?) " +
					"AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.seq = ? AND r.job = s.job) ORDER BY s.job",
				[now - LOST_AFTER_MS, d.branch, d.seq, d.seq],
			);
			if (!rows.length) continue;
			await this.db.run("UPDATE deploys SET stuck_at = ? WHERE seq = ?", [now, d.seq]);
			stuck += rows.length;
			await this.addAlert({
				level: "warning",
				code: "server_stuck",
				message: `${rows.length} server${rows.length === 1 ? " is" : "s are"} still below seq ${d.seq} on ${d.branch} with no deploy report after 3 minutes`,
				job: rows.length === 1 ? rows[0].job : null,
				branch: d.branch,
				artifact: d.artifact,
				seq: d.seq,
				generation: null,
				kernel: null,
				source: "server",
				details: { jobs: rows.slice(0, 100).map((r) => r.job), count: rows.length },
			});
		}
		if (now - this.lastRetention > 3_600_000) {
			this.lastRetention = now;
			await this.db.run("DELETE FROM reports WHERE received < ?", [now - KEEP_REPORTS_MS]);
			await this.db.run("DELETE FROM alerts WHERE created < ?", [now - KEEP_ALERTS_MS]);
			await this.db.run("DELETE FROM deploys WHERE received < ?", [now - KEEP_ALERTS_MS]);
			await this.db.run("DELETE FROM servers WHERE (closed_at IS NOT NULL AND closed_at < ?) OR (lost_at IS NOT NULL AND lost_at < ?)", [now - KEEP_GONE_SERVERS_MS, now - KEEP_GONE_SERVERS_MS]);
		}
		return { lost: lostRows.length, stuck };
	}

	async counts(): Promise<{ servers: number; reports: number; alerts: number; unacked: number }> {
		const now = this.clock();
		const r = await this.db.first<{ servers: number; reports: number; alerts: number; unacked: number }>(
			"SELECT (SELECT COUNT(*) FROM servers WHERE closed_at IS NULL AND lost_at IS NULL AND last_seen >= ?) AS servers, (SELECT COUNT(*) FROM reports) AS reports, " +
				"(SELECT COUNT(*) FROM alerts) AS alerts, (SELECT COUNT(*) FROM alerts WHERE acked_at IS NULL) AS unacked",
			[now - LOST_AFTER_MS],
		);
		return r ?? { servers: 0, reports: 0, alerts: 0, unacked: 0 };
	}

	async close(): Promise<void> {
		this.listeners.clear();
		await this.db.close();
	}
}
