/**
 * Identity helpers for the server: the backfill from the game's DataStore links (`TypeTorchAnalytics` / `p/<UserId>`
 * -> { pid, first, last }) for players who joined before identity rows existed. Needs an Open Cloud key with
 * universe-datastores.objects:list and :read on the game's universe.
 */
import type { IdentityStore } from "../fleet/identity.ts";
import { getDataStoreEntry, listDataStoreEntries } from "../opencloud.ts";
import { PID_DATASTORE, pidFromLink } from "./erasure.ts";

export interface BackfillOptions {
	apiKey: string;
	universeId: number;
	store: IdentityStore;
	/** Continue a previous run (its nextPageToken). */
	pageToken?: string;
	/** Most links read in this call (default 200: each one is a DataStore read). */
	maxEntries?: number;
	clock: () => number;
	fetch?: typeof fetch;
}

export interface BackfillResult {
	/** Links listed. */
	scanned: number;
	/** Identities written. */
	added: number;
	/** UserIds already known (not read again). */
	known: number;
	/** More links to read: call again with this token. */
	nextPageToken?: string;
}

export async function backfillIdentities(o: BackfillOptions): Promise<BackfillResult> {
	const max = Math.min(2000, Math.max(1, o.maxEntries ?? 200));
	const base = { apiKey: o.apiKey, universeId: o.universeId, dataStore: PID_DATASTORE, ...(o.fetch ? { fetch: o.fetch } : {}) };
	const out: BackfillResult = { scanned: 0, added: 0, known: 0 };
	let pageToken = o.pageToken;
	while (out.scanned < max) {
		const page = await listDataStoreEntries({ ...base, prefix: "p/", maxPageSize: Math.min(100, max - out.scanned), ...(pageToken ? { pageToken } : {}) });
		for (const id of page.ids) {
			const match = /^p\/(\d{1,16})$/.exec(id);
			if (!match) continue;
			out.scanned++;
			const uid = Number(match[1]);
			if ((await o.store.byUid(uid)).length) {
				out.known++;
				continue;
			}
			const value = await getDataStoreEntry({ ...base, entry: id });
			const pid = pidFromLink(value);
			if (!pid) continue;
			const link = (typeof value === "object" && value !== null ? value : {}) as { first?: unknown; last?: unknown };
			const seconds = typeof link.last === "number" && link.last > 0 ? link.last : typeof link.first === "number" && link.first > 0 ? link.first : 0;
			out.added += await o.store.upsert([{ pid, uid, t: seconds ? seconds * 1000 : o.clock() }]);
		}
		pageToken = page.nextPageToken;
		if (!pageToken) break;
	}
	if (pageToken) out.nextPageToken = pageToken;
	return out;
}
