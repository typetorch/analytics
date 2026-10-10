/** Why a server needs a look: fleet/health.ts, and the `reasons` on the fleet API's server rows. */
import { describe, expect, test } from "bun:test";
import { openSqlite } from "../src/fleet/db.ts";
import { HIGH_MEMORY_MB, healthReasons, LOW_TPS, STALE_AFTER_MS } from "../src/fleet/health.ts";
import { FleetService } from "../src/fleet/service.ts";

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const healthy = { health: "ok", tps: 59.9, memMb: 900, lastSeen: NOW - 20_000 };

describe("healthReasons", () => {
	test("a healthy server has none; unknown readings are not reasons", () => {
		expect(healthReasons(healthy, NOW)).toEqual([]);
		expect(healthReasons({ health: null, tps: null, memMb: null, lastSeen: NOW }, NOW)).toEqual([]);
		// Exactly on the line is not over it.
		expect(healthReasons({ ...healthy, tps: LOW_TPS, memMb: HIGH_MEMORY_MB, lastSeen: NOW - STALE_AFTER_MS }, NOW)).toEqual([]);
	});

	test("the kernel's health word", () => {
		for (const h of ["degraded", "failed", "unverified"]) {
			expect(healthReasons({ ...healthy, health: h }, NOW)).toEqual([{ signal: "health", label: "Kernel health", value: h, threshold: "ok", unit: null, op: "!=" }]);
		}
	});

	test("TPS under the line, rounded away from it", () => {
		expect(healthReasons({ ...healthy, tps: 31.27 }, NOW)).toEqual([{ signal: "tps", label: "TPS", value: 31.2, threshold: LOW_TPS, unit: "TPS", op: "<" }]);
		expect(healthReasons({ ...healthy, tps: 49.96 }, NOW)[0]?.value).toBe(49.9);
	});

	test("memory over the line", () => {
		expect(healthReasons({ ...healthy, memMb: 3000.2 }, NOW)).toEqual([{ signal: "memory", label: "Memory", value: 3001, threshold: HIGH_MEMORY_MB, unit: "MB", op: ">" }]);
	});

	test("a late heartbeat, but not for a server that closed", () => {
		expect(healthReasons({ ...healthy, lastSeen: NOW - 80_000 }, NOW)).toEqual([{ signal: "heartbeat", label: "Heartbeat age", value: 80, threshold: STALE_AFTER_MS / 1000, unit: "s", op: ">" }]);
		expect(healthReasons({ ...healthy, lastSeen: NOW - 80_000, closed: true }, NOW)).toEqual([]);
	});

	test("several at once, the kernel's first", () => {
		const r = healthReasons({ health: "degraded", tps: 20, memMb: 3500, lastSeen: NOW - 100_000 }, NOW);
		expect(r.map((x) => x.signal)).toEqual(["health", "heartbeat", "tps", "memory"]);
	});
});

describe("reasons on the fleet API's server rows", () => {
	test("servers() and server() carry them, computed with the row", async () => {
		let now = NOW;
		const service = await FleetService.open({ db: await openSqlite(":memory:"), clock: () => now });
		const beat = (j: string, over: Record<string, unknown> = {}) => ({ j, t: "public", b: "prod", n: 3, m: 10, v: "0.4.2", q: 1, g: 1, h: "ok", sv: 2, pf: { a: 59.8, m: 55, p: 60 }, bu: { p: 3, mem: { t: 800, h: 100 } }, ...over });
		await service.heartbeat(beat("job-ok"));
		await service.heartbeat(beat("job-sick", { h: "degraded", e: "boom", pf: { a: 42.5, m: 30, p: 60 }, bu: { p: 3, mem: { t: 3400, h: 900 } } }));
		const { servers } = await service.servers();
		const by = new Map(servers.map((s) => [s.job, s]));
		expect(by.get("job-ok")?.reasons).toEqual([]);
		expect(by.get("job-sick")?.reasons?.map((r) => [r.signal, r.value, r.threshold])).toEqual([
			["health", "degraded", "ok"],
			["tps", 42.5, LOW_TPS],
			["memory", 3400, HIGH_MEMORY_MB],
		]);
		// 80 s later (not lost yet): the heartbeat is late on the server page too.
		now = NOW + 80_000;
		const { server } = await service.server("job-ok");
		expect(server?.reasons).toEqual([{ signal: "heartbeat", label: "Heartbeat age", value: 80, threshold: 75, unit: "s", op: ">" }]);
		await service.close();
	});
});
