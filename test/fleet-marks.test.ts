/**
 * Deploy marks for the explorer's charts: releases (POST /v1/fleet/deploy with the CLI's kind), kernel publishes and
 * backup refreshes (POST /v1/fleet/mark), read back by GET /v1/fleet/marks. All tokens are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { openSqlite } from "../src/fleet/db.ts";
import { FleetService, markTime, parseDeploy, parseMark, type FleetEvent } from "../src/fleet/service.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

async function service(clock: () => number) {
	return FleetService.open({ db: await openSqlite(":memory:"), clock });
}

describe("parsing", () => {
	test("deploy kinds, the build before, the note; marks are kernel or backup only", () => {
		expect(parseDeploy({ s: 7, b: "prod", a: "art-7", k: "rollback", fr: "art-6", m: "bad build" })).toMatchObject({ seq: 7, kind: "rollback", from: "art-6", message: "bad build" });
		expect(parseDeploy({ s: 7, b: "prod" })).toMatchObject({ kind: null, from: null, message: null });
		expect(() => parseDeploy({ s: 7, b: "prod", k: "explode" })).toThrow(/k must be one of/);
		expect(parseMark({ k: "kernel", v: "0.4.0", pv: 23 })).toMatchObject({ kind: "kernel", kernel: "0.4.0", placeVersion: 23 });
		expect(parseMark({ k: "backup", b: "prod", s: 41, a: "art-41", pv: 24 })).toMatchObject({ kind: "backup", branch: "prod", seq: 41, artifact: "art-41" });
		expect(() => parseMark({ k: "deploy", s: 1 })).toThrow(/releases go to \/v1\/fleet\/deploy/);
		expect(() => parseMark({ v: "0.4.0" })).toThrow(/k is required/);
		expect(() => parseMark({ k: "kernel", m: "x".repeat(201) })).toThrow(/at most 200/);
	});

	test("a sender's time: seconds or ms; a clock a day off is replaced by now", () => {
		expect(markTime(Math.floor(T0 / 1000) - 60, T0)).toBe(T0 - 60_000);
		expect(markTime(T0 - 5000, T0)).toBe(T0 - 5000);
		expect(markTime(T0 + 2 * DAY, T0)).toBe(T0);
		expect(markTime(null, T0)).toBe(T0);
	});
});

describe("the service", () => {
	test("releases with kinds and report results, reports-only releases inferred, kernel and backup marks, oldest first", async () => {
		let now = T0;
		const fleet = await service(() => now);
		const events: FleetEvent[] = [];
		fleet.subscribe((e) => events.push(e));
		await fleet.deploy({ s: 40, b: "prod", a: "art-40", ch: "prod", k: "deploy", t: T0 - 3 * HOUR });
		await fleet.deploy({ s: 41, b: "prod", a: "art-41", ch: "prod", k: "deploy", fr: "art-40", m: "new shop", t: T0 - 2 * HOUR });
		for (const [j, r] of [["job-1", "swapped"], ["job-2", "swapped"], ["job-3", "failed"]]) await fleet.report({ s: 41, j, r, b: "prod", a: "art-41" });
		await fleet.report({ s: 41, j: "job-3", r: "rolled_back", b: "prod", a: "art-41" }); // its newest report counts
		await fleet.deploy({ s: 42, b: "prod", a: "art-40", ch: "prod", k: "rollback", fr: "art-41", t: T0 - HOUR });
		now = T0 - 30 * MIN;
		await fleet.report({ s: 43, j: "job-9", r: "swapped", b: "dev", a: "art-43" }); // no CLI post: a release known from its report
		now = T0;
		await fleet.mark({ k: "kernel", v: "0.4.0", pv: 23, m: "kernel 0.4.0 (patch, luau)", t: T0 - 20 * MIN });
		await fleet.mark({ k: "backup", b: "prod", s: 40, a: "art-40", pv: 24, t: T0 - 10 * MIN });

		const marks = await fleet.marks({ since: T0 - DAY, until: T0 + MIN });
		expect(marks.map((m) => [m.kind, m.seq ?? m.kernel])).toEqual([
			["deploy", 40],
			["deploy", 41],
			["rollback", 42],
			["deploy", 43],
			["kernel", "0.4.0"],
			["backup", 40],
		]);
		const [, d41, rb, inferred, kernel, backup] = marks;
		expect(d41).toMatchObject({ id: "deploy:41", at: T0 - 2 * HOUR, branch: "prod", artifact: "art-41", from: "art-40", message: "new shop", results: { swapped: 2, rolled_back: 1 } });
		expect(d41.inferred).toBeUndefined();
		expect(rb).toMatchObject({ from: "art-41", artifact: "art-40", results: {} });
		expect(inferred).toMatchObject({ kind: "deploy", inferred: true, branch: "dev", at: T0 - 30 * MIN, results: { swapped: 1 } });
		expect(kernel).toMatchObject({ kernel: "0.4.0", placeVersion: 23, branch: null, at: T0 - 20 * MIN, message: "kernel 0.4.0 (patch, luau)" });
		expect(backup).toMatchObject({ branch: "prod", seq: 40, artifact: "art-40", placeVersion: 24 });
		expect(new Date(kernel.time).getTime()).toBe(kernel.at);

		// A branch keeps that branch's releases and the place-wide marks; kinds and the window filter; limit keeps the newest.
		const dev = await fleet.marks({ since: T0 - DAY, until: T0 + MIN, branch: "dev" });
		expect(dev.map((m) => m.kind)).toEqual(["deploy", "kernel", "backup"]);
		expect((await fleet.marks({ since: T0 - DAY, until: T0 + MIN, kinds: ["rollback", "kernel"] })).map((m) => m.kind)).toEqual(["rollback", "kernel"]);
		expect((await fleet.marks({ since: T0 - 90 * MIN, until: T0 - 15 * MIN })).map((m) => m.id)).toEqual(["deploy:42", "deploy:43", "mark:1"]);
		expect((await fleet.marks({ since: T0 - DAY, until: T0 + MIN, limit: 2 })).map((m) => m.kind)).toEqual(["kernel", "backup"]);
		await expect(fleet.marks({ since: T0, until: T0 - 1 })).rejects.toThrow(/before until/);
		await expect(fleet.marks({ since: T0 - 400 * DAY, until: T0 })).rejects.toThrow(/366-day/);
		await expect(fleet.marks({ kinds: ["meteor"] })).rejects.toThrow(/kinds/);

		// The SSE stream hears releases (with their kind) and marks.
		expect(events.some((e) => e.type === "deploy" && e.seq === 42 && e.kind === "rollback")).toBe(true);
		expect(events.filter((e) => e.type === "mark").map((e) => (e as Extract<FleetEvent, { type: "mark" }>).mark.kind)).toEqual(["kernel", "backup"]);
		await fleet.close();
	});

	test("a later post with the kind fills in a release first known from its reports", async () => {
		const fleet = await service(() => T0);
		await fleet.report({ s: 50, j: "job-1", r: "swapped", b: "prod", a: "art-50" });
		expect((await fleet.marks({ since: T0 - HOUR, until: T0 + MIN }))[0]).toMatchObject({ kind: "deploy", inferred: true });
		await fleet.deploy({ s: 50, b: "prod", a: "art-50", k: "promote", fr: "art-49", t: T0 - MIN });
		const [m] = await fleet.marks({ since: T0 - HOUR, until: T0 + MIN });
		expect(m).toMatchObject({ kind: "promote", from: "art-49", at: T0 - MIN });
		expect(m.inferred).toBeUndefined();
		await fleet.close();
	});

	test("a fleet file made before the release kinds gets the new columns on open", async () => {
		const db = await openSqlite(":memory:");
		await db.exec("CREATE TABLE deploys (seq INTEGER PRIMARY KEY, branch TEXT, artifact TEXT, channel TEXT, t INTEGER, received INTEGER NOT NULL, stuck_at INTEGER)");
		await db.run("INSERT INTO deploys (seq, branch, artifact, channel, t, received) VALUES (1, 'prod', 'art-1', 'prod', NULL, ?)", [T0 - HOUR]);
		const fleet = await FleetService.open({ db, clock: () => T0 });
		expect((await db.all<{ name: string }>("PRAGMA table_info(deploys)")).map((c) => c.name)).toEqual(expect.arrayContaining(["kind", "from_artifact", "message"]));
		expect(await fleet.marks({ since: T0 - DAY, until: T0 })).toMatchObject([{ id: "deploy:1", kind: "deploy", inferred: true, at: T0 - HOUR }]);
		await fleet.close();
	});

	test("marks are kept a year", async () => {
		let now = T0;
		const fleet = await service(() => now);
		await fleet.mark({ k: "kernel", v: "0.3.9" });
		now = T0 + 366 * DAY;
		await fleet.sweep();
		expect(await fleet.marks({ since: T0 - DAY, until: T0 + DAY })).toEqual([]);
		await fleet.close();
	});
});

describe("over HTTP", () => {
	let h: Harness;
	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet" });
	});
	afterAll(async () => {
		await h.close();
	});

	test("the CLI posts with the game key; the explorer reads with the admin token", async () => {
		expect((await h.call("/v1/fleet/deploy", post(API, { j: "cli", s: 60, b: "prod", a: "art-60", ch: "prod", k: "deploy", t: T0 - MIN }))).status).toBe(202);
		expect((await h.call("/v1/fleet/mark", post(API, { j: "cli", k: "kernel", v: "0.4.0", pv: 23, t: T0 }))).status).toBe(202);
		expect((await h.call("/v1/fleet/mark", post(API, { j: "cli", k: "nope" }))).status).toBe(400);
		expect((await h.call("/v1/fleet/mark", post(ADMIN, { j: "cli", k: "kernel" }))).status).toBe(401);
		const res = await h.call(`/v1/fleet/marks?since=${T0 - HOUR}&until=${T0 + MIN}`, { headers: bearer(ADMIN) });
		expect(res.status).toBe(200);
		const body = await asJson(res);
		expect(body.marks.map((m: { kind: string }) => m.kind)).toEqual(["deploy", "kernel"]);
		// The explorer's /api prefix, ISO times and filters.
		const iso = await asJson(await h.call(`/api/v1/fleet/marks?since=${new Date(T0 - HOUR).toISOString()}&kinds=kernel&branch=dev`, { headers: bearer(ADMIN) }));
		expect(iso.marks.map((m: { kind: string }) => m.kind)).toEqual(["kernel"]);
		expect((await h.call("/v1/fleet/marks", { headers: bearer(API) })).status).toBe(401);
		expect((await h.call("/v1/fleet/marks?since=yesterday", { headers: bearer(ADMIN) })).status).toBe(400);
		expect((await h.call("/v1/fleet/marks?limit=x", { headers: bearer(ADMIN) })).status).toBe(400);
		// The bus' live subscriber (queued) took the mark without trouble.
		await h.app.bus.idle(2000);
		const health = await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }));
		expect(JSON.stringify(health)).not.toMatch(/"failed":[1-9]/);
	});

	test("mark posts are rate limited per sender like deploy starts", async () => {
		const statuses: number[] = [];
		for (let i = 0; i < 32; i++) statuses.push((await h.call("/v1/fleet/mark", post(API, { j: "cli", k: "backup", s: i }))).status);
		expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
	});
});
