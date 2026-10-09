/**
 * DuckDB store: the logical queries on a DuckDB connection. Used three ways:
 *   - inside the analytics server, over its live file + day Parquet files (server/db.ts builds it);
 *   - on your PC over a copy of a server's data folder (`openDuckDbStore({ dataDir })`, read-only);
 *   - in tests, over plain tables (`new DuckDbStore(connection, () => "events")`).
 */
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync } from "node:fs";
import { dataLayout, pathLit, tableExpression } from "../duckdb/layout.ts";
import { DataFolderLocked, isLockConflict } from "../duckdb/lock.ts";
import type { Row, TableName } from "../queries/core.ts";
import { duckdb } from "../sql/dialect.ts";
import { SqlStore } from "./sql-store.ts";

/** A DuckDB value as plain JSON-able JS: BIGINT/HUGEINT -> number, everything else as DuckDB's JS conversion gives it. */
export function plain(value: unknown): unknown {
	if (typeof value === "bigint") return Number(value);
	if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
		const v = value as { toDouble?: () => number; toString(): string };
		if (typeof v.toDouble === "function") return v.toDouble();
		return v.toString();
	}
	return value;
}

export async function readRows(connection: DuckDBConnection, sql: string): Promise<Row[]> {
	const reader = await connection.runAndReadAll(sql);
	const rows = reader.getRowObjectsJS() as Record<string, unknown>[];
	for (const row of rows) for (const key of Object.keys(row)) row[key] = plain(row[key]);
	return rows;
}

export type TableResolver = (name: TableName, from: number, to: number) => string;

export class DuckDbStore extends SqlStore {
	readonly backend = "duckdb" as const;
	readonly dialect = duckdb;

	constructor(
		readonly connection: DuckDBConnection,
		private readonly resolve: TableResolver,
		clock?: () => number,
		private readonly onClose?: () => Promise<void> | void,
	) {
		super(clock);
	}

	protected table(name: TableName, from: number, to: number): string {
		return this.resolve(name, from, to);
	}

	sql(statement: string): Promise<Row[]> {
		return readRows(this.connection, statement);
	}

	async close(): Promise<void> {
		await this.onClose?.();
	}
}

export interface LocalDuckDbOptions {
	/** A copy of an analytics server's data folder. */
	dataDir: string;
	memoryLimit?: string;
	threads?: number;
	clock?: () => number;
}

/**
 * Opens a read-only store over a data folder: a copy of a server's, or one no server is using. A folder a running
 * server holds is refused with DataFolderLocked (ask that server over HTTP instead: `{ url, token }`), so a second
 * handle never sits next to the server's; while this store is open, a server starting on the folder waits for it.
 */
export async function openDuckDbStore(options: LocalDuckDbOptions): Promise<DuckDbStore> {
	const layout = dataLayout(options.dataDir);
	const instance = await DuckDBInstance.create(":memory:", {
		memory_limit: options.memoryLimit ?? "1GB",
		threads: String(options.threads ?? 4),
	});
	let connection: DuckDBConnection | undefined;
	const hasLive = existsSync(layout.live);
	try {
		connection = await instance.connect();
		// The owner lock first (shared): a running server holds it even while compaction has live.duckdb detached.
		for (const [file, alias] of [
			[layout.lock, "folder_lock"],
			[layout.live, "live"],
		] as const) {
			if (!existsSync(file)) continue;
			try {
				await connection.run(`ATTACH ${pathLit(file)} AS ${alias} (READ_ONLY)`);
			} catch (error) {
				if (!isLockConflict(error)) throw error;
				const locked = new DataFolderLocked(file, (error as Error).message);
				locked.message = `a running backend holds ${file}: query it over HTTP ({ url, token }) or open a copy of the folder`;
				throw locked;
			}
		}
	} catch (error) {
		try {
			connection?.closeSync();
		} catch {}
		instance.closeSync();
		throw error;
	}
	const open = connection;
	return new DuckDbStore(open, (name, from, to) => tableExpression(layout, name, from, to, hasLive ? "live" : null), options.clock, () => {
		open.closeSync();
		instance.closeSync();
	});
}
