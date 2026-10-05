/**
 * Right to Erasure. Roblox posts a webhook (Creator Hub > Webhooks, event "Right to erasure request") with
 *   header  roblox-signature: t=<unix seconds>,v1=<base64 HMAC-SHA256(secret, "<t>.<raw body>")>
 *   body    { NotificationId, EventType: "RightToErasureRequest", EventTime, EventPayload: { UserId, GameIds } }
 * (create.roblox.com/docs/cloud/webhooks/webhook-notifications). Events carry a random pid, never the UserId, so the
 * server maps UserId -> pid by reading the game's DataStore entry `TypeTorchAnalytics` / `p/<UserId>` through Open
 * Cloud (API key with universe-datastores.objects:read, plus :delete when TT_ANALYTICS_ERASURE_DELETE_LINK=1), then
 * deletes that pid's rows. The game side deletes the link too; whichever runs second finds nothing, which is fine.
 * The log keeps the notification id, time and outcome, never the UserId.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deleteDataStoreEntry, getDataStoreEntry } from "../opencloud.ts";

export const PID_DATASTORE = "TypeTorchAnalytics";
export const pidEntry = (userId: number) => `p/${userId}`;
/** Signatures older or newer than this are refused (Roblox suggests about 10 minutes). */
export const SIGNATURE_WINDOW_SECONDS = 600;

export type SignatureCheck = { ok: true; t: number } | { ok: false; reason: string };

/** Verifies a `roblox-signature` header against the raw body. */
export function verifyRobloxSignature(header: string | null, rawBody: string, secret: string, nowMs: number): SignatureCheck {
	if (!header) return { ok: false, reason: "no roblox-signature header" };
	let t: number | undefined;
	const signatures: string[] = [];
	for (const part of header.split(",")) {
		const [key, ...rest] = part.trim().split("=");
		const value = rest.join("=");
		if (key === "t") t = Number(value);
		else if (key === "v1" && value) signatures.push(value);
	}
	if (t === undefined || !Number.isFinite(t)) return { ok: false, reason: "no timestamp" };
	if (Math.abs(nowMs / 1000 - t) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: "timestamp outside the 10 minute window" };
	if (!signatures.length) return { ok: false, reason: "no v1 signature (is a secret set on the webhook?)" };
	const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
	for (const sig of signatures) {
		const given = Buffer.from(sig, "base64");
		if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true, t };
	}
	return { ok: false, reason: "signature mismatch" };
}

export interface ErasureRequest {
	notificationId: string;
	eventType: string;
	userId?: number;
	gameIds: number[];
}

export function parseErasureBody(body: unknown): ErasureRequest {
	const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const payload = (typeof b.EventPayload === "object" && b.EventPayload !== null ? b.EventPayload : {}) as Record<string, unknown>;
	const userId = typeof payload.UserId === "number" && Number.isSafeInteger(payload.UserId) && payload.UserId > 0 ? payload.UserId : undefined;
	return {
		notificationId: typeof b.NotificationId === "string" ? b.NotificationId.slice(0, 100) : "",
		eventType: typeof b.EventType === "string" ? b.EventType : "",
		...(userId !== undefined ? { userId } : {}),
		gameIds: Array.isArray(payload.GameIds) ? payload.GameIds.filter((g): g is number => typeof g === "number") : [],
	};
}

/** The pid inside a DataStore link value: a plain string, or an object with `pid`. */
export function pidFromLink(value: unknown): string | undefined {
	if (typeof value === "string") return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : undefined;
	if (typeof value === "object" && value !== null && typeof (value as { pid?: unknown }).pid === "string") return pidFromLink((value as { pid: string }).pid);
	return undefined;
}

export interface LookupConfig {
	apiKey: string;
	universeId: number;
	deleteLink: boolean;
	fetch?: typeof fetch;
}

/** UserId -> pid through the game's DataStore (and deletes the link when configured). */
export async function lookupPid(config: LookupConfig, userId: number): Promise<string | undefined> {
	const options = { apiKey: config.apiKey, universeId: config.universeId, dataStore: PID_DATASTORE, entry: pidEntry(userId), ...(config.fetch ? { fetch: config.fetch } : {}) };
	const pid = pidFromLink(await getDataStoreEntry(options));
	if (config.deleteLink) await deleteDataStoreEntry(options);
	return pid;
}

/** Appends one line to data/erasure/log.jsonl (no UserId). */
export function logErasure(dir: string, entry: Record<string, unknown>): void {
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
}
