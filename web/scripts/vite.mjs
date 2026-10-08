/**
 * Starts the explorer with the analytics proxy (vite.config.ts sets it up from TT_ANALYTICS_ENV_FILE):
 *   node scripts/vite.mjs dev     [--env-file <analytics env file>] [--port 5173]
 *   node scripts/vite.mjs preview [--env-file <analytics env file>] [--port 4173]   (serves dist/; build first)
 * The env file is the analytics server's own (TT_ANALYTICS_HOST, TT_ANALYTICS_PORT, TT_ANALYTICS_ADMIN_TOKEN) or one
 * with TT_ANALYTICS_URL + TT_ANALYTICS_ADMIN_TOKEN. The token stays in this process; it is never printed.
 * Runs on Node: Vite's restart after a config change hangs under Bun (2026-10, Bun 1.3).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
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

// The env file: --env-file (remembered in .explorer.local, git-ignored: the path only, never the token), else
// TT_ANALYTICS_ENV_FILE, else the remembered path, else the usual local server's file (~/.config/typetorch/fleet).
const REMEMBERED = ".explorer.local";
const DEFAULT_ENV = join(homedir(), ".config", "typetorch", "fleet", "fleet.env");
let envFile = flag("--env-file");
if (envFile) {
	if (!existsSync(envFile)) {
		console.error(`env file not found: ${envFile}`);
		process.exit(2);
	}
	envFile = resolve(envFile);
	try {
		writeFileSync(REMEMBERED, JSON.stringify({ envFile }, null, "\t") + "\n");
	} catch {}
} else if (!process.env.TT_ANALYTICS_ENV_FILE) {
	let remembered;
	try {
		remembered = JSON.parse(readFileSync(REMEMBERED, "utf8")).envFile;
	} catch {}
	if (typeof remembered === "string" && existsSync(remembered)) {
		envFile = remembered;
		console.log(`env file ${envFile} (remembered; pass --env-file to change)`);
	} else if (existsSync(DEFAULT_ENV)) {
		envFile = DEFAULT_ENV;
		console.log(`env file ${envFile} (default; pass --env-file to change)`);
	}
}
if (envFile) process.env.TT_ANALYTICS_ENV_FILE = envFile;
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
