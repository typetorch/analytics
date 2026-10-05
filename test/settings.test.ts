import { describe, expect, test } from "bun:test";
import { deleteDataStoreEntry, getDataStoreEntry, OpenCloudError } from "../src/opencloud.ts";
import { SETTINGS_KEY, validateSettings, writeSettings } from "../src/settings.ts";

const KEY = "test-api-key-not-real-0000";
const good = {
	backend: "basin" as const,
	events: "https://abc123.ingest.cloudflare.com",
	recordings: "https://def456.ingest.cloudflare.com",
	token: "send-only-token-0123456789",
	recordShare: 0.5,
	experiments: { onboarding: { variants: ["short", "long"], split: [50, 50] } },
};

function recorder(responses: { status: number; body?: unknown }[]) {
	const calls: { method: string; url: string; headers: Headers; body: unknown }[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ method: String(init?.method), url: String(input), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const next = responses.shift() ?? { status: 500 };
		return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
	}) as typeof fetch;
	return { calls, fetchImpl };
}

describe("validateSettings", () => {
	test("accepts good settings and drops unknown fields", () => {
		expect(validateSettings({ ...good, extra: 1 })).toEqual(good);
		expect(validateSettings({ backend: "duckdb", events: "https://a.example.com/v1/ingest" })).toEqual({ backend: "duckdb", events: "https://a.example.com/v1/ingest" });
	});
	test.each([
		[{ backend: "sqlite" }, "backend"],
		[{ events: "http://insecure.example.com" }, "https"],
		[{ events: "https://user:pw@x.example.com" }, "credentials"],
		[{ recordings: undefined }, "recordings stream"],
		[{ recordShare: 2 }, "recordShare"],
		[{ token: "short" }, "token"],
		[{ experiments: { onboarding: { variants: ["a"] } } }, "2-10"],
		[{ experiments: { onboarding: { variants: ["a", "b"], split: [50, 40] } } }, "add up to 100"],
		[{ experiments: { "bad name": { variants: ["a", "b"] } } }, "experiment name"],
	])("refuses %p", (over, message) => {
		expect(() => validateSettings({ ...good, ...over })).toThrow(message);
	});
});

describe("writeSettings", () => {
	test("PATCHes the draft with only our key, then publishes; never reads", async () => {
		const { calls, fetchImpl } = recorder([
			{ status: 200, body: { draftHash: "h1" } },
			{ status: 200, body: { configVersion: 7 } },
		]);
		const result = await writeSettings({ apiKey: KEY, universeId: 123, settings: good, fetch: fetchImpl });
		expect(result).toEqual({ value: good, published: true, configVersion: 7 });
		expect(calls.map((c) => c.method)).toEqual(["PATCH", "POST"]);
		expect(calls[0].url).toBe("https://apis.roblox.com/creator-configs-public-api/v1/configs/universes/123/repositories/InExperienceConfig/draft");
		expect(calls[0].body).toEqual({ entries: { [SETTINGS_KEY]: good } });
		expect(calls[1].url.endsWith("/publish")).toBe(true);
		expect(calls[1].body).toMatchObject({ draftHash: "h1", deploymentStrategy: "Immediate" });
		expect(calls[0].headers.get("x-api-key")).toBe(KEY);
	});

	test("dry run makes no calls", async () => {
		const { calls, fetchImpl } = recorder([]);
		expect(await writeSettings({ apiKey: KEY, universeId: 1, settings: good, fetch: fetchImpl, dryRun: true })).toEqual({ value: good, published: false });
		expect(calls).toEqual([]);
	});

	test("a scope error names the scope and never the key", async () => {
		const { fetchImpl } = recorder([{ status: 403, body: { message: "Scope not authorized" } }]);
		const error = await writeSettings({ apiKey: KEY, universeId: 1, settings: good, fetch: fetchImpl }).catch((e) => e);
		expect(error).toBeInstanceOf(OpenCloudError);
		expect(error.message).toContain("universe:write");
		expect(error.message).not.toContain(KEY);
	});
});

describe("DataStore entries", () => {
	test("get: value, 404 -> undefined, the key is URL-encoded", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { value: { pid: "p_abc", first: 1 } } }, { status: 404 }]);
		expect(await getDataStoreEntry({ apiKey: KEY, fetch: fetchImpl, universeId: 9, dataStore: "TypeTorchAnalytics", entry: "p/123" })).toEqual({ pid: "p_abc", first: 1 });
		expect(await getDataStoreEntry({ apiKey: KEY, fetch: fetchImpl, universeId: 9, dataStore: "TypeTorchAnalytics", entry: "p/456" })).toBeUndefined();
		expect(calls[0].url).toBe("https://apis.roblox.com/cloud/v2/universes/9/data-stores/TypeTorchAnalytics/entries/p%2F123");
	});
	test("delete: 404 counts as done", async () => {
		const { fetchImpl } = recorder([{ status: 404 }]);
		await deleteDataStoreEntry({ apiKey: KEY, fetch: fetchImpl, universeId: 9, dataStore: "TypeTorchAnalytics", entry: "p/1" });
	});
});
