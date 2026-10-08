/**
 * The backend's in-process event bus: ingest publishes, subscribers consume. No broker, no network.
 *
 * Two kinds of subscriber:
 *   - "await": the publisher waits for the handler, so a 202 still means "stored". For the local stores whose success the
 *     HTTP answer reports: the DuckDB raw-file writer, the fleet SQLite store, the error store. A handler that throws
 *     makes `publish` reject (the route answers 500) and the message is not passed on to the queued subscribers.
 *   - "queue": the message goes into a bounded queue and a handler drains it later, one message at a time. `publish` never
 *     waits for it, so a slow webhook or a slow browser can't slow ingest down. A queue holds at most `maxQueue` messages
 *     and `maxBytes` of weight; past that new messages are dropped and counted (`stats()`, shown by /healthz).
 *
 * Messages are delivered in publish order per subscriber. Handlers must not throw for flow control: a throw in a queued
 * handler is counted (`failed`) and logged, never retried.
 */

export interface BusSubscriberStats {
	name: string;
	mode: "await" | "queue";
	topics: string[];
	/** Messages handled (await: all; queue: the drained ones). */
	processed: number;
	failed: number;
	/** Messages not queued because the queue was full. */
	dropped: number;
	queued: number;
	queuedBytes: number;
	maxQueue: number;
	maxBytes: number;
	lastError?: string;
}

export interface BusStats {
	published: Record<string, number>;
	subscribers: BusSubscriberStats[];
	/** Messages dropped across all queued subscribers. */
	dropped: number;
}

export interface SubscribeOptions {
	mode: "await" | "queue";
	/** Queue only: most messages held (default: the bus' default). */
	maxQueue?: number;
	/** Queue only: most total weight held (default: the bus' default). */
	maxBytes?: number;
}

export interface BusOptions {
	maxQueue?: number;
	maxBytes?: number;
	log?: (line: string) => void;
}

interface Envelope<M> {
	topic: keyof M & string;
	message: M[keyof M & string];
	weight: number;
}

type Handler<M> = (topic: keyof M & string, message: M[keyof M & string]) => void | Promise<void>;

interface Subscription<M> {
	name: string;
	mode: "await" | "queue";
	topics: Set<string>;
	handler: Handler<M>;
	maxQueue: number;
	maxBytes: number;
	queue: Envelope<M>[];
	head: number;
	queuedBytes: number;
	draining: Promise<void> | undefined;
	processed: number;
	failed: number;
	dropped: number;
	lastError: string | undefined;
	lastLog: number;
}

export class EventBus<M extends object> {
	private readonly subs: Subscription<M>[] = [];
	private readonly published: Record<string, number> = {};
	private readonly maxQueue: number;
	private readonly maxBytes: number;

	constructor(private readonly options: BusOptions = {}) {
		this.maxQueue = options.maxQueue ?? 1000;
		this.maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
	}

	/** Subscribes `handler` to topics. Returns the unsubscribe function (its queue is discarded). */
	subscribe<T extends keyof M & string>(name: string, topics: readonly T[], handler: (topic: T, message: M[T]) => void | Promise<void>, options: SubscribeOptions): () => void {
		const sub: Subscription<M> = {
			name,
			mode: options.mode,
			topics: new Set(topics),
			handler: handler as unknown as Handler<M>,
			maxQueue: options.maxQueue ?? this.maxQueue,
			maxBytes: options.maxBytes ?? this.maxBytes,
			queue: [],
			head: 0,
			queuedBytes: 0,
			draining: undefined,
			processed: 0,
			failed: 0,
			dropped: 0,
			lastError: undefined,
			lastLog: 0,
		};
		this.subs.push(sub);
		return () => {
			const at = this.subs.indexOf(sub);
			if (at >= 0) this.subs.splice(at, 1);
			sub.queue = [];
			sub.head = 0;
			sub.queuedBytes = 0;
		};
	}

