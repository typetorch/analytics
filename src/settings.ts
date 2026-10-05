/**
 * The game's analytics settings: the server-only ConfigService key `TypeTorchAnalytics` (repository
 * InExperienceConfig), read in-engine by game servers (no scope needed there) and written by `writeSettings` through
 * Open Cloud (universe:write). Updating it needs no place publish. Read tokens (Basin SQL, the server's admin token)
 * never go here: only the write-only ingest/send token.
 */
import { publishConfigKey, type OpenCloudOptions, type PublishResult } from "./opencloud.ts";
import { SAFE_KEY } from "./sql/dialect.ts";

export const SETTINGS_KEY = "TypeTorchAnalytics";
/** The configs API limits a value to 10,000 characters. */
export const MAX_SETTINGS_CHARS = 9_500;

export interface ExperimentSetting {
	/** Variant names, e.g. ["short", "long"]. */
	variants: string[];
	/** Percent per variant (same order, sums to 100). Default: equal. */
	split?: number[];
	/** false stops assigning (everyone gets the first variant). Default true. */
	on?: boolean;
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
	/** The fleet API's base URL (heartbeats, deploy reports, alerts), when the game uses it. */
	fleet?: string;
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
	if (raw.flushSeconds !== undefined) out.flushSeconds = checkNumber(raw.flushSeconds, "flushSeconds", 2, 300);
	if (raw.recordShare !== undefined) out.recordShare = checkNumber(raw.recordShare, "recordShare", 0, 1);
	if (raw.techEvery !== undefined) out.techEvery = checkNumber(raw.techEvery, "techEvery", 5, 3600);
	if (raw.fleet !== undefined) out.fleet = checkUrl(raw.fleet, "fleet");
	if (raw.experiments !== undefined) {
		if (typeof raw.experiments !== "object" || raw.experiments === null || Array.isArray(raw.experiments)) throw new Error("experiments must be an object");
		out.experiments = {};
		for (const [name, value] of Object.entries(raw.experiments as Record<string, unknown>)) {
			if (!SAFE_KEY.test(name)) throw new Error(`experiment name ${JSON.stringify(name)}: letters, digits, _ - . only`);
			const e = value as Record<string, unknown>;
			if (!Array.isArray(e?.variants) || e.variants.length < 2 || e.variants.length > 10 || e.variants.some((v) => typeof v !== "string" || !SAFE_KEY.test(v))) {
				throw new Error(`experiment ${name}: variants must be 2-10 names (letters, digits, _ - .)`);
			}
			if (new Set(e.variants).size !== e.variants.length) throw new Error(`experiment ${name}: variant names must differ`);
			const setting: ExperimentSetting = { variants: [...(e.variants as string[])] };
			if (e.split !== undefined) {
				if (!Array.isArray(e.split) || e.split.length !== setting.variants.length || e.split.some((p) => typeof p !== "number" || p < 0)) {
					throw new Error(`experiment ${name}: split needs one percent per variant`);
				}
				const sum = (e.split as number[]).reduce((s, p) => s + p, 0);
				if (Math.abs(sum - 100) > 1e-9) throw new Error(`experiment ${name}: split must add up to 100`);
				setting.split = [...(e.split as number[])];
			}
			if (e.on !== undefined) {
				if (typeof e.on !== "boolean") throw new Error(`experiment ${name}: on must be true or false`);
				setting.on = e.on;
			}
			out.experiments[name] = setting;
		}
	}
	const size = JSON.stringify(out).length;
	if (size > MAX_SETTINGS_CHARS) throw new Error(`settings are ${size} characters; ConfigService allows about ${MAX_SETTINGS_CHARS}`);
	return out;
}

export interface WriteSettingsOptions extends OpenCloudOptions {
	universeId: number;
	settings: AnalyticsSettings;
	/** The publish message (shown in Creator Hub's config history). */
	message?: string;
	/** Validate and return the value without calling Open Cloud. */
	dryRun?: boolean;
}

export interface WriteSettingsResult {
	value: AnalyticsSettings;
	/** True when the publish call succeeded (false on a dry run). Nothing is read back: API keys can't read configs. */
	published: boolean;
	configVersion?: number;
}

/**
 * Writes the `TypeTorchAnalytics` key and publishes it (Open Cloud, universe:write). Write-only by design: the draft
 * gets only this key, then the draft is published.
 */
export async function writeSettings(options: WriteSettingsOptions): Promise<WriteSettingsResult> {
	const value = validateSettings(options.settings);
	if (options.dryRun) return { value, published: false };
	const result: PublishResult = await publishConfigKey({ ...options, key: SETTINGS_KEY, value, message: options.message ?? "TypeTorch analytics settings" });
	return { value, published: true, ...(result.configVersion !== undefined ? { configVersion: result.configVersion } : {}) };
}
