/**
 * Runs the analytics + fleet server on this PC for testing, reachable by game servers through a Cloudflare quick
 * tunnel, and points the game at it:
 *
 *   bun run local -- --env-file <server env file> --game <game repo>
 *
 * 1. starts the server (`src/server/main.ts --env-file ...`), or reuses one already answering on that port;
 * 2. opens a quick tunnel (cloudflared, with an empty --config so a ~/.cloudflared/config.yml can't override --url);
 * 3. waits until the tunnel answers;
 * 4. points the game at it through the game's own TypeTorch CLI (0.8+, kernel 0.3.8's signed settings record):
 *    `typetorch fleet setup --url <tunnel>` (settings.fleet = {url, token}; also sets typetorch.json `fleet.url`, a
 *    local edit: the tunnel URL changes every run, don't commit it) and `typetorch settings set analytics -` (DuckDB
 *    ingest at <url>/v1/ingest). The CLI signs with the game's keys (`typetorch keys init`) and uses the game's Open
 *    Cloud key (DataStore read/create/update + messaging), then pings servers so they switch within seconds;
 * 5. keeps running; Ctrl+C stops the tunnel and the server it started.
 *
 * `--no-settings` skips step 4; `--cli <entry>` runs that CLI entry file instead of the game's
 * node_modules/@typetorch/cli. Prints no tokens or keys (the token reaches the CLI through its environment).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFleetSettings, writeSettings } from "../src/settings.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const envFile = flag("--env-file");
const gameDir = flag("--game") ? resolve(flag("--game")!) : undefined;
const writeGameSettings = !args.includes("--no-settings");
const cliEntry = flag("--cli") ? resolve(flag("--cli")!) : undefined;
if (!envFile) {
	console.error("usage: bun run local -- --env-file <server env file> [--game <game repo>] [--no-settings] [--cli <cli entry>] [--cloudflared <path>]");
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
		const cli = { gameDir, ...(cliEntry ? { cli: [process.execPath, cliEntry] } : {}) };
		const fleet = await writeFleetSettings({ ...cli, url, ingestToken });
		log(`settings.fleet ${fleet.written ? "written" : "already set"}${fleet.seq !== undefined ? ` (settings #${fleet.seq})` : ""}; typetorch.json fleet.url = ${url} (local edit; don't commit it)`);
		const analytics = await writeSettings({
			...cli,
			settings: { backend: "duckdb", events: `${url}/v1/ingest`, token: ingestToken, flushSeconds: 15, recordShare: 1 },
		});
		log(`settings.analytics ${analytics.written ? "written" : "already set"}${analytics.seq !== undefined ? ` (settings #${analytics.seq})` : ""}`);
	}
}
log("ready: running servers (kernel 0.3.8+) switch within seconds of the ping, new servers at once. Ctrl+C stops.");
await new Promise(() => {});
