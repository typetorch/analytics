#!/usr/bin/env node
/**
 * typetorch-backend: the analytics API (DuckDB), the fleet API (SQLite), error logs and the explorer in one process
 * (README "The backend").
 *   bun src/server/main.ts [--env-file backend.env]
 *   node dist/server/main.js [--env-file backend.env]
 * Settings come from environment variables (TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN are required).
 */
import { runtimeName } from "../runtime.ts";
import { startApp } from "./app.ts";
import { describeConfig, loadConfig } from "./config.ts";

async function main(): Promise<void> {
	if (process.argv.includes("--help") || process.argv.includes("-h")) {
		console.log("usage: typetorch-backend [--env-file <file>]\nRequired: TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN (32+ random characters each, different). See the README for the rest.");
		return;
	}
	const config = loadConfig();
	for (const warning of config.warnings) console.warn(`[backend] ${warning}`);
	const app = await startApp(config);
	console.log(`[backend] listening on ${config.host}:${app.port} (${runtimeName()}); ${describeConfig(config)}`);
	let stopping = false;
	const stop = async (signal: string) => {
		if (stopping) return;
		stopping = true;
		console.log(`[backend] ${signal}: loading the last raw files and closing`);
		await app.stop().catch((e) => console.error(`[backend] stop failed: ${(e as Error).message}`));
		process.exit(0);
	};
	process.on("SIGINT", () => void stop("SIGINT"));
	process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error) => {
	console.error(`[backend] ${(error as Error).message}`);
	process.exit(1);
});
