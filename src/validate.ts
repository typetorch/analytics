/**
 * Row validation, generated from the field lists in schema.ts. Used by the DuckDB server's ingest (invalid rows are
 * dropped and counted, never stored) and available to anyone producing rows (the Basin stream drops rows that don't
 * match its schema silently, so check before sending).
 */
import {
	EVENT_FIELDS,
	RECORDING_FIELDS,
	ROW_VERSION,
	type EventRow,
	type FieldSpec,
	type IngestBatch,
	type RecordingRow,
} from "./schema.ts";

/** 2020-01-01 and 2100-01-01: anything outside is a unit mistake (seconds instead of ms) or garbage. */
const MIN_T = 1_577_836_800_000;
const MAX_T = 4_102_444_800_000;
const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;

export type Validation<T> = { ok: true; row: T } | { ok: false; error: string };

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkField(spec: FieldSpec, value: unknown): string | undefined {
	switch (spec.type) {
		case "int32":
		case "int64": {
			if (typeof value !== "number" || !Number.isSafeInteger(value)) return `${spec.name} must be an integer`;
			if (spec.type === "int32" && (value < INT32_MIN || value > INT32_MAX)) return `${spec.name} is out of int32 range`;
			return undefined;
		}
		case "bool":
			return typeof value === "boolean" ? undefined : `${spec.name} must be a boolean`;
		case "string": {
			if (typeof value !== "string") return `${spec.name} must be a string`;
			if (value.includes("\0")) return `${spec.name} holds a NUL character`;
			if (spec.maxLength !== undefined && value.length > spec.maxLength) return `${spec.name} is longer than ${spec.maxLength} characters`;
			if (spec.maxBytes !== undefined && encoder.encode(value).length > spec.maxBytes) return `${spec.name} is larger than ${spec.maxBytes} bytes`;
			if (spec.enum && !spec.enum.includes(value)) return `${spec.name} must be one of ${spec.enum.join(", ")}`;
			if (spec.json) {
				let parsed: unknown;
				try {
					parsed = JSON.parse(value);
				} catch {
					return `${spec.name} is not valid JSON`;
				}
				if (!isRecord(parsed)) return `${spec.name} must be a JSON object`;
			}
			return undefined;
		}
	}
}

function validateRow<T>(raw: unknown, fields: readonly FieldSpec[]): Validation<T> {
	if (!isRecord(raw)) return { ok: false, error: "row must be an object" };
	const row: Record<string, unknown> = {};
	for (const spec of fields) {
		const value = raw[spec.name];
		if (value === undefined || value === null) {
			if (spec.required) return { ok: false, error: `${spec.name} is required` };
			continue;
		}
		const error = checkField(spec, value);
		if (error) return { ok: false, error };
		row[spec.name] = value;
	}
	if (row.v !== ROW_VERSION) return { ok: false, error: `v must be ${ROW_VERSION}` };
	const t = row.t as number;
	if (t < MIN_T || t > MAX_T) return { ok: false, error: "t must be unix milliseconds (2020-2100)" };
	return { ok: true, row: row as T };
}

/** Checks one event row; returns a copy holding only the known fields. */
export function validateEvent(raw: unknown): Validation<EventRow> {
	const result = validateRow<EventRow>(raw, EVENT_FIELDS);
	if (result.ok && result.row.exp !== undefined) {
		// exp is a map of experiment name -> variant name.
		const parsed = JSON.parse(result.row.exp) as Record<string, unknown>;
		for (const value of Object.values(parsed)) {
			if (typeof value !== "string") return { ok: false, error: "exp values must be strings (variant names)" };
		}
	}
	return result;
}

/** Checks one recording row; returns a copy holding only the known fields. */
export function validateRecording(raw: unknown): Validation<RecordingRow> {
	const result = validateRow<RecordingRow>(raw, RECORDING_FIELDS);
	if (result.ok) {
		if (result.row.chunk < 0) return { ok: false, error: "chunk must be >= 0" };
		if (result.row.n < 0) return { ok: false, error: "n must be >= 0" };
		if (!/^[A-Za-z0-9+/]*={0,2}$/.test(result.row.data) || result.row.data.length % 4 !== 0) {
			return { ok: false, error: "data must be base64" };
		}
	}
	return result;
}

export interface BatchValidation {
	events: EventRow[];
	recordings: RecordingRow[];
	/** Rows dropped, with the first few reasons. */
	rejected: number;
	errors: string[];
}

/** Validates an ingest body (`{ events, recordings }`); invalid rows are dropped and counted. */
export function validateBatch(raw: unknown, options: { maxRows?: number; maxErrors?: number } = {}): BatchValidation {
	const maxRows = options.maxRows ?? 50_000;
	const maxErrors = options.maxErrors ?? 5;
	const out: BatchValidation = { events: [], recordings: [], rejected: 0, errors: [] };
	if (!isRecord(raw)) throw new BatchShapeError("body must be a JSON object { events, recordings }");
	const events = raw.events ?? [];
	const recordings = raw.recordings ?? [];
	if (!Array.isArray(events) || !Array.isArray(recordings)) throw new BatchShapeError("events and recordings must be arrays");
	if (events.length + recordings.length > maxRows) throw new BatchShapeError(`a batch holds at most ${maxRows} rows`);
	const reject = (kind: string, index: number, error: string) => {
		out.rejected++;
		if (out.errors.length < maxErrors) out.errors.push(`${kind}[${index}]: ${error}`);
	};
	events.forEach((row, i) => {
		const result = validateEvent(row);
		if (result.ok) out.events.push(result.row);
		else reject("events", i, result.error);
	});
	recordings.forEach((row, i) => {
		const result = validateRecording(row);
		if (result.ok) out.recordings.push(result.row);
		else reject("recordings", i, result.error);
	});
	return out;
}

export class BatchShapeError extends Error {
	override name = "BatchShapeError";
}

export type { IngestBatch };
