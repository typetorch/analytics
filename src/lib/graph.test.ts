import { describe, expect, it } from "vitest";
import { edgeWidth, exits, LEFT, START, stateLines, toFlow, toMermaid } from "./graph";
import type { GraphData } from "./types";

/** The live server's player graph for its one test player (2026-10-05), plus a (left) edge. */
const graph: GraphData = {
	kind: "player",
	facet: "all",
	pid: "18245d7c22f64d32b32ae12b4c221da6",
	nodes: [
		{ id: START, visits: 2, dwellMs: 0 },
		{ id: "activity:lobby", visits: 4, dwellMs: 1367, players: 1 },
		{ id: "screen:TargetRush|activity:lobby", visits: 3, dwellMs: 172, players: 1 },
		{ id: LEFT, visits: 1, dwellMs: 0 },
	],
	edges: [
		{ from: "activity:lobby", to: "screen:TargetRush|activity:lobby", count: 3, dwellMs: 1367, share: 1, players: 1 },
		{ from: START, to: "activity:lobby", count: 2, dwellMs: 0, share: 1, players: 1 },
		{ from: "screen:TargetRush|activity:lobby", to: "activity:lobby", count: 2, dwellMs: 172, share: 0.67, players: 1 },
		{ from: "screen:TargetRush|activity:lobby", to: LEFT, count: 1, dwellMs: 1_099_000, share: 0.33, players: 1 },
	],
	hiddenEdges: 0,
};

describe("graph adapter", () => {
	it("state ids become readable lines", () => {
		expect(stateLines("screen:TargetRush|activity:lobby")).toEqual(["screen: TargetRush", "activity: lobby"]);
		expect(stateLines("Lobby")).toEqual(["Lobby"]);
		expect(stateLines(START)).toEqual(["start"]);
		expect(stateLines(LEFT)).toEqual(["left the game"]);
	});

	it("lays out every node and edge left to right, start first", () => {
		const flow = toFlow(graph);
		expect(flow.nodes).toHaveLength(4);
		expect(flow.edges).toHaveLength(4);
		const byLabel = new Map(flow.nodes.map((n) => [n.data.lines.join(" | "), n]));
		const start = byLabel.get("start");
		const lobby = byLabel.get("activity: lobby");
		const left = byLabel.get("left the game");
		expect(start?.data.kind).toBe("start");
		expect(left?.data.kind).toBe("left");
		expect(start && lobby && start.position.x < lobby.position.x).toBe(true);
		expect(lobby?.data).toMatchObject({ visits: 4, players: 1 });
		expect(lobby?.data.avgDwellMs).toBeCloseTo(1367 / 4);
		for (const n of flow.nodes) expect(Number.isFinite(n.position.x) && Number.isFinite(n.position.y)).toBe(true);
		// Edges point at node ids, carry "count · avg time" labels and a width by count.
		const ids = new Set(flow.nodes.map((n) => n.id));
		for (const e of flow.edges) expect(ids.has(e.source) && ids.has(e.target)).toBe(true);
		expect(flow.edges[0].label).toBe("3 · 0s");
		expect(flow.edges.find((e) => e.data?.count === 2 && e.label === "2")).toBeDefined(); // from start: no time
		expect(flow.edges.find((e) => e.data?.count === 1)?.label).toBe("1 · 18m 19s");
		expect(flow.edges[0].style?.strokeWidth).toBe(6);
		expect(edgeWidth(1, 3)).toBe(3);
		// A move back to an earlier state goes around the side, not over the forward edge.
		const back = flow.edges.find((e) => e.label === "2 · 0s");
		expect(back?.data?.back).toBe(true);
		expect(back?.sourceHandle).toBe("back-s");
		expect(flow.edges[0]).toMatchObject({ sourceHandle: "s", targetHandle: "t" });
		const tb = toFlow(graph, { direction: "TB" });
		expect(tb.nodes[0].sourcePosition).toBe("bottom");
		expect(tb.nodes[0].data.backSide).toBe("right");
	});

	it("drops the smallest edges past maxEdges and counts them", () => {
		const flow = toFlow({ ...graph, hiddenEdges: 5 }, { maxEdges: 2 });
		expect(flow.edges).toHaveLength(2);
		expect(flow.hiddenEdges).toBe(7);
		expect(flow.nodes.map((n) => n.data.lines[0]).sort()).toEqual(["activity: lobby", "screen: TargetRush", "start"].sort());
	});

	it("a graph without edges still shows its states", () => {
		const flow = toFlow({ ...graph, nodes: [{ id: "zone:Lobby", visits: 1, dwellMs: 0 }], edges: [] });
		expect(flow.nodes).toHaveLength(1);
		expect(flow.edges).toHaveLength(0);
	});

	it("exports Mermaid like the analytics package, and lists exits", () => {
		const text = toMermaid(graph);
		expect(text.startsWith("flowchart LR\n")).toBe(true);
		expect(text).toContain('(["start"])');
		expect(text).toContain('["screen:TargetRush<br/>activity:lobby<br/><small>3 visits, 1 player</small>"]');
		expect(text).toContain('-->|"3 · 0s"|');
		expect(text).toContain("linkStyle 0 stroke-width:6px");
		expect(exits(graph)).toEqual([{ state: "screen:TargetRush|activity:lobby", count: 1, share: 1 }]);
	});
});
