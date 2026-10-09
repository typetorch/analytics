/**
 * Plans/25 "Instant wake": a watch that starts on a server that isn't polling publishes one wake message through Open
 * Cloud Messaging (a fake Open Cloud here), rate-limited per job and in all; no key = no publish; the key never shows up
 * in a log line or a response. Keys and tokens are made up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { RemoteDebugWaker, WAKE_JOB_GAP_MS, WAKE_PER_MINUTE, WAKE_SHOWN_MS, WAKE_TOPIC, wakeMessage } from "../src/fleet/remote-debug-wake.ts";
import { WATCH_MS } from "../src/fleet/remote-debug.ts";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API, asJson, bearer, harness, post, T0, type Harness } from "./harness.ts";

const KEY = "messaging-key-for-tests-ONLY-publish-0123456789abcdef";
const UNIVERSE = 4242;

interface Sent {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: { topic?: string; message?: string };
}

/** A fake Open Cloud: records each request; `answer` decides the reply (default 200 {}). */
function fakeOpenCloud() {
	const sent: Sent[] = [];
	const state: { answer: (req: Sent) => Response | Promise<Response> } = { answer: () => new Response("{}", { status: 200 }) };
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const req: Sent = {
			url: String(input),
			method: init?.method ?? "GET",
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
			body: init?.body ? JSON.parse(String(init.body)) : {},
		};
		sent.push(req);
		return state.answer(req);
	}) as typeof fetch;
	return { sent, state, fetch: fetchFn };
}

const hb = (h: Harness, j: string) => ({ j, t: "public", b: "prod", c: "prod", a: "art-1", n: 3, m: 20, s: Math.floor((h.now() - 3_600_000) / 1000), u: Math.floor(h.now() / 1000), p: 1001, v: "0.5.1", q: 7, g: 2, h: "ok", sv: 2 });
const heartbeat = (h: Harness, j: string) => h.call("/v1/fleet/heartbeat", post(API, hb(h, j)));
const admin = (h: Harness, path: string, init: RequestInit = {}) => h.call(path, { ...init, headers: { ...bearer(ADMIN), "content-type": "application/json", ...(init.headers as Record<string, string>) } });
const watch = (h: Harness, job: string) => admin(h, `/v1/fleet/servers/${job}/watch`, { method: "POST" });
const poll = (h: Harness, job: string) => h.call("/v1/fleet/commands?wait=0", { headers: { ...bearer(API), "x-tt-job": job } });

