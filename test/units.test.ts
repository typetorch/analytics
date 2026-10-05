import { describe, expect, test } from "bun:test";
import { Graph, buildGraph, formatDuration } from "../src/graph.ts";
import { detectSignals, decodeSessions, hasDecoder, RecordingCodecUnavailable, type RecordingSample } from "../src/recording.ts";
import { bootstrapMeans, normalCdf, percentSure, prng, twoProportion, verdict, welch } from "../src/stats.ts";

describe("stats", () => {
	test("normal CDF", () => {
		expect(normalCdf(0)).toBeCloseTo(0.5, 6);
		expect(normalCdf(1.96)).toBeCloseTo(0.975, 4);
		expect(normalCdf(-2.5758)).toBeCloseTo(0.005, 4);
	});

	test("two-proportion z-test", () => {
		// 50/100 vs 65/100: pooled 0.575, z = 2.1456, two-sided p = 0.0319.
		const r = twoProportion(50, 100, 65, 100);
		expect(r.a).toBe(0.5);
		expect(r.b).toBe(0.65);
		expect(r.pValue).toBeCloseTo(0.0319, 3);
		expect(r.sure).toBeCloseTo(0.968, 3);
		expect(twoProportion(0, 0, 1, 2).sure).toBe(0);
		expect(twoProportion(10, 10, 10, 10).sure).toBe(0);
	});

	test("Welch and bootstrap agree on a clear difference", () => {
		const random = prng(3);
		const a = Array.from({ length: 400 }, () => 10 + random() * 10);
		const b = Array.from({ length: 400 }, () => 11 + random() * 10);
		const mean = (x: number[]) => x.reduce((s, v) => s + v, 0) / x.length;
		const variance = (x: number[]) => x.reduce((s, v) => s + (v - mean(x)) ** 2, 0) / (x.length - 1);
		const boot = bootstrapMeans(a, b, { seed: 5 });
		const w = welch(mean(a), variance(a), a.length, mean(b), variance(b), b.length);
		expect(boot.sure).toBeGreaterThan(0.99);
		expect(w.sure).toBeGreaterThan(0.99);
		expect(bootstrapMeans(a, b, { seed: 5 })).toEqual(boot); // repeatable
		const same = bootstrapMeans(a, a.slice().reverse());
		expect(same.sure).toBeLessThan(0.5);
	});

	test("plain words", () => {
		const strong = twoProportion(400, 1000, 460, 1000);
		expect(verdict("B", "returned", strong, 1000)).toBe(`B keeps more players: ${percentSure(strong.sure)} sure`);
		const weak = twoProportion(40, 100, 47, 100);
		expect(verdict("B", "returned", weak, 100)).toMatch(/^No clear difference yet \(\d+% sure\)$/);
		expect(verdict("B", "robux", strong, 10)).toContain("Too few players");
		expect(percentSure(0.99999)).toBe("99%");
	});
});

