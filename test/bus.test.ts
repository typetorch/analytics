/** The in-process event bus: awaited and queued subscribers, bounded queues, drops counted. */
import { describe, expect, test } from "bun:test";
import { EventBus } from "../src/bus.ts";

interface Topics {
	a: { n: number };
	b: { text: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("EventBus", () => {
	test("awaited subscribers finish before publish returns; queued ones run after, in order", async () => {
		const bus = new EventBus<Topics>();
		const order: string[] = [];
		bus.subscribe("store", ["a"], async (_t, m) => (await sleep(5), void order.push(`store ${m.n}`)), { mode: "await" });
		bus.subscribe("watcher", ["a", "b"], (t, m) => void order.push(`watch ${t} ${"n" in m ? m.n : (m as { text: string }).text}`), { mode: "queue" });
		await bus.publish("a", { n: 1 });
		// The store is done, the watcher hasn't necessarily run yet.
		expect(order[0]).toBe("store 1");
		await bus.publish("a", { n: 2 });
		await bus.publish("b", { text: "x" });
		await bus.idle();
		// Each subscriber sees its messages in publish order.
		expect(order.filter((l) => l.startsWith("store"))).toEqual(["store 1", "store 2"]);
		expect(order.filter((l) => l.startsWith("watch"))).toEqual(["watch a 1", "watch a 2", "watch b x"]);
		const stats = bus.stats();
		expect(stats.published).toEqual({ a: 2, b: 1 });
		expect(stats.subscribers.find((s) => s.name === "watcher")).toMatchObject({ processed: 3, dropped: 0, queued: 0, failed: 0 });
	});

	test("a slow queued subscriber does not slow publish; a full queue drops and counts", async () => {
		const bus = new EventBus<Topics>();
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const seen: number[] = [];
		bus.subscribe(
			"slow",
			["a"],
			async (_t, m) => {
				await gate;
				seen.push(m.n);
			},
			{ mode: "queue", maxQueue: 5 },
		);
		const started = performance.now();
		for (let i = 0; i < 100; i++) await bus.publish("a", { n: i });
		expect(performance.now() - started).toBeLessThan(250);
		const s = bus.stats().subscribers[0];
		// One message is in the handler, five wait, the rest were dropped.
		expect(s.queued).toBeLessThanOrEqual(5);
		expect(s.dropped).toBeGreaterThanOrEqual(94);
		expect(bus.stats().dropped).toBe(s.dropped);
		release();
		await bus.idle();
		expect(seen.length).toBe(100 - s.dropped);
		// The kept ones are the oldest, in order.
		expect(seen).toEqual([...seen].sort((x, y) => x - y));
		expect(bus.stats().subscribers[0].queued).toBe(0);
	});

	test("the queue is bounded by weight too", async () => {
		const bus = new EventBus<Topics>({ maxBytes: 1000 });
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		bus.subscribe("slow", ["a"], () => gate, { mode: "queue" });
		for (let i = 0; i < 10; i++) await bus.publish("a", { n: i }, 400);
		// 1 in the handler (400), the queue holds 400 + 400 = 800 and refuses the next 400.
		const s = bus.stats().subscribers[0];
		expect(s.queuedBytes).toBeLessThanOrEqual(1000);
		expect(s.dropped).toBeGreaterThan(0);
		release();
		await bus.idle();
	});

	test("a failing queued handler is counted and the next messages still arrive", async () => {
		const lines: string[] = [];
		const bus = new EventBus<Topics>({ log: (l) => lines.push(l) });
		const seen: number[] = [];
		bus.subscribe(
			"flaky",
			["a"],
			(_t, m) => {
				if (m.n === 2) throw new Error("boom");
				seen.push(m.n);
			},
			{ mode: "queue" },
		);
		for (const n of [1, 2, 3]) await bus.publish("a", { n });
		await bus.idle();
		expect(seen).toEqual([1, 3]);
		expect(bus.stats().subscribers[0]).toMatchObject({ failed: 1, processed: 2, lastError: "Error: boom" });
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("flaky");
	});

	test("a failing awaited handler rejects publish and the message is not passed on", async () => {
		const bus = new EventBus<Topics>();
		const seen: number[] = [];
		bus.subscribe("store", ["a"], () => Promise.reject(new Error("disk full")), { mode: "await" });
		bus.subscribe("watch", ["a"], (_t, m) => void seen.push(m.n), { mode: "queue" });
		await expect(bus.publish("a", { n: 1 })).rejects.toThrow("disk full");
		await bus.idle();
		expect(seen).toEqual([]);
		expect(bus.stats().subscribers.find((s) => s.name === "store")?.failed).toBe(1);
	});

	test("unsubscribe stops delivery and drops the queue", async () => {
		const bus = new EventBus<Topics>();
		const seen: number[] = [];
		const off = bus.subscribe("w", ["a"], (_t, m) => void seen.push(m.n), { mode: "queue" });
		await bus.publish("a", { n: 1 });
		await bus.idle();
		off();
		await bus.publish("a", { n: 2 });
		await bus.idle();
		expect(seen).toEqual([1]);
		expect(bus.stats().subscribers).toEqual([]);
	});

	test("publish only queues: handlers run after it returns, a burst drains in order", async () => {
		const bus = new EventBus<Topics>({ maxQueue: 100_000 });
		const seen: number[] = [];
		bus.subscribe("fast", ["a"], (_t, m) => void seen.push(m.n), { mode: "queue" });
		const pending: Promise<void>[] = [];
		for (let i = 0; i < 1000; i++) pending.push(bus.publish("a", { n: i }));
		expect(seen.length).toBe(0);
		expect(bus.stats().subscribers[0].queued).toBe(1000);
		await Promise.all(pending);
		await bus.idle();
		expect(seen.length).toBe(1000);
		expect(seen[999]).toBe(999);
	});

	test("idle can give up on a stuck handler instead of hanging a shutdown", async () => {
		const bus = new EventBus<Topics>();
		bus.subscribe("stuck", ["a"], () => new Promise<void>(() => {}), { mode: "queue" });
		await bus.publish("a", { n: 1 });
		const started = performance.now();
		expect(await bus.idle(50)).toBe(false);
		expect(performance.now() - started).toBeLessThan(1000);
		const quiet = new EventBus<Topics>();
		expect(await quiet.idle(50)).toBe(true);
	});
});
