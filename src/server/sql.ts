/**
 * Read-only ad-hoc SQL for the admin (`POST /v1/sql`): one SELECT/WITH statement over two views, `events` and
 * `recordings` (every day file plus a snapshot of today's live rows), with a row cap and a timeout.
 *
 * Layers, each enough on its own for the common mistakes, together for the uncommon ones:
 *   1. Text: one statement that starts with SELECT or WITH; no ATTACH/COPY/PRAGMA/INSTALL/LOAD/SET/... words outside
 *      strings, quoted names and comments.
 *   2. DuckDB's parser (json_serialize_sql): a single SELECT; tables are only `events`, `recordings` or the query's
 *      own CTEs (no file paths, no schemas); table functions only range/generate_series/unnest/json_each/json_tree.
 *   3. The prepared statement's type is SELECT.
 *   4. A separate DuckDB instance: a READ_ONLY database file, `enable_external_access = false` with only the data
 *      folders allowed, no extension install/load, `lock_configuration = true`, its own small memory limit, 1 thread.
 * `fleet` rows show no props (a heartbeat's props can hold a private server's access code).
 */
import { DuckDBInstance, StatementType, type DuckDBConnection } from "@duckdb/node-api";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dayFiles, fieldsOf, pathLit, SERVER_COLUMNS, type DataLayout } from "../duckdb/layout.ts";
import { duckdbType } from "../schema.ts";
import { lit } from "../sql/dialect.ts";

export class SqlInputError extends Error {
	override name = "SqlInputError";
}

/** Statement words that never belong in a read-only query (checked outside strings, quoted names and comments). */
const DENIED_WORDS = [
	"ALTER",
	"ATTACH",
	"CALL",
	"CHECKPOINT",
	"COPY",
	"CREATE",
	"DELETE",
	"DETACH",
	"DROP",
	"EXPORT",
	"FORCE",
	"GRANT",
	"IMPORT",
	"INSERT",
	"INSTALL",
	"LOAD",
	"MERGE",
	"PRAGMA",
	"RESET",
	"SET",
	"TRUNCATE",
	"UPDATE",
	"USE",
	"VACUUM",
];

/** Table functions a query may call (everything else, e.g. read_parquet, read_text, glob, query, is refused). */
export const ALLOWED_TABLE_FUNCTIONS = new Set(["range", "generate_series", "unnest", "json_each", "json_tree"]);
export const SQL_TABLES = ["events", "recordings"] as const;
export const SQL_MAX_ROWS = 10_000;

/**
 * The query text with strings, quoted names and comments blanked out (same length, so positions match), or an error
 * for an unterminated one.
 */
export function blankLiterals(sql: string): string {
	let out = "";
	let i = 0;
	while (i < sql.length) {
		const c = sql[i];
		const next = sql[i + 1];
		if (c === "-" && next === "-") {
			const end = sql.indexOf("\n", i);
			const stop = end < 0 ? sql.length : end;
			out += " ".repeat(stop - i);
			i = stop;
		} else if (c === "/" && next === "*") {
			const end = sql.indexOf("*/", i + 2);
			if (end < 0) throw new SqlInputError("unterminated /* comment");
			out += " ".repeat(end + 2 - i);
			i = end + 2;
		} else if (c === "'" || c === '"') {
			let j = i + 1;
			for (;;) {
				const k = sql.indexOf(c, j);
				if (k < 0) throw new SqlInputError(`unterminated ${c === "'" ? "string" : "quoted name"}`);
				if (sql[k + 1] === c) {
					j = k + 2;
					continue;
				}
				j = k + 1;
				break;
			}
			out += c + " ".repeat(j - i - 2) + c;
			i = j;
		} else if (c === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
			const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0] as string;
			const end = sql.indexOf(tag, i + tag.length);
			if (end < 0) throw new SqlInputError("unterminated $$ string");
			out += " ".repeat(end + tag.length - i);
			i = end + tag.length;
		} else {
			out += c;
			i++;
		}
	}
	return out;
}

