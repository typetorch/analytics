import { describe, expect, it } from "vitest";
import {
	buildSearchIndex,
	clearViewParams,
	compareNormalised,
	copyValue,
	csvField,
	decodeStored,
	defaultView,
	describeFilter,
	effectiveView,
	encodeStored,
	filterEntries,
	filterOptions,
	hasViewParams,
	isDefaultView,
	normalise,
	numberBounds,
	paramsToView,
	resolveColumns,
	toCsv,
	toEpochMs,
	typeFromSql,
	viewToParams,
	type ColumnFilter,
	type DataColumn,
	type TableView,
} from "./model";

interface Server {
	job: string;
	branch: string | null;
	health: "ok" | "degraded" | "failing";
	players: number;
	max: number;
	memoryMb: number | null;
	tps: number | null;
	seen: string;
	up: boolean;
}

const NOW = Date.parse("2026-10-09T12:00:00Z");
const servers: Server[] = [
	{ job: "job-10", branch: "dev", health: "ok", players: 47, max: 60, memoryMb: 812, tps: 59.8, seen: "2026-10-09T11:59:30Z", up: true },
	{ job: "job-2", branch: "prod", health: "failing", players: 5, max: 60, memoryMb: 95, tps: 12, seen: "2026-10-09T09:00:00Z", up: false },
	{ job: "job-1", branch: null, health: "degraded", players: 110, max: 120, memoryMb: null, tps: null, seen: "2026-10-08T12:00:00Z", up: true },
	{ job: "job-3", branch: "prod", health: "ok", players: 9, max: 60, memoryMb: 1203, tps: 30.5, seen: "2026-10-09T11:00:00Z", up: true },
];

const specs: DataColumn<Server>[] = [
	{ id: "job", header: "Job", accessor: (s) => s.job },
	{ id: "branch", header: "Branch", type: "enum", accessor: (s) => s.branch },
	{ id: "health", header: "Health", type: "enum", order: ["ok", "degraded", "failing"], accessor: (s) => s.health },
	// Shown as "47 / 60" but sorted and filtered by the player count.
	{ id: "players", header: "Players", accessor: (s) => s.players, cell: (s) => `${s.players} / ${s.max}` },
	// Shown as "1.2 GB" / "812 MB": the number is what counts.
	{ id: "memory", header: "Memory", accessor: (s) => s.memoryMb, format: (v) => (v === null ? "" : `${v} MB`) },
	{ id: "tps", header: "TPS", accessor: (s) => s.tps },
	// Shown as "30 s ago": the timestamp is what counts.
	{ id: "seen", header: "Seen", type: "date", accessor: (s) => s.seen, format: () => "x ago" },
	{ id: "up", header: "Up", accessor: (s) => s.up },
];
const cols = resolveColumns(specs, servers);
const col = (id: string) => cols.find((c) => c.id === id)!;

/** Rows sorted the way the table sorts one column (undefined last in both directions). */
function sortedBy(id: string, desc = false): string[] {
	const c = col(id);
	const order = c.spec.order;
	const rows = servers.map((row, i) => ({ row, i, v: c.norm(row) }));
	rows.sort((a, b) => {
		if (a.v === undefined || b.v === undefined) return a.v === b.v ? a.i - b.i : a.v === undefined ? 1 : -1;
		const diff = compareNormalised(a.v, b.v, order);
		return (desc ? -diff : diff) || a.i - b.i;
	});
	return rows.map((r) => r.row.job);
}

