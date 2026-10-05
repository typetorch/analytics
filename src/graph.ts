/**
 * Node graphs (plans/16 section 4): states are nodes, moves between them are edges with how often and how long the
 * player stayed before moving. One player's graph covers all their sessions; a flow graph merges everyone matching
 * a filter. `(start)` and `(left)` are the session's start and end. Exported as Mermaid (any Markdown viewer) or JSON.
 */

export const START = "(start)";
export const LEFT = "(left)";

export interface GraphNode {
	id: string;
	/** Times a session entered this state (start/left: sessions). */
	visits: number;
	/** Distinct players (absent when unknown). */
	players?: number;
	/** Total time spent in this state before moving on, ms. */
	dwellMs: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	count: number;
	players?: number;
	/** Total time spent in `from` before taking this edge, ms. */
	dwellMs: number;
	/** Share of `from`'s outgoing moves that took this edge (0-1). */
	share: number;
}

export interface GraphData {
	kind: "player" | "flow";
	/** Which part of the state the nodes are: all of it, or only zone / screen / activity. */
	facet: string;
	pid?: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	/** Edges left out by minCount / maxEdges. */
	hiddenEdges: number;
}

export interface MermaidOptions {
	/** Most edges to draw (busiest first; default 40). */
	maxEdges?: number;
	direction?: "LR" | "TD";
	/** Average time before each move on the edge labels (default true). */
	times?: boolean;
}

/** "45s", "2m 05s", "1h 03m". */
export function formatDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function escapeLabel(text: string): string {
	return text.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
}

/** A state as a node label: `zone:Lobby|screen:Shop` on two lines. */
function nodeLabel(id: string): string {
	return id.split("|").map(escapeLabel).join("<br/>");
}

export class Graph implements GraphData {
	kind: "player" | "flow";
	facet: string;
	pid?: string;
	nodes: GraphNode[];
	edges: GraphEdge[];
	hiddenEdges: number;

	constructor(data: GraphData) {
		this.kind = data.kind;
		this.facet = data.facet;
		if (data.pid !== undefined) this.pid = data.pid;
		this.nodes = data.nodes;
		this.edges = data.edges;
		this.hiddenEdges = data.hiddenEdges ?? 0;
	}

	/** Rebuilds a Graph from its JSON (e.g. an analytics server response). */
	static fromJSON(data: GraphData | string): Graph {
		return new Graph(typeof data === "string" ? (JSON.parse(data) as GraphData) : data);
	}

	toJSON(): GraphData {
		const out: GraphData = { kind: this.kind, facet: this.facet, nodes: this.nodes, edges: this.edges, hiddenEdges: this.hiddenEdges };
		if (this.pid !== undefined) out.pid = this.pid;
		return out;
	}

	/** Busiest moves first. */
	topEdges(limit = 10): GraphEdge[] {
		return [...this.edges].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)).slice(0, limit);
	}

	/** States where sessions ended, most first. */
	exits(): { state: string; count: number; share: number }[] {
		const ends = this.edges.filter((e) => e.to === LEFT);
		const total = ends.reduce((sum, e) => sum + e.count, 0);
		return ends
			.map((e) => ({ state: e.from, count: e.count, share: total ? e.count / total : 0 }))
			.sort((a, b) => b.count - a.count);
	}

	toMermaid(options: MermaidOptions = {}): string {
		const maxEdges = options.maxEdges ?? 40;
		const times = options.times ?? true;
		const edges = this.topEdges(maxEdges);
		const used = new Set<string>();
		for (const e of edges) used.add(e.from).add(e.to);
		const ids = new Map<string, string>();
		const lines = [`flowchart ${options.direction ?? "LR"}`];
		const nodes = this.nodes.filter((n) => used.has(n.id));
		for (const id of used) if (!nodes.some((n) => n.id === id)) nodes.push({ id, visits: 0, dwellMs: 0 });
		nodes.forEach((node, i) => {
			const key = `n${i}`;
			ids.set(node.id, key);
			if (node.id === START || node.id === LEFT) {
				lines.push(`  ${key}(["${node.id === START ? "start" : "left"}"])`);
			} else {
				const who = node.players !== undefined ? `, ${node.players} player${node.players === 1 ? "" : "s"}` : "";
				lines.push(`  ${key}["${nodeLabel(node.id)}<br/><small>${node.visits} visit${node.visits === 1 ? "" : "s"}${who}</small>"]`);
			}
		});
		const maxCount = Math.max(1, ...edges.map((e) => e.count));
		edges.forEach((edge) => {
			const avg = edge.count ? edge.dwellMs / edge.count : 0;
			const label = times && edge.from !== START ? `${edge.count} · ${formatDuration(avg)}` : `${edge.count}`;
			lines.push(`  ${ids.get(edge.from)} -->|"${escapeLabel(label)}"| ${ids.get(edge.to)}`);
		});
		edges.forEach((edge, i) => {
			const width = 1 + Math.round((edge.count / maxCount) * 5);
			lines.push(`  linkStyle ${i} stroke-width:${width}px`);
		});
		if (this.hiddenEdges + (this.edges.length - edges.length) > 0) {
			lines.push(`  %% ${this.hiddenEdges + this.edges.length - edges.length} smaller edges not drawn`);
		}
		return `${lines.join("\n")}\n`;
	}
}

export interface EdgeRow {
	src: string;
	dst: string;
	n: number;
	players?: number;
	dwell_ms: number;
}

export interface NodeRow {
	st: string;
	visits: number;
	players?: number;
}

/** Builds a Graph from the graph query's edge and node rows. */
export function buildGraph(input: {
	kind: "player" | "flow";
	facet: string;
	pid?: string;
	edges: EdgeRow[];
	nodes: NodeRow[];
	minCount?: number;
	maxEdges?: number;
}): Graph {
	const minCount = input.minCount ?? 1;
	const out = new Map<string, number>();
	const dwell = new Map<string, number>();
	for (const e of input.edges) {
		out.set(e.src, (out.get(e.src) ?? 0) + e.n);
		dwell.set(e.src, (dwell.get(e.src) ?? 0) + e.dwell_ms);
	}
	const all = input.edges
		.map<GraphEdge>((e) => {
			const edge: GraphEdge = { from: e.src, to: e.dst, count: e.n, dwellMs: e.dwell_ms, share: (out.get(e.src) ?? 0) ? e.n / (out.get(e.src) ?? 1) : 0 };
			if (e.players !== undefined) edge.players = e.players;
			return edge;
		})
		.sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
	const kept = all.filter((e) => e.count >= minCount).slice(0, input.maxEdges ?? Number.POSITIVE_INFINITY);
	const nodes: GraphNode[] = input.nodes
		.map((n) => {
			const node: GraphNode = { id: n.st, visits: n.visits, dwellMs: dwell.get(n.st) ?? 0 };
			if (n.players !== undefined) node.players = n.players;
			return node;
		})
		.sort((a, b) => b.visits - a.visits || a.id.localeCompare(b.id));
	const starts = all.filter((e) => e.from === START).reduce((s, e) => s + e.count, 0);
	const lefts = all.filter((e) => e.to === LEFT).reduce((s, e) => s + e.count, 0);
	if (starts) nodes.unshift({ id: START, visits: starts, dwellMs: 0 });
	if (lefts) nodes.push({ id: LEFT, visits: lefts, dwellMs: 0 });
	const data: GraphData = { kind: input.kind, facet: input.facet, nodes, edges: kept, hiddenEdges: all.length - kept.length };
	if (input.pid !== undefined) data.pid = input.pid;
	return new Graph(data);
}
