/**
 * The HTTP server and the few other places where Bun and Node differ, behind one small API, so the server runs the
 * same under `bun src/server/main.ts` and `node dist/server/main.js`. Pattern from @typetorch/dev-server's runtime.ts:
 * Bun.serve under Bun, node:http under Node, handlers are Web `Request -> Response` either way. Differences from the
 * dev-server: bodies are read whole (they are small and capped), streamed responses (Server-Sent Events) are piped,
 * and the handler gets the client's IP.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export const isBun = typeof process.versions.bun === "string";

export function runtimeName(): string {
	return isBun ? `bun ${process.versions.bun}` : `node ${process.version}`;
}

export interface RequestContext {
	/** The TCP peer's address (the proxy's, behind Caddy; see the server's trustProxy). */
	ip: string;
	/** Seconds without traffic before this request's connection closes; 0 = never (long-lived streams). */
	timeout(seconds: number): void;
}

export interface ServeOptions {
	hostname: string;
	/** 0 = a random free port. */
	port: number;
	/** Bodies over this many bytes get 413 before the handler runs. */
	maxRequestBodySize: number;
	/** Idle seconds before a connection closes (default 30). */
	idleTimeoutSeconds?: number;
	fetch(req: Request, ctx: RequestContext): Promise<Response> | Response;
	/** The answer when `fetch` throws. */
	error(error: Error): Response;
	backend?: "bun" | "node";
}

export interface Served {
	readonly port: number;
	readonly backend: "bun" | "node";
	stop(): Promise<void>;
}

interface BunServer {
	port: number;
	timeout(req: Request, seconds: number): void;
	requestIP(req: Request): { address: string } | null;
	stop(closeActiveConnections?: boolean): Promise<void> | void;
}

interface BunApi {
	serve(options: {
		hostname: string;
		port: number;
		development: boolean;
		maxRequestBodySize: number;
		idleTimeout: number;
		fetch(req: Request, server: BunServer): Promise<Response> | Response;
		error(error: Error): Response;
	}): BunServer;
}

export async function serve(options: ServeOptions): Promise<Served> {
	const bun = (globalThis as unknown as { Bun?: BunApi }).Bun;
	const forced = process.env.NODE_ENV === "test" ? process.env.TT_TEST_HTTP_BACKEND : undefined;
	const backend = options.backend ?? (forced === "node" || forced === "bun" ? forced : bun ? "bun" : "node");
	if (backend === "bun") {
		if (!bun) throw new Error("Bun.serve needs Bun");
		const server = bun.serve({
			hostname: options.hostname,
			port: options.port,
			development: false,
			maxRequestBodySize: options.maxRequestBodySize,
			idleTimeout: Math.min(255, options.idleTimeoutSeconds ?? 30),
			fetch: (req, srv) => options.fetch(req, { ip: srv.requestIP(req)?.address ?? "", timeout: (s) => srv.timeout(req, s) }),
			error: options.error,
		});
		return {
			port: server.port,
			backend,
			async stop() {
				await server.stop(true);
			},
		};
	}
	return serveNode(options);
}

async function serveNode(options: ServeOptions): Promise<Served> {
	const idleMs = (options.idleTimeoutSeconds ?? 30) * 1000;
	const max = options.maxRequestBodySize;
	let port = 0;
	const server = createServer({ headersTimeout: 20_000, requestTimeout: 120_000, keepAliveTimeout: idleMs });
	server.on("connection", (socket: Socket) => {
		socket.setTimeout(idleMs);
		socket.on("timeout", () => socket.destroy());
	});
	server.on("request", (req: IncomingMessage, res: ServerResponse) => void handle(req, res));

	async function readBody(req: IncomingMessage): Promise<Buffer | "too-large"> {
		const chunks: Buffer[] = [];
		let size = 0;
		for await (const chunk of req as AsyncIterable<Buffer>) {
			size += chunk.length;
			if (size > max) return "too-large";
			chunks.push(chunk);
		}
		return Buffer.concat(chunks);
	}

	async function send(req: IncomingMessage, res: ServerResponse, response: Response): Promise<void> {
		if (res.headersSent || res.destroyed) return;
		const headers: Record<string, string> = {};
		response.headers.forEach((value, name) => (headers[name] = value));
		const streaming = (response.headers.get("content-type") ?? "").startsWith("text/event-stream");
		if (streaming && response.body) {
			res.writeHead(response.status, headers);
			res.flushHeaders();
			const reader = response.body.getReader();
			res.on("close", () => void reader.cancel().catch(() => {}));
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					res.write(value);
				}
			} catch {}
			res.end();
			return;
		}
		const body = response.body ? Buffer.from(await response.arrayBuffer()) : Buffer.alloc(0);
		const noBody = response.status === 204 || response.status === 304 || req.method === "HEAD";
		if (!noBody) headers["content-length"] = String(body.length);
		res.writeHead(response.status, headers);
		res.end(noBody ? undefined : body);
	}

	async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const socket = req.socket;
		const declared = req.headers["content-length"];
		if (declared !== undefined && (!/^\d{1,15}$/.test(declared) || Number(declared) > max)) {
			res.shouldKeepAlive = false;
			req.resume();
			await send(req, res, new Response(JSON.stringify({ error: "body too large" }), { status: 413, headers: { "content-type": "application/json" } }));
			return;
		}
		const hasBody = req.method !== "GET" && req.method !== "HEAD";
		const body = hasBody ? await readBody(req).catch(() => Buffer.alloc(0)) : undefined;
		if (body === "too-large") {
			res.shouldKeepAlive = false;
			await send(req, res, new Response(JSON.stringify({ error: "body too large" }), { status: 413, headers: { "content-type": "application/json" } }));
			socket.destroy();
			return;
		}
		const abort = new AbortController();
		res.on("close", () => {
			if (!res.writableFinished) abort.abort();
		});
		const headers = new Headers();
		for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
		let request: Request;
		try {
			request = new Request(`http://${options.hostname}:${port}${req.url ?? "/"}`, {
				method: req.method,
				headers,
				body: body && body.length ? body : undefined,
				signal: abort.signal,
			});
		} catch {
			await send(req, res, new Response("bad request", { status: 400 }));
			return;
		}
		let response: Response;
		try {
			response = await options.fetch(request, {
				ip: socket.remoteAddress ?? "",
				timeout: (seconds) => socket.setTimeout(Math.max(0, seconds) * 1000),
			});
		} catch (error) {
			response = options.error(error instanceof Error ? error : new Error(String(error)));
		}
		await send(req, res, response).catch(() => socket.destroy());
	}

	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(options.port, options.hostname, () => {
			server.off("error", fail);
			done();
		});
	});
	port = (server.address() as AddressInfo).port;
	return {
		port,
		backend: "node",
		stop() {
			return new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			});
		},
	};
}

export function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}
