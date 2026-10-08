/**
 * Environment variable names from before the rename to one backend (TT_ANALYTICS_*, TT_FLEET_*, TT_SERVER_PARTS,
 * TYPETORCH_FLEET_*). They are still read for one release; each use gives a one-line warning that names the new variable.
 * Values are never part of a warning.
 */

/** Old name -> new name. Read for one release, with a warning. (TT_ANALYTICS_INGEST_TOKENS is a list: handled apart.) */
export const LEGACY_ENV: Readonly<Record<string, string>> = {
	TT_ANALYTICS_ADMIN_TOKEN: "TYPETORCH_ADMIN_TOKEN",
	TYPETORCH_FLEET_TOKEN: "TYPETORCH_ADMIN_TOKEN",
	TYPETORCH_FLEET_INGEST_TOKEN: "TYPETORCH_API_KEY",
	TT_ANALYTICS_DATA: "TYPETORCH_DATA_DIR",
	TT_ANALYTICS_HOST: "HOST",
	TT_ANALYTICS_PORT: "PORT",
	TT_ANALYTICS_WEBHOOK_SECRET: "ROBLOX_WEBHOOK_SECRET",
	TT_ANALYTICS_OPENCLOUD_KEY: "OPENCLOUD_API_KEY",
	TT_ANALYTICS_UNIVERSE_ID: "TYPETORCH_UNIVERSE_ID",
	TT_ANALYTICS_ERASURE_DELETE_LINK: "TYPETORCH_ERASURE_DELETE_LINK",
	TT_ANALYTICS_TRUST_PROXY: "TYPETORCH_TRUST_PROXY",
	TT_ANALYTICS_MAX_BODY: "TYPETORCH_MAX_BODY",
	TT_ANALYTICS_MAX_INFLATE: "TYPETORCH_MAX_INFLATE",
	TT_ANALYTICS_IP_PER_MINUTE: "TYPETORCH_IP_PER_MINUTE",
	TT_ANALYTICS_JOB_PER_MINUTE: "TYPETORCH_JOB_PER_MINUTE",
	TT_ANALYTICS_MEMORY_LIMIT: "TYPETORCH_MEMORY_LIMIT",
	TT_ANALYTICS_THREADS: "TYPETORCH_THREADS",
	TT_ANALYTICS_LOAD_SECONDS: "TYPETORCH_LOAD_SECONDS",
	TT_ANALYTICS_KEEP_DAYS: "TYPETORCH_KEEP_DAYS",
	TT_ANALYTICS_RAW_KEEP_DAYS: "TYPETORCH_RAW_KEEP_DAYS",
	TT_ANALYTICS_COMPACT_MB: "TYPETORCH_COMPACT_MB",
	TT_ANALYTICS_QUERY_TIMEOUT: "TYPETORCH_QUERY_TIMEOUT",
	TT_ANALYTICS_QUERY_CONCURRENCY: "TYPETORCH_QUERY_CONCURRENCY",
	TT_ANALYTICS_FSYNC_MS: "TYPETORCH_FSYNC_MS",
	TT_ANALYTICS_SQL: "TYPETORCH_SQL",
	TT_ANALYTICS_SQL_MEMORY: "TYPETORCH_SQL_MEMORY",
	TT_ANALYTICS_ENV_FILE: "TYPETORCH_ENV_FILE",
	TT_SERVER_PARTS: "TYPETORCH_PARTS",
	TT_FLEET_DB: "TYPETORCH_SQLITE",
	TT_FLEET_WEBHOOK_URL: "TYPETORCH_ALERT_WEBHOOK_URL",
	TT_FLEET_WEBHOOK_FORMAT: "TYPETORCH_ALERT_WEBHOOK_FORMAT",
	TT_FLEET_WEBHOOK_LEVELS: "TYPETORCH_ALERT_WEBHOOK_LEVELS",
	TT_FLEET_NEW_JOBS_PER_MINUTE: "TYPETORCH_NEW_JOBS_PER_MINUTE",
};

/** Same as LEGACY_ENV, for the client side of this package (storeConfigFromEnv). */
export const LEGACY_CLIENT_ENV: Readonly<Record<string, string>> = {
	TT_ANALYTICS_URL: "TYPETORCH_BACKEND_URL",
	TT_ANALYTICS_ADMIN_TOKEN: "TYPETORCH_ADMIN_TOKEN",
	TYPETORCH_FLEET_TOKEN: "TYPETORCH_ADMIN_TOKEN",
};

/**
 * Copies each old name's value to its new name (the new name wins when both are set) and returns one warning per old
 * name found. Returns a new object; the input is left alone.
 */
export function applyLegacyEnv(env: Record<string, string | undefined>, map: Readonly<Record<string, string>> = LEGACY_ENV): { env: Record<string, string | undefined>; warnings: string[] } {
	const out = { ...env };
	const warnings: string[] = [];
	for (const [old, current] of Object.entries(map)) {
		if (out[old] === undefined || out[old] === "") continue;
		if (out[current] === undefined || out[current] === "") {
			out[current] = out[old];
			warnings.push(`${old} is deprecated: use ${current}`);
		} else {
			warnings.push(`${old} is ignored because ${current} is set; remove it`);
		}
		delete out[old];
	}
	return { env: out, warnings };
}
