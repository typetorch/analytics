import { describe, expect, it } from "vitest";
import { guardRequest, parseEnvFile, resolveTarget } from "./proxy";

const same = { host: "localhost:5173", "sec-fetch-site": "same-origin", "content-type": "application/json" };

describe("explorer proxy", () => {
	it("reads the analytics server's env file; real environment wins", () => {
		const file = '# comment\nTT_ANALYTICS_HOST=0.0.0.0\nTT_ANALYTICS_PORT="8787"\nexport TT_ANALYTICS_ADMIN_TOKEN=abc123 # trailing\n';
		expect(parseEnvFile(file)).toEqual({ TT_ANALYTICS_HOST: "0.0.0.0", TT_ANALYTICS_PORT: "8787", TT_ANALYTICS_ADMIN_TOKEN: "abc123" });
		const target = resolveTarget({ TT_ANALYTICS_ENV_FILE: "x.env" }, () => file);
		expect(target.url).toBe("http://127.0.0.1:8787");
		expect(target.token).toBe("abc123");
		expect(resolveTarget({ TT_ANALYTICS_ENV_FILE: "x.env", TT_ANALYTICS_URL: "https://a.example.com/" }, () => file).url).toBe("https://a.example.com");
		expect(resolveTarget({}).token).toBeUndefined();
		expect(resolveTarget({}).url).toBe("http://127.0.0.1:8787");
	});

	it("forwards only the explorer's read endpoints", () => {
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/v1/fleet/stream?branch=dev", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "POST", url: "/v1/sql", headers: same }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "GET", url: "/healthz", headers: { host: "localhost:5173", "sec-fetch-site": "none" } }, true)).toEqual({ ok: true });
		for (const [method, url] of [
			["POST", "/v1/erasure"],
			["POST", "/v1/ingest"],
			["POST", "/v1/fleet/alerts/3/ack"],
			["POST", "/v1/fleet/heartbeat"],
			["GET", "/v1/settings"],
			["GET", "/v1/query/overview"],
			["POST", "/v1/query/../erasure"],
		]) {
			expect(guardRequest({ method, url, headers: same }, true)).toMatchObject({ ok: false, status: 403 });
		}
	});

	it("refuses other sites and non-JSON posts, and explains a missing token", () => {
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, "sec-fetch-site": "cross-site" } }, true)).toMatchObject({
			status: 403,
		});
		expect(
			guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, "sec-fetch-site": undefined, origin: "https://evil.example" } }, true),
		).toMatchObject({ status: 403 });
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, origin: "http://localhost:5173" } }, true)).toEqual({ ok: true });
		expect(guardRequest({ method: "POST", url: "/v1/query/overview", headers: { ...same, "content-type": "text/plain" } }, true)).toMatchObject({
			status: 415,
		});
		const noToken = guardRequest({ method: "POST", url: "/v1/query/overview", headers: same }, false);
		expect(noToken).toMatchObject({ ok: false, status: 503 });
		expect(noToken.ok ? "" : noToken.error).toContain("--env-file");
	});
});
