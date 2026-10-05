/**
 * The TypeTorch analytics row format: the contract between the game side (`AnalyticsEngine` in @typetorch/framework,
 * which writes these rows) and the read side (this package). One flat JSON object per row; the same rows go to Basin
 * streams (JSON array POSTs) and to the DuckDB server (`POST /v1/ingest`, gzip `{ events, recordings }`).
 *
 * This file is the single source of truth here: the TypeScript types, the validator, the Basin stream schemas
 * (basin/*.schema.json) and the DuckDB table definitions are all generated from the field lists below.
 */

export const ROW_VERSION = 1;

export const EVENT_KINDS = [
	"session",
	"tech",
	"zone",
	"funnel",
	"purchase",
	"currency",
	"state",
	"experiment",
	"custom",
	"recording_meta",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const DEVICES = ["desktop", "phone", "tablet", "console", "vr", "unknown"] as const;
export type Device = (typeof DEVICES)[number];

export const SOURCES = ["server", "client"] as const;
export type Source = (typeof SOURCES)[number];

/** The only recording codec so far (documented by the framework in framework/src/analytics/SCHEMA.md). */
export const RECORDING_CODECS = ["tt-rec-1"] as const;
export type RecordingCodec = (typeof RECORDING_CODECS)[number];

/** props is a JSON string of at most this many bytes (UTF-8). */
export const MAX_PROPS_BYTES = 4096;
/** A recording chunk's base64 data, at most this many characters. */
export const MAX_RECORDING_DATA_CHARS = 64 * 1024;

/** One event row. */
export interface EventRow {
	/** Row format version (1). */
	v: 1;
	/** Unix time in ms (int64). */
	t: number;
	kind: EventKind;
	name: string;
	/** Random player id (never a UserId); empty for server-level rows such as server tech health. */
	pid?: string;
	/** Session id. */
	sid?: string;
	/** Game server JobId. */
	job: string;
	/** Server type, e.g. public, private, reserved, studio. */
	srv?: string;
	/** PlaceId (int64). */
	place?: number;
	/** Artifact id (the build that was live). */
	art: string;
	/** Artifact deploy seq (int64). */
	seq?: number;
	branch?: string;
	channel?: string;
	dev?: Device;
	/** True on every event of a player's first-ever session. */
	newp?: boolean;
	/** The player's state, e.g. `zone:Lobby|screen:Shop|activity:round`. */
	state?: string;
	/** JSON string of the player's experiment variants, e.g. `{"onboarding":"short"}`. */
	exp?: string;
	/** The server's experiment (per-server A/B), if any. */
	sexp?: string;
	src?: Source;
	/** JSON string, at most 4 KB. */
	props?: string;
}

/** One first-session recording chunk (packed blob, one row per batch, not per sample). */
export interface RecordingRow {
	v: 1;
	t: number;
	pid: string;
	sid: string;
	job: string;
	art: string;
	/** Chunk number within the session (0, 1, 2, ...). */
	chunk: number;
	codec: RecordingCodec;
	/** Base64 of the packed chunk. */
	data: string;
	/** Number of samples or records in the chunk. */
	n: number;
}

/** The DuckDB server's ingest body (gzip JSON). */
export interface IngestBatch {
	events?: EventRow[];
	recordings?: RecordingRow[];
}

/** Column types shared by the generators (Basin stream schema type / DuckDB type). */
export type FieldType = "int32" | "int64" | "string" | "bool";

export interface FieldSpec {
	name: string;
	type: FieldType;
	/** Required in every row (the validator rejects rows without it; the Basin schema marks it required). */
	required: boolean;
	/** Allowed values (strings only). */
	enum?: readonly string[];
	/** Maximum length in characters (strings). */
	maxLength?: number;
	/** A JSON-encoded string (validated as JSON; must encode an object). */
	json?: boolean;
	/** Maximum UTF-8 bytes (strings). */
	maxBytes?: number;
	description: string;
}

export const EVENT_FIELDS: readonly FieldSpec[] = [
	{ name: "v", type: "int32", required: true, description: "row format version (1)" },
	{ name: "t", type: "int64", required: true, description: "unix time in ms" },
	{ name: "kind", type: "string", required: true, enum: EVENT_KINDS, description: "event group" },
	{ name: "name", type: "string", required: true, maxLength: 128, description: "event name" },
	{ name: "pid", type: "string", required: false, maxLength: 64, description: "random player id (never a UserId)" },
	{ name: "sid", type: "string", required: false, maxLength: 64, description: "session id" },
	{ name: "job", type: "string", required: true, maxLength: 64, description: "game server JobId" },
	{ name: "srv", type: "string", required: false, maxLength: 32, description: "server type" },
	{ name: "place", type: "int64", required: false, description: "PlaceId" },
	{ name: "art", type: "string", required: true, maxLength: 64, description: "artifact id" },
	{ name: "seq", type: "int64", required: false, description: "artifact deploy seq" },
	{ name: "branch", type: "string", required: false, maxLength: 64, description: "branch" },
	{ name: "channel", type: "string", required: false, maxLength: 16, description: "channel (prod or dev)" },
	{ name: "dev", type: "string", required: false, enum: DEVICES, description: "device type" },
	{ name: "newp", type: "bool", required: false, description: "first-ever session" },
	{ name: "state", type: "string", required: false, maxLength: 512, description: "zone:X|screen:Y|activity:Z" },
	{ name: "exp", type: "string", required: false, json: true, maxBytes: 1024, description: "JSON of the player's experiment variants" },
	{ name: "sexp", type: "string", required: false, maxLength: 128, description: "the server's experiment" },
	{ name: "src", type: "string", required: false, enum: SOURCES, description: "server or client" },
	{ name: "props", type: "string", required: false, json: true, maxBytes: MAX_PROPS_BYTES, description: "JSON string, at most 4 KB" },
];

export const RECORDING_FIELDS: readonly FieldSpec[] = [
	{ name: "v", type: "int32", required: true, description: "row format version (1)" },
	{ name: "t", type: "int64", required: true, description: "unix time in ms" },
	{ name: "pid", type: "string", required: true, maxLength: 64, description: "random player id" },
	{ name: "sid", type: "string", required: true, maxLength: 64, description: "session id" },
	{ name: "job", type: "string", required: true, maxLength: 64, description: "game server JobId" },
	{ name: "art", type: "string", required: true, maxLength: 64, description: "artifact id" },
	{ name: "chunk", type: "int32", required: true, description: "chunk number within the session" },
	{ name: "codec", type: "string", required: true, enum: RECORDING_CODECS, description: "packing format" },
	{ name: "data", type: "string", required: true, maxLength: MAX_RECORDING_DATA_CHARS, description: "base64 packed chunk" },
	{ name: "n", type: "int32", required: true, description: "samples or records in the chunk" },
];

export const EVENT_COLUMNS = EVENT_FIELDS.map((f) => f.name);
export const RECORDING_COLUMNS = RECORDING_FIELDS.map((f) => f.name);

/** DuckDB column type for a field. */
export function duckdbType(type: FieldType): string {
	switch (type) {
		case "int32":
			return "INTEGER";
		case "int64":
			return "BIGINT";
		case "bool":
			return "BOOLEAN";
		case "string":
			return "VARCHAR";
	}
}

/**
 * Prop keys the logical queries read (the framework writes them). Documented in plans/16 section 6a and the README.
 * A query option can override each one.
 */
export const PROP_KEYS = {
	/** funnel rows (`kind = funnel`, `name` = funnel id): the step number. */
	funnelStep: "step",
	/** funnel rows: the step's label, e.g. "opened_shop". */
	funnelLabel: "label",
	/** purchase rows: Robux spent. */
	purchaseRobux: "robux",
	/** purchase rows: the product id. */
	purchaseProduct: "product",
	/** currency rows (`name` = currency): the signed amount. */
	currencyAmount: "amount",
} as const;
