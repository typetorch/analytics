/**
 * A game repo's `.env`, for `bun run local` and the other scripts: the backend's API key and admin token (and the Roblox
 * OAuth app) live there next to the Open Cloud key, so nothing is typed twice. Process environment variables win over
 * the file, and TYPETORCH_ENV_FILE names another file (the CLI's override). Values stay in memory; errors name variables
 * and files, never values.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MIN_SECRET_LENGTH, parseDotEnv } from "./server/config.ts";

/** What the backend reads from the game's .env (everything else in that file is the CLI's). */
export const GAME_ENV_NAMES = ["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN", "ROBLOX_OAUTH_CLIENT_ID", "ROBLOX_OAUTH_CLIENT_SECRET"] as const;
export type GameEnvName = (typeof GAME_ENV_NAMES)[number];

export function gameEnvFile(gameDir: string, env: Record<string, string | undefined> = process.env): string {
	return env.TYPETORCH_ENV_FILE ? resolve(env.TYPETORCH_ENV_FILE) : join(resolve(gameDir), ".env");
}

export interface GameEnv {
	file: string;
	exists: boolean;
	values: Partial<Record<GameEnvName, string>>;
}

/** The named variables from the process environment, else the game's .env. */
export function readGameEnv(gameDir: string, env: Record<string, string | undefined> = process.env, names: readonly GameEnvName[] = GAME_ENV_NAMES): GameEnv {
	const file = gameEnvFile(gameDir, env);
	const exists = existsSync(file);
	const fromFile = exists ? parseDotEnv(readFileSync(file, "utf8")) : {};
	const values: Partial<Record<GameEnvName, string>> = {};
	for (const name of names) {
		const value = env[name] || fromFile[name];
		if (value) values[name] = value;
	}
	return { file, exists, values };
}

export interface LocalPlan {
	/** The environment for the backend process (secrets inside: never print it). */
	serverEnv: Record<string, string>;
	file: string;
	publicUrl: string;
	/** Why the run can't start (variable and file names, plus the fix). Empty = go. */
	problems: string[];
	/** Things worth saying at startup (no values). */
	notes: string[];
}

/**
 * What `bun run local -- --game <repo>` starts the backend with: the API key and admin token from the game's .env, data in
 * the backend's own data folder, the public URL on localhost (a quick tunnel's URL changes every run, so Roblox sign-in
 * returns to localhost), Roblox sign-in on when the OAuth app's id and secret are in the .env.
 */
export function planLocalRun(o: { gameDir?: string; env: Record<string, string | undefined>; port: number; host?: string; dataDir: string; publicUrl?: string }): LocalPlan {
	const fromProcess: Partial<Record<GameEnvName, string>> = {};
	for (const name of GAME_ENV_NAMES) if (o.env[name]) fromProcess[name] = o.env[name] as string;
	const read: GameEnv = o.gameDir ? readGameEnv(o.gameDir, o.env) : { file: "the process environment", exists: true, values: fromProcess };
	const problems: string[] = [];
	const notes: string[] = [];
	const fix = o.gameDir
		? `add them to ${read.file}: TYPETORCH_API_KEY=<32+ random characters> and TYPETORCH_ADMIN_TOKEN=<32+ random characters>, different from each other (generate each with: openssl rand -hex 32)`
		: "run with --game <game repo> (e.g. --game ../template) so they come from that repo's .env";
	if (o.gameDir && !read.exists) problems.push(`${read.file} does not exist: ${fix}`);
	const key = read.values.TYPETORCH_API_KEY;
	const admin = read.values.TYPETORCH_ADMIN_TOKEN;
	if (read.exists) {
		if (!key) problems.push(`TYPETORCH_API_KEY is missing: ${fix}`);
		else if (key.length < MIN_SECRET_LENGTH) problems.push(`TYPETORCH_API_KEY is shorter than ${MIN_SECRET_LENGTH} characters: replace it with a random value (openssl rand -hex 32)`);
		if (!admin) problems.push(`TYPETORCH_ADMIN_TOKEN is missing: ${fix}`);
		else if (admin.length < MIN_SECRET_LENGTH) problems.push(`TYPETORCH_ADMIN_TOKEN is shorter than ${MIN_SECRET_LENGTH} characters: replace it with a random value (openssl rand -hex 32)`);
		if (key && admin && key === admin) problems.push("TYPETORCH_API_KEY and TYPETORCH_ADMIN_TOKEN are the same value: they must be different (the API key lives in game servers, the admin token must not)");
	}
	const publicUrl = (o.publicUrl ?? `http://localhost:${o.port}`).replace(/\/+$/, "");
	const serverEnv: Record<string, string> = {
		...(Object.fromEntries(Object.entries(o.env).filter((e): e is [string, string] => typeof e[1] === "string")) as Record<string, string>),
		TYPETORCH_DATA_DIR: o.dataDir,
		HOST: o.host ?? "127.0.0.1",
		PORT: String(o.port),
		TYPETORCH_PUBLIC_URL: publicUrl,
		// The local server is reached through localhost and a Cloudflare quick tunnel (one proxy hop).
		TYPETORCH_TRUST_PROXY: "1",
	};
	// Old names in the shell would only add warnings; this run is configured by what is set below.
	for (const name of Object.keys(serverEnv)) if (/^TT_(ANALYTICS|FLEET|SERVER)_/.test(name) || name === "TYPETORCH_FLEET_TOKEN" || name === "TYPETORCH_FLEET_INGEST_TOKEN") delete serverEnv[name];
	if (key) serverEnv.TYPETORCH_API_KEY = key;
	else delete serverEnv.TYPETORCH_API_KEY;
	if (admin) serverEnv.TYPETORCH_ADMIN_TOKEN = admin;
	else delete serverEnv.TYPETORCH_ADMIN_TOKEN;
	const oauthId = read.values.ROBLOX_OAUTH_CLIENT_ID;
	const oauthSecret = read.values.ROBLOX_OAUTH_CLIENT_SECRET;
	delete serverEnv.ROBLOX_OAUTH_CLIENT_ID;
	delete serverEnv.ROBLOX_OAUTH_CLIENT_SECRET;
	if (oauthId && oauthSecret) {
		serverEnv.ROBLOX_OAUTH_CLIENT_ID = oauthId;
		serverEnv.ROBLOX_OAUTH_CLIENT_SECRET = oauthSecret;
		notes.push(`Sign in with Roblox is on (redirect ${publicUrl}/v1/auth/roblox/callback must be one of the OAuth app's redirect URLs)`);
	} else {
		notes.push("Sign in with Roblox is off (ROBLOX_OAUTH_CLIENT_ID / ROBLOX_OAUTH_CLIENT_SECRET are not both in the .env); the explorer takes the admin token");
	}
	return { serverEnv, file: read.file, publicUrl, problems, notes };
}
