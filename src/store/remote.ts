/**
 * Remote store: the logical queries answered by a TypeTorch analytics server (`POST /v1/query/<name>` with the admin
 * token). What the CLI uses when a game's backend is "duckdb".
 */
import { Graph, type GraphData } from "../graph.ts";
import type { QueryName, QueryOptions, QueryResult } from "../queries/index.ts";
import type { Filters } from "../sql/filters.ts";
import type { Store } from "./sql-store.ts";

export interface RemoteStoreConfig {
	/** The server's base URL, e.g. https://analytics.example.com */
	url: string;
	/** The admin (read) token. Never logged. */
	token: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export class RemoteQueryError extends Error {
	override name = "RemoteQueryError";
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const GRAPH_QUERIES = new Set<string>(["player-graph", "flow"]);

export function baseUrl(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) {
		throw new Error("the analytics server URL must be https (http only for localhost)");
	}
	return parsed.toString().replace(/\/+$/, "");
}

export class RemoteStore implements Store {
	readonly backend = "remote" as const;
	private readonly base: string;

	constructor(private readonly config: RemoteStoreConfig) {
		this.base = baseUrl(config.url);
		if (!config.token) throw new Error("the analytics server's admin token is required");
	}

	async query<N extends QueryName>(name: N, filters?: Filters, options?: QueryOptions<N>): Promise<QueryResult<N>> {
		const doFetch = this.config.fetch ?? fetch;
		const response = await doFetch(`${this.base}/v1/query/${encodeURIComponent(name)}`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.config.token}`, "content-type": "application/json" },
			body: JSON.stringify({ filters: filters ?? {}, options: options ?? {} }),
			signal: AbortSignal.timeout(this.config.timeoutMs ?? 120_000),
		});
		const text = await response.text();
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			throw new RemoteQueryError(`analytics server ${response.status}: ${text.slice(0, 300)}`, response.status);
		}
		if (!response.ok) {
			const error = typeof body === "object" && body !== null && "error" in body ? String((body as { error: unknown }).error) : text.slice(0, 300);
			throw new RemoteQueryError(`analytics server ${response.status}: ${error}`, response.status);
		}
		const result = (body as { result: unknown }).result;
		return (GRAPH_QUERIES.has(name) ? Graph.fromJSON(result as GraphData) : result) as QueryResult<N>;
	}

	async close(): Promise<void> {}
}
