/** A node graph from the analytics server (player-graph / flow), drawn with React Flow and laid out by dagre. */
import { Background, Controls, Handle, ReactFlow, type Node, type NodeProps, type Position } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "cn";
import { fmtDuration, fmtInt } from "@/lib/format";
import { toFlow, type StateNodeData } from "@/lib/graph";
import { useTheme } from "@/lib/theme";
import type { GraphData } from "@/lib/types";

const handle = "!size-1.5 !min-h-0 !min-w-0 !border-0 !bg-muted-foreground/50";

/** Back moves leave and arrive on the side, a bit apart. */
const backStyle = (side: Position, at: number) => (side === "right" || side === "left" ? { top: `${at * 100}%` } : { left: `${at * 100}%` });

function StateNode({ data, sourcePosition, targetPosition }: NodeProps<Node<StateNodeData>>) {
	const ends = data.kind !== "state";
	return (
		<div
			className={cn(
				"h-full w-full rounded-lg border bg-card px-3 py-2 text-card-foreground shadow-xs",
				ends && "flex items-center justify-center rounded-full border-dashed bg-muted text-muted-foreground",
				data.kind === "left" && "border-[var(--status-critical)]/60",
			)}
		>
			{targetPosition ? <Handle id="t" type="target" position={targetPosition} className={handle} /> : null}
			<Handle id="back-t" type="target" position={data.backSide} className={handle} style={backStyle(data.backSide, 0.3)} />
			{ends ? (
				<div className="text-xs font-medium whitespace-nowrap">
					{data.lines[0]} <span className="font-normal tabular-nums">({fmtInt(data.visits)})</span>
				</div>
			) : (
				<>
					{data.lines.map((line) => (
						<div key={line} className="truncate text-xs font-medium leading-[18px]" title={line}>
							{line}
						</div>
					))}
					<div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular-nums">
						{fmtInt(data.visits)} visit{data.visits === 1 ? "" : "s"}
						{data.players !== undefined ? ` · ${fmtInt(data.players)} player${data.players === 1 ? "" : "s"}` : ""}
						{data.avgDwellMs ? ` · ${fmtDuration(data.avgDwellMs)}` : ""}
					</div>
				</>
			)}
			{sourcePosition ? <Handle id="s" type="source" position={sourcePosition} className={handle} /> : null}
			<Handle id="back-s" type="source" position={data.backSide} className={handle} style={backStyle(data.backSide, 0.7)} />
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

export default function GraphView({ graph, maxEdges = 60, className }: { graph: GraphData; maxEdges?: number; className?: string }) {
	const { resolved } = useTheme();
	const { ref, width } = useWidth();
	// Left to right reads best; a narrow column gets top to bottom so labels stay readable.
	const direction = width && width < 720 ? "TB" : "LR";
	const flow = useMemo(() => toFlow(graph, { maxEdges, direction }), [graph, maxEdges, direction]);
	return (
		<div className="space-y-1">
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
						defaultEdgeOptions={{ labelBgPadding: [4, 2], labelBgBorderRadius: 4 }}
					>
						<Background gap={24} size={1} />
						<Controls showInteractive={false} />
					</ReactFlow>
				) : null}
			</div>
			<p className="text-xs text-muted-foreground">
				Edges are moves, labelled count · average time before the move; thicker = more. Drag to pan; Ctrl+scroll or the buttons zoom.
				{flow.hiddenEdges > 0 ? ` ${fmtInt(flow.hiddenEdges)} smaller moves not drawn.` : ""}
			</p>
		</div>
	);
}
