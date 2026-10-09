/**
 * The Dex tab: a READ-ONLY explorer of the server's DataModel (ops `dex.children` and `dex.props`; the framework runs
 * its explorer core with editing off, and set / rename / destroy are not ops). A lazy tree from `game` (a node's
 * children load when it opens, 200 at a time) and the selected instance's properties, attributes and tags.
 */
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { cn } from "cn";
import { EmptyState } from "@/components/common";
import { DataTable, type DataColumn } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtInt } from "@/lib/format";
import { useRemote } from "@/lib/remote-debug";
import type { DexChildrenPage, DexPropRow, DexProps, DexRow } from "@/lib/types";
import { MEMORY_ONLY, RemoteBar, useDebug, useFirstFetch } from "./shared";

/** Rows a node loads per request (the framework's REMOTE_DEX_ROWS). */
export const DEX_PAGE = 200;

export interface DexNode {
	row: DexRow;
	/** Child ids in the server's order (as many as loaded). */
	children?: number[];
	total?: number;
	gone?: boolean;
}

export const GAME_ROW: DexRow = { id: 0, name: "game", className: "DataModel", childCount: -1, parent: -1 };

/** Applies a dex.children answer to the node map (a page at offset 0 replaces a node's children; later pages append). */
export function applyChildren(nodes: ReadonlyMap<number, DexNode>, pages: readonly DexChildrenPage[]): Map<number, DexNode> {
	const next = new Map(nodes);
	for (const page of pages) {
		const node = next.get(page.id) ?? { row: { ...GAME_ROW, id: page.id, name: `#${page.id}` } };
		if (page.gone) {
			next.set(page.id, { ...node, gone: true, children: [], total: 0 });
			continue;
		}
		const ids = (page.rows ?? []).map((row) => {
			const existing = next.get(row.id);
			next.set(row.id, { ...existing, row, gone: false });
			return row.id;
		});
		const kept = page.offset > 0 ? (node.children ?? []).slice(0, page.offset) : [];
		next.set(page.id, { ...node, gone: false, children: [...kept, ...ids.filter((id) => !kept.includes(id))], total: page.total });
	}
	return next;
}

interface TreeLine {
	kind: "node" | "more";
	id: number;
	depth: number;
	left?: number;
}

/** The visible lines: depth-first through the open nodes, with a "load more" line where a node has more children. */
export function treeLines(nodes: ReadonlyMap<number, DexNode>, open: ReadonlySet<number>, root = 0): TreeLine[] {
	const out: TreeLine[] = [];
	const walk = (id: number, depth: number, seen: Set<number>) => {
		if (seen.has(id)) return;
		seen.add(id);
		out.push({ kind: "node", id, depth });
		const node = nodes.get(id);
		if (!open.has(id) || !node?.children) return;
		for (const child of node.children) walk(child, depth + 1, seen);
		const left = (node.total ?? 0) - node.children.length;
		if (left > 0) out.push({ kind: "more", id, depth: depth + 1, left });
	};
	walk(root, 0, new Set());
	return out;
}

function propColumns(onRef: (id: number) => void): DataColumn<DexPropRow>[] {
	return [
		{ id: "name", header: "Name", accessor: (p) => p.name, cell: (p) => <span className={cn("font-mono text-xs", p.deprecated && "line-through")}>{p.name}</span> },
		{ id: "category", header: "Category", type: "enum", accessor: (p) => p.category, className: "text-xs text-muted-foreground" },
		{
			id: "value",
			header: "Value",
			accessor: (p) => p.text,
			cell: (p) =>
				p.ref !== undefined ? (
					<button type="button" className="font-mono text-xs break-all underline-offset-2 hover:underline" onClick={() => onRef(p.ref as number)} title="Show this instance's properties">
						{p.text}
					</button>
				) : (
					<span className="font-mono text-xs break-all">{p.text}</span>
				),
			className: "min-w-40 max-w-[32rem] whitespace-pre-wrap",
		},
		{ id: "kind", header: "Kind", type: "enum", accessor: (p) => p.kind, defaultHidden: true, className: "text-xs" },
	];
}

