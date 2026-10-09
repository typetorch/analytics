/**
 * Which sidebar groups are collapsed, remembered in localStorage (like the theme). One store for the page, so the desktop
 * sidebar and the mobile drawer agree. Storage can be missing or throw (a private window, blocked site data): then the
 * choice lasts until the page is closed.
 */
import { useSyncExternalStore } from "react";

export const NAV_STATE_KEY = "tt-explorer-nav-collapsed";

/** group id -> true when collapsed (a group that isn't in the list is open). */
export type Collapsed = Readonly<Record<string, true>>;

function read(): Collapsed {
	try {
		const parsed: unknown = JSON.parse(localStorage.getItem(NAV_STATE_KEY) ?? "{}");
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out: Record<string, true> = {};
		for (const [id, value] of Object.entries(parsed)) if (value === true) out[id] = true;
		return out;
	} catch {
		return {};
	}
}

function write(value: Collapsed): void {
	try {
		localStorage.setItem(NAV_STATE_KEY, JSON.stringify(value));
	} catch {
		// Not remembered; still applied for this page view.
	}
}

const NONE: Collapsed = {};
let state: Collapsed | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

const snapshot = (): Collapsed => (state ??= read());

/** Start over from what storage holds (another tab changed it; the tests clear it). */
export function reloadCollapsed(): void {
	state = undefined;
	emit();
}

export function setGroupCollapsed(id: string, collapsed: boolean): void {
	const current = snapshot();
	if (Boolean(current[id]) === collapsed) return;
	const next: Record<string, true> = { ...current };
	if (collapsed) next[id] = true;
	else delete next[id];
	state = next;
	write(next);
	emit();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	const onStorage = (e: StorageEvent) => {
		if (e.key === NAV_STATE_KEY || e.key === null) reloadCollapsed();
	};
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(listener);
		window.removeEventListener("storage", onStorage);
	};
}

export function useCollapsedGroups(): Collapsed {
	return useSyncExternalStore(subscribe, snapshot, () => NONE);
}
