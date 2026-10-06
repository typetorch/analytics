/**
 * The analytics API, through the local proxy (`/api` -> the analytics server, admin token added by the proxy).
 * Every call answers parsed JSON or throws an ApiError carrying the server's own message.
 */
import type { BackfillResult, Filters, FleetAlert, FleetReports, FleetServers, Health, Identity, QueryInfo, QueryName, QueryResults, SqlResult, StorageReport } from "./types";

export class ApiError extends Error {
	override name = "ApiError";
	constructor(
		readonly status: number,
		message: string,
		readonly path: string,
	) {
		super(message);
	}

	/** The endpoint doesn't exist on this server (an older server version, or the part is off). */
	get notFound(): boolean {
		return this.status === 404;
	}
}

export interface ApiOptions {
	/** Base path or URL (default "/api"). */
	base?: string;
	fetch?: typeof fetch;
}

/** Drops empty values so the server sees only the filters that are set (and cache keys stay stable). */
export function cleanFilters(filters: Filters): Filters {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(filters)) {
		if (value === undefined || value === null || value === "") continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (key === "variant") {
			const v = value as Filters["variant"];
			if (!v?.experiment || !v.variant || (Array.isArray(v.variant) && !v.variant.length)) continue;
		}
		out[key] = value;
	}
	return out as Filters;
}

export function createApi(options: ApiOptions = {}) {
	const base = (options.base ?? "/api").replace(/\/+$/, "");
	const doFetch = options.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));

	async function request<T>(path: string, init?: RequestInit): Promise<T> {
		let response: Response;
		try {
			response = await doFetch(`${base}${path}`, {
				...init,
				headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
			});
		} catch (error) {
			throw new ApiError(0, `cannot reach the explorer's proxy: ${(error as Error).message}`, path);
		}
		const text = await response.text();
		let body: unknown = undefined;
		try {
			body = text ? JSON.parse(text) : undefined;
		} catch {
			// a proxy error page, not JSON
		}
		if (!response.ok) {
			const b = body as { error?: string; detail?: string } | undefined;
			const message = b?.error
				? b.detail
					? `${b.error}: ${b.detail}`
					: b.error
				: response.status === 502 || response.status === 504
					? "the analytics server is not answering"
					: `HTTP ${response.status}`;
			throw new ApiError(response.status, message, path);
		}
		if (body === undefined) throw new ApiError(response.status, "the answer is not JSON", path);
		return body as T;
	}

	const post = <T>(path: string, body: unknown, signal?: AbortSignal) =>
		request<T>(path, { method: "POST", body: JSON.stringify(body), ...(signal ? { signal } : {}) });
	const get = <T>(path: string, signal?: AbortSignal) => request<T>(path, signal ? { signal } : undefined);
	const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
		const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false);
		return entries.length ? `?${new URLSearchParams(entries.map(([k, v]) => [k, v === true ? "1" : String(v)])).toString()}` : "";
	};

	return {
		/** A named query: POST /v1/query/<name> { filters, options } -> result. */
		async query<N extends QueryName>(name: N, filters: Filters = {}, queryOptions: object = {}, signal?: AbortSignal): Promise<QueryResults[N]> {
			const answer = await post<{ result: QueryResults[N]; ms: number }>(
				`/v1/query/${encodeURIComponent(name)}`,
				{ filters: cleanFilters(filters), options: queryOptions },
				signal,
			);
			return answer.result;
		},
		/** The raw answer of any named query (the Query page). */
		raw(name: string, body: unknown, signal?: AbortSignal): Promise<{ result: unknown; ms: number }> {
			return post(`/v1/query/${encodeURIComponent(name)}`, body, signal);
		},
		queries: (signal?: AbortSignal) => get<{ queries: QueryInfo[] }>("/v1/queries", signal).then((r) => r.queries),
		sql: (sql: string, limit?: number, signal?: AbortSignal) => post<SqlResult>("/v1/sql", { sql, ...(limit ? { limit } : {}) }, signal),
		health: (signal?: AbortSignal) => get<Health>("/healthz", signal),
		/** What the server keeps on disk (measured at most every 30 s). */
		storage: (signal?: AbortSignal) => get<StorageReport>("/v1/storage", signal),
		/** pid <-> UserId: the identities of a pid or a UserId (most recently seen first). */
		identity: (who: { pid: string } | { uid: number | string }, signal?: AbortSignal) =>
			get<{ identities: Identity[] }>(`/v1/identity${qs("pid" in who ? { pid: who.pid } : { uid: String(who.uid) })}`, signal).then((r) => r.identities),
		/** How many pids are mapped, and whether the server can backfill older ones from the DataStore. */
		identitySummary: (signal?: AbortSignal) => get<{ count: number; backfill: boolean }>("/v1/identity", signal),
		backfillIdentities: (pageToken?: string, signal?: AbortSignal) => post<BackfillResult>("/v1/identity/backfill", pageToken ? { pageToken } : {}, signal),
		fleetServers: (branch?: string, signal?: AbortSignal) => get<FleetServers>(`/v1/fleet/servers${qs({ branch })}`, signal),
		fleetAlerts: (params: { since?: number; level?: string; unacked?: boolean; limit?: number } = {}, signal?: AbortSignal) =>
			get<{ alerts: FleetAlert[] }>(`/v1/fleet/alerts${qs(params)}`, signal).then((r) => r.alerts),
		fleetReport: (params: { seq?: number; artifact?: string; branch?: string } = {}, signal?: AbortSignal) =>
			get<FleetReports>(
				`/v1/fleet/reports${params.seq || params.artifact ? qs(params) : `?latest${params.branch ? `&branch=${encodeURIComponent(params.branch)}` : ""}`}`,
				signal,
			),
		/** The SSE stream's URL (EventSource can't set headers; the proxy adds the token). */
		streamUrl: (params: { branch?: string; types?: string } = {}) => `${base}/v1/fleet/stream${qs(params)}`,
	};
}

export type Api = ReturnType<typeof createApi>;

export const api = createApi();
