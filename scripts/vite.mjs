/**
 * Starts the explorer with the analytics proxy (vite.config.ts sets it up from TT_ANALYTICS_ENV_FILE):
 *   node scripts/vite.mjs dev     [--env-file <analytics env file>] [--port 5173]
 *   node scripts/vite.mjs preview [--env-file <analytics env file>] [--port 4173]   (serves dist/; build first)
 * The env file is the analytics server's own (TT_ANALYTICS_HOST, TT_ANALYTICS_PORT, TT_ANALYTICS_ADMIN_TOKEN) or one
 * with TT_ANALYTICS_URL + TT_ANALYTICS_ADMIN_TOKEN. The token stays in this process; it is never printed.
 * Runs on Node: Vite's restart after a config change hangs under Bun (2026-10, Bun 1.3).
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer, preview } from "vite";

const [mode, ...args] = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};

if (mode !== "dev" && mode !== "preview") {
	console.error("usage: node scripts/vite.mjs dev|preview [--env-file <analytics env file>] [--port <n>]");
	process.exit(2);
}

const envFile = flag("--env-file");
if (envFile) {
	if (!existsSync(envFile)) {
		console.error(`env file not found: ${envFile}`);
		process.exit(2);
	}
	process.env.TT_ANALYTICS_ENV_FILE = resolve(envFile);
}
const port = flag("--port") ? Number(flag("--port")) : undefined;

if (mode === "dev") {
	const server = await createServer({ server: { ...(port ? { port } : {}) } });
	await server.listen();
	server.printUrls();
	server.bindCLIShortcuts({ print: true });
} else {
	if (!existsSync("dist/index.html")) {
		console.error("dist/ is missing: run `bun run build` first (or `bun run local`, which builds and previews)");
		process.exit(2);
	}
	const server = await preview({ preview: { ...(port ? { port } : {}) } });
	server.printUrls();
}
