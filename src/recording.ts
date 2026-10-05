/**
 * First-session recordings: decoding the packed chunks and finding confusion signals in them.
 *
 * The packing format (`tt-rec-1`) is defined by the framework's recorder and documented in
 * framework/src/analytics/SCHEMA.md. TODO(tt-rec-1): that document doesn't exist yet (2026-10-05), so the decoder below
 * is a stub that throws RecordingCodecUnavailable; the confusion query then reports recordings as unavailable and
 * still returns the signals it gets from events. Everything after decoding (the DecodedRecording shape and the
 * detectors) is ready and tested with synthetic decoded recordings: when SCHEMA.md lands, only `decodeTtRec1` needs
 * writing.
 */
import type { RecordingRow } from "./schema.ts";

export type Vec3 = [number, number, number];

/** About 10 per second: where the character and the camera were. */
export interface RecordingSample {
	t: number;
	/** Character root position (studs); absent while there is no character. */
	pos?: Vec3;
	/** Camera position and look direction (unit vector). */
	cam?: Vec3;
	look?: Vec3;
}

export type RecordingInputType =
	| "key"
	| "click"
	| "tap"
	| "stick_start"
	| "stick_stop"
	| "button"
	| "hover"
	| "screen_open"
	| "screen_close"
	| "prompt_shown"
	| "prompt_used"
	| "death"
	| "custom";

/** Something that happened once: an input, a button press (target = its path, e.g. Shop/Buy/Coins100), a screen. */
export interface RecordingInput {
	t: number;
	type: RecordingInputType;
	target?: string;
}

export interface DecodedRecording {
	pid: string;
	sid: string;
	samples: RecordingSample[];
	inputs: RecordingInput[];
}

export class RecordingCodecUnavailable extends Error {
	override name = "RecordingCodecUnavailable";
}

export type ChunkRow = Pick<RecordingRow, "pid" | "sid" | "chunk" | "codec" | "data" | "n"> & { t?: number };

export interface RecordingDecoder {
	codec: string;
	/** Decodes all chunks of one session (already sorted by chunk). */
	decode(chunks: ChunkRow[]): DecodedRecording;
}

/** TODO(tt-rec-1): fill in from framework/src/analytics/SCHEMA.md once the framework agent writes it. */
function decodeTtRec1(_chunks: ChunkRow[]): DecodedRecording {
	throw new RecordingCodecUnavailable("the tt-rec-1 decoder isn't written yet (waiting for framework/src/analytics/SCHEMA.md)");
}

const decoders = new Map<string, RecordingDecoder & { stub?: boolean }>([["tt-rec-1", { codec: "tt-rec-1", decode: decodeTtRec1, stub: true }]]);

/** Replaces or adds a decoder (tests, or a newer codec). */
export function registerDecoder(decoder: RecordingDecoder): () => void {
	const previous = decoders.get(decoder.codec);
	decoders.set(decoder.codec, decoder);
	return () => {
		if (previous) decoders.set(decoder.codec, previous);
		else decoders.delete(decoder.codec);
	};
}

/** True when a real (non-stub) decoder exists for the codec. */
export function hasDecoder(codec: string): boolean {
	const decoder = decoders.get(codec);
	return decoder !== undefined && !decoder.stub;
}

/** Groups chunk rows by session and decodes each session. Throws RecordingCodecUnavailable when a codec can't decode. */
export function decodeSessions(rows: ChunkRow[]): DecodedRecording[] {
	const bySession = new Map<string, ChunkRow[]>();
	for (const row of rows) {
		const list = bySession.get(row.sid) ?? [];
		list.push(row);
		bySession.set(row.sid, list);
	}
	const out: DecodedRecording[] = [];
	for (const chunks of bySession.values()) {
		chunks.sort((a, b) => a.chunk - b.chunk);
		const decoder = decoders.get(chunks[0].codec);
		if (!decoder) throw new RecordingCodecUnavailable(`no decoder for codec ${chunks[0].codec}`);
		out.push(decoder.decode(chunks));
	}
	return out;
}

// Confusion detectors ---------------------------------------------------------------------------------------------

export interface DetectorOptions {
	/** Idle: at least this long with no input and (almost) no movement. Default 10 s. */
	idleSeconds?: number;
	/** Movement below this many studs counts as standing still. Default 2. */
	stillStuds?: number;
	/** Camera spin: at least this many degrees of camera turning... Default 360. */
	spinDegrees?: number;
	/** ...within this window... Default 6 s... */
	spinWindowSeconds?: number;
	/** ...while the character moved less than this. Default 4 studs. */
	spinMaxStuds?: number;
	/** Repeated clicks: this many presses of the same button... Default 3... */
	repeatClicks?: number;
	/** ...within this window, with no screen change in between. Default 2 s. */
	repeatWindowSeconds?: number;
}

export type SignalKind = "idle" | "camera_spin" | "repeated_clicks";