describe("with TYPETORCH_MESSAGING_KEY and TYPETORCH_UNIVERSE_ID", () => {
	let h: Harness;
	const oc = fakeOpenCloud();
	/** Every response body the tests read, to check the key never appears. */
	const bodies: string[] = [];
	const read = async (res: Response) => {
		const text = await res.text();
		bodies.push(text);
		return JSON.parse(text) as Record<string, any>;
	};

	beforeAll(async () => {
		h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_MESSAGING_KEY: KEY, TYPETORCH_UNIVERSE_ID: String(UNIVERSE) }, { fetch: oc.fetch });
	});
	afterAll(async () => {
		await h.close();
	});

	test("the startup line says wake is on (no key in it)", () => {
		expect(h.logs.some((l) => l.startsWith("remote debug wake is on") && l.includes(String(UNIVERSE)) && l.includes(WAKE_TOPIC))).toBe(true);
	});

	test("a watch that starts on a server that isn't polling publishes one wake through Open Cloud Messaging", async () => {
		await heartbeat(h, "wake-1");
		const w = await read(await watch(h, "wake-1"));
		expect(w).toMatchObject({ job: "wake-1", watched: true, connected: false, wake: true });
		await h.app.waker!.idle();
		expect(oc.sent).toHaveLength(1);
		const req = oc.sent[0];
		expect(req.method).toBe("POST");
		expect(req.url).toBe(`https://apis.roblox.com/cloud/v2/universes/${UNIVERSE}:publishMessage`);
		expect(req.headers["x-api-key"]).toBe(KEY);
		expect(req.headers["content-type"]).toBe("application/json");
		expect(req.body).toEqual({ topic: "TypeTorch/deploy", message: JSON.stringify({ k: "rd", j: "wake-1" }) });
		expect(new TextEncoder().encode(req.body.message).length).toBeLessThan(1024);
		// The heartbeat path still works next to it.
		expect(await read(await heartbeat(h, "wake-1"))).toEqual({ ok: true, rd: 1 });
	});

	test("the page's 20 s repeats don't publish again; the reply keeps saying wake until the server polls", async () => {
		h.setNow(T0 + 20_000);
		expect(await read(await watch(h, "wake-1"))).toMatchObject({ watched: true, connected: false, wake: true });
		await h.app.waker!.idle();
		expect(oc.sent).toHaveLength(1);
		// The kernel polls: connected, so no more "Waking server...".
		await poll(h, "wake-1");
		expect(await read(await watch(h, "wake-1"))).toMatchObject({ connected: true, wake: false });
		h.setNow(T0);
	});

	test("a server that is already polling gets no wake", async () => {
		await heartbeat(h, "polling-1");
		await poll(h, "polling-1");
		expect(await read(await watch(h, "polling-1"))).toMatchObject({ watched: true, connected: true, wake: false });
		await h.app.waker!.idle();
		expect(oc.sent.filter((r) => r.body.message?.includes("polling-1"))).toHaveLength(0);
	});

	test("a watch that lapsed and starts again wakes again", async () => {
		h.setNow(T0 + WATCH_MS + 60_000);
		await heartbeat(h, "wake-1");
		expect(await read(await watch(h, "wake-1"))).toMatchObject({ watched: true, connected: false, wake: true });
		await h.app.waker!.idle();
		expect(oc.sent.filter((r) => r.body.message?.includes("wake-1"))).toHaveLength(2);
		h.setNow(T0);
	});

	test(`at most ${WAKE_PER_MINUTE} wakes a minute in all; the rest keep the heartbeat path`, async () => {
		h.setNow(T0 + 10 * 60_000);
		const before = oc.sent.length;
		const replies: Record<string, any>[] = [];
		for (let i = 0; i < WAKE_PER_MINUTE + 3; i++) {
			await heartbeat(h, `burst-${i}`);
			replies.push(await read(await watch(h, `burst-${i}`)));
		}
		await h.app.waker!.idle();
		expect(oc.sent.length - before).toBe(WAKE_PER_MINUTE);
		expect(replies.filter((r) => r.wake === true)).toHaveLength(WAKE_PER_MINUTE);
		expect(replies.every((r) => r.watched === true)).toBe(true);
		expect(h.logs.filter((l) => l.includes("wakes went out in the last minute"))).toHaveLength(1);
		// A minute later there is room again.
		h.setNow(T0 + 11 * 60_000 + 1);
		await heartbeat(h, "after-burst");
		expect(await read(await watch(h, "after-burst"))).toMatchObject({ wake: true });
		await h.app.waker!.idle();
		expect(oc.sent.length - before).toBe(WAKE_PER_MINUTE + 1);
		h.setNow(T0);
	});

	test("a refused publish is logged without the key and never breaks the watch", async () => {
		h.setNow(T0 + 20 * 60_000);
		// Even a reply that echoes the key must not carry it into the log.
		oc.state.answer = () => new Response(JSON.stringify({ code: "PERMISSION_DENIED", message: `bad key ${KEY}` }), { status: 403 });
		await heartbeat(h, "refused-1");
		const w = await read(await watch(h, "refused-1"));
		expect(w).toMatchObject({ watched: true });
		await h.app.waker!.idle();
		const line = h.logs.find((l) => l.startsWith("remote debug wake for refused-1 failed"));
		expect(line).toBeDefined();
		expect(line).toContain("403");
		expect(line).toContain("universe-messaging-service:publish");
		// The page falls back to the heartbeat text.
		expect(await read(await watch(h, "refused-1"))).toMatchObject({ watched: true, wake: false });
		expect(await read(await heartbeat(h, "refused-1"))).toEqual({ ok: true, rd: 1 });
		// A network error (its text holding the key) too.
		oc.state.answer = () => {
			throw new Error(`connect failed (x-api-key: ${KEY})`);
		};
		await heartbeat(h, "refused-2");
		expect((await watch(h, "refused-2")).status).toBe(200);
		await h.app.waker!.idle();
		expect(h.logs.some((l) => l.startsWith("remote debug wake for refused-2 failed") && l.includes("<redacted>"))).toBe(true);
		oc.state.answer = () => new Response("{}", { status: 200 });
		h.setNow(T0);
	});

	test("the key never appears in a log line or a response (watch, server, healthz, settings)", async () => {
		bodies.push(await (await admin(h, "/v1/fleet/servers/wake-1")).text());
		const health = await (await h.call("/healthz", { headers: bearer(ADMIN) })).text();
		bodies.push(health);
		expect(JSON.parse(health).remoteDebug.wake).toMatchObject({ published: expect.any(Number), failed: 2, limited: 3 });
		const settings = await (await admin(h, "/v1/admin/settings")).text();
		bodies.push(settings);
		expect(JSON.parse(settings).envOnly).toContain("TYPETORCH_MESSAGING_KEY");
		for (const body of bodies) expect(body).not.toContain(KEY);
		for (const line of h.logs) expect(line).not.toContain(KEY);
	});
});

