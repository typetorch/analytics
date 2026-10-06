/**
 * The game's analytics settings: the `analytics` field of the game's signed settings record (kernel 0.3.8, TypeTorch
 * plans/20; DataStore TypeTorch / settings), read by game servers and written by `writeSettings` through the game's own
 * TypeTorch CLI (`typetorch settings set analytics -`), which signs it with the game's two prod keys. Updating it
 * needs no place publish: servers re-read it within seconds (ping) or a minute. Read tokens (Basin SQL, the server's
 * admin token) never go here: only the write-only ingest/send token.
 */
import { SAFE_KEY } from "./sql/dialect.ts";
import { runTypeTorch, type TypeTorchCliOptions } from "./typetorch-cli.ts";

/** The settings record's field that holds these settings. */
export const SETTINGS_FIELD = "analytics";
/** Keeps the analytics field well inside the settings record (32 KB for every field together). */
export const MAX_SETTINGS_CHARS = 9_500;

/**
 * One experiment's live dials, as the framework reads them (framework/src/analytics/SCHEMA.md "Sink settings"). The
 * variants themselves are the game's (`analytics.experiment("onboarding", ["short", "long"])`).
 */
export interface ExperimentSetting {
	/** false: everyone gets the first variant, not stamped. Default true. */
	active?: boolean;
	/** A weight per variant, in the game's order (e.g. [1, 1]; [3, 1] = 75% / 25%). */
	weights?: number[];
	/** Force this variant for everyone. */
	variant?: string;
}

export interface AnalyticsSettings {
	backend: "basin" | "duckdb";
	/** Basin: the events stream endpoint. DuckDB: the server's ingest URL (https://host/v1/ingest). */
	events: string;
	/** Basin: the recordings stream endpoint. DuckDB: unused (one batch carries both). */
	recordings?: string;
	/** The write-only token: Basin "Pipelines Send" API token, or the DuckDB server's ingest token. */
	token?: string;
	/** Seconds between sends (default the framework's, ~15). */
	flushSeconds?: number;
	/** Share (0-1) of new players whose first session is recorded in detail. Turn down first on a spike. */
	recordShare?: number;
	/** Seconds between tech-health samples. */
	techEvery?: number;
	experiments?: Record<string, ExperimentSetting>;
}

