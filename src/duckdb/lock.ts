/**
 * One process per data folder. DuckDB lets one process write a database file (others can't even read it then); the
 * server holds `lock.duckdb` and `live.duckdb` for its whole run (server/warehouse.ts), so a second server on the same
 * folder (a rolling deploy's new container) waits, and a local read-only store refuses to open it.
 */

/**
 * Another process holds the data folder's DuckDB files (the previous container during a rolling deploy, or a second
 * server on the same folder). The caller waits and tries again, or says so.
 */
export class DataFolderLocked extends Error {
	override name = "DataFolderLocked";
	constructor(
		/** The file that could not be locked. */
		readonly file: string,
		/** DuckDB's message (names the other process where it can). */
		readonly detail: string,
	) {
		super(`${file} is held by another process`);
	}
}

/**
 * DuckDB's "someone else has this file" errors: "Could not set lock on file ... Conflicting lock is held in ..." (Linux,
 * macOS), "Cannot open file ...: The process cannot access the file because it is being used by another process. File is
 * already open in ..." (Windows).
 */
export function isLockConflict(error: unknown): boolean {
	const message = (error as Error | undefined)?.message ?? String(error);
	return /Could not set lock on file|Conflicting lock is held|being used by another process|File is already open in/i.test(message);
}
