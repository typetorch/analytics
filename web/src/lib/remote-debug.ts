/**
 * Remote debug from the explorer (plans/25, the server page /servers/<JobId>). A Roblox server can't be called into, so
 * it pulls: the page tells the backend it watches the job (every 20 s while the tab is visible; the watch lapses 60 s
 * after the last one), the server's next heartbeat reply says so, and the server long-polls the backend for commands.
 *
 * A fetch here = queue one read-only command, then read its state until the answer is in (at most 15 s). Answers live
 * in this page's memory only (component state, never the query cache, localStorage or the URL): they can hold player
 * names, logs and state. The backend keeps them 3 minutes, also in memory only.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api as defaultApi, ApiError, type Api } from "./api";
import type { DebugStatus, RemoteCommand, RemoteOp } from "./types";

/** How long a click waits for the server's answer. */
export const COMMAND_TIMEOUT_MS = 15_000;
/** How often the page repeats "I'm watching" (the backend keeps a watch 60 s). */
export const WATCH_EVERY_MS = 20_000;
/** How often a waiting command's state is read. */
export const RESULT_POLL_MS = 600;
/** The buttons stay on this long after the server was last seen polling (a slow op or a held poll is not a disconnect). */
export const CONNECTED_GRACE_MS = 30_000;

export type RemoteErrorCode = "timeout" | "failed" | "expired" | "dropped" | "request";

export class RemoteError extends Error {
	override name = "RemoteError";
	constructor(
		message: string,
		readonly code: RemoteErrorCode,
	) {
		super(message);
	}
}

/** The kernel's and the backend's short reasons, as sentences. Unknown reasons are shown as they came. */
export function explainRemoteError(raw: string | undefined): string {
	const text = (raw ?? "").trim();
	if (!text) return "The server could not answer.";
	const [code] = text.split(":", 1);
	switch (code) {
		case "owners_only":
			return "Only the game's owners may read this server (your Roblox account is not an owner by the kernel's rule).";
		case "rate_limited":
			return "The server is answering too many commands this minute: wait a few seconds and try again.";
		case "op_not_allowed":
			return "This server's kernel doesn't allow that read (an older kernel?).";
		case "not_supported":
			return text.includes("hook")
				? "This build can't answer that: it needs framework 0.5.0+ with devtools on (the kernel's own reads still work)."
				: `Not supported here: ${text.slice(code.length + 1).trim()}`;
		case "not_in_server":
			return "That player isn't in this server any more.";
		case "no_reply":
			return "The player's client didn't answer in time (it may be loading or leaving).";
		case "expired":
			return "The command expired before the server ran it.";
		default:
			return text;
	}
}

export interface RemoteAnswer<T> {
	result: T;
	/** How long the op took on the server. */
	ms?: number;
	/** Secrets the kernel replaced with <redacted>. */
	redacted?: number;
	/** When the answer arrived (backend clock, unix ms). */
	at: number;
}

export interface RunOptions {
	api?: Pick<Api, "remoteCommand" | "remoteResult" | "watchServer">;
	signal?: AbortSignal;
	timeoutMs?: number;
	pollMs?: number;
	/** Tests pass a fake clock. */
	now?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) return reject(signal.reason ?? new DOMException("aborted", "AbortError"));
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", stop);
			resolve();
		}, ms);
		const stop = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
		};
		signal?.addEventListener("abort", stop, { once: true });
	});
}

/**
 * Queues one command and waits for its answer. A 409 (the watch lapsed, e.g. after the tab was hidden) re-watches the
 * job and queues once more. Throws RemoteError with a sentence for the page, or the abort.
 */
export async function runRemote<T = unknown>(job: string, op: RemoteOp, args?: Record<string, unknown>, options: RunOptions = {}): Promise<RemoteAnswer<T>> {
	const client = options.api ?? defaultApi;
	const now = options.now ?? Date.now;
	const sleep = options.sleep ?? sleepFor;
	const timeout = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
	const signal = options.signal;
	let queued: RemoteCommand;
	try {
		queued = await client.remoteCommand(job, op, args, signal);
	} catch (error) {
		if (!(error instanceof ApiError) || error.status !== 409) throw asRemote(error);
		try {
			await client.watchServer(job, signal);
			queued = await client.remoteCommand(job, op, args, signal);
		} catch (again) {
			throw asRemote(again);
		}
	}
	const deadline = now() + timeout;
	let command = queued;
	while (command.state === "queued" || command.state === "sent") {
		if (now() >= deadline) throw new RemoteError(`The server didn't answer in ${Math.round(timeout / 1000)} s.`, "timeout");
		await sleep(options.pollMs ?? RESULT_POLL_MS, signal);
		try {
			command = await client.remoteResult(job, queued.id, signal);
		} catch (error) {
			if (error instanceof ApiError && error.status === 404) throw new RemoteError("The answer was dropped before it was read (answers are kept 3 minutes).", "dropped");
			throw asRemote(error);
		}
	}
	if (command.state === "done") return { result: command.result as T, ...(command.ms !== undefined ? { ms: command.ms } : {}), ...(command.redacted ? { redacted: command.redacted } : {}), at: command.doneAt ?? now() };
	if (command.state === "expired") {
		throw new RemoteError(command.sentAt === undefined ? "The server never picked the command up (is it still polling?)." : "The server didn't answer in time.", "expired");
	}
	throw new RemoteError(explainRemoteError(command.error), "failed");
}

