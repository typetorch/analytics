/**
 * Server settings from the environment and an optional env file (`--env-file <path>` or TT_ANALYTICS_ENV_FILE; real
 * environment variables win). Values stay in this object and are never printed; only names are.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ServerPart = "analytics" | "fleet";

export interface ServerConfig {
	dataDir: string;
	host: string;
	port: number;
	/** Which parts run: the DuckDB analytics API, the SQLite fleet API, or both (default). */
	parts: Set<ServerPart>;
	/** Write-only tokens accepted by ingest endpoints (several, for rotation). */
	ingestTokens: string[];
	/** The read token (queries, settings, fleet reads, erasure by pid). */
	adminToken?: string;
	/** Use X-Forwarded-For's last hop as the client IP (behind Caddy on the same box). */
	trustProxy: boolean;
	/** Gzip body cap and inflated cap, bytes. */
	maxBodyBytes: number;
	maxInflateBytes: number;
	ipPerMinute: number;
	jobPerMinute: number;
	// DuckDB
	memoryLimit: string;
	threads: number;
	loadSeconds: number;
	/** Days of day files to keep (0 = forever). */
	keepDays: number;
	rawKeepDays: number;
	/** Compact live.duckdb after the nightly export when it is bigger than this. */
	compactMb: number;
	queryTimeoutSeconds: number;
	queryConcurrency: number;
	fsyncMs: number;
	// Right to Erasure
	webhookSecret?: string;
	openCloudKey?: string;
	universeId?: number;
	erasureDeleteLink: boolean;
	// Fleet
	fleetDb: string;
	fleetWebhookUrl?: string;
	fleetWebhookFormat?: "discord" | "slack" | "json";
	fleetWebhookLevels: Set<"critical" | "warning">;
}

