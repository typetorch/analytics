/**
 * The owners who may sign in to the explorer with Roblox: the access list the CLI sends with the admin token whenever it
 * writes the signed settings record (`PUT /v1/access { seq, owners: [UserId, ...] }`). Kept in `<data dir>/access.json`.
 * A lower seq is refused (a stale CLI can't bring back a removed owner); the same seq is accepted only with the same list.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const OWNERS_MAX = 200;

export interface AccessRecord {
	seq: number | null;
	owners: number[];
	updatedAt: string | null;
}

export class AccessError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 409,
		/** The stored seq, on a 409. */
		readonly seq?: number | null,
	) {
		super(message);
	}
}

/** Checks a PUT body: `{ seq: whole number >= 0, owners: [positive whole numbers] }`. */
export function parseAccessBody(body: unknown): { seq: number; owners: number[] } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AccessError("body must be an object { seq, owners }", 400);
	const b = body as Record<string, unknown>;
	if (typeof b.seq !== "number" || !Number.isSafeInteger(b.seq) || b.seq < 0) throw new AccessError("seq must be a whole number from 0", 400);
	if (!Array.isArray(b.owners)) throw new AccessError("owners must be an array of Roblox UserIds", 400);
	if (b.owners.length > OWNERS_MAX) throw new AccessError(`at most ${OWNERS_MAX} owners`, 400);
	const owners: number[] = [];
	for (const o of b.owners) {
		const n = typeof o === "string" && /^\d{1,16}$/.test(o) ? Number(o) : o;
		if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) throw new AccessError("owners must be positive whole numbers (Roblox UserIds)", 400);
		if (!owners.includes(n)) owners.push(n);
	}
	return { seq: b.seq, owners: owners.sort((x, y) => x - y) };
}

export class AccessStore {
	private record: AccessRecord = { seq: null, owners: [], updatedAt: null };
	private owners = new Set<number>();

	constructor(
		private readonly file: string,
		private readonly clock: () => number = Date.now,
	) {
		this.read();
	}

	private read(): void {
		this.record = { seq: null, owners: [], updatedAt: null };
		this.owners = new Set();
		if (!existsSync(this.file)) return;
		try {
			const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<AccessRecord>;
			if (Array.isArray(parsed.owners)) {
				const owners = parsed.owners.filter((o): o is number => typeof o === "number" && Number.isSafeInteger(o) && o > 0);
				this.record = { seq: typeof parsed.seq === "number" ? parsed.seq : null, owners, updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null };
				this.owners = new Set(owners);
			}
		} catch {
			// An unreadable file means no owners until the CLI sends the list again: fail closed.
		}
	}

	/**
	 * Reads the file again (a deploy's previous server may have saved a newer list while both ran). Returns whether the
	 * list changed; the caller ends the sessions of owners who are gone.
	 */
	reload(): boolean {
		const before = `${this.record.seq}:${this.record.owners.join(",")}`;
		this.read();
		return `${this.record.seq}:${this.record.owners.join(",")}` !== before;
	}

	static at(dataDir: string, clock?: () => number): AccessStore {
		return new AccessStore(join(dataDir, "access.json"), clock);
	}

	get(): AccessRecord {
		return { seq: this.record.seq, owners: [...this.record.owners], updatedAt: this.record.updatedAt };
	}

	isOwner(userId: number): boolean {
		return this.owners.has(userId);
	}

	/** Replaces the list. Returns the owners that were removed (their sessions end). Throws AccessError (409) on a stale seq. */
	put(body: unknown): { record: AccessRecord; removed: number[]; changed: boolean } {
		const next = parseAccessBody(body);
		const current = this.record.seq;
		if (current !== null && next.seq < current) throw new AccessError(`seq ${next.seq} is older than the stored seq ${current}`, 409, current);
		if (current !== null && next.seq === current && next.owners.join(",") !== this.record.owners.join(",")) {
			throw new AccessError(`seq ${next.seq} is already stored with a different list; send a higher seq`, 409, current);
		}
		const same = current === next.seq;
		const removed = this.record.owners.filter((o) => !next.owners.includes(o));
		if (!same) {
			this.record = { seq: next.seq, owners: next.owners, updatedAt: new Date(this.clock()).toISOString() };
			this.owners = new Set(next.owners);
			mkdirSync(dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, `${JSON.stringify(this.record)}\n`, { mode: 0o600 });
			renameSync(tmp, this.file);
		}
		return { record: this.get(), removed, changed: !same };
	}
}
