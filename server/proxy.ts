/**
 * The local proxy between the explorer and the analytics server, for `vite dev` and `vite preview`.
 *
 * The browser calls `/api/...`; this forwards to the analytics server and adds the admin token, read from an env file
 * (`--env-file` / TT_ANALYTICS_ENV_FILE, the same file the server uses) or the environment. The token never reaches
 * the browser. Because any page open in the same browser could also send requests to localhost, a guard runs first:
 * only the read endpoints the explorer uses, only from the explorer's own origin, JSON bodies only.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Plugin, ProxyOptions } from "vite";

export interface AnalyticsTarget {
	/** Base URL of the analytics server, e.g. http://127.0.0.1:8787 */
	url: string;
	token?: string;
	/** Where the settings came from (for the startup line; never the token itself). */
	source: string;
}

/** KEY=value lines (comments, quotes and `export` allowed), like the analytics server reads them. */
export function parseEnvFile(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
		if (!match) continue;
		let value = match[2];
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) value = value.slice(1, value.lastIndexOf(quote));
		else value = value.replace(/\s+#.*$/, "").trim();
		values[match[1]] = value;
	}
	return values;
}

/**
 * The analytics server to talk to: TT_ANALYTICS_URL, else http://TT_ANALYTICS_HOST:TT_ANALYTICS_PORT (the server's own
 * settings; 0.0.0.0 means this machine), else http://127.0.0.1:8787. Real environment variables win over the file.
 */
export function resolveTarget(env: Record<string, string | undefined>, readFile: (path: string) => string = (p) => readFileSync(p, "utf8")): AnalyticsTarget {
	const file = env.TT_ANALYTICS_ENV_FILE;
	const fromFile = file ? parseEnvFile(readFile(resolve(file))) : {};
	const pick = (key: string) => (env[key] !== undefined && env[key] !== "" ? env[key] : fromFile[key]);
	let url = pick("TT_ANALYTICS_URL");
	if (!url) {
		const host = pick("TT_ANALYTICS_HOST") ?? "127.0.0.1";
		const local = host === "0.0.0.0" || host === "::" || host === "" ? "127.0.0.1" : host;
		url = `http://${local.includes(":") ? `[${local}]` : local}:${pick("TT_ANALYTICS_PORT") ?? "8787"}`;
	}
	const token = pick("TT_ANALYTICS_ADMIN_TOKEN");
	return { url: url.replace(/\/+$/, ""), ...(token ? { token } : {}), source: file ? `env file ${resolve(file)}` : "environment" };
}

/** The analytics endpoints the explorer may reach through the proxy (paths without /api). Everything else is refused. */
export const ALLOWED_ROUTES: { method: "GET" | "POST"; path: RegExp }[] = [
	{ method: "GET", path: /^\/healthz$/ },
	{ method: "GET", path: /^\/v1\/queries$/ },
	{ method: "GET", path: /^\/v1\/storage$/ },
	{ method: "POST", path: /^\/v1\/query\/[A-Za-z-]{1,64}$/ },
	{ method: "POST", path: /^\/v1\/sql$/ },
	{ method: "GET", path: /^\/v1\/rollups\/(daily|players|player_days|edges)$/ },
	{ method: "GET", path: /^\/v1\/fleet\/(servers|reports|alerts|stream)$/ },
];

export interface GuardInput {
	method: string;
	/** The path after /api, with or without a query string. */
	url: string;
	headers: Record<string, string | string[] | undefined>;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

const header = (headers: GuardInput["headers"], name: string): string | undefined => {
	const v = headers[name];
	return Array.isArray(v) ? v[0] : v;
};

/** Decides whether a browser request may go through the proxy. */
export function guardRequest(req: GuardInput, hasToken: boolean): GuardResult {
	const path = req.url.split("?")[0] ?? "";
	const method = req.method.toUpperCase();
	if (!ALLOWED_ROUTES.some((r) => r.method === method && r.path.test(path)))
		return { ok: false, status: 403, error: `the explorer proxy does not forward ${method} ${path}` };
	// Only the explorer's own pages: browsers mark every request with Sec-Fetch-Site, and cross-origin ones with Origin.
	const site = header(req.headers, "sec-fetch-site");
	if (site && site !== "same-origin" && site !== "none") return { ok: false, status: 403, error: "cross-site requests are refused" };
	const origin = header(req.headers, "origin");
	const host = header(req.headers, "host");
	if (origin) {
		let originHost = "";
		try {
			originHost = new URL(origin).host;
		} catch {
			// "null" or garbage
		}
		if (!host || originHost !== host) return { ok: false, status: 403, error: "cross-origin requests are refused" };
	}
	// A JSON content type makes a cross-origin POST need a CORS preflight, which this server never grants.
	if (method === "POST" && !/^application\/json\b/i.test(header(req.headers, "content-type") ?? ""))
		return { ok: false, status: 415, error: "POST bodies must be application/json" };
	if (!hasToken)
		return { ok: false, status: 503, error: "no admin token: start the explorer with --env-file <the analytics server's env file> (or TT_ANALYTICS_ENV_FILE)" };
	return { ok: true };
}

/** The Vite `proxy` entry and the guard plugin for a target. */
export function analyticsProxy(target: AnalyticsTarget): { proxy: Record<string, ProxyOptions>; plugin: Plugin } {
	const guard = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
		const result = guardRequest({ method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers }, Boolean(target.token));
		if (result.ok) return next();
		res.statusCode = result.status;
		res.setHeader("content-type", "application/json");
		res.setHeader("cache-control", "no-store");
		res.end(JSON.stringify({ error: result.error }));
	};
	const proxy: Record<string, ProxyOptions> = {
		"/api": {
			target: target.url,
			changeOrigin: true,
			rewrite: (path) => path.replace(/^\/api/, ""),
			configure(server) {
				server.on("proxyReq", (proxyReq) => {
					proxyReq.removeHeader("cookie");
					proxyReq.removeHeader("origin");
					proxyReq.removeHeader("referer");
					if (target.token) proxyReq.setHeader("authorization", `Bearer ${target.token}`);
				});
			},
		},
	};
	const plugin: Plugin = {
		name: "typetorch-analytics-proxy-guard",
		configureServer(server) {
			server.middlewares.use("/api", guard);
		},
		configurePreviewServer(server) {
			server.middlewares.use("/api", guard);
		},
	};
	return { proxy, plugin };
}
