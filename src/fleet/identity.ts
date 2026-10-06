/**
 * pid <-> UserId, from the identity rows game servers send (framework option `identity`): DuckDB games in the ingest
 * batch (`identities`), Basin games to `POST /v1/identity`. One table in the fleet SQLite file, so it's deletable and
 * the same for both backends: `identities (pid PRIMARY KEY, uid, first_seen, last_seen)`. The erasure webhook maps
 * UserId -> pid through it, then deletes the row.
 */
import type { FleetDb } from "./db.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS identities (pid TEXT PRIMARY KEY, uid INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS identities_uid ON identities (uid, last_seen);
`;

export const PID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Most identity rows taken from one request. */
export const IDENTITIES_MAX = 1000;

export interface IdentityRow {
	pid: string;
	uid: number;
	/** Unix ms. */
	t: number;
}

export interface Identity {
	pid: string;
	uid: number;
	firstSeen: string;
	lastSeen: string;
}

/** A UserId: a positive safe integer, as a number or a string of digits. */
export function parseUid(value: unknown): number | undefined {
	const n = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
	return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** Checks identity rows (bad ones are counted, not fatal). `now` stands in for a missing or odd `t`. */
export function parseIdentities(raw: unknown, now: number): { rows: IdentityRow[]; rejected: number } {
	const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
	const rows: IdentityRow[] = [];
	let rejected = 0;
	for (const item of list.slice(0, IDENTITIES_MAX)) {
		const r = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
		const uid = parseUid(r.uid);
		if (typeof r.pid !== "string" || !PID_PATTERN.test(r.pid) || uid === undefined) {
			rejected++;
			continue;
		}
		const t = typeof r.t === "number" && Number.isSafeInteger(r.t) && r.t > 0 && r.t < now + 86_400_000 ? r.t : now;
		rows.push({ pid: r.pid, uid, t });
	}
	return { rows, rejected: rejected + Math.max(0, list.length - IDENTITIES_MAX) };
}

interface Row {
	pid: string;
	uid: number;
	first_seen: number;
	last_seen: number;
}

const identityOf = (r: Row): Identity => ({ pid: r.pid, uid: Number(r.uid), firstSeen: new Date(Number(r.first_seen)).toISOString(), lastSeen: new Date(Number(r.last_seen)).toISOString() });

export class IdentityStore {
	private constructor(private readonly db: FleetDb) {}

	static async open(db: FleetDb): Promise<IdentityStore> {
		await db.exec(SCHEMA);
		return new IdentityStore(db);
	}

	/** Adds or refreshes rows (a pid keeps its first_seen; the newest UserId wins). Returns rows written. */
	async upsert(rows: IdentityRow[]): Promise<number> {
		let written = 0;
		for (const r of rows) {
			await this.db.run(
				"INSERT INTO identities (pid, uid, first_seen, last_seen) VALUES (?, ?, ?, ?) " +
					"ON CONFLICT(pid) DO UPDATE SET uid = excluded.uid, first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)",
				[r.pid, r.uid, r.t, r.t],
			);
			written++;
		}
		return written;
	}

	async byPid(pid: string): Promise<Identity | undefined> {
		const row = await this.db.first<Row>("SELECT pid, uid, first_seen, last_seen FROM identities WHERE pid = ?", [pid]);
		return row ? identityOf(row) : undefined;
	}

	/** A UserId's pids, the most recently seen first. */
	async byUid(uid: number): Promise<Identity[]> {
		return (await this.db.all<Row>("SELECT pid, uid, first_seen, last_seen FROM identities WHERE uid = ? ORDER BY last_seen DESC", [uid])).map(identityOf);
	}

	/** UserIds for many pids (unknown pids are left out). */
	async uids(pids: string[]): Promise<Map<string, number>> {
		const out = new Map<string, number>();
		for (let i = 0; i < pids.length; i += 200) {
			const chunk = pids.slice(i, i + 200);
			const rows = await this.db.all<{ pid: string; uid: number }>(`SELECT pid, uid FROM identities WHERE pid IN (${chunk.map(() => "?").join(", ")})`, chunk);
			for (const r of rows) out.set(r.pid, Number(r.uid));
		}
		return out;
	}

	async deleteUid(uid: number): Promise<number> {
		return (await this.db.run("DELETE FROM identities WHERE uid = ?", [uid])).changes;
	}

	async deletePids(pids: string[]): Promise<number> {
		let changes = 0;
		for (const pid of pids) changes += (await this.db.run("DELETE FROM identities WHERE pid = ?", [pid])).changes;
		return changes;
	}

	async count(): Promise<number> {
		return Number((await this.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM identities"))?.n ?? 0);
	}
}