/** Layer 1: the text checks. Returns the statement without a trailing semicolon. */
export function checkSqlText(input: unknown): string {
	if (typeof input !== "string" || input.trim() === "") throw new SqlInputError("give the query as { sql }");
	if (input.length > 32 * 1024) throw new SqlInputError("the query is longer than 32 KB");
	if (/[\0]/.test(input)) throw new SqlInputError("the query contains a NUL character");
	const sql = input.trim().replace(/;\s*$/, "").trimEnd();
	const bare = blankLiterals(sql);
	if (bare.includes(";")) throw new SqlInputError("one statement only");
	const first = /^[\s(]*([A-Za-z]+)/.exec(bare)?.[1]?.toUpperCase();
	if (first !== "SELECT" && first !== "WITH") throw new SqlInputError("the query must start with SELECT or WITH");
	const words = new Set(bare.toUpperCase().match(/[A-Z_][A-Z0-9_]*/g) ?? []);
	const denied = DENIED_WORDS.filter((w) => words.has(w));
	if (denied.length) throw new SqlInputError(`read-only: ${denied.join(", ")} not allowed (quote a column named like that: "set")`);
	return sql;
}

interface AstRefs {
	tables: { catalog: string; schema: string; name: string }[];
	functions: string[];
	ctes: string[];
}

/** Every table and table function a serialized query refers to, and every CTE name it defines (any depth). */
export function astRefs(ast: unknown): AstRefs {
	const refs: AstRefs = { tables: [], functions: [], ctes: [] };
	const walk = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const n of node) walk(n);
			return;
		}
		if (!node || typeof node !== "object") return;
		const n = node as Record<string, unknown>;
		if (n.type === "BASE_TABLE") refs.tables.push({ catalog: String(n.catalog_name ?? ""), schema: String(n.schema_name ?? ""), name: String(n.table_name ?? "") });
		if (n.type === "TABLE_FUNCTION") {
			const fn = n.function as { function_name?: unknown } | undefined;
			refs.functions.push(String(fn?.function_name ?? "?"));
		}
		const cteMap = n.cte_map as { map?: { key?: unknown }[] } | undefined;
		for (const entry of cteMap?.map ?? []) refs.ctes.push(String(entry.key ?? ""));
		for (const value of Object.values(n)) walk(value);
	};
	walk(ast);
	return refs;
}

/** Layer 2 on a serialized query: only our views, the query's own CTEs and a few harmless table functions. */
export function checkAst(ast: unknown): AstRefs {
	const a = ast as { error?: boolean; error_message?: string; statements?: unknown[] };
	if (!a || a.error) throw new SqlInputError(`not a single SELECT: ${String(a?.error_message ?? "could not parse")}`);
	if (!Array.isArray(a.statements) || a.statements.length !== 1) throw new SqlInputError("one statement only");
	const refs = astRefs(ast);
	const ctes = new Set(refs.ctes.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).map((name) => name.toLowerCase()));
	for (const t of refs.tables) {
		const name = t.name.toLowerCase();
		if (t.catalog || t.schema || !(SQL_TABLES.includes(name as never) || ctes.has(name))) {
			throw new SqlInputError(`unknown table ${JSON.stringify([t.catalog, t.schema, t.name].filter(Boolean).join("."))}: query events, recordings or your own CTEs`);
		}
	}
	for (const f of refs.functions) {
		if (!ALLOWED_TABLE_FUNCTIONS.has(f.toLowerCase())) throw new SqlInputError(`table function ${f}() is not allowed (allowed: ${[...ALLOWED_TABLE_FUNCTIONS].join(", ")})`);
	}
	return refs;
}

export interface SqlColumn {
	name: string;
	type: string;
}

export interface SqlResult {
	columns: SqlColumn[];
	rows: unknown[][];
	/** More rows existed than the limit. */
	truncated: boolean;
}

/** A DuckDB JS value as JSON: BIGINT -> number (string when unsafe), dates -> ISO, blobs -> base64, nested values too. */
export function jsonValue(value: unknown): unknown {
	if (value === null || value === undefined) return null;
	if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "string" || typeof value === "boolean") return value;
	if (value instanceof Date) return value.toISOString();
	if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
	if (Array.isArray(value)) return value.map(jsonValue);
	const v = value as { toDouble?: () => number; toString(): string; constructor?: { name?: string } };
	if (typeof v.toDouble === "function") return v.toDouble();
	if (v.constructor === Object) return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, x]) => [k, jsonValue(x)]));
	return v.toString();
}

export interface SqlSandboxOptions {
	layout: DataLayout;
	memoryLimit: string;
	timeoutSeconds: number;
	/** Writes snapshots of today's live tables and returns their files (the Warehouse's snapshotLive). */
	snapshot(tables: ("events" | "recordings")[]): Promise<Partial<Record<"events" | "recordings", string>>>;
}

/** The sandboxed DuckDB instance that runs admin SQL, one query at a time. */
export class SqlSandbox {
	private chain: Promise<unknown> = Promise.resolve();

	private constructor(
		private readonly options: SqlSandboxOptions,
		private readonly instance: DuckDBInstance,
		private readonly connection: DuckDBConnection,
	) {}