describe("sorting uses the underlying value", () => {
	it("sorts numbers by number, not by the formatted text", () => {
		// As text "110" < "47" < "5" < "9"; as numbers 5 < 9 < 47 < 110.
		expect(sortedBy("players")).toEqual(["job-2", "job-3", "job-10", "job-1"]);
		expect(sortedBy("players", true)).toEqual(["job-1", "job-10", "job-3", "job-2"]);
		expect(col("players").text(servers[0]!)).toBe("47");
	});

	it("sorts a memory column shown in MB by its number, with missing values last in both directions", () => {
		expect(sortedBy("memory")).toEqual(["job-2", "job-10", "job-3", "job-1"]);
		expect(sortedBy("memory", true)).toEqual(["job-3", "job-10", "job-2", "job-1"]);
	});

	it("sorts TPS as a number and keeps rows without it last", () => {
		expect(sortedBy("tps")).toEqual(["job-2", "job-3", "job-10", "job-1"]);
		expect(sortedBy("tps", true)).toEqual(["job-10", "job-3", "job-2", "job-1"]);
	});

	it("sorts a date column by its timestamp, whatever text it shows", () => {
		expect(sortedBy("seen")).toEqual(["job-1", "job-2", "job-3", "job-10"]);
		expect(sortedBy("seen", true)).toEqual(["job-10", "job-3", "job-2", "job-1"]);
	});

	it("sorts text naturally (job-2 before job-10) and enums by their declared order", () => {
		expect(sortedBy("job")).toEqual(["job-1", "job-2", "job-3", "job-10"]);
		expect(sortedBy("health")).toEqual(["job-10", "job-3", "job-1", "job-2"]);
		expect(sortedBy("health", true)).toEqual(["job-2", "job-1", "job-10", "job-3"]);
	});

	it("sorts booleans false before true", () => {
		expect(sortedBy("up")).toEqual(["job-2", "job-10", "job-1", "job-3"]);
	});

	it("guesses the type from the values when none is given", () => {
		expect(col("job").type).toBe("text");
		expect(col("players").type).toBe("number");
		expect(col("up").type).toBe("boolean");
		expect(col("tps").type).toBe("number");
		expect(resolveColumns([{ id: "t", header: "T", accessor: (d: Date) => d }], [new Date()])[0]!.type).toBe("date");
	});

	it("reads dates as ms, Date, ISO, day-only or the server's UTC text", () => {
		const iso = Date.parse("2026-10-09T12:00:00Z");
		expect(toEpochMs(iso)).toBe(iso);
		expect(toEpochMs(new Date(iso))).toBe(iso);
		expect(toEpochMs("2026-10-09T12:00:00Z")).toBe(iso);
		expect(toEpochMs("2026-10-09 12:00:00")).toBe(iso);
		expect(toEpochMs("2026-10-09")).toBe(Date.parse("2026-10-09T00:00:00Z"));
		expect(toEpochMs("never")).toBeUndefined();
		expect(toEpochMs(null)).toBeUndefined();
	});

	it("treats numeric strings as numbers (SQL bigints) and junk as missing", () => {
		expect(normalise("42", "number")).toBe(42);
		expect(normalise("n/a", "number")).toBeUndefined();
		expect(normalise(Number.NaN, "number")).toBeUndefined();
		expect(normalise(7n, "number")).toBe(7);
		expect(normalise(true, "boolean")).toBe(1);
	});

	it("maps DuckDB column types", () => {
		expect(typeFromSql("BIGINT")).toBe("number");
		expect(typeFromSql("DOUBLE")).toBe("number");
		expect(typeFromSql("DECIMAL(18,3)")).toBe("number");
		expect(typeFromSql("BOOLEAN")).toBe("boolean");
		expect(typeFromSql("TIMESTAMP WITH TIME ZONE")).toBe("date");
		expect(typeFromSql("VARCHAR")).toBeUndefined();
	});
});

