/**
 * Raw files first: every accepted batch is appended to an NDJSON file (one row per line) before the 202, so spikes
 * fill files, never the database, and nothing accepted is lost when the process restarts. One open file per table
 * (`<table>-<start ms>-<n>.ndjson.open`); the loader rotates it (rename to `.ndjson`) and loads the ready files in
 * big chunks. Writes are serialized per file; data is fdatasync'ed every `fsyncMs` (0 = on every write).
 */
import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export type RawTable = "events" | "recordings";

interface OpenFile {
	path: string;
	handle: FileHandle;
	started: number;
	bytes: number;
	dirty: boolean;
}

export interface ReadyFile {
	table: RawTable;
	path: string;
	name: string;
	/** When the file was started (ms): the oldest data in it. */
	started: number;
	bytes: number;
}

const FILE = /^(events|recordings)-(\d+)-(\d+)\.ndjson(\.open)?$/;

/** An append after close(): the server is stopping (the request answers 503; the sender retries). */
export class RawLogClosed extends Error {
	override name = "RawLogClosed";
	constructor() {
		super("the raw log is closed: the server is stopping");
	}
}

export class RawLog {
	private files = new Map<RawTable, OpenFile>();
	private chain: Promise<unknown> = Promise.resolve();
	private counter = 0;
	private syncTimer: ReturnType<typeof setInterval> | undefined;
	private closed = false;
	/** Bytes appended since start (stats). */
	appended = 0;

	constructor(
		readonly dir: string,
		private readonly fsyncMs: number,
		private readonly clock: () => number = Date.now,
	) {
		mkdirSync(dir, { recursive: true });
		// Files left open by a previous run hold accepted rows: make them ready.
		for (const name of readdirSync(dir)) if (name.endsWith(".ndjson.open")) renameSync(join(dir, name), join(dir, name.slice(0, -".open".length)));
		if (fsyncMs > 0) {
			this.syncTimer = setInterval(() => void this.sync(), fsyncMs);
			this.syncTimer.unref?.();
		}
	}

	/** Runs `job` after every write queued before it (one writer at a time). */
	private serial<T>(job: () => Promise<T>): Promise<T> {
		const next = this.chain.then(job, job);
		this.chain = next.catch(() => {});
		return next;
	}

	/**
	 * Appends lines (each ends with \n) to the table's open file. Resolves once written. After close() it throws
	 * RawLogClosed: a file opened then would stay ".open" until a later restart, since the next server may already own
	 * the folder.
	 */
	append(table: RawTable, text: string): Promise<void> {
		return this.serial(async () => {
			if (this.closed) throw new RawLogClosed();
			let file = this.files.get(table);
			if (!file) {
				const started = this.clock();
				const path = join(this.dir, `${table}-${started}-${++this.counter}.ndjson.open`);
				file = { path, handle: await open(path, "a"), started, bytes: 0, dirty: false };
				this.files.set(table, file);
			}
			const data = Buffer.from(text, "utf8");
			await file.handle.write(data);
			file.bytes += data.length;
			file.dirty = true;
			this.appended += data.length;
			if (this.fsyncMs === 0) {
				await file.handle.datasync();
				file.dirty = false;
			}
		});
	}

	sync(): Promise<void> {
		return this.serial(async () => {
			for (const file of this.files.values()) {
				if (!file.dirty) continue;
				await file.handle.datasync();
				file.dirty = false;
			}
		});
	}

	/** Closes the open files and makes them ready for the loader. */
	rotate(): Promise<void> {
		return this.serial(async () => {
			for (const [table, file] of this.files) {
				if (file.dirty) await file.handle.datasync();
				await file.handle.close();
				renameSync(file.path, file.path.slice(0, -".open".length));
				this.files.delete(table);
			}
		});
	}

	/** Ready files, oldest first. */
	ready(): ReadyFile[] {
		const out: ReadyFile[] = [];
		for (const name of readdirSync(this.dir)) {
			const m = FILE.exec(name);
			if (!m || m[4]) continue;
			const path = join(this.dir, name);
			out.push({ table: m[1] as RawTable, path, name, started: Number(m[2]), bytes: statSync(path).size });
		}
		return out.sort((a, b) => a.started - b.started || a.name.localeCompare(b.name));
	}

	/** The oldest unloaded data (open or ready), ms; undefined when everything is loaded. */
	oldestPending(): number | undefined {
		let oldest: number | undefined;
		for (const file of this.files.values()) if (file.bytes > 0) oldest = Math.min(oldest ?? Infinity, file.started);
		for (const file of this.ready()) oldest = Math.min(oldest ?? Infinity, file.started);
		return oldest;
	}

	pendingBytes(): number {
		let bytes = 0;
		for (const file of this.files.values()) bytes += file.bytes;
		for (const file of this.ready()) bytes += file.bytes;
		return bytes;
	}

	/** Syncs and closes the open files, makes them ready for the loader (this run's or the next one's), refuses appends. */
	async close(): Promise<void> {
		this.closed = true;
		if (this.syncTimer) clearInterval(this.syncTimer);
		await this.rotate();
	}
}
