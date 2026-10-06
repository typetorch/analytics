import { describe, expect, it } from "vitest";
import { barMax, change, estimatePercentile, loadBenchmarks, saveBenchmarks } from "./benchmarks";
import { createApi } from "./api";
import { fmtBytes } from "./format";

describe("benchmark cards", () => {
	it("change: relative, direction, and whether it's better (lower is better handled)", () => {
		expect(change(12, 10)).toEqual({ relative: 0.2, direction: "up", good: true });
		expect(change(8, 10)).toMatchObject({ direction: "down", good: false });
		expect(change(8, 10, true)).toMatchObject({ direction: "down", good: true });
		expect(change(10, 10)).toEqual({ relative: 0, direction: "flat", good: null });
		expect(change(5, 0)).toEqual({ relative: null, direction: "up", good: true });
		expect(change(null, 3)).toEqual({ relative: null, direction: "flat", good: null });
		expect(change(3, null).good).toBeNull();
	});

	it("estimates the percentile by straight lines through 0, the 50th and the 90th", () => {
		const b = { p50: 10, p90: 30 };
		expect(estimatePercentile(5, b)).toBe(25);
		expect(estimatePercentile(10, b)).toBe(50);
		expect(estimatePercentile(20, b)).toBe(70);
		expect(estimatePercentile(30, b)).toBe(90);
		expect(estimatePercentile(1000, b)).toBe(99);
		expect(estimatePercentile(5, { p50: 30, p90: 10 })).toBeNull(); // 90th below the 50th: not a "higher is better" pair
		expect(estimatePercentile(20, { p50: 30, p90: 10 }, true)).toBe(70);
		expect(estimatePercentile(5, { p50: 0, p90: 10 })).toBeNull();
		expect(barMax(10, b)).toBe(36);
		expect(barMax(0)).toBe(1);
	});

	it("keeps the typed benchmarks in localStorage, and survives a broken or missing one", () => {
		const store = new Map<string, string>();
		const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
		expect(saveBenchmarks({ d1: { p50: 8, p90: 15 } }, storage)).toBe(true);
		expect(loadBenchmarks(storage)).toEqual({ d1: { p50: 8, p90: 15 } });
		store.set("tt-explorer-benchmarks", "{not json");
		expect(loadBenchmarks(storage)).toEqual({});
		store.set("tt-explorer-benchmarks", JSON.stringify({ d1: { p50: "x" }, d7: { p50: 2, p90: 5 } }));
		expect(loadBenchmarks(storage)).toEqual({ d7: { p50: 2, p90: 5 } });
		const throwing = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		};
		expect(loadBenchmarks(throwing)).toEqual({});
		expect(saveBenchmarks({}, throwing)).toBe(false);
		expect(loadBenchmarks(undefined)).toEqual({});
	});
});

describe("storage", () => {
	it("is read from GET /v1/storage; sizes print in binary units", async () => {
		const urls: string[] = [];
		const api = createApi({
			fetch: (async (input: RequestInfo | URL) => {
				urls.push(String(input));
				return new Response(JSON.stringify({ totalBytes: 5, parts: [] }), { status: 200 });
			}) as typeof fetch,
		});
		expect((await api.storage()).totalBytes).toBe(5);
		expect(urls).toEqual(["/api/v1/storage"]);
		expect(fmtBytes(512)).toBe("512 B");
		expect(fmtBytes(1536)).toBe("1.5 KB");
		expect(fmtBytes(250 * 1024 * 1024)).toBe("250 MB");
		expect(fmtBytes(null)).toBe("–");
	});
});
