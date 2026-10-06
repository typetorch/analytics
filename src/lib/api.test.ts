import { describe, expect, it } from "vitest";
import { ApiError, cleanFilters, createApi } from "./api";

interface Call {
	url: string;
	method: string;
	body: unknown;
	headers: Record<string, string>;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
		};
		calls.push(call);
		return answer(call);
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("api client", () => {
	it("posts a named query with cleaned filters and returns the result", async () => {
		const { fetch, calls } = fakeFetch(() => json(200, { result: { players: 1, days: [] }, ms: 4 }));
		const api = createApi({ fetch });
		const result = await api.query("overview", { from: "2026-10-01", branch: "", art: [], variant: { experiment: "x", variant: "" } }, {});
		expect(result).toEqual({ players: 1, days: [] });
		expect(calls[0]).toMatchObject({ url: "/api/v1/query/overview", method: "POST", body: { filters: { from: "2026-10-01" }, options: {} } });
		expect(calls[0].headers["content-type"]).toBe("application/json");
		expect(calls[0].headers.authorization).toBeUndefined(); // the proxy adds the token, never the browser
	});

	it("throws ApiError with the server's message (and detail)", async () => {
		const api = createApi({ fetch: fakeFetch(() => json(400, { error: "pid must be 1-64 characters" })).fetch });
		const error = await api.query("timeline", {}, { pid: "x y" }).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(ApiError);
		expect((error as ApiError).status).toBe(400);
		expect((error as ApiError).message).toBe("pid must be 1-64 characters");
		const failing = createApi({ fetch: fakeFetch(() => json(500, { error: "query failed", detail: "Binder Error" })).fetch });
		await expect(failing.sql("SELECT nope")).rejects.toThrow("query failed: Binder Error");
	});

	it("names proxy and network failures plainly", async () => {
		const down = createApi({ fetch: fakeFetch(() => new Response("<html>Bad Gateway</html>", { status: 502 })).fetch });
		await expect(down.health()).rejects.toThrow("the analytics server is not answering");
		const offline = createApi({
			fetch: (async () => {
				throw new TypeError("Failed to fetch");
			}) as typeof globalThis.fetch,
		});
		const error = (await offline.queries().catch((e: unknown) => e)) as ApiError;
		expect(error.status).toBe(0);
		expect(error.message).toContain("Failed to fetch");
		const missing = createApi({ fetch: fakeFetch(() => json(404, { error: "not found" })).fetch });
		expect(((await missing.sql("SELECT 1").catch((e: unknown) => e)) as ApiError).notFound).toBe(true);
	});

	it("builds fleet and SQL requests", async () => {
		const { fetch, calls } = fakeFetch((call) =>
			call.url.includes("/reports")
				? json(200, { seq: 41 })
				: call.url.includes("/alerts")
					? json(200, { alerts: [{ id: 1 }] })
					: json(200, { servers: [], columns: [], rows: [] }),
		);
		const api = createApi({ fetch, base: "/api/" });
		await api.fleetServers("dev");
		await api.fleetReport({ branch: "prod" });
		await api.fleetReport({ seq: 41 });
		expect(await api.fleetAlerts({ unacked: true, limit: 5 })).toEqual([{ id: 1 }]);
		await api.sql("SELECT 1", 50);
		expect(calls.map((c) => c.url)).toEqual([
			"/api/v1/fleet/servers?branch=dev",
			"/api/v1/fleet/reports?latest&branch=prod",
			"/api/v1/fleet/reports?seq=41",
			"/api/v1/fleet/alerts?unacked=1&limit=5",
			"/api/v1/sql",
		]);
		expect(calls[4].body).toEqual({ sql: "SELECT 1", limit: 50 });
		expect(api.streamUrl({ branch: "dev" })).toBe("/api/v1/fleet/stream?branch=dev");
	});

	it("looks up pid <-> UserId and backfills through the proxy", async () => {
		const { fetch, calls } = fakeFetch((call) =>
			call.url.includes("backfill") ? json(200, { scanned: 2, added: 1, known: 1 }) : call.url.endsWith("/v1/identity") ? json(200, { count: 3, backfill: false }) : json(200, { identities: [{ pid: "abc", uid: 42 }] }),
		);
		const api = createApi({ fetch });
		expect(await api.identity({ uid: 42 })).toEqual([{ pid: "abc", uid: 42 }]);
		await api.identity({ pid: "abc" });
		expect(await api.identitySummary()).toEqual({ count: 3, backfill: false });
		expect((await api.backfillIdentities("next")).added).toBe(1);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET /api/v1/identity?uid=42",
			"GET /api/v1/identity?pid=abc",
			"GET /api/v1/identity",
			"POST /api/v1/identity/backfill",
		]);
		expect(calls[3].body).toEqual({ pageToken: "next" });
	});

	it("cleanFilters keeps set values only", () => {
		expect(cleanFilters({ from: "2026-10-01", to: "", dev: "phone", branch: [], variant: { experiment: "e", variant: "b" } })).toEqual({
			from: "2026-10-01",
			dev: "phone",
			variant: { experiment: "e", variant: "b" },
		});
	});
});