describe("filters", () => {
	const index = (visible = cols) => buildSearchIndex(servers, visible.filter((c) => c.searchable));
	const run = (view: { search?: string; filters?: Record<string, ColumnFilter> }, visible = cols) =>
		filterEntries(servers, cols, { search: view.search ?? "", filters: view.filters ?? {} }, index(visible), NOW).map((e) => e.row.job);

	it("searches every visible column, all words, any case", () => {
		expect(run({ search: "PROD" })).toEqual(["job-2", "job-3"]);
		expect(run({ search: "prod ok" })).toEqual(["job-3"]);
		expect(run({ search: "job-10" })).toEqual(["job-10"]);
		expect(run({ search: "nothing like this" })).toEqual([]);
		expect(run({ search: "  " })).toHaveLength(4);
	});

	it("searches what is shown and the underlying value", () => {
		expect(run({ search: "812 mb" })).toEqual(["job-10"]);
		expect(run({ search: "812" })).toEqual(["job-10"]);
		expect(run({ search: "2026-10-08" })).toEqual(["job-1"]);
	});

	it("searches only the visible columns", () => {
		const withoutBranch = cols.filter((c) => c.id !== "branch");
		expect(run({ search: "dev" })).toEqual(["job-10"]);
		expect(run({ search: "dev" }, withoutBranch)).toEqual([]);
	});

	it("filters by a set of values (an enum column), the empty value included", () => {
		expect(run({ filters: { health: { kind: "set", values: ["ok"] } } })).toEqual(["job-10", "job-3"]);
		expect(run({ filters: { health: { kind: "set", values: ["ok", "failing"] } } })).toEqual(["job-10", "job-2", "job-3"]);
		expect(run({ filters: { branch: { kind: "set", values: [""] } } })).toEqual(["job-1"]);
		expect(run({ filters: { up: { kind: "set", values: ["false"] } } })).toEqual(["job-2"]);
	});

	it("filters a number column by its number range, ends inclusive, rows without a number out", () => {
		expect(run({ filters: { players: { kind: "range", min: 9, max: 47 } } })).toEqual(["job-10", "job-3"]);
		expect(run({ filters: { memory: { kind: "range", min: 800 } } })).toEqual(["job-10", "job-3"]);
		expect(run({ filters: { memory: { kind: "range", max: 100 } } })).toEqual(["job-2"]);
	});

	it("filters a date column by how long ago", () => {
		expect(run({ filters: { seen: { kind: "since", within: "1h" } } })).toEqual(["job-10", "job-3"]);
		expect(run({ filters: { seen: { kind: "since", within: "24h" } } })).toEqual(["job-10", "job-2", "job-1", "job-3"]);
	});

	it("combines the search and every column filter (and)", () => {
		expect(run({ search: "prod", filters: { health: { kind: "set", values: ["ok"] }, players: { kind: "range", min: 5, max: 9 } } })).toEqual(["job-3"]);
	});

	it("filters a text column by 'contains'", () => {
		expect(run({ filters: { job: { kind: "text", q: "JOB-1" } } })).toEqual(["job-10", "job-1"]);
	});

	it("lists the choices of an enum with counts, in the declared order", () => {
		expect(filterOptions(col("health"), servers).map((o) => [o.value, o.count])).toEqual([
			["ok", 2],
			["degraded", 1],
			["failing", 1],
		]);
		const branch = filterOptions(col("branch"), servers);
		expect(branch.map((o) => o.value)).toEqual(["dev", "prod", ""]);
		expect(branch.at(-1)?.label).toBe("(empty)");
	});

	it("offers declared options that no row has", () => {
		const c = resolveColumns([{ id: "level", header: "Level", type: "enum", options: ["critical", "warning"], accessor: (s: { level: string }) => s.level }], [{ level: "warning" }])[0]!;
		expect(filterOptions(c, [{ level: "warning" }]).map((o) => [o.value, o.count])).toEqual([
			["critical", 0],
			["warning", 1],
		]);
	});

	it("finds the bounds of a number column", () => {
		expect(numberBounds(col("memory"), servers)).toEqual({ min: 95, max: 1203 });
		expect(numberBounds(col("branch"), servers)).toBeNull();
	});

	it("describes a filter for its chip", () => {
		expect(describeFilter(col("health"), { kind: "set", values: ["ok", "failing"] })).toBe("ok, failing");
		expect(describeFilter(col("health"), { kind: "set", values: ["a", "b", "c", "d", "e"] })).toBe("a, b, c +2");
		expect(describeFilter(col("players"), { kind: "range", min: 5, max: 20 })).toBe("5 to 20");
		expect(describeFilter(col("players"), { kind: "range", min: 5 })).toBe("at least 5");
		expect(describeFilter(col("seen"), { kind: "since", within: "24h" })).toBe("last 24 hours");
	});
});

