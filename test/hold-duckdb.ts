/**
 * Test helper, run as its own process (DuckDB's file locks are per process on Linux, so a second holder in the test's own
 * process wouldn't conflict): holds a data folder's DuckDB files like another server would.
 *   bun test/hold-duckdb.ts <data dir> [--only-live]
 * Attaches lock.duckdb and live.duckdb (--only-live: just live.duckdb, like a server from before the owner lock),
 * prints "held", lets go when a line "release" comes on stdin (or stdin closes), prints "released" and exits.
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { dataLayout, pathLit } from "../src/duckdb/layout.ts";

const dir = process.argv[2];
if (!dir) {
	console.error("usage: bun test/hold-duckdb.ts <data dir> [--only-live]");
	process.exit(2);
}
const layout = dataLayout(dir);
mkdirSync(layout.root, { recursive: true });
const instance = await DuckDBInstance.create(":memory:");
const connection = await instance.connect();
if (!process.argv.includes("--only-live")) await connection.run(`ATTACH ${pathLit(layout.lock)} AS folder_lock`);
await connection.run(`ATTACH ${pathLit(layout.live)} AS live`);
console.log("held");

const release = () => {
	connection.closeSync();
	instance.closeSync();
	console.log("released");
	process.exit(0);
};
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
	if (line.trim() === "release") release();
});
lines.on("close", release);
