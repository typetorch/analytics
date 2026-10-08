/**
 * Runs the backend on this PC for testing, reachable by game servers through a Cloudflare quick tunnel, and points the
 * game at it:
 *
 *   bun run local -- --game <game repo>        (e.g. --game ../template)
 *
 * 1. reads the game repo's `.env`: TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN (32+ random characters each, different),
 *    and ROBLOX_OAUTH_CLIENT_ID / ROBLOX_OAUTH_CLIENT_SECRET when Sign in with Roblox should work (missing ones: that
 *    feature is off, no error). Process environment variables win over the file; TYPETORCH_ENV_FILE names another file;
 * 2. starts the backend (`src/server/main.ts`) with those, its data in this repo's `data/`, the public URL on
 *    http://localhost:<port> (the quick tunnel's URL changes every run, so Roblox sign-in returns to localhost), or
 *    reuses one already answering on that port. It serves the explorer at the same address when `web/dist` is built;
 * 3. opens a quick tunnel (cloudflared, with an empty --config so a ~/.cloudflared/config.yml can't override --url);
 * 4. waits until the tunnel answers;
 * 5. points the game at it through the game's own TypeTorch CLI (0.9+, the signed settings record):
 *    `typetorch backend setup --url <tunnel> --flush-seconds 15 --record-share 1` (settings.backend = {url, key,
 *    analytics}, plus the old fleet and analytics sections for kernels before 0.4; also sets typetorch.json
 *    `backend.url`, a local edit: the tunnel URL changes every run, don't commit it). The keys reach the CLI through its
 *    environment, never its command line. The CLI signs with the game's keys (`typetorch keys init`), uses the game's
 *    Open Cloud key (DataStore read/create/update + messaging), pings servers so they switch within seconds, and sends
 *    the owner list to the backend (PUT /v1/access);
 * 6. keeps running; Ctrl+C stops the tunnel and the server it started.
 *
 * The CLI checks the address and both keys before it signs (the URL parses and is https, GET <url>/healthz answers,
 * GET /v1/auth/check says role game for the API key and role admin for the admin token) and refuses a broken value;
 * step 5 then prints the CLI's reason and fix in red, the tunnel keeps running, and the game keeps its old settings.
 * `--port <n>` (default 8787), `--public-url <url>` (instead of localhost), `--no-settings` skips step 5, `--cli <entry>`
 * runs that CLI entry file instead of the game's node_modules/@typetorch/cli, `--cloudflared <path>`. Prints no tokens
 * or keys (the API key reaches the CLI through its environment).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { planLocalRun } from "../src/game-env.ts";
import { writeBackendSettings } from "../src/settings.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const root = resolve(import.meta.dir, "..");
const gameDir = flag("--game") ? resolve(flag("--game") as string) : undefined;
const writeGameSettings = !args.includes("--no-settings");
const cliEntry = flag("--cli") ? resolve(flag("--cli") as string) : undefined;
const port = Number(flag("--port") ?? 8787);

const log = (line: string) => console.log(`${new Date().toTimeString().slice(0, 8)} ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const color = !process.env.NO_COLOR && (process.stdout.isTTY ?? false);
const red = (text: string) => (color ? `\x1b[1;31m${text}\x1b[0m` : text);
const yellow = (text: string) => (color ? `\x1b[33m${text}\x1b[0m` : text);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
	console.error(red("--port must be a number from 1 to 65535"));
	process.exit(2);
}

// Without --game nothing points game servers at this tunnel: say so loudly, now and again when ready.
const NO_GAME = "no --game: the game's settings and typetorch.json are NOT updated, so game servers won't use this tunnel";
const NO_GAME_FIX = "  fix: Ctrl+C, then bun run local -- --game <game repo> (e.g. --game ../template)";
if (writeGameSettings && !gameDir) {
	log(red(NO_GAME));
	log(red(NO_GAME_FIX));
}

// The keys: from the game's .env. A clear red error with the fix when they are missing.
const plan = planLocalRun({ ...(gameDir ? { gameDir } : {}), env: process.env, port, dataDir: join(root, "data"), ...(flag("--public-url") ? { publicUrl: flag("--public-url") as string } : {}) });
if (plan.problems.length) {
	for (const problem of plan.problems) console.error(red(`bun run local: ${problem}`));
	process.exit(1);
}
for (const note of plan.notes) log(note);
const local = `http://127.0.0.1:${port}`;
const apiKey = plan.serverEnv.TYPETORCH_API_KEY as string;
const adminToken = plan.serverEnv.TYPETORCH_ADMIN_TOKEN as string;

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

// 1. The backend.
if (await answers(local)) log(`backend already running on ${local} (it keeps the keys it started with)`);
else {
	const server = spawn(process.execPath, ["src/server/main.ts"], { cwd: root, env: plan.serverEnv, stdio: ["ignore", "pipe", "pipe"] });
	children.push(server);
	const relay = (prefix: string) => (chunk: Buffer) => {
		for (const line of chunk.toString().split(/\r?\n/)) if (line.trim()) log(`${prefix} ${line}`);
	};
	server.stdout!.on("data", relay("[backend]"));
	server.stderr!.on("data", relay("[backend]"));
	server.on("exit", (code) => {
		log(`backend exited (${code}); stopping`);
		stop();
	});
	for (let i = 0; i < 40 && !(await answers(local)); i++) await sleep(250);
	if (!(await answers(local))) throw new Error(`the backend didn't answer on ${local}`);
	log(`backend running on ${local}`);
}
if (existsSync(join(root, "web", "dist", "index.html"))) log(`explorer: ${plan.publicUrl}  (sign in with the admin token from ${plan.file})`);
else log(yellow(`explorer not built, so ${plan.publicUrl} shows nothing yet: bun run web:build (once; needs web/ dependencies: bun run web:install)`));

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

// 4. Point the game at it. The game's CLI checks the address and token (URL, GET /healthz, GET /v1/auth/check) before it
// signs anything, so a tunnel that does not answer or a token the server does not know is refused with the reason;
// the server and tunnel keep running either way, and the game keeps its old settings.
let pointed = false;
let refusal: string | undefined;
if (writeGameSettings) {
	if (!gameDir) {
		log(red(NO_GAME));
		log(red(NO_GAME_FIX));
	} else {
		const cli = { gameDir, ...(cliEntry ? { cli: [process.execPath, cliEntry] } : {}) };
		try {
			const backend = await writeBackendSettings({ ...cli, url, apiKey, adminToken, flushSeconds: 15, recordShare: 1 });
			log(`settings.backend ${backend.written ? "written" : "already set"}${backend.seq !== undefined ? ` (settings #${backend.seq})` : ""}; typetorch.json backend.url = ${url} (local edit; don't commit it)`);
			const owners = backend.owners as { state?: string; reason?: string; message?: string } | undefined;
			if (owners?.state === "failed" || owners?.state === "conflict") log(yellow(`the backend's owner list wasn't updated (${owners.message ?? owners.state}): run typetorch access push in the game repo`));
			pointed = true;
		} catch (error) {
			refusal = (error as Error).message;
			for (const line of refusal.split("\n")) log(red(line));
			log(red("the game was NOT pointed at this tunnel (its old settings stay). Fix the above and restart, or run the typetorch command by hand."));
		}
	}
}
if (pointed) {
	log("ready: running servers (kernel 0.3.8+) switch within seconds of the ping, new servers at once. Ctrl+C stops.");
} else {
	const why = refusal ? "the game's CLI refused the settings" : gameDir ? "--no-settings" : "no --game";
	log(red(`ready on ${url}, but game servers were NOT told about it (${why}). Ctrl+C stops.`));
}
await new Promise(() => {});