export interface Signal {
	kind: SignalKind;
	pid: string;
	sid: string;
	t: number;
	/** How long it lasted, ms (idle, spin) or the number of presses (repeated clicks). */
	amount: number;
	/** The button path (repeated clicks). */
	target?: string;
	/** The zone at that moment, when known. */
	zone?: string;
}

/** The zone a player was in over time (from the session's state events), for placing signals. */
export type ZoneTimeline = { t: number; zone: string | null }[];

export function zoneAt(timeline: ZoneTimeline | undefined, t: number): string | undefined {
	if (!timeline?.length) return undefined;
	let zone: string | null = null;
	for (const entry of timeline) {
		if (entry.t > t) break;
		zone = entry.zone;
	}
	return zone ?? undefined;
}

function distance(a: Vec3, b: Vec3): number {
	return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Camera yaw in degrees from a look vector. */
function yaw(look: Vec3): number {
	return (Math.atan2(look[0], look[2]) * 180) / Math.PI;
}

function yawDelta(a: number, b: number): number {
	let d = b - a;
	while (d > 180) d -= 360;
	while (d < -180) d += 360;
	return Math.abs(d);
}

/** Finds idle spots, camera spins without movement, and repeated clicks in one decoded session. */
export function detectSignals(rec: DecodedRecording, zones?: ZoneTimeline, options: DetectorOptions = {}): Signal[] {
	const idleMs = (options.idleSeconds ?? 10) * 1000;
	const still = options.stillStuds ?? 2;
	const spinDeg = options.spinDegrees ?? 360;
	const spinWindow = (options.spinWindowSeconds ?? 6) * 1000;
	const spinStuds = options.spinMaxStuds ?? 4;
	const repeat = options.repeatClicks ?? 3;
	const repeatWindow = (options.repeatWindowSeconds ?? 2) * 1000;
	const signals: Signal[] = [];
	const at = (kind: SignalKind, t: number, amount: number, target?: string) => {
		const signal: Signal = { kind, pid: rec.pid, sid: rec.sid, t, amount };
		if (target !== undefined) signal.target = target;
		const zone = zoneAt(zones, t);
		if (zone !== undefined) signal.zone = zone;
		signals.push(signal);
	};
	const samples = [...rec.samples].sort((a, b) => a.t - b.t);
	const inputs = [...rec.inputs].sort((a, b) => a.t - b.t);

	// Idle: a stretch with no input and the character within `still` studs of where the stretch began.
	const activeInputs = inputs.filter((i) => i.type !== "hover" && i.type !== "prompt_shown");
	let inputIndex = 0;
	let idleStart: RecordingSample | undefined;
	let idleEnd = 0;
	const closeIdle = () => {
		if (idleStart && idleEnd - idleStart.t >= idleMs) at("idle", idleStart.t, idleEnd - idleStart.t);
		idleStart = undefined;
	};
	for (const sample of samples) {
		let hadInput = false;
		while (inputIndex < activeInputs.length && activeInputs[inputIndex].t <= sample.t) {
			hadInput = true;
			inputIndex++;
		}
		const moved = idleStart?.pos && sample.pos ? distance(idleStart.pos, sample.pos) > still : false;
		if (hadInput || moved || !sample.pos) {
			closeIdle();
			if (sample.pos && !hadInput) {
				idleStart = sample;
				idleEnd = sample.t;
			}
			continue;
		}
		if (!idleStart) idleStart = sample;
		idleEnd = sample.t;
	}
	closeIdle();

	// Camera spin: a sliding window turning >= spinDeg while the character stays within spinStuds.
	const withLook = samples.filter((s) => s.look && s.pos);
	let start = 0;
	let turned = 0;
	let lastSpinEnd = -Infinity;
	for (let i = 1; i < withLook.length; i++) {
		turned += yawDelta(yaw(withLook[i - 1].look as Vec3), yaw(withLook[i].look as Vec3));
		while (withLook[i].t - withLook[start].t > spinWindow) {
			turned -= yawDelta(yaw(withLook[start].look as Vec3), yaw(withLook[start + 1].look as Vec3));
			start++;
		}
		const moved = distance(withLook[start].pos as Vec3, withLook[i].pos as Vec3);
		if (turned >= spinDeg && moved < spinStuds && withLook[start].t > lastSpinEnd) {
			at("camera_spin", withLook[start].t, withLook[i].t - withLook[start].t);
			lastSpinEnd = withLook[i].t;
			start = i;
			turned = 0;
		}
	}

	// Repeated clicks: `repeat` presses of the same button within the window, no screen change in between.
	const presses = inputs.filter((i) => i.type === "button" || i.type === "screen_open" || i.type === "screen_close");
	let run: RecordingInput[] = [];
	const flush = () => {
		if (run.length >= repeat) at("repeated_clicks", run[0].t, run.length, run[0].target);
		run = [];
	};
	for (const input of presses) {
		if (input.type !== "button") {
			flush();
			continue;
		}
		if (run.length && (run[0].target !== input.target || input.t - run[0].t > repeatWindow)) flush();
		run.push(input);
	}
	flush();
	return signals;
}
