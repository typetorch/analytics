/** Plain helpers for the node graph JSON: labels, sorting, edge widths, path order, Mermaid text, exits (no layout library). */
import { fmtDuration } from "./format";
import type { GraphData, GraphEdge, GraphNode } from "./types";

export const START = "(start)";
export const LEFT = "(left)";

export type StateNodeKind = "start" | "left" | "state" | "moment";

/** "zone:Lobby|screen:Shop" -> ["zone: Lobby", "screen: Shop"]; a faceted id ("Lobby") stays one line; "@x" is moment x. */
export function stateLines(id: string): string[] {
	if (id === START) return ["start"];
	if (id === LEFT) return ["left the game"];
	if (id.startsWith("@")) return [id.slice(1)];
	return id.split("|").map((part) => {
		const at = part.indexOf(":");
		return at > 0 ? `${part.slice(0, at)}: ${part.slice(at + 1)}` : part;
	});
}

export function nodeKind(id: string): StateNodeKind {
	return id === START ? "start" : id === LEFT ? "left" : id.startsWith("@") ? "moment" : "state";
}

/** States the game logged (not start/left, not moments). Fewer than 3 = a sparse graph. */
export function realStates(graph: GraphData): number {
	return graph.nodes.filter((n) => nodeKind(n.id) === "state").length;
}

/** "target_hit 34 · coin_pickup 6" (busiest first). */
export function eventsLine(node: Pick<GraphNode, "events">, max = 3): string {
	return (node.events ?? [])
		.slice(0, max)
		.map((e) => `${e.name} ${e.count}`)
		.join(" · ");
}

/** "onboarding: first_hit, round: started". */
export function stepsLine(node: Pick<GraphNode, "steps">, max = 3): string {
	const steps = node.steps ?? [];
	const text = steps
		.slice(0, max)
		.map((s) => `${s.funnel}: ${s.step}`)
		.join(", ");
	return steps.length > max ? `${text}, +${steps.length - max}` : text;
}

/** Busiest moves first (ties by name, like the server). */
export function topEdges(edges: GraphEdge[], limit: number): GraphEdge[] {
	return [...edges].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).slice(0, limit);
}

/** Edge stroke width 1-6 by count relative to the busiest edge drawn. */
export function edgeWidth(count: number, maxCount: number): number {
	return 1 + Math.round((count / Math.max(1, maxCount)) * 5);
}

export function edgeLabel(edge: GraphEdge): string {
	const avg = edge.count ? edge.dwellMs / edge.count : 0;
	return edge.from === START ? `${edge.count}` : `${edge.count} · ${fmtDuration(avg)}`;
}

/**
 * A one-session graph's moves in order: start -> first visit is move 1, then each next visit, then -> left when the
 * session is over. Map key "from>to", value the move numbers (a move made twice has two numbers).
 */
export function moveOrder(graph: GraphData): Map<string, number[]> {
	const order = new Map<string, number[]>();
	if (!graph.path?.length) return order;
	const seq = [START, ...graph.path.map((p) => p.state), ...(graph.ended ? [LEFT] : [])];
	for (let i = 1; i < seq.length; i++) {
		const key = `${seq[i - 1]}>${seq[i]}`;
		order.set(key, [...(order.get(key) ?? []), i]);
	}
	return order;
}

/** "#2" or "#2, #5" (at most 4 numbers, then "…"). */
export function orderLabel(numbers: number[]): string {
	const shown = numbers.slice(0, 4).map((n) => `#${n}`);
	return numbers.length > 4 ? `${shown.join(", ")}, …` : shown.join(", ");
}

function escapeMermaid(text: string): string {
	return text.replace(/&/g, "#amp;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
}

/** Mermaid flowchart text, for pasting into docs or https://mermaid.live. */
export function toMermaid(graph: GraphData, maxEdges = 40): string {
	const edges = topEdges(graph.edges, maxEdges);
	const used = new Set<string>();
	for (const e of edges) used.add(e.from).add(e.to);
	const nodes = graph.nodes.filter((n) => used.has(n.id));
	for (const id of used) if (!nodes.some((n) => n.id === id)) nodes.push({ id, visits: 0, dwellMs: 0 });
	const ids = new Map<string, string>();
	const lines = ["flowchart LR"];
	nodes.forEach((node, i) => {
		ids.set(node.id, `n${i}`);
		if (node.id === START || node.id === LEFT) {
			lines.push(`  n${i}(["${node.id === START ? "start" : "left"}"])`);
		} else if (node.id.startsWith("@")) {
			lines.push(`  n${i}(["${escapeMermaid(node.id.slice(1))}"])`);
		} else {
			const who = node.players !== undefined ? `, ${node.players} player${node.players === 1 ? "" : "s"}` : "";
			const label = node.id.split("|").map(escapeMermaid).join("<br/>");
			lines.push(`  n${i}["${label}<br/><small>${node.visits} visit${node.visits === 1 ? "" : "s"}${who}</small>"]`);
		}
	});
	const order = moveOrder(graph);
	const maxCount = Math.max(1, ...edges.map((e) => e.count));
	edges.forEach((e) => {
		const numbers = order.get(`${e.from}>${e.to}`);
		lines.push(`  ${ids.get(e.from)} -->|"${escapeMermaid(numbers ? orderLabel(numbers) : edgeLabel(e))}"| ${ids.get(e.to)}`);
	});
	edges.forEach((e, i) => lines.push(`  linkStyle ${i} stroke-width:${edgeWidth(e.count, maxCount)}px`));
	const hidden = graph.hiddenEdges + graph.edges.length - edges.length;
	if (hidden > 0) lines.push(`  %% ${hidden} smaller edges not drawn`);
	return `${lines.join("\n")}\n`;
}

/** Where sessions ended, most first (edges into `(left)`). */
export function exits(graph: GraphData): { state: string; count: number; share: number }[] {
	const ends = graph.edges.filter((e) => e.to === LEFT);
	const total = ends.reduce((sum, e) => sum + e.count, 0);
	return ends.map((e) => ({ state: e.from, count: e.count, share: total ? e.count / total : 0 })).sort((a, b) => b.count - a.count);
}