export function DexTab({ active }: { active: boolean }) {
	const { call, ready } = useDebug();
	const children = useRemote<DexChildrenPage[]>(call, "dex.children");
	const props = useRemote<DexProps>(call, "dex.props");
	const loadChildrenOp = children.run;
	const loadPropsOp = props.run;
	const [nodes, setNodes] = useState<Map<number, DexNode>>(() => new Map([[0, { row: GAME_ROW }]]));
	const [open, setOpen] = useState<Set<number>>(() => new Set());
	const [selected, setSelected] = useState<number | undefined>();
	const [loading, setLoading] = useState<number | undefined>();

	const loadChildren = useCallback(
		async (id: number, offset = 0) => {
			setLoading(id);
			try {
				const answer = await loadChildrenOp({ nodes: [{ id, offset, limit: DEX_PAGE }] });
				if (!Array.isArray(answer)) return;
				setNodes((current) => applyChildren(current, answer));
				setOpen((current) => new Set(current).add(id));
			} finally {
				setLoading(undefined);
			}
		},
		[loadChildrenOp],
	);
	const expandRoot = useCallback(() => loadChildren(0), [loadChildren]);
	useFirstFetch(active && ready, expandRoot);

	const select = useCallback(
		(id: number) => {
			setSelected(id);
			void loadPropsOp({ id });
		},
		[loadPropsOp],
	);
	const toggle = (id: number) => {
		if (open.has(id)) {
			setOpen((current) => {
				const next = new Set(current);
				next.delete(id);
				return next;
			});
		} else if (nodes.get(id)?.children) {
			setOpen((current) => new Set(current).add(id));
		} else {
			void loadChildren(id);
		}
	};
	const lines = useMemo(() => treeLines(nodes, open), [nodes, open]);
	const columns = useMemo(() => propColumns(select), [select]);
	const busy = !ready || children.status === "running";
	const shown = props.data;

	return (
		<div className="space-y-3">
			<RemoteBar state={children} onFetch={() => void loadChildren(selected !== undefined && open.has(selected) ? selected : 0)} label="Refresh">
				<span className="text-xs text-muted-foreground">Read only. Refresh reloads the open node you selected (or game).</span>
			</RemoteBar>
			<div className="grid gap-4 lg:grid-cols-2">
				<ul role="tree" aria-label="Server instances" className="max-h-[60vh] min-w-0 overflow-auto rounded-lg border p-1 text-sm">
					{lines.map((line) =>
						line.kind === "more" ? (
							<li key={`more-${line.id}`} role="none" style={{ paddingLeft: line.depth * 14 + 22 }}>
								<button type="button" className="py-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50" disabled={busy} onClick={() => void loadChildren(line.id, nodes.get(line.id)?.children?.length ?? 0)}>
									Load more ({fmtInt(line.left)} left)
								</button>
							</li>
						) : (
							<TreeItem
								key={line.id}
								node={nodes.get(line.id)}
								depth={line.depth}
								open={open.has(line.id)}
								selected={selected === line.id}
								loading={loading === line.id}
								disabled={busy}
								onToggle={() => toggle(line.id)}
								onSelect={() => select(line.id)}
							/>
						),
					)}
				</ul>
				<div className="min-w-0 space-y-3">
					{selected === undefined ? (
						<p className="text-sm text-muted-foreground">Select an instance to read its properties.</p>
					) : (
						<>
							<RemoteBar state={props} onFetch={() => select(selected)} label="Reload properties" />
							{shown ? (
								<div className="space-y-3">
									<div>
										<div className="font-medium">
											{shown.name} <span className="text-xs font-normal text-muted-foreground">{shown.className}</span>
										</div>
										<div className="font-mono text-xs break-all text-muted-foreground">{shown.path}</div>
									</div>
									<DataTable id="server-dex-props" label={`Properties of ${shown.name}`} columns={columns} data={shown.props ?? []} rowId={(p) => p.name} pageSize={100} density="compact" maxHeight="50vh" {...MEMORY_ONLY} />
									{shown.attrs?.length ? (
										<DataTable id="server-dex-attrs" label={`Attributes of ${shown.name}`} columns={columns} data={shown.attrs} rowId={(p) => p.name} density="compact" maxHeight="30vh" {...MEMORY_ONLY} />
									) : null}
									{shown.tags?.length ? (
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="text-xs text-muted-foreground">Tags</span>
											{shown.tags.map((t) => (
												<Badge key={t} variant="secondary">
													{t}
												</Badge>
											))}
										</div>
									) : null}
								</div>
							) : props.status !== "running" ? (
								<EmptyState>No properties read yet.</EmptyState>
							) : null}
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function TreeItem({
	node,
	depth,
	open,
	selected,
	loading,
	disabled,
	onToggle,
	onSelect,
}: {
	node?: DexNode;
	depth: number;
	open: boolean;
	selected: boolean;
	loading: boolean;
	disabled: boolean;
	onToggle: () => void;
	onSelect: () => void;
}) {
	if (!node) return null;
	const { row } = node;
	// game's child count is unknown until it loads; it always has children.
	const hasChildren = row.childCount !== 0 && !node.gone;
	return (
		<li role="treeitem" aria-level={depth + 1} aria-expanded={hasChildren ? open : undefined} aria-selected={selected} className="list-none">
			<div className={cn("flex items-center gap-1 rounded-md pr-2", selected && "bg-muted")} style={{ paddingLeft: depth * 14 }}>
				{hasChildren ? (
					<Button type="button" variant="ghost" size="icon-xs" onClick={onToggle} disabled={disabled && !open} aria-label={open ? `Close ${row.name}` : `Open ${row.name}`}>
						{loading ? <LoaderCircle className="animate-spin" aria-hidden /> : open ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
					</Button>
				) : (
					<span className="inline-block size-6 shrink-0" aria-hidden />
				)}
				<button
					type="button"
					onClick={onSelect}
					aria-label={`${row.name} (${row.className}${row.childCount > 0 ? `, ${row.childCount} children` : ""})`}
					className={cn("flex min-w-0 items-baseline gap-1.5 py-1 text-left", node.gone && "text-muted-foreground line-through")}
					title={node.gone ? "This instance is gone" : undefined}
				>
					<span className="truncate">{row.name}</span>
					<span className="shrink-0 text-xs text-muted-foreground">{row.className}</span>
					{row.childCount > 0 ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{fmtInt(row.childCount)}</span> : null}
				</button>
			</div>
		</li>
	);
}
