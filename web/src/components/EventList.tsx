/** Event rows as a compact list: time, kind, name, state on one line; where and props under it (reads well at any width). */
import type { ReactNode } from "react";
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

export function EventList<E extends ListedEvent>({ events, dateToo = false, extra }: { events: E[]; dateToo?: boolean; extra?: (event: E) => ReactNode }) {
	return (
		<div className="divide-y">
			{events.map((e, i) => {
				const props = compactJson(e.props, 400);
				const more = extra?.(e);
				return (
					<div key={`${e.t}-${i}`} className="py-1.5 text-sm">
						<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
							<span className="font-mono text-xs text-muted-foreground tabular-nums">{dateToo ? fmtTime(e.time) : fmtTime(e.time).slice(11)}</span>
							<Badge variant="outline">{e.kind}</Badge>
							<span className="font-medium">{e.name}</span>
							{e.src ? <span className="text-[11px] text-muted-foreground">{e.src}</span> : null}
							{e.state ? <span className="ml-auto text-xs text-muted-foreground">{e.state}</span> : null}
						</div>
						{more ? <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-muted-foreground">{more}</div> : null}
						{props && props !== "{}" ? <div className="mt-0.5 font-mono text-[11px] break-all text-muted-foreground">{props}</div> : null}
					</div>
				);
			})}
		</div>
	);
}
