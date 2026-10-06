/**
 * Runs the analytics + fleet server on this PC for testing, reachable by game servers through a Cloudflare quick
 * tunnel, and points the game at it:
 *
 *   bun run local -- --env-file <server env file> --game <game repo>
 *
 * 1. starts the server (`src/server/main.ts --env-file ...`), or reuses one already answering on that port;
 * 2. opens a quick tunnel (cloudflared, with an empty --config so a ~/.cloudflared/config.yml can't override --url);
 * 3. waits until the tunnel answers;
 * 4. writes the game's server-only ConfigService keys `TypeTorchFleet` ({url, token}) and `TypeTorchAnalytics`
 *    (DuckDB ingest at <url>/v1/ingest), with the Open Cloud key from the game's env (universe:write), and sets
 *    `fleet.url` in the game's typetorch.json (local edit: the tunnel URL changes every run, don't commit it);
 * 5. keeps running; Ctrl+C stops the tunnel and the server it started.
 *
 * `--no-settings` skips step 4. Prints no tokens or keys.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { publishConfigKey } from "../src/opencloud.ts";
import { writeSettings } from "../src/settings.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const envFile = flag("--env-file");
const gameDir = flag("--game") ? resolve(flag("--game")!) : undefined;
const writeGameSettings = !args.includes("--no-settings");
if (!envFile) {
	console.error("usage: bun run local -- --env-file <server env file> [--game <game repo>] [--no-settings] [--cloudflared <path>]");
	process.exit(2);
}

function readEnv(path: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
		if (line.trimStart().startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq > 0) out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1"));
	}
	return out;
}

const log = (line: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const serverEnv = readEnv(envFile);
const host = serverEnv.get("TT_ANALYTICS_HOST") ?? "127.0.0.1";
const port = serverEnv.get("TT_ANALYTICS_PORT") ?? "8787";
const local = `http://${host}:${port}`;
const ingestToken = serverEnv.get("TT_ANALYTICS_INGEST_TOKENS")?.split(",")[0]?.trim();
if (!ingestToken) throw new Error(`TT_ANALYTICS_INGEST_TOKENS is missing from ${envFile}`);

/** The game's Open Cloud key: the environment, then TYPETORCH_ENV_FILE, then .env files from the game folder up. */
function openCloudKey(start: string): string | undefined {
	const names = ["OPENCLOUD_DEPLOY_KEY", "TYPETORCH_API_KEY", "OPENCLOUD_API_KEY", "ROBLOX_API_KEY"];
	for (const name of names) if (process.env[name]) return process.env[name];
	const files: string[] = [];
	if (process.env.TYPETORCH_ENV_FILE) files.push(process.env.TYPETORCH_ENV_FILE);
	for (let dir = start; ; dir = dirname(dir)) {
		const candidate = join(dir, ".env");
		if (existsSync(candidate)) files.push(candidate);
		if (dirname(dir) === dir) break;
	}
	for (const file of files) {
		const env = readEnv(file);
		const pointer = env.get("TYPETORCH_ENV_FILE");
		if (pointer && existsSync(pointer)) files.push(pointer);
		for (const name of names) if (env.get(name)) return env.get(name);
	}
	return undefined;
}

async function answers(url: string): Promise<boolean> {
	try {
		const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(5000) });
		return response.ok;
	} catch {
		return false;
	}
}

const children: ChildProcess[] = [];
const stop = () => {
	for (const child of children) child.kill();
	process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// 1. The server.
if (await answers(local)) log(`server already running on ${local}`);
else {
	const server = spawn(process.execPath, ["src/server/main.ts", "--env-file", envFile], { cwd: resolve(import.meta.dir, ".."), stdio: ["ignore", "pipe", "pipe"] });
	children.push(server);
	const relay = (prefix: string) => (chunk: Buffer) => {
		for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(`${prefix} ${line}`);
	};
	server.stdout!.on("data", relay("[server]"));
	server.stderr!.on("data", relay("[server]"));
	server.on("exit", (code) => {
		log(`server exited (${code}); stopping`);
		stop();
	});
	for (let i = 0; i < 40 && !(await answers(local)); i++) await sleep(250);
	if (!(await answers(local))) throw new Error(`the server didn't answer on ${local}`);
	log(`server running on ${local}`);
}

// 2. The quick tunnel.
const cloudflared = flag("--cloudflared") ?? Bun.which("cloudflared");
if (!cloudflared) throw new Error("cloudflared is not installed (Windows: winget install --id Cloudflare.cloudflared -e; macOS: brew install cloudflared)");
const emptyConfig = join(mkdtempSync(join(tmpdir(), "tt-local-")), "config.yml");
writeFileSync(emptyConfig, "# empty: quick tunnel only\n");
const tunnel = spawn(cloudflared, ["tunnel", "--config", emptyConfig, "--no-autoupdate", "--url", local], { stdio: ["ignore", "pipe", "pipe"] });
children.push(tunnel);
const url = await new Promise<string>((resolveUrl, reject) => {
	const timer = setTimeout(() => reject(new Error("cloudflared printed no trycloudflare.com URL within 60 s")), 60_000);
	const scan = (chunk: Buffer) => {
		const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
		if (match) {
			clearTimeout(timer);
			resolveUrl(match[0]);
		}
	};
	tunnel.stdout!.on("data", scan);
	tunnel.stderr!.on("data", scan);
	tunnel.on("exit", (code) => reject(new Error(`cloudflared exited (${code})`)));
});
log(`tunnel ${url}`);

// 3. Wait until it answers (a new quick tunnel can take up to a minute).
const waitStart = Date.now();
while (!(await answers(url))) {
	if (Date.now() - waitStart > 120_000) throw new Error("the tunnel didn't answer within 2 minutes");
	await sleep(2000);
}
log(`tunnel answering after ${Math.round((Date.now() - waitStart) / 1000)} s`);

// 4. Point the game at it.
if (writeGameSettings) {
	if (!gameDir) log("no --game: skipped the game's settings and typetorch.json (pass --game <game repo>)");
	else {
		const configPath = join(gameDir, "typetorch.json");
		const raw = readFileSync(configPath, "utf8");
		const config = JSON.parse(raw) as { universeId: number; fleet?: { url: string } };
		const apiKey = openCloudKey(gameDir);
		if (!apiKey) throw new Error("no Open Cloud key found (environment, TYPETORCH_ENV_FILE or a .env from the game folder up)");
		const fleet = await publishConfigKey({ apiKey, universeId: config.universeId, key: "TypeTorchFleet", value: { url, token: ingestToken }, message: "TypeTorch fleet API (local quick tunnel)" });
		log(`TypeTorchFleet published${fleet.configVersion !== undefined ? ` (config v${fleet.configVersion})` : ""}`);
		const analytics = await writeSettings({
			apiKey,
			universeId: config.universeId,
			settings: { backend: "duckdb", events: `${url}/v1/ingest`, token: ingestToken, flushSeconds: 15, recordShare: 1 },
			message: "TypeTorch analytics: DuckDB (local quick tunnel)",
		});
		log(`TypeTorchAnalytics published${analytics.configVersion !== undefined ? ` (config v${analytics.configVersion})` : ""}`);
		config.fleet = { url };
		const indent = raw.match(/^(\s+)"/m)?.[1] ?? "\t";
		writeFileSync(configPath, JSON.stringify(config, null, indent) + "\n");
		log(`${configPath}: fleet.url = ${url} (local edit; don't commit it)`);
	}
}
log("ready: game servers pick up the new URL when ConfigService pushes the update (new servers at once). Ctrl+C stops.");
await new Promise(() => {});