describe("graph", () => {
	const g = buildGraph({
		kind: "flow",
		facet: "zone",
		edges: [
			{ src: "(start)", dst: "Lobby", n: 10, players: 10, dwell_ms: 0 },
			{ src: "Lobby", dst: 'Sh"op', n: 6, players: 5, dwell_ms: 60_000 },
			{ src: "Lobby", dst: "(left)", n: 4, players: 4, dwell_ms: 8_000 },
			{ src: 'Sh"op', dst: "(left)", n: 1, players: 1, dwell_ms: 1000 },
		],
		nodes: [
			{ st: "Lobby", visits: 10, players: 10 },
			{ st: 'Sh"op', visits: 6, players: 5 },
		],
		minCount: 2,
	});

	test("build: shares, dwell, hidden edges, start/left nodes", () => {
		expect(g.edges.length).toBe(3);
		expect(g.hiddenEdges).toBe(1);
		expect(g.edges.find((e) => e.to === 'Sh"op')?.share).toBe(0.6);
		expect(g.nodes[0].id).toBe("(start)");
		expect(g.nodes.at(-1)?.id).toBe("(left)");
		expect(g.nodes.find((n) => n.id === "Lobby")?.dwellMs).toBe(68_000);
		expect(g.exits()).toEqual([{ state: "Lobby", count: 4, share: 1 }]); // the hidden Shop -> left edge is not counted
	});

	test("Mermaid: escaped labels, edge times, widths", () => {
		const m = g.toMermaid();
		expect(m).toContain("flowchart LR");
		expect(m).toContain("Sh#quot;op");
		expect(m).not.toContain('Sh"op');
		expect(m).toContain('-->|"6 · 10s"|');
		expect(m).toContain("linkStyle 0 stroke-width:6px");
		expect(m).toContain("%% 1 smaller edges not drawn");
		expect(g.toMermaid({ direction: "TD", times: false })).toContain('-->|"6"|');
	});

	test("state labels split on |", () => {
		const one = buildGraph({ kind: "player", facet: "all", pid: "p1", edges: [{ src: "(start)", dst: "zone:A|screen:", n: 1, dwell_ms: 0 }], nodes: [{ st: "zone:A|screen:", visits: 1 }] });
		expect(one.toMermaid()).toContain('["zone:A<br/>screen:<br/><small>1 visits</small>"]');
		expect(Graph.fromJSON(JSON.stringify(one)).toJSON()).toEqual(one.toJSON());
	});

	test("durations", () => {
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(125_000)).toBe("2m 05s");
		expect(formatDuration(3_780_000)).toBe("1h 03m");
	});
});

describe("recordings", () => {
	test("tt-rec-1 is a stub until SCHEMA.md exists", () => {
		expect(hasDecoder("tt-rec-1")).toBe(false);
		expect(() => decodeSessions([{ pid: "p", sid: "s", chunk: 0, codec: "tt-rec-1", data: "", n: 0 }])).toThrow(RecordingCodecUnavailable);
	});

	const T = 1_000_000;
	const still = (from: number, to: number, look = (_t: number): [number, number, number] => [0, 0, 1]): RecordingSample[] => {
		const out: RecordingSample[] = [];
		for (let t = from; t <= to; t += 100) out.push({ t, pos: [0, 3, 0], cam: [0, 8, -10], look: look(t) });
		return out;
	};

	test("idle: no input and no movement for 10 s", () => {
		const signals = detectSignals({ pid: "p", sid: "s", samples: still(T, T + 12_000), inputs: [] }, [{ t: 0, zone: "Lobby" }]);
		expect(signals).toEqual([{ kind: "idle", pid: "p", sid: "s", t: T, amount: 12_000, zone: "Lobby" }]);
		const busy = detectSignals({ pid: "p", sid: "s", samples: still(T, T + 12_000), inputs: [{ t: T + 5000, type: "key" }] });
		expect(busy.filter((s) => s.kind === "idle")).toEqual([]);
	});

	test("camera spin: 360 degrees in place", () => {
		const spin = (t: number): [number, number, number] => {
			const a = ((t - T) / 4000) * 2 * Math.PI; // a full turn every 4 s
			return [Math.sin(a), 0, Math.cos(a)];
		};
		const signals = detectSignals({ pid: "p", sid: "s", samples: still(T, T + 5000, spin), inputs: [{ t: T + 50, type: "key" }] });
		const spins = signals.filter((s) => s.kind === "camera_spin");
		expect(spins.length).toBe(1);
		expect(spins[0].amount).toBeLessThanOrEqual(6000);
	});

	test("repeated clicks on one button, broken by a screen change", () => {
		const press = (t: number, target = "Shop/Buy") => ({ t, type: "button" as const, target });
		const signals = detectSignals({
			pid: "p",
			sid: "s",
			samples: [],
			inputs: [press(T), press(T + 400), press(T + 800), press(T + 1200), { t: T + 5000, type: "screen_open", target: "Shop" }, press(T + 5100), press(T + 5200), { t: T + 5300, type: "screen_close" }, press(T + 5400)],
		});
		expect(signals).toEqual([{ kind: "repeated_clicks", pid: "p", sid: "s", t: T, amount: 4, target: "Shop/Buy" }]);
	});
});
