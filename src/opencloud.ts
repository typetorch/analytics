/**
 * The few Roblox Open Cloud calls this package makes (fetch only; the API key goes only into `x-api-key` and is never
 * logged or put in an error message):
 *   - configs (ConfigService), write only: PATCH the draft with one key, then publish. Scope universe:write.
 *     Reading back is impossible for API keys (universe:read is OAuth-only), so nothing here reads configs.
 *   - DataStore entries (v2): read `TypeTorchAnalytics` / `p/<UserId>` to map an erasure request's UserId to a pid.
 *     Scope universe-datastores.objects:read (and :delete to remove the link).
 */
export const OPEN_CLOUD = "https://apis.roblox.com";

export class OpenCloudError extends Error {
	override name = "OpenCloudError";
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface OpenCloudOptions {
	apiKey: string;
	fetch?: typeof fetch;
	/** Base URL override (tests). */
	base?: string;
	timeoutMs?: number;
}

async function call(options: OpenCloudOptions, method: string, path: string, body?: unknown): Promise<{ status: number; body: unknown; text: string }> {
	if (!options.apiKey) throw new Error("an Open Cloud API key is required");
	const doFetch = options.fetch ?? fetch;
	const headers: Record<string, string> = { "x-api-key": options.apiKey };
	if (body !== undefined) headers["content-type"] = "application/json";
	let lastError: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await doFetch(`${options.base ?? OPEN_CLOUD}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
			});
			const text = await response.text();
			let parsed: unknown;
			try {
				parsed = text ? JSON.parse(text) : undefined;
			} catch {
				parsed = undefined;
			}
			// Retry only reads on 429/5xx (writes could apply twice).
			if (method === "GET" && attempt < 3 && (response.status === 429 || response.status >= 500)) {
				await new Promise((done) => setTimeout(done, 500 * attempt));
				continue;
			}
			return { status: response.status, body: parsed, text };
		} catch (error) {
			lastError = error;
			if (method !== "GET") break;
			await new Promise((done) => setTimeout(done, 500 * attempt));
		}
	}
	throw new OpenCloudError(`${method} ${path} failed: ${(lastError as Error)?.message ?? lastError}`, 0);
}

function fail(method: string, path: string, status: number, text: string, scope: string): never {
	const hint = status === 401 || status === 403 ? ` (the API key needs ${scope})` : "";
	throw new OpenCloudError(`${method} ${path} -> ${status}${hint}: ${text.replace(/\s+/g, " ").slice(0, 300)}`, status);
}

function record(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// ConfigService (configs API) -------------------------------------------------------------------------------------------

export const CONFIG_REPOSITORY = "InExperienceConfig";

export interface PublishResult {
	/** True once the publish call succeeded. */
	published: true;
	configVersion?: number;
}

/**
 * Sets ONE key in the experience's ConfigService and publishes it. PATCHes the draft with only that key (never
 * `draft:overwrite`, which would wipe the game's other keys), then publishes the draft. Needs universe:write only.
 * Note: the publish ships the whole draft; unpublished edits someone else made to other keys go live with it (an
 * API key can't read the draft to check).
 */
export async function publishConfigKey(options: OpenCloudOptions & { universeId: number; key: string; value: unknown; message: string }): Promise<PublishResult> {
	if (!Number.isSafeInteger(options.universeId) || options.universeId <= 0) throw new Error("universeId must be a positive integer");
	const base = `/creator-configs-public-api/v1/configs/universes/${options.universeId}/repositories/${CONFIG_REPOSITORY}`;
	const patch = await call(options, "PATCH", `${base}/draft`, { entries: { [options.key]: options.value } });
	if (patch.status < 200 || patch.status >= 300) fail("PATCH", `${base}/draft`, patch.status, patch.text, "universe:write");
	const draftHash = record(patch.body).draftHash;
	const body: Record<string, unknown> = { message: options.message.slice(0, 200), deploymentStrategy: "Immediate" };
	if (typeof draftHash === "string" && draftHash) body.draftHash = draftHash;
	const publish = await call(options, "POST", `${base}/publish`, body);
	if (publish.status < 200 || publish.status >= 300) fail("POST", `${base}/publish`, publish.status, publish.text, "universe:write");
	const version = record(publish.body).configVersion;
	return typeof version === "number" ? { published: true, configVersion: version } : { published: true };
}

// DataStore entries (v2) ------------------------------------------------------------------------------------------------

function entryPath(universeId: number, dataStore: string, entry: string, scope?: string): string {
	const ds = encodeURIComponent(dataStore);
	const scopePart = scope ? `/scopes/${encodeURIComponent(scope)}` : "";
	return `/cloud/v2/universes/${universeId}/data-stores/${ds}${scopePart}/entries/${encodeURIComponent(entry)}`;
}

/** A DataStore entry's value, or undefined when it doesn't exist (404). */
export async function getDataStoreEntry(options: OpenCloudOptions & { universeId: number; dataStore: string; entry: string; scope?: string }): Promise<unknown> {
	const path = entryPath(options.universeId, options.dataStore, options.entry, options.scope);
	const response = await call(options, "GET", path);
	if (response.status === 404) return undefined;
	if (response.status < 200 || response.status >= 300) fail("GET", path, response.status, response.text, "universe-datastores.objects:read");
	return record(response.body).value;
}

/** Deletes a DataStore entry (404 counts as done). */
export async function deleteDataStoreEntry(options: OpenCloudOptions & { universeId: number; dataStore: string; entry: string; scope?: string }): Promise<void> {
	const path = entryPath(options.universeId, options.dataStore, options.entry, options.scope);
	const response = await call(options, "DELETE", path);
	if (response.status === 404) return;
	if (response.status < 200 || response.status >= 300) fail("DELETE", path, response.status, response.text, "universe-datastores.objects:delete");
}

/**
 * One page of a DataStore's entry ids, optionally only those starting with `prefix` (v2 `filter: id.startsWith`).
 * Scope universe-datastores.objects:list.
 */
export async function listDataStoreEntries(
	options: OpenCloudOptions & { universeId: number; dataStore: string; prefix?: string; pageToken?: string; maxPageSize?: number },
): Promise<{ ids: string[]; nextPageToken?: string }> {
	const params = new URLSearchParams({ maxPageSize: String(Math.min(256, Math.max(1, options.maxPageSize ?? 100))) });
	if (options.prefix) params.set("filter", `id.startsWith("${options.prefix.replace(/["\\]/g, "")}")`);
	if (options.pageToken) params.set("pageToken", options.pageToken);
	const path = `/cloud/v2/universes/${options.universeId}/data-stores/${encodeURIComponent(options.dataStore)}/entries?${params.toString()}`;
	const response = await call(options, "GET", path);
	if (response.status < 200 || response.status >= 300) fail("GET", path.split("?")[0], response.status, response.text, "universe-datastores.objects:list");
	const body = record(response.body);
	const entries = Array.isArray(body.dataStoreEntries) ? body.dataStoreEntries : [];
	const ids = entries
		.map((e) => {
			const r = record(e);
			if (typeof r.id === "string") return r.id;
			return typeof r.path === "string" ? decodeURIComponent(r.path.split("/entries/")[1] ?? "") : "";
		})
		.filter((id) => id !== "");
	const next = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : undefined;
	return next ? { ids, nextPageToken: next } : { ids };
}
