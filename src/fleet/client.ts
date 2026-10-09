/**
 * `createFleetClient({ url, token })`: the CLI's way to the fleet API (`typetorch servers [--watch]`, `report`,
 * `deploy --wait`, `alerts [--follow]`). Reads use the admin token; `deployStarted` and `alert` (e.g. auto_rollback)
 * post with the ingest token like a game server would.
 */
import type { ServerInfo } from "../queries/fleet.ts";
import { baseUrl } from "../store/remote.ts";
import type { Alert, AlertLevel, DeployMark, FleetEvent, FleetReport } from "./service.ts";

export interface FleetClientConfig {
	url: string;
	/** Admin (read) token. */
	token?: string;
	/** Ingest (write-only) token, for deployStarted and alert. */
	ingestToken?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}

export interface FleetServers {
	servers: ServerInfo[];
	players: number;
	byArtifact: { artifact: string; servers: number; players: number }[];
	byHealth: Record<string, number>;
}

export class FleetApiError extends Error {
	override name = "FleetApiError";
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface FleetStream {
	/** Stops the stream. */
	close(): void;
	/** Resolves when the stream ends (closed, or the server went away). */
	done: Promise<void>;
}

export interface FleetClient {
	servers(options?: { branch?: string; maxAgeSeconds?: number }): Promise<FleetServers>;
	reports(options?: { seq?: number; artifact?: string; latest?: boolean; branch?: string }): Promise<FleetReport>;
	alerts(options?: { since?: number | string; level?: AlertLevel; unacked?: boolean; limit?: number }): Promise<Alert[]>;
	ack(id: number, by?: string): Promise<boolean>;
	/** Live changes and new alerts (Server-Sent Events). */
	stream(onEvent: (event: FleetEvent | { type: "hello"; at: string }) => void, options?: { branch?: string; types?: FleetEvent["type"][] }): FleetStream;
	/**
	 * Tells the API a release started (`{s, b, a, ch, t, k?, fr?, m?}`), so stuck servers are found even before any report
	 * and the explorer's charts get a mark (`k`: deploy, rollback, promote, resign; `fr`: the build before).
	 */
	deployStarted(deploy: { s: number; b: string; a?: string; ch?: string; t?: number; k?: string; fr?: string; m?: string }): Promise<void>;
	/** A kernel publish (`k: "kernel"`, `v`, `pv`) or backup refresh (`k: "backup"`, `b`, `s`, `a`, `pv`): a chart mark. */
	mark(mark: { k: "kernel" | "backup"; b?: string; s?: number; a?: string; ch?: string; v?: string; pv?: number; m?: string; t?: number }): Promise<void>;
	/** Chart marks (releases, kernel publishes, backup refreshes) in a window, oldest first. */
	marks(options?: { since?: number | string; until?: number | string; branch?: string; kinds?: string[]; limit?: number }): Promise<DeployMark[]>;
	/** Posts an alert, e.g. `auto_rollback` after `deploy --wait` rolled a branch back. */
	alert(alert: { level: AlertLevel; code: string; message: string; j?: string; b?: string; a?: string; s?: number; t?: number; g?: number; k?: string }): Promise<number>;
}

export function createFleetClient(config: FleetClientConfig): FleetClient {
	const base = baseUrl(config.url);
	const doFetch = config.fetch ?? fetch;
	const call = async (method: string, path: string, token: string | undefined, body?: unknown): Promise<unknown> => {
		if (!token) throw new Error(`the fleet API ${method === "GET" ? "admin" : "ingest"} token is required for ${path}`);
		const response = await doFetch(`${base}${path}`, {
			method,
			headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(config.timeoutMs ?? 30_000),
		});
		const text = await response.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : undefined;
		} catch {
			parsed = undefined;
		}
		if (!response.ok) {
			const error = typeof parsed === "object" && parsed !== null && "error" in parsed ? String((parsed as { error: unknown }).error) : text.slice(0, 200);
			throw new FleetApiError(`fleet API ${response.status}: ${error}`, response.status);
		}
		return parsed;
	};
	const qs = (params: Record<string, string | number | boolean | undefined>) => {
		const s = new URLSearchParams();
		for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== false) s.set(k, String(v));
		const text = s.toString();
		return text ? `?${text}` : "";
	};
	return {
		async servers(options = {}) {
			return (await call("GET", `/v1/fleet/servers${qs({ branch: options.branch, maxAge: options.maxAgeSeconds })}`, config.token)) as FleetServers;
		},
		async reports(options = {}) {
			return (await call("GET", `/v1/fleet/reports${qs({ seq: options.seq, artifact: options.artifact, branch: options.branch, latest: options.latest })}`, config.token)) as FleetReport;
		},
		async alerts(options = {}) {
			const since = typeof options.since === "string" ? Date.parse(options.since) : options.since;
			const body = (await call("GET", `/v1/fleet/alerts${qs({ since, level: options.level, unacked: options.unacked ? 1 : undefined, limit: options.limit })}`, config.token)) as { alerts: Alert[] };
			return body.alerts;
		},
		async ack(id, by) {
			try {
				await call("POST", `/v1/fleet/alerts/${id}/ack`, config.token, by ? { by } : {});
				return true;
			} catch (error) {
				if (error instanceof FleetApiError && error.status === 404) return false;
				throw error;
			}
		},
		stream(onEvent, options = {}) {
			if (!config.token) throw new Error("the fleet API admin token is required for the stream");
			const controller = new AbortController();
			const path = `/v1/fleet/stream${qs({ branch: options.branch, types: options.types?.join(",") })}`;
			const done = (async () => {
				const response = await doFetch(`${base}${path}`, { headers: { authorization: `Bearer ${config.token}`, accept: "text/event-stream" }, signal: controller.signal });
				if (!response.ok || !response.body) throw new FleetApiError(`fleet stream ${response.status}`, response.status);
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				while (true) {
					const { done: end, value } = await reader.read();
					if (end) break;
					buffer += decoder.decode(value, { stream: true });
					let at: number;
					while ((at = buffer.indexOf("\n\n")) >= 0) {
						const block = buffer.slice(0, at);
						buffer = buffer.slice(at + 2);
						const data = block
							.split("\n")
							.filter((l) => l.startsWith("data: "))
							.map((l) => l.slice(6))
							.join("\n");
						const event = /^event: (.+)$/m.exec(block)?.[1];
						if (!data || !event) continue;
						try {
							const parsed = JSON.parse(data);
							onEvent(event === "hello" ? { type: "hello", at: parsed.at } : parsed);
						} catch {}
					}
				}
			})().catch((error) => {
				if ((error as Error).name !== "AbortError") throw error;
			});
			return { close: () => controller.abort(), done };
		},
		async deployStarted(deploy) {
			await call("POST", "/v1/fleet/deploy", config.ingestToken, { t: Date.now(), ...deploy });
		},
		async mark(mark) {
			await call("POST", "/v1/fleet/mark", config.ingestToken, { j: "cli", t: Date.now(), ...mark });
		},
		async marks(options = {}) {
			const time = (v: number | string | undefined) => (typeof v === "string" ? Date.parse(v) : v);
			const body = (await call(
				"GET",
				`/v1/fleet/marks${qs({ since: time(options.since), until: time(options.until), branch: options.branch, kinds: options.kinds?.join(","), limit: options.limit })}`,
				config.token,
			)) as { marks: DeployMark[] };
			return body.marks;
		},
		async alert(alert) {
			const body = (await call("POST", "/v1/fleet/alert", config.ingestToken, { t: Date.now(), ...alert })) as { id: number };
			return body.id;
		},
	};
}
