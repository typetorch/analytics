#!/usr/bin/env node
/**
 * typetorch-analytics-server: the DuckDB analytics API and the SQLite fleet API (README "DuckDB server").
 *   bun src/server/main.ts [--env-file analytics.env]
 *   node dist/server/main.js [--env-file analytics.env]
 */
import { runtimeName } from "../runtime.ts";
import { startApp } from "./app.ts";
import { describeConfig, loadConfig } from "./config.ts";

async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log("usage: typetorch-analytics-server [--env-file <file>]\nSettings come from TT_* environment variables; see the README.");
		return;
	}
	const config = loadConfig();
	if (!config.adminToken) console.warn("[analytics] TT_ANALYTICS_ADMIN_TOKEN is not set: queries and fleet reads are refused");
	const app = await startApp(config);
	console.log(`[analytics] listening on ${config.host}:${app.port} (${runtimeName()}); ${describeConfig(config)}`);
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`[analytics] ${signal}: loading the last raw files and closing`);
		await app.stop().catch((e) => console.error(`[analytics] stop failed: ${(e as Error).message}`));
		process.exit(0);
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error) => {
	console.error(`[analytics] ${(error as Error).message}`);
	process.exit(1);
});