function asRemote(error: unknown): unknown {
	if (error instanceof DOMException && error.name === "AbortError") return error;
	if (error instanceof ApiError) {
		if (error.status === 409) return new RemoteError("This server isn't watched: it closed, or the page lost its watch. Reload the page.", "request");
		return new RemoteError(error.message, "request");
	}
	return error;
}

export const isAbort = (error: unknown) => (error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "AbortError");

/**
 * One runner per page: `call` queues an op and resolves with its answer; everything in flight is aborted when the page
 * goes away. `onAnswer` hears about every answer (the page uses it to know the server is connected).
 */
export function useRemoteRunner(job: string, onAnswer?: () => void) {
	const controllers = useRef(new Set<AbortController>());
	const onAnswerRef = useRef(onAnswer);
	onAnswerRef.current = onAnswer;
	useEffect(() => {
		const live = controllers.current;
		return () => {
			for (const c of live) c.abort();
			live.clear();
		};
	}, [job]);
	return useCallback(
		async <T>(op: RemoteOp, args?: Record<string, unknown>): Promise<RemoteAnswer<T>> => {
			const controller = new AbortController();
			controllers.current.add(controller);
			try {
				const answer = await runRemote<T>(job, op, args, { signal: controller.signal });
				onAnswerRef.current?.();
				return answer;
			} finally {
				controllers.current.delete(controller);
			}
		},
		[job],
	);
}

export type Runner = ReturnType<typeof useRemoteRunner>;

export interface RemoteState<T> {
	status: "idle" | "running" | "done" | "error";
	data?: T;
	error?: string;
	ms?: number;
	redacted?: number;
	at?: number;
}

/**
 * One op's last answer, for a "Fetch" button. The previous answer stays on screen while a new one is fetched; a
 * failure keeps it too (with the error above it).
 */
export function useRemote<T>(call: Runner, op: RemoteOp) {
	const [state, setState] = useState<RemoteState<T>>({ status: "idle" });
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);
	const run = useCallback(
		async (args?: Record<string, unknown>): Promise<T | undefined> => {
			setState((s) => ({ ...s, status: "running", error: undefined }));
			try {
				const answer = await call<T>(op, args);
				if (mounted.current) setState({ status: "done", data: answer.result, ms: answer.ms, redacted: answer.redacted, at: answer.at });
				return answer.result;
			} catch (error) {
				if (isAbort(error)) return undefined;
				if (mounted.current) setState((s) => ({ ...s, status: "error", error: error instanceof Error ? error.message : String(error) }));
				return undefined;
			}
		},
		[call, op],
	);
	const set = useCallback((data: T | undefined) => setState((s) => ({ ...s, data })), []);
	return { ...state, run, set };
}

/**
 * Keeps the job watched while the page is open and visible: once now, then every WATCH_EVERY_MS. A hidden tab stops
 * (the server stops polling about a minute later) and watches again as soon as it is visible. `enabled` false (a
 * closed, lost or unknown server) sends nothing.
 */
export function useServerWatch(job: string, enabled: boolean, client: Pick<Api, "watchServer"> = defaultApi) {
	const [reply, setReply] = useState<DebugStatus | undefined>();
	const [error, setError] = useState<string | undefined>();
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setInterval> | undefined;
		const send = () => {
			if (typeof document !== "undefined" && document.hidden) return;
			client.watchServer(job, controller.signal).then(
				(r) => {
					setReply(r);
					setError(undefined);
				},
				(e: unknown) => {
					if (!isAbort(e)) setError(e instanceof Error ? e.message : String(e));
				},
			);
		};
		send();
		timer = setInterval(send, WATCH_EVERY_MS);
		const onVisible = () => {
			if (!document.hidden) send();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			controller.abort();
			if (timer) clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [job, enabled, client]);
	return { reply, error };
}
