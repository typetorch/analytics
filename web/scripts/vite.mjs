/**
 * Works on the explorer with the backend's proxy (vite.config.ts sets it up from the variables below):
 *   node scripts/vite.mjs dev     --game <game repo> [--url <backend url>] [--port 5173]
 *   node scripts/vite.mjs preview --game <game repo> [--url <backend url>] [--port 4173]   (serves dist/; build first)
 * The admin token comes from TYPETORCH_ADMIN_TOKEN in the game repo's .env (TYPETORCH_ENV_FILE names another file, a token
 * in the environment wins); the backend's URL from the game's typetorch.json `backend.url`, or `--url`, else
 * http://127.0.0.1:8787. The token stays in this process; it is never printed. In production the backend serves the built
 * explorer itself and people sign in there; this is only for developing the explorer.
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
	console.error("usage: node scripts/vite.mjs dev|preview --game <game repo> [--url <backend url>] [--port <n>]");
	process.exit(2);
}

const game = flag("--game");
if (game) {
	const dir = resolve(game);
	if (!existsSync(dir)) {
		console.error(`game repo not found: ${dir}`);
		process.exit(2);
	}
	process.env.TYPETORCH_GAME_DIR = dir;
}
if (flag("--url")) process.env.TYPETORCH_BACKEND_URL = flag("--url");
if (!game && !process.env.TYPETORCH_ADMIN_TOKEN) {
	console.warn("no --game: there is no admin token for the proxy, so /api answers 503 (pass --game <game repo>, e.g. --game ../../template)");
}
const port = flag("--port") ? Number(flag("--port")) : undefined;

if (mode === "dev") {
	const server = await createServer({ server: { ...(port ? { port } : {}) } });
	await server.listen();
	server.printUrls();
	server.bindCLIShortcuts({ print: true });
} else {
	if (!existsSync("dist/index.html")) {
		console.error("dist/ is missing: run `bun run build` first");
		process.exit(2);
	}
	const server = await preview({ preview: { ...(port ? { port } : {}) } });
	server.printUrls();
}