	/**
	 * Delivers a message. Awaited subscribers run first, in subscription order (the first failure is rethrown after the
	 * rest ran); only if they all succeed is the message queued for the others. `weight` is the message's size in bytes
	 * (default 1), for the queues' byte bound.
	 */
	async publish<T extends keyof M & string>(topic: T, message: M[T], weight = 1): Promise<void> {
		this.published[topic] = (this.published[topic] ?? 0) + 1;
		let failure: unknown;
		let failed = false;
		for (const sub of this.subs) {
			if (sub.mode !== "await" || !sub.topics.has(topic)) continue;
			try {
				await sub.handler(topic, message);
				sub.processed++;
			} catch (error) {
				sub.failed++;
				sub.lastError = errorText(error);
				if (!failed) {
					failed = true;
					failure = error;
				}
			}
		}
		if (failed) throw failure;
		for (const sub of this.subs) {
			if (sub.mode !== "queue" || !sub.topics.has(topic)) continue;
			const size = sub.queue.length - sub.head;
			if (size >= sub.maxQueue || (size > 0 && sub.queuedBytes + weight > sub.maxBytes)) {
				sub.dropped++;
				continue;
			}
			sub.queue.push({ topic, message, weight });
			sub.queuedBytes += weight;
			this.schedule(sub);
		}
	}

	private schedule(sub: Subscription<M>): void {
		if (sub.draining) return;
		sub.draining = this.drain(sub).finally(() => {
			sub.draining = undefined;
			// Something may have been queued while the last message finished.
			if (sub.queue.length - sub.head > 0 && this.subs.includes(sub)) this.schedule(sub);
		});
	}

	private async drain(sub: Subscription<M>): Promise<void> {
		// Let publish() return first.
		await Promise.resolve();
		let sinceYield = 0;
		while (sub.head < sub.queue.length) {
			const item = sub.queue[sub.head++] as Envelope<M>;
			sub.queuedBytes -= item.weight;
			if (sub.head > 1024 && sub.head * 2 > sub.queue.length) {
				sub.queue = sub.queue.slice(sub.head);
				sub.head = 0;
			}
			try {
				await sub.handler(item.topic, item.message);
				sub.processed++;
			} catch (error) {
				sub.failed++;
				sub.lastError = errorText(error);
				const now = Date.now();
				if (now - sub.lastLog > 30_000) {
					sub.lastLog = now;
					this.options.log?.(`bus subscriber ${sub.name} failed on ${item.topic}: ${sub.lastError}`);
				}
			}
			// A long burst must not starve the event loop (HTTP, timers).
			if (++sinceYield >= 100) {
				sinceYield = 0;
				await new Promise<void>((done) => setImmediate(done));
			}
		}
		sub.queue = [];
		sub.head = 0;
		sub.queuedBytes = 0;
	}

	/** Resolves when every queue is empty and every drain has finished (tests, shutdown). */
	async idle(): Promise<void> {
		for (let guard = 0; guard < 1000; guard++) {
			const busy = this.subs.filter((s) => s.draining || s.queue.length - s.head > 0);
			if (!busy.length) return;
			for (const sub of busy) {
				if (!sub.draining) this.schedule(sub);
				await sub.draining;
			}
		}
	}

	stats(): BusStats {
		return {
			published: { ...this.published },
			subscribers: this.subs.map((s) => ({
				name: s.name,
				mode: s.mode,
				topics: [...s.topics],
				processed: s.processed,
				failed: s.failed,
				dropped: s.dropped,
				queued: s.queue.length - s.head,
				queuedBytes: s.queuedBytes,
				maxQueue: s.maxQueue,
				maxBytes: s.maxBytes,
				...(s.lastError ? { lastError: s.lastError } : {}),
			})),
			dropped: this.subs.reduce((n, s) => n + s.dropped, 0),
		};
	}
}

function errorText(error: unknown): string {
	return (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).slice(0, 200);
}
