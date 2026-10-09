import { describe, expect, it } from "vitest";
import type { FleetServerDetail, RemoteLogEntry } from "@/lib/types";
import { detailRefetch, sessionState } from "../Server";
import { applyChildren, GAME_ROW, treeLines, type DexNode } from "./DexTab";
import { epochMs, limitRows } from "./InfoTabs";
import { LOGS_KEPT, mergeLogs } from "./LogsTab";
import { clientState } from "./PlayersTab";
import { openEntry, stateQuery } from "./StateTab";

const line = (i: number, text = `line ${i}`): RemoteLogEntry => ({ i, t: 1_760_000_000 + i, kind: "output", text });

describe("logs", () => {
	it("merges by index without duplicates, oldest first, and keeps the newest LOGS_KEPT", () => {
		expect(mergeLogs([line(1), line(2)], [line(2, "again"), line(3)]).map((e) => [e.i, e.text])).toEqual([
			[1, "line 1"],
			[2, "again"],
			[3, "line 3"],
		]);
		const many = Array.from({ length: LOGS_KEPT + 10 }, (_, i) => line(i + 1));
		const kept = mergeLogs([], many);
		expect(kept).toHaveLength(LOGS_KEPT);
		expect(kept[0].i).toBe(11);
		expect(mergeLogs([line(5)], [null as unknown as RemoteLogEntry])).toHaveLength(1);
	});
});

describe("state browser", () => {
	it("asks for the roots, then a root, then a key below it", () => {
		expect(stateQuery(undefined, 0, "")).toEqual({ root: "", path: [], page: 0 });
		const root = openEntry(undefined, { key: "Inventory", seg: "Inventory", type: "module", preview: "{...}", expandable: true });
		expect(root).toEqual({ root: "Inventory", label: "Inventory", segs: [] });
		const below = openEntry(root, { key: "items", seg: "sitems", type: "table", preview: "{3}", expandable: true });
		expect(stateQuery(below, 2, "sw")).toEqual({ root: "Inventory", path: ["sitems"], page: 2, filter: "sw" });
	});
});

describe("dex tree", () => {
	it("loads children under game, appends a second page, marks a gone node, and lists open nodes depth first", () => {
		let nodes: Map<number, DexNode> = new Map([[0, { row: GAME_ROW }]]);
		nodes = applyChildren(nodes, [{ id: 0, offset: 0, total: 3, rows: [{ id: 1, name: "Workspace", className: "Workspace", childCount: 2, parent: 0 }, { id: 2, name: "Players", className: "Players", childCount: 0, parent: 0 }] }]);
		expect(treeLines(nodes, new Set([0]))).toEqual([
			{ kind: "node", id: 0, depth: 0 },
			{ kind: "node", id: 1, depth: 1 },
			{ kind: "node", id: 2, depth: 1 },
			{ kind: "more", id: 0, depth: 1, left: 1 },
		]);
		nodes = applyChildren(nodes, [{ id: 0, offset: 2, total: 3, rows: [{ id: 3, name: "Lighting", className: "Lighting", childCount: 0, parent: 0 }] }]);
		nodes = applyChildren(nodes, [{ id: 1, offset: 0, total: 1, rows: [{ id: 4, name: "Baseplate", className: "Part", childCount: 0, parent: 1 }] }]);
		expect(treeLines(nodes, new Set([0, 1])).map((l) => `${l.kind}:${l.id}@${l.depth}`)).toEqual(["node:0@0", "node:1@1", "node:4@2", "node:2@1", "node:3@1"]);
		// Closing a node hides its children; its loaded rows stay.
		expect(treeLines(nodes, new Set([0])).map((l) => l.id)).toEqual([0, 1, 2, 3]);
		nodes = applyChildren(nodes, [{ id: 1, rows: [], total: 0, offset: 0, gone: true }]);
		expect(nodes.get(1)).toMatchObject({ gone: true, children: [] });
		expect(nodes.get(1)?.row.name).toBe("Workspace");
	});
});

describe("tables", () => {
	it("flattens the budget's kinds, reads kernel times in seconds or ms", () => {
		expect(limitRows({ kinds: { http: { rows: [{ name: "requests", used: 10, limit: 500 }] }, datastore: { rows: [{ name: "read", used: 30, limit: 60, left: 900 }] } } })).toEqual([
			{ kind: "http", name: "requests", used: 10, limit: 500 },
			{ kind: "datastore", name: "read", used: 30, limit: 60, left: 900 },
		]);
		expect(limitRows(undefined)).toEqual([]);
		expect(epochMs(1_760_000_000)).toBe(1_760_000_000_000);
		expect(epochMs(1_760_000_000_000)).toBe(1_760_000_000_000);
		expect(epochMs(undefined)).toBeNull();
		expect(epochMs(0)).toBeNull();
	});

	it("names a player's client start", () => {
		expect(clientState({ userId: 1, name: "a" })).toBe("waiting");
		expect(clientState({ userId: 1, name: "a", client: { ok: true } })).toBe("ok");
		expect(clientState({ userId: 1, name: "a", client: { ok: false, error: "boom" } })).toBe("failed");
	});
});

describe("the session", () => {
	it("is connected when the backend saw a poll, the watch reply says so, or an answer came in the last 30 s", () => {
		expect(sessionState(undefined, undefined, undefined).connected).toBe(false);
		expect(sessionState({ watched: true, connected: true, lastPollAt: 5 }, undefined, undefined)).toEqual({ connected: true, lastPollAt: 5 });
		expect(sessionState({ watched: true, connected: false }, { watched: true, connected: true, lastPollAt: 9 }, undefined)).toEqual({ connected: true, lastPollAt: 9 });
		expect(sessionState({ watched: true, connected: false }, undefined, 1000, 20_000).connected).toBe(true);
		expect(sessionState({ watched: true, connected: false }, undefined, 1000, 40_000).connected).toBe(false);
	});

	it("re-reads a live server quickly until it polls, a lost one slowly, a closed one never", () => {
		const detail = (state: FleetServerDetail["state"], connected = false): FleetServerDetail => ({ server: null, state, debug: { watched: false, connected } });
		expect(detailRefetch(detail("live"))).toBe(5_000);
		expect(detailRefetch(detail("live", true))).toBe(15_000);
		expect(detailRefetch(detail("lost"))).toBe(30_000);
		expect(detailRefetch(detail("closed"))).toBe(false);
		expect(detailRefetch(detail("unknown"))).toBe(false);
		expect(detailRefetch(undefined)).toBe(false);
	});
});