describe("without the key", () => {
	test("no publish, the heartbeat path, and one startup line saying wake is off", async () => {
		const oc = fakeOpenCloud();
		const h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_UNIVERSE_ID: String(UNIVERSE) }, { fetch: oc.fetch });
		try {
			expect(h.logs.filter((l) => l.startsWith("remote debug wake is off (TYPETORCH_MESSAGING_KEY not set)"))).toHaveLength(1);
			await heartbeat(h, "nokey-1");
			expect(await asJson(await watch(h, "nokey-1"))).toMatchObject({ watched: true, connected: false, wake: false });
			expect(await asJson(await heartbeat(h, "nokey-1"))).toEqual({ ok: true, rd: 1 });
			await h.app.waker?.idle();
			expect(oc.sent).toHaveLength(0);
			expect((await asJson(await h.call("/healthz", { headers: bearer(ADMIN) }))).remoteDebug.wake).toBe("off");
		} finally {
			await h.close();
		}
	});

	test("a key without the universe id stays off too", async () => {
		const oc = fakeOpenCloud();
		const h = await harness({ TYPETORCH_PARTS: "fleet", TYPETORCH_MESSAGING_KEY: KEY }, { fetch: oc.fetch });
		try {
			expect(h.logs.some((l) => l.startsWith("remote debug wake is off (TYPETORCH_UNIVERSE_ID not set)"))).toBe(true);
			await heartbeat(h, "nouniverse-1");
			expect(await asJson(await watch(h, "nouniverse-1"))).toMatchObject({ wake: false });
			await h.app.waker?.idle();
			expect(oc.sent).toHaveLength(0);
			for (const line of h.logs) expect(line).not.toContain(KEY);
		} finally {
			await h.close();
		}
	});
});

describe("the waker", () => {
	test("one wake per job per 10 s; the cap is a sliding minute; waking() lasts 30 s", async () => {
		let now = T0;
		const oc = fakeOpenCloud();
		const logs: string[] = [];
		const waker = new RemoteDebugWaker({ apiKey: KEY, universeId: UNIVERSE, fetch: oc.fetch, clock: () => now, log: (l) => logs.push(l) });
		expect(waker.wake("job-a")).toBe("sent");
		expect(waker.wake("job-a")).toBe("recent");
		now += WAKE_JOB_GAP_MS - 1;
		expect(waker.wake("job-a")).toBe("recent");
		expect(waker.waking("job-a")).toBe(true);
		now += 1;
		expect(waker.wake("job-a")).toBe("sent");
		await waker.idle();
		expect(oc.sent).toHaveLength(2);
		now += WAKE_SHOWN_MS;
		expect(waker.waking("job-a")).toBe(false);
		expect(waker.waking("never")).toBe(false);
		expect(waker.stats).toMatchObject({ published: 2, recent: 2, failed: 0, limited: 0 });
		// The cap: WAKE_PER_MINUTE in any 60 s (two went out above, 40 s ago).
		for (let i = 0; i < WAKE_PER_MINUTE - 2; i++) expect(waker.wake(`cap-${i}`)).toBe("sent");
		expect(waker.wake("cap-over")).toBe("limited");
		now = T0 + 60_000; // the first wake leaves the window
		expect(waker.wake("cap-over")).toBe("sent");
		expect(waker.wake("cap-over-2")).toBe("limited");
		await waker.idle();
		expect(oc.sent).toHaveLength(WAKE_PER_MINUTE + 1);
		expect(logs.filter((l) => l.includes("wakes went out"))).toHaveLength(1);
	});

	test("off without a key or a universe: wake() does nothing", () => {
		const oc = fakeOpenCloud();
		expect(new RemoteDebugWaker({ universeId: UNIVERSE, fetch: oc.fetch }).wake("x")).toBe("off");
		expect(new RemoteDebugWaker({ apiKey: KEY, fetch: oc.fetch }).wake("x")).toBe("off");
		expect(oc.sent).toHaveLength(0);
	});

	test("the message is tiny: {k:'rd', j}", () => {
		const longest = "x".repeat(64);
		expect(JSON.parse(wakeMessage(longest))).toEqual({ k: "rd", j: longest });
		expect(wakeMessage(longest).length).toBeLessThan(100);
	});
});

describe("config", () => {
	const base = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN };
	test("TYPETORCH_MESSAGING_KEY: read, checked, never echoed", () => {
		expect(loadConfig([], { ...base, TYPETORCH_MESSAGING_KEY: KEY }).messagingKey).toBe(KEY);
		expect(loadConfig([], base).messagingKey).toBeUndefined();
		for (const bad of ["short", `${KEY} with spaces`, `${KEY}\n`]) {
			let message = "";
			try {
				loadConfig([], { ...base, TYPETORCH_MESSAGING_KEY: bad });
			} catch (error) {
				message = (error as Error).message;
			}
			expect(message).toContain("TYPETORCH_MESSAGING_KEY");
			expect(message).not.toContain(bad.trim());
		}
		expect(() => loadConfig([], { ...base, TYPETORCH_MESSAGING_KEY: API })).toThrow("not TYPETORCH_API_KEY or TYPETORCH_ADMIN_TOKEN");
		expect(() => loadConfig([], { ...base, TYPETORCH_MESSAGING_KEY: ADMIN })).toThrow("not TYPETORCH_API_KEY or TYPETORCH_ADMIN_TOKEN");
		const shared = loadConfig([], { ...base, TYPETORCH_MESSAGING_KEY: KEY, OPENCLOUD_API_KEY: KEY });
		expect(shared.warnings.some((w) => w.includes("TYPETORCH_MESSAGING_KEY is the same key as OPENCLOUD_API_KEY"))).toBe(true);
		expect(shared.warnings.join(" ")).not.toContain(KEY);
	});
});
