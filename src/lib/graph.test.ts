import { describe, expect, it } from "vitest";
import { edgeWidth, eventsLine, exits, LEFT, moveOrder, nodeKind, realStates, START, stateLines, stepsLine, toFlow, toMermaid } from "./graph";
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

	/** A one-session graph with key moments, as player-graph answers with sid and moments. */
	const session: GraphData = {
		kind: "player",
		facet: "all",
		pid: "p1",
		sid: "s1",
		moments: true,
		nodes: [
			{ id: START, visits: 1, dwellMs: 0 },
			{
				id: "activity:lobby",
				visits: 2,
				dwellMs: 90_000,
				players: 1,
				events: [
					{ kind: "custom", name: "coin_pickup", count: 6 },
					{ kind: "custom", name: "pad_start", count: 1 },
				],
				steps: [{ funnel: "onboarding", step: "spawned", index: 1, count: 1, players: 1 }],
			},
			{ id: "activity:round", visits: 1, dwellMs: 120_000, players: 1, events: [{ kind: "custom", name: "target_hit", count: 34 }], steps: [] },
			{ id: "@onboarding: first_hit", visits: 1, dwellMs: 5_000, players: 1 },
			{ id: LEFT, visits: 1, dwellMs: 0 },
		],
		edges: [
			{ from: START, to: "activity:lobby", count: 1, dwellMs: 0, share: 1 },
			{ from: "activity:lobby", to: "activity:round", count: 1, dwellMs: 60_000, share: 0.5 },
			{ from: "activity:round", to: "@onboarding: first_hit", count: 1, dwellMs: 10_000, share: 1 },
			{ from: "@onboarding: first_hit", to: "activity:lobby", count: 1, dwellMs: 5_000, share: 1 },
			{ from: "activity:lobby", to: LEFT, count: 1, dwellMs: 30_000, share: 0.5 },
		],
		hiddenEdges: 0,
		path: [
			{ step: 1, state: "activity:lobby", at: "2026-10-06T10:00:00.000Z", ms: 60_000 },
			{ step: 2, state: "activity:round", at: "2026-10-06T10:01:00.000Z", ms: 10_000 },
			{ step: 3, state: "@onboarding: first_hit", at: "2026-10-06T10:01:10.000Z", ms: 5_000 },
			{ step: 4, state: "activity:lobby", at: "2026-10-06T10:01:15.000Z", ms: 30_000 },
		],
		ended: true,
	};

	it("one session: edges numbered in the order the player moved, nodes carry the time spent", () => {
		const order = moveOrder(session);
		expect(order.get(`${START}>activity:lobby`)).toEqual([1]);
		expect(order.get("activity:lobby>activity:round")).toEqual([2]);
		expect(order.get("@onboarding: first_hit>activity:lobby")).toEqual([4]);
		expect(order.get(`activity:lobby>${LEFT}`)).toEqual([5]);
		const flow = toFlow(session);
		expect(flow.edges.map((e) => e.label).sort()).toEqual(["#1", "#2", "#3", "#4", "#5"]);
		const lobby = flow.nodes.find((n) => n.data.state === "activity:lobby");
		expect(lobby?.data.timeMs).toBe(90_000);
		expect(toMermaid(session)).toContain('-->|"#2"|');
		// A path that revisits the same move lists every number.
		const twice = moveOrder({ ...session, path: [...(session.path ?? []), { step: 5, state: "activity:round", at: "", ms: 1 }], ended: false });
		expect(twice.get("activity:lobby>activity:round")).toEqual([2, 5]);
		expect(twice.has(`activity:lobby>${LEFT}`)).toBe(false);
	});

	it("nodes say what happened there; moments are small pills; sparse graphs are counted", () => {
		const flow = toFlow(session);
		const lobby = flow.nodes.find((n) => n.data.state === "activity:lobby");
		expect(lobby?.data.eventsLine).toBe("coin_pickup 6 · pad_start 1");
		expect(lobby?.data.stepsLine).toBe("onboarding: spawned");
		const moment = flow.nodes.find((n) => n.data.state === "@onboarding: first_hit");
		expect(moment?.data.kind).toBe("moment");
		expect(moment?.data.lines).toEqual(["onboarding: first_hit"]);
		expect(moment?.height).toBe(28);
		expect((lobby?.height ?? 0) > 52).toBe(true); // room for the events and steps lines
		expect(nodeKind("@round_end")).toBe("moment");
		expect(eventsLine({ events: [] })).toBe("");
		expect(stepsLine({ steps: [1, 2, 3, 4].map((i) => ({ funnel: "round", step: `s${i}`, index: i, count: 1, players: 1 })) })).toBe("round: s1, round: s2, round: s3, +1");
		expect(realStates(session)).toBe(2);
		expect(realStates(graph)).toBe(2);
		expect(toMermaid(session)).toContain('(["onboarding: first_hit"])');
	});
});
