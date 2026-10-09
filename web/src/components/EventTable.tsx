/** Event rows as a table: time, kind, name, side, state and props, plus the extra columns a page adds. Sort, filter, export like any table. */
import { useMemo } from "react";
import { DataTable, type DataColumn, type DataTableProps } from "@/components/data-table";
import { Badge } from "@/components/ui/badge";
import { compactJson, fmtTime } from "@/lib/format";

export interface ListedEvent {
	time: string;
	t: number;
	kind: string;
	name: string;
	state: string | null;
	src: string | null;
	props: unknown;
}

/** The columns every event table has. `dateToo` shows the day as well as the time. */
export function eventColumns<E extends ListedEvent>(dateToo: boolean): DataColumn<E>[] {
	const shown = (e: E) => (dateToo ? fmtTime(e.time) : fmtTime(e.time).slice(11));
	return [
		{
			id: "time",
			header: dateToo ? "Time (UTC)" : "Time",
			type: "date",
			accessor: (e) => e.t,
			cell: shown,
			format: (_v, e) => shown(e),
			className: "font-mono text-xs text-muted-foreground tabular-nums",
		},
		{ id: "kind", header: "Kind", type: "enum", accessor: (e) => e.kind, cell: (e) => <Badge variant="outline">{e.kind}</Badge> },
		{ id: "name", header: "Name", accessor: (e) => e.name, className: "font-medium" },
		{ id: "side", header: "Side", type: "enum", options: ["server", "client"], accessor: (e) => e.src, className: "text-xs text-muted-foreground" },
		{ id: "state", header: "State", accessor: (e) => e.state, className: "text-xs text-muted-foreground" },
		{
			id: "props",
			header: "Props",
			accessor: (e) => e.props,
			format: (v) => compactJson(v, 400),
			cell: (e) => {
				const props = compactJson(e.props, 400);
				return props && props !== "{}" ? <span title={props}>{props}</span> : <span className="text-muted-foreground">–</span>;
			},
			filter: "text",
			className: "max-w-[28rem] truncate font-mono text-[11px] text-muted-foreground",
		},
	];
}

type Props<E extends ListedEvent> = {
	events: E[];
	dateToo?: boolean;
	/** More columns after the standard ones. Define the array outside the component. */
	extra?: DataColumn<E>[];
} & Omit<DataTableProps<E>, "columns" | "data">;

export function EventTable<E extends ListedEvent>({ events, dateToo = false, extra, ...rest }: Props<E>) {
	const columns = useMemo(() => [...eventColumns<E>(dateToo), ...(extra ?? [])], [dateToo, extra]);
	return <DataTable<E> columns={columns} data={events} {...rest} />;
}
