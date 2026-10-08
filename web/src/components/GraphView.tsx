/** A node graph from the analytics server (player-graph / flow), drawn with React Flow and laid out by dagre. */
import { Background, Controls, Handle, ReactFlow, type Node, type NodeProps, type Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { fmtDuration, fmtInt } from "@/lib/format";
import { toFlow, type StateNodeData } from "@/lib/graph";
import { useTheme } from "@/lib/theme";
import type { GraphData } from "@/lib/types";

const handle = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-muted-foreground/50";

/** Back moves leave and arrive on the side, a bit apart. */
const backStyle = (side: Position, at: number) => (side === "right" || side === "left" ? { top: `${at * 100}%` } : { left: `${at * 100}%` });

/** The full "what happened here" text (hover title and the details panel). */
function details(data: StateNodeData): string[] {
	const out: string[] = [];
	if (data.events.length) out.push(`Events: ${data.events.map((e) => `${e.name} ${e.count}`).join(", ")}`);
	if (data.steps.length) out.push(`Funnel steps: ${data.steps.map((s) => `${s.funnel}: ${s.step} (${s.count})`).join(", ")}`);
	return out;
}

function meta(data: StateNodeData): string {
	const parts = [`${fmtInt(data.visits)} visit${data.visits === 1 ? "" : "s"}`];
	if (data.timeMs !== undefined) parts.push(`${fmtDuration(data.timeMs)} here`);
	else {
		if (data.players !== undefined) parts.push(`${fmtInt(data.players)} player${data.players === 1 ? "" : "s"}`);
		if (data.avgDwellMs) parts.push(`avg ${fmtDuration(data.avgDwellMs)}`);
	}
	return parts.join(" · ");
}

function StateNode({ data, sourcePosition, targetPosition }: NodeProps<Node<StateNodeData>>) {
	const handles = (
		<>
			{targetPosition ? <Handle id="t" type="target" position={targetPosition} className={handle} /> : null}
			<Handle id="back-t" type="target" position={data.backSide} className={handle} style={backStyle(data.backSide, 0.3)} />
			{sourcePosition ? <Handle id="s" type="source" position={sourcePosition} className={handle} /> : null}
			<Handle id="back-s" type="source" position={data.backSide} className={handle} style={backStyle(data.backSide, 0.7)} />
		</>
	);
	if (data.kind === "moment") {
		return (
			<div
				className="flex h-full w-full items-center justify-center rounded-full border border-[var(--chart-4)] bg-[var(--chart-4)]/10 px-2 text-[11px] font-medium whitespace-nowrap"
				title={`Key moment: ${data.lines[0]} (${data.visits}x)`}
			>
				{handles}
				<span className="truncate">{data.lines[0]}</span>
			</div>
		);
	}
	if (data.kind !== "state") {
		return (
			<div
				className={cn(
					"flex h-full w-full items-center justify-center rounded-full border border-dashed bg-muted text-muted-foreground",
					data.kind === "left" && "border-[var(--status-critical)]/60",
				)}
			>
				{handles}
				<div className="text-xs font-medium whitespace-nowrap">
					{data.lines[0]} <span className="font-normal tabular-nums">({fmtInt(data.visits)})</span>
				</div>
			</div>
		);
	}
	const more = details(data);
	return (
		<div
			className="h-full w-full cursor-pointer rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-xs hover:border-ring"
			title={[data.lines.join(" | "), meta(data), ...more].join("\n")}
		>
			{handles}
			{data.lines.map((line) => (
				<div key={line} className="truncate text-xs font-medium leading-[18px]">
					{line}
				</div>
			))}
			<div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">{meta(data)}</div>
			{data.eventsLine ? <div className="truncate text-[11px] leading-4 text-[var(--chart-1)]">{data.eventsLine}</div> : null}
			{data.stepsLine ? <div className="truncate text-[11px] leading-4 text-[var(--chart-3)]">{data.stepsLine}</div> : null}
		</div>
	);
}

const nodeTypes = { state: StateNode };

/** The container's width (0 until measured). */
function useWidth() {
	const ref = useRef<HTMLDivElement>(null);
	const [width, setWidth] = useState(0);
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
		observer.observe(el);
		return () => observer.disconnect();
	}, []);
	return { ref, width };
}

