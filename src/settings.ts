/**
 * The game's analytics settings: the `analytics` field of the game's signed settings record (kernel 0.3.8, TypeTorch
 * plans/20; DataStore TypeTorch / settings), read by game servers. Since CLI 0.9 (plans/21 B) the game's own TypeTorch
 * CLI writes it, with the record's `backend` section, through `typetorch backend setup` (`writeBackendSettings` runs
 * it), signed with the game's two prod keys. Updating it needs no place publish: servers re-read it within seconds
 * (ping) or a minute. Read tokens (Basin SQL, the server's admin token) never go here: only the write-only key.
 * `validateSettings` still checks the shape (the server's /v1/settings answers with it).
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

export interface WriteBackendSettingsOptions extends TypeTorchCliOptions {
	/** The backend's public https base URL (this server, or its tunnel). */
	url: string;
	/** The backend's API key (TYPETORCH_API_KEY, the game key). Goes to the CLI through its environment only. */
	apiKey: string;
	/** The backend's admin token (TYPETORCH_ADMIN_TOKEN): the CLI checks it and sends the owner list with it. Environment only. */
	adminToken: string;
	/** Seconds between analytics sends (5-300). */
	flushSeconds?: number;
	/** Share (0-1) of new players whose first session is recorded in detail. */
	recordShare?: number;
	/** Don't ping servers (they still read the record within about a minute). */
	noPing?: boolean;
	/**
	 * `--force`: write it although the CLI's endpoint checks failed (the URL, GET /healthz), and replace a record the
	 * game's keys didn't sign. The CLI never lets the admin token into the record, --force or not.
	 */
	force?: boolean;
}

export interface WriteBackendSettingsResult {
	/** True when the CLI wrote the record (false when it already held this backend). */
	written: boolean;
	/** The settings record's seq after the call. */
	seq?: number;
	/** True when the CLI pinged running servers. */
	pinged?: boolean;
	/** The owner list sent to the backend (PUT /v1/access): the CLI's outcome, no secrets. */
	owners?: Record<string, unknown>;
}

/**
 * Points the game at a backend (TypeTorch plans/21 B): runs `typetorch backend setup --url <url>` in the game folder
 * (CLI 0.9+) with the API key and the admin token in the CLI's environment (TYPETORCH_API_KEY, TYPETORCH_ADMIN_TOKEN;
 * never argv). The CLI checks the address and both keys (URL, GET /healthz, GET /v1/auth/check: role game for the key,
 * role admin for the token), writes the signed record's backend section (and, for kernels before 0.4, the old fleet and
 * analytics sections from it), pings servers, sends the owner list to the backend and sets typetorch.json backend.url.
 * It refuses a broken address or key (this throws with its message and the fix) unless `force`.
 */
export async function writeBackendSettings(options: WriteBackendSettingsOptions): Promise<WriteBackendSettingsResult> {
	if (!/^https:\/\//.test(options.url)) throw new Error("the backend URL must be https");
	if (options.flushSeconds !== undefined) checkNumber(options.flushSeconds, "flushSeconds", 5, 300);
	if (options.recordShare !== undefined) checkNumber(options.recordShare, "recordShare", 0, 1);
	const args = [
		"backend",
		"setup",
		"--url",
		options.url,
		...(options.flushSeconds !== undefined ? ["--flush-seconds", String(options.flushSeconds)] : []),
		...(options.recordShare !== undefined ? ["--record-share", String(options.recordShare)] : []),
		...(options.noPing ? ["--no-ping"] : []),
		...(options.force ? ["--force"] : []),
	];
	const out = await runTypeTorch(options, args, { env: { TYPETORCH_API_KEY: options.apiKey, TYPETORCH_ADMIN_TOKEN: options.adminToken } });
	const result: WriteBackendSettingsResult = { written: out.outcome === "written" };
	if (typeof out.settingsSeq === "number") result.seq = out.settingsSeq;
	if (out.pinged === true) result.pinged = true;
	if (typeof out.owners === "object" && out.owners !== null) result.owners = out.owners as Record<string, unknown>;
	return result;
}
