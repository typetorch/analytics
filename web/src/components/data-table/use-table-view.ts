/**
 * A table's view (sort, search, filters, hidden columns, widths, page size): starts from the URL when it carries this
 * table's parameters (a shared link), else from localStorage, else from the defaults; every change is written back to
 * both a moment later. Works without either: no router means no URL, blocked storage means no memory.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { clearViewParams, hasViewParams, paramsToView, readStored, viewToParams, writeStored, type TableView } from "./model";

/** The page's query string, as far as the table needs it (the router's, or nothing in tests and previews). */
export interface UrlBridge {
	params: URLSearchParams;
	/** Replaces the query string (no new history entry). */
	update(change: (params: URLSearchParams) => URLSearchParams): void;
}

/** The table's parameters merged into `params` (its old ones removed, defaults left out). */
export function withViewParams(params: URLSearchParams, id: string, view: TableView, defaults: TableView): URLSearchParams {
	const next = clearViewParams(id, params);
	for (const [key, value] of Object.entries(viewToParams(id, view, defaults))) next.set(key, value);
	return next;
}

export function useTableView(options: { id: string; defaults: TableView; persist: boolean; url: UrlBridge | null }) {
	const { id, defaults, persist } = options;
	const [view, setView] = useState<TableView>(() => {
		if (options.url && hasViewParams(id, options.url.params)) return paramsToView(id, options.url.params, defaults);
		return (persist ? readStored(id, defaults) : null) ?? defaults;
	});
	const touched = useRef(false);
	const latest = useRef({ view, defaults, persist, url: options.url, id });
	latest.current = { view, defaults, persist, url: options.url, id };
	const pending = useRef<((leaving: boolean) => void) | null>(null);

	const update = useCallback((change: (view: TableView) => TableView) => {
		touched.current = true;
		setView(change);
	}, []);
	const reset = useCallback(() => update(() => latest.current.defaults), [update]);

	useEffect(() => {
		if (!touched.current) return;
		const write = (leaving: boolean) => {
			pending.current = null;
			const { view: v, defaults: d, persist: p, url, id: key } = latest.current;
			if (p) writeStored(key, v, d);
			// Not when leaving: the page is already changing, and a late URL write would take it back.
			if (!leaving) url?.update((params) => withViewParams(params, key, v, d));
		};
		const timer = setTimeout(() => write(false), 250);
		pending.current = (leaving) => {
			clearTimeout(timer);
			write(leaving);
		};
		return () => clearTimeout(timer);
	}, [view]);
	// Leaving the page within the quarter second must not lose the last change.
	useEffect(
		() => () => {
			pending.current?.(true);
		},
		[],
	);

	return { view, update, reset };
}
