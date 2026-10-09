// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DataTable } from "@/components/data-table";
import { resolveColumns } from "@/components/data-table/model";
import type { SqlResult } from "@/lib/types";
import { sqlColumns } from "./Query";

beforeAll(() => {
	globalThis.ResizeObserver ??= class {
		observe() {}
		unobserve() {}
		disconnect() {}
	} as unknown as typeof ResizeObserver;
});
beforeEach(() => localStorage.clear());
afterEach(cleanup);

const result: SqlResult = {
	columns: [
		{ name: "t", type: "BIGINT" },
		{ name: "name", type: "VARCHAR" },
		{ name: "n", type: "BIGINT" },
		{ name: "n", type: "DOUBLE" },
		{ name: "ok", type: "BOOLEAN" },
		{ name: "props", type: "JSON" },
	],
	rows: [
		[1760000000000, "alpha", 9, 1.5, true, '{"a":1}'],
		[1760000060000, "beta", 10, 20.25, false, null],
		[1760000120000, "gamma", 100, null, true, '{"b":2}'],
	],
	truncated: false,
	ms: 4,
};

describe("SQL result columns", () => {
	it("names columns by the SQL column, makes repeated names unique, and keeps the DuckDB type as a hint", () => {
		const cols = sqlColumns(result.columns);
		expect(cols.map((c) => c.id)).toEqual(["t", "name", "n", "n_2", "ok", "props"]);
		expect(cols[2]?.hint).toBe("BIGINT");
	});

	it("maps types: numbers, booleans and unix-ms `t` as a time; the rest as text", () => {
		const resolved = resolveColumns(sqlColumns(result.columns), result.rows);
		expect(resolved.map((c) => c.type)).toEqual(["date", "text", "number", "number", "boolean", "text"]);
		expect(resolved.map((c) => c.filterKind)).toEqual(["since", "text", "range", "range", "set", "text"]);
	});

	it("exports `t` as the number the query returned", () => {
		const t = resolveColumns(sqlColumns(result.columns), result.rows)[0]!;
		expect(t.exportValue(result.rows[1]!)).toBe(1760000060000);
	});
});

describe("SQL result table", () => {
	function mount() {
		return render(
			<MemoryRouter>
				<DataTable id="query-sql" columns={sqlColumns(result.columns)} data={result.rows} search />
			</MemoryRouter>,
		);
	}
	const firstColumn = (at: number) => Array.from(document.querySelectorAll("tbody tr")).map((tr) => tr.querySelectorAll("td")[at]?.textContent);

	it("sorts a BIGINT column by its number (100 after 10 after 9), not as text", () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: /^n BIGINT/ }));
		expect(firstColumn(2)).toEqual(["100", "10", "9"]);
		fireEvent.click(screen.getByRole("button", { name: /^n BIGINT/ }));
		expect(firstColumn(2)).toEqual(["9", "10", "100"]);
	});

	it("sorts rows without a value last in both directions", () => {
		mount();
		fireEvent.click(screen.getByRole("button", { name: /^n DOUBLE/ }));
		expect(firstColumn(1)).toEqual(["beta", "alpha", "gamma"]);
		fireEvent.click(screen.getByRole("button", { name: /^n DOUBLE/ }));
		expect(firstColumn(1)).toEqual(["alpha", "beta", "gamma"]);
	});
});
