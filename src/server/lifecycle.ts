/**
 * Shutting down on SIGTERM / SIGINT (Docker and Coolify send SIGTERM, then SIGKILL after the stop grace period: 30 s in
 * compose.yaml). The app stops promptly (App.stop: no new requests, the running ones finish, DuckDB and SQLite are
 * checkpointed and closed), then the process exits. A deadline below the grace period makes sure it exits either way
 * (DuckDB replays its WAL on the next start, nothing accepted is lost: the raw files are synced on every write).
 * A second signal while stopping exits at once.
 */

/** Exit this long after the first signal even if the close isn't done (well under compose.yaml's 30 s). */
export const SHUTDOWN_DEADLINE_MS = 20_000;

export interface ShutdownOptions {
	/** Stops the app (App.stop, after the app has started). */
	stop(): Promise<void>;
	log(line: string): void;
	exit(code: number): void;
	deadlineMs?: number;
	signals?: readonly NodeJS.Signals[];
}

export interface Shutdown {
	/** A shutdown has started (a signal, or `shutdown()`). */
	readonly requested: boolean;
	/** Stops once and exits with `code` (later calls get the same run). */
	shutdown(reason: string, code?: number): Promise<void>;
	/** Removes the signal listeners (tests). */
	dispose(): void;
}

export function handleShutdown(options: ShutdownOptions): Shutdown {
	const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
	const signals = options.signals ?? (["SIGTERM", "SIGINT"] as const);
	let running: Promise<void> | undefined;
	let exited = false;
	const exit = (code: number) => {
		if (exited) return;
		exited = true;
		options.exit(code);
	};

	function shutdown(reason: string, code = 0): Promise<void> {
		if (running) return running;
		options.log(`${reason}: stopping (closing DuckDB and SQLite, then exiting)`);
		const started = Date.now();
		const deadline = setTimeout(() => {
			options.log(`stop took over ${Math.round(deadlineMs / 1000)} s: exiting without a clean close (DuckDB replays its WAL on the next start)`);
			exit(1);
		}, deadlineMs);
		deadline.unref?.();
		running = options
			.stop()
			.then(
				() => {
					options.log(`stopped in ${((Date.now() - started) / 1000).toFixed(1)} s`);
					return code;
				},
				(error) => {
					options.log(`stop failed: ${((error as Error).message ?? String(error)).slice(0, 300)}`);
					return 1;
				},
			)
			.then((exitCode) => {
				clearTimeout(deadline);
				exit(exitCode);
			});
		return running;
	}

	const listeners = signals.map((signal) => {
		const listener = () => {
			if (running) {
				options.log(`${signal} again: exiting now`);
				exit(1);
				return;
			}
			void shutdown(signal);
		};
		process.on(signal, listener);
		return () => process.off(signal, listener);
	});

	return {
		get requested() {
			return running !== undefined;
		},
		shutdown,
		dispose: () => {
			for (const off of listeners) off();
		},
	};
}
