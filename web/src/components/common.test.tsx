// @vitest-environment jsdom
import type { UseQueryResult } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { QueryState } from "./common";

afterEach(cleanup);

const query = <T,>(partial: Partial<UseQueryResult<T, Error>>) => partial as UseQueryResult<T, Error>;

describe("QueryState", () => {
	it("shows the data, or the empty text for sparse data", () => {
		render(<QueryState query={query({ isPending: false, isError: false, data: { players: 3 } })}>{(d) => <p>players {d.players}</p>}</QueryState>);
		expect(screen.getByText("players 3")).toBeTruthy();
		cleanup();
		render(
			<QueryState query={query({ isPending: false, isError: false, data: { rows: [] as number[] } })} isEmpty={(d) => d.rows.length === 0} empty="Nothing yet.">
				{() => <p>table</p>}
			</QueryState>,
		);
		expect(screen.getByText("Nothing yet.")).toBeTruthy();
		expect(screen.queryByText("table")).toBeNull();
	});

	it("explains a missing admin token and an older server", () => {
		render(<QueryState query={query({ isPending: false, isError: true, error: new ApiError(503, "no admin token", "/v1/queries") })}>{() => null}</QueryState>);
		expect(screen.getByText("no admin token")).toBeTruthy();
		expect(screen.getByText(/--game <game repo>/)).toBeTruthy();
		cleanup();
		render(
			<QueryState query={query({ isPending: false, isError: true, error: new ApiError(404, 'unknown query "players"', "/v1/query/players") })}>
				{() => null}
			</QueryState>,
		);
		expect(screen.getByText(/update and restart the backend/)).toBeTruthy();
	});
});