function NodeDetails({ data, onClose }: { data: StateNodeData; onClose(): void }) {
	return (
		<div className="rounded-lg border bg-muted/30 p-3 text-sm">
			<div className="flex items-start justify-between gap-2">
				<div>
					<div className="font-medium">{data.lines.join(" · ")}</div>
					<div className="text-xs text-muted-foreground tabular-nums">{meta(data)}</div>
				</div>
				<Button variant="ghost" size="icon-xs" onClick={onClose} aria-label="Close">
					<X />
				</Button>
			</div>
			<div className="mt-2 grid gap-3 sm:grid-cols-2">
				<div>
					<div className="text-xs font-medium text-muted-foreground">Top events here</div>
					{data.events.length ? (
						<ul className="mt-1 space-y-0.5 text-xs tabular-nums">
							{data.events.map((e) => (
								<li key={`${e.kind}/${e.name}`}>
									{e.name} <span className="text-muted-foreground">({e.kind})</span> {fmtInt(e.count)}
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-xs text-muted-foreground">No custom, purchase or currency events logged in this state.</p>
					)}
				</div>
				<div>
					<div className="text-xs font-medium text-muted-foreground">Funnel steps here</div>
					{data.steps.length ? (
						<ul className="mt-1 space-y-0.5 text-xs tabular-nums">
							{data.steps.map((s) => (
								<li key={`${s.funnel}/${s.step}`}>
									{s.funnel}: {s.step} <span className="text-muted-foreground">({fmtInt(s.count)}x, {plural(s.players)})</span>
								</li>
							))}
						</ul>
					) : (
						<p className="mt-1 text-xs text-muted-foreground">No funnel steps logged in this state.</p>
					)}
				</div>
			</div>
		</div>
	);
}

const plural = (n: number) => `${fmtInt(n)} player${n === 1 ? "" : "s"}`;

export default function GraphView({ graph, maxEdges = 60, className }: { graph: GraphData; maxEdges?: number; className?: string }) {
	const { resolved } = useTheme();
	const { ref, width } = useWidth();
	const [selected, setSelected] = useState<string | null>(null);
	// Left to right reads best; a narrow column gets top to bottom so labels stay readable.
	const direction = width && width < 720 ? "TB" : "LR";
	const flow = useMemo(() => toFlow(graph, { maxEdges, direction }), [graph, maxEdges, direction]);
	const picked = flow.nodes.find((n) => n.data.state === selected && n.data.kind === "state");
	useEffect(() => setSelected(null), [graph]);
	return (
		<div className="space-y-2">
			<div ref={ref} className={cn("w-full overflow-hidden rounded-lg border", direction === "TB" ? "h-[560px]" : "h-[460px]", className)}>
				{width ? (
					<ReactFlow
						key={direction}
						nodes={flow.nodes}
						edges={flow.edges}
						nodeTypes={nodeTypes}
						colorMode={resolved}
						fitView
						fitViewOptions={{ padding: 0.12, maxZoom: 1.1, minZoom: 0.35 }}
						minZoom={0.1}
						zoomOnScroll={false}
						preventScrolling={false}
						zoomActivationKeyCode="Control"
						nodesDraggable
						nodesConnectable={false}
						elementsSelectable={false}
						onNodeClick={(_, node) => setSelected((node.data as StateNodeData).state)}
						defaultEdgeOptions={{ labelBgPadding: [4, 2], labelBgBorderRadius: 4 }}
					>
						<Background gap={24} size={1} />
						<Controls showInteractive={false} />
					</ReactFlow>
				) : null}
			</div>
			{picked ? <NodeDetails data={picked.data} onClose={() => setSelected(null)} /> : null}
			<p className="text-xs text-muted-foreground">
				{graph.path
					? "Edges are numbered in the order the player moved; each state shows the time spent in it."
					: "Edges are moves, labelled count · average time before the move; thicker = more."}{" "}
				Click a state for what happened there. Drag to pan; Ctrl+scroll or the buttons zoom.
				{flow.hiddenEdges > 0 ? ` ${fmtInt(flow.hiddenEdges)} smaller moves not drawn.` : ""}
			</p>
		</div>
	);
}
