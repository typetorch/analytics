/**
 * Why a live server needs a look: the signals behind its Health badge, each with its reading and the line it crossed.
 * Computed with the rest of the server's payload (`serverInfo` in service.ts), so the list and the status can't drift.
 *
 * The `health` word itself is the kernel's (heartbeat `h`): "degraded" means a deploy failed there, or the running
 * generation failed its check or keeps erroring (kernel Health.state); "failed" means nothing runs; "unverified" is the
 * boot fail-safe. The heartbeat carries no error counts, so that reason names the state and the server's last error
 * (`lastError`) explains it. The other signals are the readings the explorer already flags: TPS under LOW_TPS, memory
 * over HIGH_MEMORY_MB (the explorer's Fleet page and its perf rules use the same lines), and a heartbeat older than
 * STALE_AFTER_MS (heartbeats come about every 60 s; past LOST_AFTER_MS the server counts as lost).
 */

/** Below this average TPS a server runs slow (a healthy one runs at 60). Same line as the explorer's LOW_TPS. */
export const LOW_TPS = 50;
/** Above this total memory (MB) a server is in trouble. Same line as the explorer's HIGH_MEMORY_MB. */
export const HIGH_MEMORY_MB = 3000;
/** A heartbeat older than this is late (they come about every 60 s; a server is lost after 90 s). */
export const STALE_AFTER_MS = 75_000;

export type HealthSignal = "health" | "tps" | "memory" | "heartbeat";

export interface HealthReason {
	signal: HealthSignal;
	/** A short plain label: "Kernel health", "TPS", "Memory", "Heartbeat age". */
	label: string;
	/** The reading: a number, or the kernel's health word. */
	value: number | string;
	/** The line it crossed: a number, or "ok" for the kernel's health. */
	threshold: number | string;
	/** "TPS", "MB", "s", or null for the kernel's health. */
	unit: string | null;
	/** How it compares: under ("<"), over (">"), or not equal ("!=") for the kernel's health. */
	op: "<" | ">" | "!=";
}

export interface HealthInput {
	health: string | null;
	tps: number | null;
	memMb: number | null;
	/** Unix ms of the last heartbeat. */
	lastSeen: number;
	/** The server said it closed: it sends no more heartbeats, so their age is no reason. */
	closed?: boolean;
}

const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v);
// Rounded away from the line, so a shown reading never looks like it sits on it (49.96 -> 49.9, 3000.2 -> 3001).
const floor1 = (v: number) => Math.floor(v * 10) / 10;

/** The signals that tripped for one server, most important first; a healthy server has none. */
export function healthReasons(s: HealthInput, now: number): HealthReason[] {
	const out: HealthReason[] = [];
	if (s.health && s.health !== "ok") out.push({ signal: "health", label: "Kernel health", value: s.health, threshold: "ok", unit: null, op: "!=" });
	const age = now - s.lastSeen;
	if (!s.closed && age > STALE_AFTER_MS) out.push({ signal: "heartbeat", label: "Heartbeat age", value: Math.ceil(age / 1000), threshold: STALE_AFTER_MS / 1000, unit: "s", op: ">" });
	if (known(s.tps) && s.tps < LOW_TPS) out.push({ signal: "tps", label: "TPS", value: floor1(s.tps), threshold: LOW_TPS, unit: "TPS", op: "<" });
	if (known(s.memMb) && s.memMb > HIGH_MEMORY_MB) out.push({ signal: "memory", label: "Memory", value: Math.ceil(s.memMb), threshold: HIGH_MEMORY_MB, unit: "MB", op: ">" });
	return out;
}