	static async open(options: SqlSandboxOptions): Promise<SqlSandbox> {
		const { layout } = options;
		const dir = join(layout.root, "sql");
		const tmp = join(dir, "tmp");
		mkdirSync(tmp, { recursive: true });
		const file = join(dir, "sandbox.duckdb");
		if (!existsSync(file)) (await DuckDBInstance.create(file)).closeSync(); // an empty database, opened read-only below
		const instance = await DuckDBInstance.create(file, {
			access_mode: "READ_ONLY",
			autoinstall_known_extensions: "false",
			autoload_known_extensions: "false",
			memory_limit: options.memoryLimit,
			threads: "1",
			temp_directory: tmp.replace(/\\/g, "/"),
		});
		const connection = await instance.connect();
		const slash = (p: string) => `${p.replace(/\\/g, "/").replace(/\/$/, "")}/`;
		const allowed = [layout.events, layout.recordings, dir].map((p) => pathLit(slash(p))).join(", ");
		await connection.run(`SET allowed_directories = [${allowed}]`);
		await connection.run("SET enable_external_access = false");
		await connection.run("SET lock_configuration = true");
		return new SqlSandbox(options, instance, connection);
	}

	/** The view over every day file of a table plus the live snapshot (fleet rows without props). */
	private viewSql(table: "events" | "recordings", snapshot: string | undefined): string {
		const files = dayFiles(table === "events" ? this.options.layout.events : this.options.layout.recordings).map((f) => f.path);
		if (snapshot) files.push(snapshot);
		const fields = [...fieldsOf(table).map((f) => ({ name: f.name, type: duckdbType(f.type) })), ...SERVER_COLUMNS];
		const cols = fields.map((f) => (table === "events" && f.name === "props" ? `CASE WHEN "kind" = 'fleet' THEN NULL ELSE "props" END AS "props"` : `"${f.name}"`)).join(", ");
		const source = files.length
			? `SELECT ${cols} FROM read_parquet([${files.map(pathLit).join(", ")}])`
			: `SELECT ${fields.map((f) => `CAST(NULL AS ${f.type}) AS "${f.name}"`).join(", ")} WHERE FALSE`;
		return `CREATE OR REPLACE TEMP VIEW ${table} AS ${source}`;
	}

	/** Runs one checked SELECT; at most `limit` rows (1-10,000). */
	run(input: unknown, limit = 1000): Promise<SqlResult> {
		const job = this.chain.then(() => this.runNow(input, limit));
		this.chain = job.catch(() => {});
		return job;
	}

	private async runNow(input: unknown, limit: number): Promise<SqlResult> {
		const sql = checkSqlText(input);
		const cap = Math.min(SQL_MAX_ROWS, Math.max(1, Math.floor(Number(limit) || 1000)));
		const c = this.connection;
		const serialized = await c.runAndReadAll(`SELECT json_serialize_sql(${lit(sql)}) AS ast`);
		const refs = checkAst(JSON.parse(String(serialized.getRowObjectsJS()[0]?.ast ?? "{}")));
		const named = new Set(refs.tables.map((t) => t.name.toLowerCase()));
		const used = SQL_TABLES.filter((t) => named.has(t));
		const snapshots = used.length ? await this.options.snapshot([...used]) : {};
		for (const table of SQL_TABLES) await c.run(this.viewSql(table, snapshots[table]));
		const extracted = await c.extractStatements(sql);
		if (extracted.count !== 1) throw new SqlInputError("one statement only");
		const prepared = await extracted.prepare(0);
		const timer = setTimeout(() => c.interrupt(), this.options.timeoutSeconds * 1000);
		try {
			if (prepared.statementType !== StatementType.SELECT) throw new SqlInputError("read-only: SELECT statements only");
			const reader = await prepared.streamAndReadUntil(cap + 1);
			const names = reader.columnNames();
			const types = reader.columnTypes().map((t) => t.toString());
			const rows = reader.getRowsJS().slice(0, cap + 1);
			return {
				columns: names.map((name, i) => ({ name, type: types[i] ?? "" })),
				rows: rows.slice(0, cap).map((row) => row.map(jsonValue)),
				truncated: rows.length > cap,
			};
		} finally {
			clearTimeout(timer);
			// Ends the streaming result, so DuckDB lets go of its files (Windows can't replace a file that is open).
			prepared.destroySync();
		}
	}

	async close(): Promise<void> {
		await this.chain;
		this.connection.closeSync();
		this.instance.closeSync();
	}
}
