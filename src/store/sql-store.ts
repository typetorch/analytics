/** The part every SQL-backed store shares: render a logical query for its dialect, run the statements, shape. */
import type { Rendered } from "../queries/index.ts";
import { renderQuery, runQuery, type QueryName, type QueryOptions, type QueryResult } from "../queries/index.ts";
import type { QueryContext, Row, Rows, TableName } from "../queries/core.ts";
import type { Dialect } from "../sql/dialect.ts";
import type { Filters } from "../sql/filters.ts";

export interface Store {
	readonly backend: "duckdb" | "basin" | "remote";
	/** Runs a logical query (see QUERIES). */
	query<N extends QueryName>(name: N, filters?: Filters, options?: QueryOptions<N>): Promise<QueryResult<N>>;
	close(): Promise<void>;
}

export abstract class SqlStore implements Store {
	abstract readonly backend: "duckdb" | "basin";
	abstract readonly dialect: Dialect;
	/** How many statements of one query run at once. */
	protected concurrency = 1;

	constructor(protected readonly clock: () => number = Date.now) {}

	/** A table expression for a time range. */
	protected abstract table(name: TableName, from: number, to: number): string;
	/** Runs one SQL statement and returns its rows. */
	abstract sql(statement: string): Promise<Row[]>;
	abstract close(): Promise<void>;

	protected context(): QueryContext {
		return { dialect: this.dialect, table: (name, from, to) => this.table(name, from, to), now: this.clock() };
	}

	async runStatements(statements: Record<string, string>): Promise<Rows> {
		const entries = Object.entries(statements);
		const out: Rows = {};
		let next = 0;
		const worker = async () => {
			while (next < entries.length) {
				const [name, sql] = entries[next++];
				out[name] = await this.sql(sql);
			}
		};
		await Promise.all(Array.from({ length: Math.min(this.concurrency, entries.length) }, worker));
		return out;
	}

	async query<N extends QueryName>(name: N, filters?: Filters, options?: QueryOptions<N>): Promise<QueryResult<N>> {
		return (await runQuery(this.context(), (s) => this.runStatements(s), name, filters, options)) as QueryResult<N>;
	}

	/** The SQL a query would run here. */
	render<N extends QueryName>(name: N, filters?: Filters, options?: QueryOptions<N>): Rendered {
		return renderQuery(this.context(), name, filters, options);
	}
}
