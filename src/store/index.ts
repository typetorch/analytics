/**
 * `createStore(config)`: one entry point for the CLI, whatever the game's backend.
 *   { backend: "basin", accountId, bucket, token }        -> Basin SQL through Cloudflare's API
 *   { backend: "duckdb", url, token }                      -> a TypeTorch analytics server (admin token)
 *   { backend: "duckdb", dataDir }                         -> a local copy of a server's data folder (read-only)
 */
import { applyLegacyEnv, LEGACY_CLIENT_ENV } from "../legacy-env.ts";
import { BasinStore, type BasinStoreConfig } from "./basin.ts";
import { openDuckDbStore, type LocalDuckDbOptions } from "./duckdb.ts";
import { RemoteStore, type RemoteStoreConfig } from "./remote.ts";
import type { Store } from "./sql-store.ts";

export type StoreConfig =
	| ({ backend: "basin" } & BasinStoreConfig)
	| ({ backend: "duckdb" } & RemoteStoreConfig)
	| ({ backend: "duckdb" } & LocalDuckDbOptions);

export async function createStore(config: StoreConfig): Promise<Store> {
	if (config.backend === "basin") return new BasinStore(config);
	if (config.backend === "duckdb") {
		if ("url" in config && config.url) return new RemoteStore(config as RemoteStoreConfig);
		if ("dataDir" in config && config.dataDir) return openDuckDbStore(config as LocalDuckDbOptions);
		throw new Error('backend "duckdb" needs either { url, token } (an analytics server) or { dataDir } (a local copy)');
	}
	throw new Error(`unknown analytics backend ${JSON.stringify((config as { backend?: unknown }).backend)}`);
}

/**
 * A store config from environment variables (names only; values are never printed):
 *   TYPETORCH_BACKEND_URL + TYPETORCH_ADMIN_TOKEN                     -> the TypeTorch backend (DuckDB)
 *   (TT_ANALYTICS_URL and TT_ANALYTICS_ADMIN_TOKEN still work for one release, with a warning on stderr)
 *   CLOUDFLARE_ACCOUNT_ID + TT_BASIN_BUCKET + TT_BASIN_SQL_TOKEN      -> Basin (WRANGLER_BASIN_SQL_AUTH_TOKEN works too)
 * Optional: TT_BASIN_NAMESPACE. `backend` picks one when both are set.
 */
export function storeConfigFromEnv(rawEnv: Record<string, string | undefined>, backend?: "basin" | "duckdb", warn: (line: string) => void = (line) => console.warn(line)): StoreConfig {
	const { env, warnings } = applyLegacyEnv(rawEnv, LEGACY_CLIENT_ENV);
	for (const w of warnings) warn(w);
	const want = backend ?? (env.TYPETORCH_BACKEND_URL ? "duckdb" : "basin");
	if (want === "duckdb") {
		if (!env.TYPETORCH_BACKEND_URL || !env.TYPETORCH_ADMIN_TOKEN) throw new Error("set TYPETORCH_BACKEND_URL and TYPETORCH_ADMIN_TOKEN");
		return { backend: "duckdb", url: env.TYPETORCH_BACKEND_URL, token: env.TYPETORCH_ADMIN_TOKEN };
	}
	const token = env.TT_BASIN_SQL_TOKEN ?? env.WRANGLER_BASIN_SQL_AUTH_TOKEN;
	if (!env.CLOUDFLARE_ACCOUNT_ID || !env.TT_BASIN_BUCKET || !token) {
		throw new Error("set CLOUDFLARE_ACCOUNT_ID, TT_BASIN_BUCKET and TT_BASIN_SQL_TOKEN (or WRANGLER_BASIN_SQL_AUTH_TOKEN)");
	}
	const config: StoreConfig = { backend: "basin", accountId: env.CLOUDFLARE_ACCOUNT_ID, bucket: env.TT_BASIN_BUCKET, token };
	if (env.TT_BASIN_NAMESPACE) config.namespace = env.TT_BASIN_NAMESPACE;
	return config;
}

export type { Store } from "./sql-store.ts";
export { BasinStore, BasinSqlError, parseBasinRows } from "./basin.ts";
export { DuckDbStore, openDuckDbStore, readRows } from "./duckdb.ts";
export { RemoteStore, RemoteQueryError } from "./remote.ts";
