/**
 * Fleet API routes on Web Request/Response only (portable to a Cloudflare Worker). The host passes the auth checks
 * and the rate limiters.
 *
 *   POST /v1/fleet/heartbeat | report | alert | closing | deploy     ingest (write-only) token
 *   GET  /v1/fleet/servers?branch=&maxAge=                          admin token
 *   GET  /v1/fleet/reports?seq=|artifact=|latest&branch=
 *   GET  /v1/fleet/alerts?since=&level=&unacked=&limit=
 *   POST /v1/fleet/alerts/<id>/ack   { by? }
 *   GET  /v1/fleet/stream?branch=&types=server,alert,...            Server-Sent Events
 */
import { FleetInputError, type FleetEvent, type FleetService } from "./service.ts";

export const FLEET_BODY_LIMIT = 16 * 1024;

/** Per-JobId limits per minute (heartbeats come every 30 s plus on change). */
export const FLEET_LIMITS = { heartbeat: 20, report: 30, alert: 30, closing: 10, deploy: 30 } as const;

export interface Limiter {
	take(key: string): boolean;
	retryAfter(key: string): number;
}

export interface FleetHttpOptions {
	service: FleetService;
	isIngest(req: Request): boolean;
	isAdmin(req: Request): boolean;
	limiters: Record<keyof typeof FLEET_LIMITS, Limiter>;
	/** Turns off a long-lived connection's idle timeout (SSE). */
	keepOpen?(req: Request): void;
	/** Seconds between SSE keep-alive comments (default 15). */
	pingSeconds?: number;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function timeParam(value: string | null): number | undefined {
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value);
	const ms = Date.parse(value);
	if (!Number.isFinite(ms)) throw new FleetInputError("since must be unix ms or an ISO time");
	return ms;
}

function intParam(value: string | null, name: string): number | undefined {
	if (value === null || value === "") return undefined;
	const n = Number(value);
	if (!Number.isSafeInteger(n)) throw new FleetInputError(`${name} must be an integer`);
	return n;
}

async function readJson(req: Request): Promise<unknown> {
	const declared = Number(req.headers.get("content-length") ?? "0");
	if (declared > FLEET_BODY_LIMIT) throw new BodyTooLarge();
	const text = await req.text();
	if (text.length > FLEET_BODY_LIMIT) throw new BodyTooLarge();
	try {
		return JSON.parse(text);
	} catch {
		throw new FleetInputError("body must be JSON");
	}
}

class BodyTooLarge extends Error {}

/** Answers a fleet request, or returns undefined when the path isn't a fleet route. */
export async function handleFleet(req: Request, url: URL, o: FleetHttpOptions, ip = ""): Promise<Response | undefined> {
	if (!url.pathname.startsWith("/v1/fleet/")) return undefined;
	const route = url.pathname.slice("/v1/fleet/".length);
	try {
		if (req.method === "POST" && route in FLEET_LIMITS) {
			if (!o.isIngest(req)) return json(401, { error: "ingest token required" });
			const kind = route as keyof typeof FLEET_LIMITS;
			const body = await readJson(req);
			const job = typeof (body as { j?: unknown })?.j === "string" ? (body as { j: string }).j : (req.headers.get("x-tt-job") ?? "");
			const key = job || `ip:${ip}`;
			if (!o.limiters[kind].take(key)) return json(429, { error: "rate limited" }, { "retry-after": String(o.limiters[kind].retryAfter(key)) });
			if (kind === "heartbeat") await o.service.heartbeat(body, req.headers.get("x-tt-job"));
			else if (kind === "report") await o.service.report(body);
			else if (kind === "closing") await o.service.closing(body);
			else if (kind === "deploy") await o.service.deploy(body);
			else {
				const alert = await o.service.alert(body);
				return json(202, { ok: true, id: alert.id });
			}
			return json(202, { ok: true });
		}
		if (!o.isAdmin(req)) return json(401, { error: "admin token required" });
		const ack = /^alerts\/(\d+)\/ack$/.exec(route);
		if (req.method === "POST" && ack) {
			const body = (await readJson(req).catch(() => ({}))) as { by?: unknown };
			const ok = await o.service.ack(Number(ack[1]), typeof body?.by === "string" ? body.by : undefined);
			return json(ok ? 200 : 404, ok ? { ok: true } : { error: "no such unacknowledged alert" });
		}
		if (req.method !== "GET") return json(405, { error: "method not allowed" });
		const q = url.searchParams;
		if (route === "servers") {
			const maxAge = intParam(q.get("maxAge"), "maxAge");
			return json(200, await o.service.servers({ ...(q.get("branch") ? { branch: q.get("branch") as string } : {}), ...(maxAge !== undefined ? { maxAgeSeconds: maxAge } : {}) }));
		}
		if (route === "reports") {
			const seq = intParam(q.get("seq"), "seq");
			return json(
				200,
				await o.service.reports({
					...(seq !== undefined ? { seq } : {}),
					...(q.get("artifact") ? { artifact: q.get("artifact") as string } : {}),
					...(q.get("branch") ? { branch: q.get("branch") as string } : {}),
				}),
			);
		}
		if (route === "alerts") {
			const level = q.get("level");
			if (level && level !== "critical" && level !== "warning") throw new FleetInputError("level must be critical or warning");
			const since = timeParam(q.get("since"));
			const limit = intParam(q.get("limit"), "limit");
			return json(200, {
				alerts: await o.service.alerts({
					...(since !== undefined ? { since } : {}),
					...(level ? { level: level as "critical" | "warning" } : {}),
					unacked: q.get("unacked") === "1" || q.get("unacked") === "true",
					...(limit !== undefined ? { limit } : {}),
				}),
			});
		}
		if (route === "stream") return stream(req, url, o);
		return json(404, { error: "not found" });
	} catch (error) {
		if (error instanceof BodyTooLarge) return json(413, { error: "body too large" });
		if (error instanceof FleetInputError) return json(400, { error: error.message });
		throw error;
	}
}

function stream(req: Request, url: URL, o: FleetHttpOptions): Response {
	const branch = url.searchParams.get("branch");
	const types = new Set((url.searchParams.get("types") ?? "").split(",").filter(Boolean));
	const encoder = new TextEncoder();
	let unsubscribe = () => {};
	let ping: ReturnType<typeof setInterval> | undefined;
	o.keepOpen?.(req);
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					unsubscribe();
				}
			};
			send("hello", { at: new Date().toISOString() });
			unsubscribe = o.service.subscribe((event: FleetEvent) => {
				if (types.size && !types.has(event.type)) return;
				if (branch) {
					const b = event.type === "server" ? event.server.branch : event.type === "alert" ? event.alert.branch : event.type === "alert_ack" ? branch : event.branch;
					if (b !== branch) return;
				}
				send(event.type, event);
			});
			ping = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": ping\n\n"));
				} catch {
					unsubscribe();
				}
			}, (o.pingSeconds ?? 15) * 1000);
			req.signal.addEventListener("abort", () => {
				unsubscribe();
				if (ping) clearInterval(ping);
				try {
					controller.close();
				} catch {}
			});
		},
		cancel() {
			unsubscribe();
			if (ping) clearInterval(ping);
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" } });
}
