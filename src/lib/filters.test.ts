import { describe, expect, it } from "vitest";
import { activeFilterCount, readFilters, toApiFilters, writeFilters } from "./filters";

const NOW = Date.UTC(2026, 9, 5, 18, 0, 0);

describe("filters", () => {
	it("read from the URL, ignoring junk", () => {
		const s = readFilters(new URLSearchParams("range=7d&branch=dev&dev=fridge&players=new&exp=lobby_hint&variant=none&pid=abc"));
		expect(s).toEqual({ range: "7d", branch: "dev", players: "new", exp: "lobby_hint", variant: "none" });
		expect(readFilters(new URLSearchParams("range=nope&from=2026-01-01")).range).toBe("30d");
		expect(readFilters(new URLSearchParams("range=custom&from=2026-10-01&to=bad"))).toEqual({ range: "custom", from: "2026-10-01" });
	});

	it("written back keeping page parameters, defaults left out", () => {
		const next = writeFilters({ range: "30d", dev: "phone" }, new URLSearchParams("pid=abc&branch=old"));
		expect(next.toString()).toBe("pid=abc&dev=phone");
		expect(readFilters(writeFilters({ range: "custom", from: "2026-09-01", to: "2026-09-30", art: "a1" }, new URLSearchParams()))).toEqual({
			range: "custom",
			from: "2026-09-01",
			to: "2026-09-30",
			art: "a1",
		});
	});

	it("become the server's filters (UTC days; presets include today)", () => {
		expect(toApiFilters({ range: "7d" }, NOW)).toEqual({ from: "2026-09-29" });
		expect(toApiFilters({ range: "1d" }, NOW)).toEqual({ from: "2026-10-05" });
		expect(toApiFilters({ range: "custom", from: "2026-09-01", to: "2026-09-30", dev: "phone", players: "returning" }, NOW)).toEqual({
			from: "2026-09-01",
			to: "2026-09-30",
			dev: "phone",
			players: "returning",
		});
		expect(toApiFilters({ range: "30d", exp: "e" }, NOW)).toEqual({ from: "2026-09-06" });
		expect(toApiFilters({ range: "30d", exp: "e", variant: "b" }, NOW).variant).toEqual({ experiment: "e", variant: "b" });
		expect(activeFilterCount({ range: "7d", branch: "dev", exp: "e" })).toBe(1);
	});
});