function checkUrl(value: unknown, what: string): string {
	if (typeof value !== "string" || value.length > 512) throw new Error(`${what} must be a URL`);
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${what} must be a URL`);
	}
	if (url.protocol !== "https:") throw new Error(`${what} must be https (Roblox game servers only reach https endpoints)`);
	if (url.username || url.password) throw new Error(`${what} must not hold credentials (use token)`);
	return value;
}

function checkNumber(value: unknown, what: string, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`${what} must be a number from ${min} to ${max}`);
	return value;
}

/** Checks settings and returns a clean copy (unknown fields dropped). Throws with a plain message. */
export function validateSettings(input: unknown): AnalyticsSettings {
	if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("settings must be an object");
	const raw = input as Record<string, unknown>;
	if (raw.backend !== "basin" && raw.backend !== "duckdb") throw new Error('backend must be "basin" or "duckdb"');
	const out: AnalyticsSettings = { backend: raw.backend, events: checkUrl(raw.events, "events") };
	if (raw.recordings !== undefined) out.recordings = checkUrl(raw.recordings, "recordings");
	if (raw.backend === "basin" && out.recordings === undefined) throw new Error("basin needs a recordings stream URL too");
	if (raw.token !== undefined) {
		if (typeof raw.token !== "string" || raw.token.length < 16 || raw.token.length > 512 || /\s/.test(raw.token)) throw new Error("token must be 16-512 characters without spaces");
		out.token = raw.token;
	}
	if (raw.flushSeconds !== undefined) out.flushSeconds = checkNumber(raw.flushSeconds, "flushSeconds", 5, 300);
	if (raw.recordShare !== undefined) out.recordShare = checkNumber(raw.recordShare, "recordShare", 0, 1);
	if (raw.techEvery !== undefined) out.techEvery = checkNumber(raw.techEvery, "techEvery", 15, 3600);
	if (raw.experiments !== undefined) {
		if (typeof raw.experiments !== "object" || raw.experiments === null || Array.isArray(raw.experiments)) throw new Error("experiments must be an object");
		out.experiments = {};
		for (const [name, value] of Object.entries(raw.experiments as Record<string, unknown>)) {
			if (!SAFE_KEY.test(name)) throw new Error(`experiment name ${JSON.stringify(name)}: letters, digits, _ - . only`);
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`experiment ${name}: must be an object`);
			const e = value as Record<string, unknown>;
			const setting: ExperimentSetting = {};
			if (e.active !== undefined) {
				if (typeof e.active !== "boolean") throw new Error(`experiment ${name}: active must be true or false`);
				setting.active = e.active;
			}
			if (e.weights !== undefined) {
				const w = e.weights;
				if (!Array.isArray(w) || w.length < 1 || w.length > 20 || w.some((x) => typeof x !== "number" || !Number.isFinite(x) || x < 0) || !w.some((x) => (x as number) > 0)) {
					throw new Error(`experiment ${name}: weights must be 1-20 numbers >= 0, at least one above 0`);
				}
				setting.weights = [...(w as number[])];
			}
			if (e.variant !== undefined) {
				if (typeof e.variant !== "string" || !SAFE_KEY.test(e.variant)) throw new Error(`experiment ${name}: variant must be a variant name`);
				setting.variant = e.variant;
			}
			out.experiments[name] = setting;
		}
	}
	const size = JSON.stringify(out).length;
	if (size > MAX_SETTINGS_CHARS) throw new Error(`settings are ${size} characters; keep them under ${MAX_SETTINGS_CHARS} (the settings record holds every field in 32 KB)`);
	return out;
}

export interface WriteSettingsOptions extends TypeTorchCliOptions {
	settings: AnalyticsSettings;
	/** Validate and return the value without running the CLI. */
	dryRun?: boolean;
	/** Don't ping servers (they still read the record within about a minute). */
	noPing?: boolean;
}

export interface WriteSettingsResult {
	value: AnalyticsSettings;
	/** True when the CLI wrote the record (false on a dry run, or when it already held these settings). */
	written: boolean;
	/** The settings record's seq after the call. */
	seq?: number;
	/** True when the CLI pinged running servers. */
	pinged?: boolean;
}

/**
 * Sets the game's `analytics` settings: validates them, then runs `typetorch settings set analytics -` in the game
 * folder (the value on stdin, so the token never sits in a command line). The CLI reads the record, checks it was
 * signed by the game's keys, signs the change with both prod keys, writes it and pings servers. Needs the game's
 * signing keys (`typetorch keys init`) and its Open Cloud key with DataStore read/create/update + messaging scopes.
 */
export async function writeSettings(options: WriteSettingsOptions): Promise<WriteSettingsResult> {
	const value = validateSettings(options.settings);
	if (options.dryRun) return { value, written: false };
	const args = ["settings", "set", SETTINGS_FIELD, "-", ...(options.noPing ? ["--no-ping"] : [])];
	const out = await runTypeTorch(options, args, { stdin: JSON.stringify(value) });
	const result: WriteSettingsResult = { value, written: out.outcome === "written" };
	if (typeof out.seq === "number") result.seq = out.seq;
	if (out.pinged === true) result.pinged = true;
	return result;
}

export interface WriteFleetSettingsOptions extends TypeTorchCliOptions {
	/** The fleet API's https base URL (this server). */
	url: string;
	/** The server's write-only ingest token (game servers post with it). Goes to the CLI through its environment. */
	ingestToken: string;
	noPing?: boolean;
}

/**
 * Points the game's servers at a fleet API: runs `typetorch fleet setup --url <url>` in the game folder with the
 * ingest token in the CLI's environment (TYPETORCH_FLEET_INGEST_TOKEN, never argv). The CLI writes the signed
 * record's `fleet` field ({url, token}) and sets typetorch.json `fleet.url`.
 */
export async function writeFleetSettings(options: WriteFleetSettingsOptions): Promise<{ written: boolean; seq?: number }> {
	if (!/^https:\/\//.test(options.url)) throw new Error("the fleet URL must be https");
	const args = ["fleet", "setup", "--url", options.url, ...(options.noPing ? ["--no-ping"] : [])];
	const out = await runTypeTorch(options, args, { env: { TYPETORCH_FLEET_INGEST_TOKEN: options.ingestToken } });
	return { written: out.outcome === "written", ...(typeof out.settingsSeq === "number" ? { seq: out.settingsSeq } : {}) };
}