describe("CSV", () => {
	it("quotes fields with commas, quotes and line breaks", () => {
		expect(csvField("plain")).toBe("plain");
		expect(csvField("a,b")).toBe('"a,b"');
		expect(csvField('say "hi"')).toBe('"say ""hi"""');
		expect(csvField("two\nlines")).toBe('"two\nlines"');
		expect(csvField(null)).toBe("");
		expect(csvField(12.5)).toBe("12.5");
		expect(csvField(false)).toBe("false");
		expect(csvField({ a: 1 })).toBe('"{""a"":1}"');
	});

	it("keeps a spreadsheet from running text as a formula", () => {
		expect(csvField("=SUM(A1:A9)")).toBe("'=SUM(A1:A9)");
		expect(csvField("@cmd")).toBe("'@cmd");
		expect(csvField("+1+1")).toBe("'+1+1");
		expect(csvField("-2+3")).toBe("'-2+3");
		// Real numbers stay numbers, as numbers or as numeric text.
		expect(csvField(-5)).toBe("-5");
		expect(csvField("-5")).toBe("-5");
		expect(csvField("1e3")).toBe("1e3");
	});

	it("exports the underlying values of the given columns and rows, not the formatted text", () => {
		const csv = toCsv([col("job"), col("players"), col("memory"), col("seen")], [servers[0]!, servers[2]!]);
		expect(csv).toBe(["Job,Players,Memory,Seen", "job-10,47,812,2026-10-09T11:59:30.000Z", "job-1,110,,2026-10-08T12:00:00.000Z"].join("\r\n"));
	});

	it("copies a cell's underlying value", () => {
		expect(copyValue(col("players"), servers[0]!)).toBe("47");
		expect(copyValue(col("job"), servers[0]!)).toBe("job-10");
		expect(copyValue(col("memory"), servers[2]!)).toBe("");
	});
});

