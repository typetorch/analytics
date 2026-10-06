/**
 * The analytics server's node graph JSON (player-graph, flow) -> React Flow nodes and edges, laid out by dagre (left to
 * right, or top to bottom in a narrow column). States are nodes ("zone:Lobby|screen:Shop" shows as two lines) with
 * what happened in them (top events, funnel steps); key moments ("@...") are small pills. Moves are edges: labelled
 * with how often and the average time before the move, or in a one-session graph with their order (#1, #2, ...).
 * Moves back to an earlier state go around the side. `(start)` and `(left)` are the session's ends.
 */
import { graphlib, layout } from "@dagrejs/dagre";
import type { Edge, Node, Position } from "@xyflow/react";
import { edgeLabel, edgeWidth, eventsLine, moveOrder, nodeKind, orderLabel, stateLines, stepsLine, topEdges, LEFT, START, type StateNodeKind } from "./graph-text";
import type { GraphData, GraphNode } from "./types";

export * from "./graph-text";

export interface StateNodeData extends Record<string, unknown> {
	kind: StateNodeKind;
	/** The state's parts, one per line ("zone: Lobby"). */
	lines: string[];
	visits: number;
	players?: number;
	/** Average time in this state before moving on, ms (0 for start/left). */
	avgDwellMs: number;
	/** One-session graph: all the time spent in this state, ms. */
	timeMs?: number;
	/** "target_hit 34 · coin_pickup 6" and "onboarding: first_hit" (empty when nothing was logged there). */
	eventsLine: string;
	stepsLine: string;
	events: NonNullable<GraphNode["events"]>;
	steps: NonNullable<GraphNode["steps"]>;
	/** The state id as the server sent it. */
	state: string;
	/** The side where moves back to an earlier state leave and arrive (so they don't overlap the forward ones). */
	backSide: Position;
}

export interface MoveEdgeData extends Record<string, unknown> {
	count: number;
	players?: number;
	share: number;
	avgDwellMs: number;
	/** Goes back to an earlier state in the layout (drawn around the side). */
	back: boolean;
	/** One-session graph: the move numbers (1 = the first move of the session). */
	order?: number[];
}

export interface FlowLayout {
	nodes: Node<StateNodeData>[];
	edges: Edge<MoveEdgeData>[];
	/** Edges not drawn (maxEdges here plus the server's own minCount/maxEdges cut). */
	hiddenEdges: number;
}

export interface FlowOptions {
	/** Most edges to draw, busiest first (default 60). */
	maxEdges?: number;
	direction?: "LR" | "TB";
}

/** A rough box size for a node, so dagre leaves room for its text. `extra` = the other text lines' lengths. */
export function nodeSize(lines: string[], kind: StateNodeKind, extra: number[] = []): { width: number; height: number } {
	if (kind === "start" || kind === "left") return { width: 130, height: 40 };
	if (kind === "moment") return { width: Math.round(Math.max(90, Math.min(260, 28 + (lines[0]?.length ?? 0) * 6.6))), height: 28 };
	const longest = Math.max(12, ...lines.map((l) => l.length));
	const small = Math.max(0, ...extra);
	return { width: Math.round(Math.min(340, 28 + Math.max(longest * 7.2, small * 6.4))), height: 34 + lines.length * 18 + extra.slice(1).filter(Boolean).length * 16 };
}

export function toFlow(graph: GraphData, options: FlowOptions = {}): FlowLayout {
	const edges = topEdges(graph.edges, options.maxEdges ?? 60);
	const used = new Set<string>();
	for (const e of edges) used.add(e.from).add(e.to);
	// Nodes the drawn edges touch; a graph with no edges still shows its states (e.g. one visit, session still on).
	const byId = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
	const ids = edges.length ? [...used] : graph.nodes.map((n) => n.id);
	const order = (id: string) => (id === START ? -1 : id === LEFT ? 1 : 0);
	ids.sort((a, b) => order(a) - order(b) || (byId.get(b)?.visits ?? 0) - (byId.get(a)?.visits ?? 0) || a.localeCompare(b));
	const key = new Map(ids.map((id, i) => [id, `n${i}`]));
	const single = Boolean(graph.path);
	const moves = moveOrder(graph);

	const g = new graphlib.Graph();
	const tb = options.direction === "TB";
	g.setGraph({ rankdir: tb ? "TB" : "LR", nodesep: tb ? 24 : 28, ranksep: tb ? 56 : 90, marginx: 16, marginy: 16 });
	g.setDefaultEdgeLabel(() => ({}));
	const sizes = new Map<string, { width: number; height: number }>();
	for (const id of ids) {
		const n = byId.get(id);
		// Room for the "N visits · N players · 1m 05s" line and the events / steps lines under the label.
		const meta = n ? `${n.visits} visits · ${n.players ?? 0} players · 10m 00s`.length : 0;
		const size = nodeSize(stateLines(id), nodeKind(id), [meta, n ? eventsLine(n).length : 0, n ? stepsLine(n).length : 0]);
		sizes.set(id, size);
		g.setNode(key.get(id) as string, { ...size });
	}
	for (const e of edges) g.setEdge(key.get(e.from) as string, key.get(e.to) as string);
	layout(g);

	const nodes: Node<StateNodeData>[] = ids.map((id) => {
		const n = byId.get(id);
		const pos = g.node(key.get(id) as string) as { x: number; y: number };
		const size = sizes.get(id) as { width: number; height: number };
		const data: StateNodeData = {
			kind: nodeKind(id),
			state: id,
			lines: stateLines(id),
			visits: n?.visits ?? 0,
			avgDwellMs: n && n.visits ? n.dwellMs / n.visits : 0,
			eventsLine: n ? eventsLine(n) : "",
			stepsLine: n ? stepsLine(n) : "",
			events: n?.events ?? [],
			steps: n?.steps ?? [],
			backSide: (tb ? "right" : "bottom") as Position,
		};
		if (single && n) data.timeMs = n.dwellMs;
		if (n?.players !== undefined) data.players = n.players;
		return {
			id: key.get(id) as string,
			type: "state",
			sourcePosition: (tb ? "bottom" : "right") as Position,
			targetPosition: (tb ? "top" : "left") as Position,
			position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
			data,
			width: size.width,
			height: size.height,
		};
	});

	const center = (id: string) => g.node(key.get(id) as string) as { x: number; y: number };
	const maxCount = Math.max(1, ...edges.map((e) => e.count));
	const flowEdges: Edge<MoveEdgeData>[] = edges.map((e, i) => {
		const from = center(e.from);
		const to = center(e.to);
		const back = tb ? to.y <= from.y : to.x <= from.x;
		const numbers = moves.get(`${e.from}>${e.to}`);
		const data: MoveEdgeData = { count: e.count, share: e.share, avgDwellMs: e.count ? e.dwellMs / e.count : 0, back };
		if (e.players !== undefined) data.players = e.players;
		if (numbers) data.order = numbers;
		return {
			id: `e${i}`,
			source: key.get(e.from) as string,
			target: key.get(e.to) as string,
			sourceHandle: back ? "back-s" : "s",
			targetHandle: back ? "back-t" : "t",
			label: numbers ? orderLabel(numbers) : edgeLabel(e),
			data,
			style: { strokeWidth: single ? 2 : edgeWidth(e.count, maxCount) },
		};
	});

	return { nodes, edges: flowEdges, hiddenEdges: graph.hiddenEdges + (graph.edges.length - edges.length) };
}
