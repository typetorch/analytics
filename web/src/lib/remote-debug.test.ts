import { describe, expect, it } from "vitest";
import { ApiError, createApi } from "./api";
import { explainRemoteError, RemoteError, runRemote, type RunOptions } from "./remote-debug";
import type { RemoteCommand } from "./types";

const JOB = "job-1";

/** A fake backend: the command answers, in order, as remoteResult reads them. */
function fake(options: { queue?: (op: string) => RemoteCommand | Error; results?: (RemoteCommand | Error)[]; watch?: () => void } = {}) {
	const calls: string[] = [];
	const results = [...(options.results ?? [])];
	let clock = 0;
	const api: NonNullable<RunOptions["api"]> = {
		remoteCommand: async (job, op, args) => {
			calls.push(`command ${job} ${op} ${JSON.stringify(args ?? {})}`);
			const answer = options.queue?.(op) ?? { id: "c1", op, state: "queued", createdAt: 0, expiresAt: 30_000 };
			if (answer instanceof Error) throw answer;
			return answer;
		},
		remoteResult: async (job, id) => {
			calls.push(`result ${job} ${id}`);
			const next = results.shift() ?? { id, op: "status", state: "sent", createdAt: 0, expiresAt: 30_000 };
			if (next instanceof Error) throw next;
			return next;
		},
		watchServer: async (job) => {
			calls.push(`watch ${job}`);
			options.watch?.();
			return { job, watched: true, connected: false };
		},
	};
	const run: RunOptions = {
		api,
		now: () => clock,
		sleep: async (ms) => {
			clock += ms;
		},
	};
	return { api, calls, run };
}

const done = (result: unknown, extra: Partial<RemoteCommand> = {}): RemoteCommand => ({ id: "c1", op: "status", state: "done", createdAt: 0, expiresAt: 0, doneAt: 1234, result, ...extra });

describe("runRemote", () => {
	it("queues the op, reads its state until the answer is in, and hands back the result with ms and redactions", async () => {
		const f = fake({ results: [{ id: "c1", op: "logs", state: "sent", createdAt: 0, expiresAt: 0 }, done({ entries: [] }, { ms: 12, redacted: 2 })] });
		const answer = await runRemote(JOB, "logs", { limit: 50 }, f.run);
		expect(answer).toEqual({ result: { entries: [] }, ms: 12, redacted: 2, at: 1234 });
		expect(f.calls).toEqual([`command ${JOB} logs {"limit":50}`, `result ${JOB} c1`, `result ${JOB} c1`]);
	});

	it("re-watches once and queues again when the watch lapsed (409)", async () => {
		let first = true;
		const f = fake({
			queue: (op) => {
				if (first) {
					first = false;
					return new ApiError(409, "this server isn't watched", "/x");
				}
				return done("ok", { op });
			},
		});
		expect((await runRemote(JOB, "status", undefined, f.run)).result).toBe("ok");
		expect(f.calls).toEqual([`command ${JOB} status {}`, `watch ${JOB}`, `command ${JOB} status {}`]);
	});

	it("gives up after 15 s without an answer", async () => {
		const f = fake();
		await expect(runRemote(JOB, "status", undefined, f.run)).rejects.toMatchObject({ name: "RemoteError", code: "timeout", message: "The server didn't answer in 15 s." });
	});

	it("explains expired, failed and dropped commands", async () => {
		const never = fake({ results: [{ id: "c1", op: "status", state: "expired", createdAt: 0, expiresAt: 0, error: "the server never picked it up" }] });
		await expect(runRemote(JOB, "status", undefined, never.run)).rejects.toMatchObject({ code: "expired", message: expect.stringContaining("never picked the command up") });
		const owners = fake({ results: [{ id: "c1", op: "state", state: "failed", createdAt: 0, expiresAt: 0, error: "owners_only" }] });
		await expect(runRemote(JOB, "state", { queries: [] }, owners.run)).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("Only the game's owners") });
		const dropped = fake({ results: [new ApiError(404, "no such command", "/x")] });
		await expect(runRemote(JOB, "status", undefined, dropped.run)).rejects.toMatchObject({ code: "dropped" });
	});

	it("passes a refused request (429) on as a sentence, and an abort as the abort", async () => {
		const limited = fake({ queue: () => new ApiError(429, "rate limited: too many commands from you this minute", "/x") });
		const error = await runRemote(JOB, "status", undefined, limited.run).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(RemoteError);
		expect((error as RemoteError).message).toContain("too many commands");
		const controller = new AbortController();
		controller.abort();
		const aborted = fake({ queue: () => new DOMException("aborted", "AbortError") as unknown as Error });
		await expect(runRemote(JOB, "status", undefined, { ...aborted.run, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
	});

	it("sends the cookie request with the CSRF header and the JobId encoded (through the real client)", async () => {
		const seen: { url: string; method: string; headers: Headers; body: unknown }[] = [];
		const api = createApi({
			fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
				seen.push({ url: String(input), method: init?.method ?? "GET", headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
				return new Response(JSON.stringify(done({ ok: 1 })), { status: 202, headers: { "content-type": "application/json" } });
			}) as typeof fetch,
		});
		await runRemote("a/b c", "dex.props", { id: 5 }, { api });
		expect(seen[0]).toMatchObject({ url: "/api/v1/fleet/servers/a%2Fb%20c/commands", method: "POST", body: { op: "dex.props", args: { id: 5 } } });
		expect(seen[0].headers.get("x-typetorch")).toBe("1");
	});
});

describe("explainRemoteError", () => {
	it("turns the kernel's short reasons into sentences and keeps unknown ones as they came", () => {
		expect(explainRemoteError("not_supported: the running build has no remote debug hook (framework 0.5.0+ with devtools on), or nothing runs")).toContain("framework 0.5.0+");
		expect(explainRemoteError("op_not_allowed: kick (read-only ops only)")).toContain("doesn't allow");
		expect(explainRemoteError("rate_limited: too many commands this minute")).toContain("too many commands");
		expect(explainRemoteError("not_in_server: that player isn't in this server")).toBe("That player isn't in this server any more.");
		expect(explainRemoteError("no_reply: the player's client didn't answer in time")).toContain("client didn't answer");
		expect(explainRemoteError("the answer is too large (300 KB, at most 195 KB): ask for less")).toContain("too large");
		expect(explainRemoteError(undefined)).toBe("The server could not answer.");
	});
});