export function parseDotEnv(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
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

function num(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
	return n;
}

function flag(env: Record<string, string | undefined>, name: string, fallback = false): boolean {
	const raw = env[name];
	if (raw === undefined || raw === "") return fallback;
	return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

function token(env: Record<string, string | undefined>, name: string): string | undefined {
	const raw = env[name];
	if (!raw) return undefined;
	if (raw.length < 24) throw new Error(`${name} must be at least 24 characters (use a random value, e.g. openssl rand -hex 32)`);
	return raw;
}

/** Reads the config. `env` defaults to the env file (if any) under the real environment. */
export function loadConfig(argv: string[] = process.argv.slice(2), realEnv: Record<string, string | undefined> = process.env): ServerConfig {
	let envFile = realEnv.TT_ANALYTICS_ENV_FILE;
	const at = argv.indexOf("--env-file");
	if (at >= 0) envFile = argv[at + 1];
	const fileEnv = envFile ? parseDotEnv(readFileSync(resolve(envFile), "utf8")) : {};
	const env: Record<string, string | undefined> = { ...fileEnv, ...Object.fromEntries(Object.entries(realEnv).filter(([, v]) => v !== undefined && v !== "")) };
	const dataDir = resolve(env.TT_ANALYTICS_DATA ?? "data");
	const parts = new Set<ServerPart>(
		(env.TT_SERVER_PARTS ?? "analytics,fleet")
			.split(",")
			.map((p) => p.trim())
			.filter(Boolean) as ServerPart[],
	);
	for (const p of parts) if (p !== "analytics" && p !== "fleet") throw new Error('TT_SERVER_PARTS lists "analytics" and/or "fleet"');
	if (parts.size === 0) throw new Error("TT_SERVER_PARTS is empty");
	const ingestTokens = (env.TT_ANALYTICS_INGEST_TOKENS ?? "")
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
	for (const t of ingestTokens) if (t.length < 24) throw new Error("each TT_ANALYTICS_INGEST_TOKENS entry must be at least 24 characters");
	const universe = env.TT_ANALYTICS_UNIVERSE_ID;
	const format = env.TT_FLEET_WEBHOOK_FORMAT;
	if (format && !["discord", "slack", "json"].includes(format)) throw new Error("TT_FLEET_WEBHOOK_FORMAT is discord, slack or json");
	const levels = new Set(
		(env.TT_FLEET_WEBHOOK_LEVELS ?? "critical")
			.split(",")
			.map((l) => l.trim())
			.filter(Boolean),
	) as Set<"critical" | "warning">;
	const config: ServerConfig = {
		dataDir,
		host: env.TT_ANALYTICS_HOST ?? "127.0.0.1",
		port: num(env, "TT_ANALYTICS_PORT", 8787, 0, 65535),
		parts,
		ingestTokens,
		trustProxy: flag(env, "TT_ANALYTICS_TRUST_PROXY"),
		maxBodyBytes: num(env, "TT_ANALYTICS_MAX_BODY", 2 * 1024 * 1024, 1024, 64 * 1024 * 1024),
		maxInflateBytes: num(env, "TT_ANALYTICS_MAX_INFLATE", 16 * 1024 * 1024, 1024, 256 * 1024 * 1024),
		ipPerMinute: num(env, "TT_ANALYTICS_IP_PER_MINUTE", 6000, 1, 1_000_000),
		jobPerMinute: num(env, "TT_ANALYTICS_JOB_PER_MINUTE", 60, 1, 100_000),
		memoryLimit: env.TT_ANALYTICS_MEMORY_LIMIT ?? "400MB",
		threads: num(env, "TT_ANALYTICS_THREADS", 2, 1, 64),
		loadSeconds: num(env, "TT_ANALYTICS_LOAD_SECONDS", 5, 0.2, 3600),
		keepDays: num(env, "TT_ANALYTICS_KEEP_DAYS", 400, 0, 100_000),
		rawKeepDays: num(env, "TT_ANALYTICS_RAW_KEEP_DAYS", 14, 0, 100_000),
		compactMb: num(env, "TT_ANALYTICS_COMPACT_MB", 256, 1, 1_000_000),
		queryTimeoutSeconds: num(env, "TT_ANALYTICS_QUERY_TIMEOUT", 60, 1, 3600),
		queryConcurrency: num(env, "TT_ANALYTICS_QUERY_CONCURRENCY", 2, 1, 16),
		fsyncMs: num(env, "TT_ANALYTICS_FSYNC_MS", 1000, 0, 60_000),
		erasureDeleteLink: flag(env, "TT_ANALYTICS_ERASURE_DELETE_LINK"),
		fleetDb: resolve(env.TT_FLEET_DB ?? resolve(dataDir, "fleet.sqlite")),
		fleetWebhookLevels: levels,
	};
	const admin = token(env, "TT_ANALYTICS_ADMIN_TOKEN");
	if (admin) config.adminToken = admin;
	if (env.TT_ANALYTICS_WEBHOOK_SECRET) config.webhookSecret = env.TT_ANALYTICS_WEBHOOK_SECRET;
	if (env.TT_ANALYTICS_OPENCLOUD_KEY) config.openCloudKey = env.TT_ANALYTICS_OPENCLOUD_KEY;
	if (universe) {
		const u = Number(universe);
		if (!Number.isSafeInteger(u) || u <= 0) throw new Error("TT_ANALYTICS_UNIVERSE_ID must be a positive integer");
		config.universeId = u;
	}
	if (env.TT_FLEET_WEBHOOK_URL) config.fleetWebhookUrl = env.TT_FLEET_WEBHOOK_URL;
	if (format) config.fleetWebhookFormat = format as "discord" | "slack" | "json";
	return config;
}

/** What's configured, by name only (for the startup line). */
export function describeConfig(config: ServerConfig): string {
	const yes = (v: unknown) => (v ? "set" : "not set");
	return [
		`parts=${[...config.parts].join("+")}`,
		`data=${config.dataDir}`,
		`ingest tokens=${config.ingestTokens.length}`,
		`admin token=${yes(config.adminToken)}`,
		`erasure webhook secret=${yes(config.webhookSecret)}`,
		`open cloud key=${yes(config.openCloudKey)}`,
		`fleet webhook=${yes(config.fleetWebhookUrl)}`,
		`duckdb memory_limit=${config.memoryLimit} threads=${config.threads}`,
	].join(", ");
}