describe("the saved view", () => {
	const defaults = defaultView({ sort: [{ id: "players", desc: true }] });
	const view: TableView = {
		sort: [
			{ id: "health", desc: true },
			{ id: "job", desc: false },
		],
		search: "prod, dev",
		filters: {
			health: { kind: "set", values: ["ok", "a,b"] },
			players: { kind: "range", min: 5, max: 20 },
			seen: { kind: "since", within: "24h" },
			job: { kind: "text", q: "x y" },
		},
		columns: { memory: false, up: true },
		sizes: { job: 180 },
		pageSize: 100,
	};

	it("round-trips through the URL (sizes aside)", () => {
		const params = new URLSearchParams(viewToParams("fleet-servers", view, defaults));
		expect(params.get("fleet-servers.sort")).toBe("-health,job");
		expect(params.get("fleet-servers.f.players")).toBe("range:5..20");
		expect(params.get("fleet-servers.cols")).toBe("-memory,+up");
		const back = paramsToView("fleet-servers", new URLSearchParams(params.toString()), defaults);
		expect(back).toEqual({ ...view, sizes: {} });
	});

	it("leaves defaults out of the URL, and says so when the sort was cleared", () => {
		expect(viewToParams("t", defaults, defaults)).toEqual({});
		expect(viewToParams("t", { ...defaults, sort: [] }, defaults)).toEqual({ "t.sort": "none" });
		expect(paramsToView("t", new URLSearchParams("t.sort=none"), defaults).sort).toEqual([]);
		expect(paramsToView("t", new URLSearchParams(""), defaults).sort).toEqual([{ id: "players", desc: true }]);
	});

	it("tells a table's params from other params, and removes only its own", () => {
		const params = new URLSearchParams("range=7d&t.sort=-a&t.f.a=since:1h&other.sort=b&tt.q=hi");
		expect(hasViewParams("t", params)).toBe(true);
		expect(hasViewParams("other", params)).toBe(true);
		expect(hasViewParams("tt", params)).toBe(true);
		expect(hasViewParams("nope", params)).toBe(false);
		expect(clearViewParams("t", params).toString()).toBe("range=7d&other.sort=b&tt.q=hi");
	});

	it("keeps ids with odd characters apart from the list syntax", () => {
		const odd: TableView = { ...defaults, sort: [{ id: "-n", desc: true }, { id: "a,b", desc: false }], columns: { "+x": false } };
		const params = new URLSearchParams(viewToParams("t", odd, defaults));
		const back = paramsToView("t", new URLSearchParams(params.toString()), defaults);
		expect(back.sort).toEqual(odd.sort);
		expect(back.columns).toEqual(odd.columns);
	});

	it("ignores malformed URL filters", () => {
		const params = new URLSearchParams("t.f.a=range:x..y&t.f.b=since:forever&t.f.c=nonsense&t.f.d=range:..&t.sort=,,");
		const parsed = paramsToView("t", params, defaults);
		expect(parsed.filters).toEqual({});
		expect(parsed.sort).toEqual([]);
	});

	it("round-trips through localStorage, sizes included, and isDefaultView sees only real changes", () => {
		expect(decodeStored(encodeStored(view), defaults)).toEqual(view);
		expect(isDefaultView(defaults, defaultView({ sort: [{ id: "players", desc: true }] }))).toBe(true);
		expect(isDefaultView(view, defaults)).toBe(false);
	});

	it("drops anything malformed from localStorage, field by field", () => {
		expect(decodeStored(null, defaults)).toBeNull();
		expect(decodeStored("not json", defaults)).toBeNull();
		expect(decodeStored("[]", defaults)).toBeNull();
		const messy = JSON.stringify({
			sort: [{ id: 5 }, { id: "ok", desc: true }, null],
			search: 7,
			filters: { a: { kind: "range" }, b: { kind: "set", values: [] }, c: { kind: "since", within: "1y" }, d: { kind: "set", values: ["x"] } },
			columns: { a: "yes", b: false },
			sizes: { a: 1, b: 120, c: "wide" },
			pageSize: 99999,
		});
		expect(decodeStored(messy, defaults)).toEqual({
			sort: [{ id: "ok", desc: true }],
			search: "",
			filters: { d: { kind: "set", values: ["x"] } },
			columns: { b: false },
			sizes: { b: 120 },
			pageSize: defaults.pageSize,
		});
	});

	it("applies a saved view to the columns that exist now", () => {
		const stale: TableView = {
			...defaults,
			sort: [
				{ id: "gone", desc: false },
				{ id: "players", desc: true },
				{ id: "players", desc: false },
			],
			filters: {
				gone: { kind: "set", values: ["a"] },
				// A text column can't take a range filter.
				job: { kind: "range", min: 1 },
				players: { kind: "range", min: 5 },
			},
			columns: { gone: false, memory: false, up: false },
			sizes: { gone: 100, job: 100 },
		};
		const now = effectiveView(stale, cols);
		expect(now.sort).toEqual([{ id: "players", desc: true }]);
		expect(Object.keys(now.filters)).toEqual(["players"]);
		expect(now.columns).toEqual({ memory: false, up: false });
		expect(now.sizes).toEqual({ job: 100 });
	});

	it("never hides every column", () => {
		const hideAll: TableView = { ...defaults, columns: Object.fromEntries(cols.map((c) => [c.id, false])) };
		const now = effectiveView(hideAll, cols);
		expect(now.columns.job).toBe(true);
	});

	it("keeps default-hidden columns hidden until turned on", () => {
		const hidden = resolveColumns([{ id: "a", header: "A", accessor: (r: { a: number }) => r.a }, { id: "b", header: "B", defaultHidden: true, accessor: (r: { a: number }) => r.a }], [{ a: 1 }]);
		expect(effectiveView({ ...defaults, columns: { b: true, a: true } }, hidden).columns).toEqual({ b: true });
	});
});
