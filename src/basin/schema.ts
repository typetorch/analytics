/**
 * Cloudflare Basin stream schemas for the two row kinds, generated from schema.ts. The files in `basin/` are the
 * output of `bun run basin:schemas`; give them to `npx wrangler basin pipelines setup` ("Load from file") or
 * `npx wrangler basin pipelines streams create <name> --schema-file basin/events.schema.json`.
 *
 * Basin stream schema format (developers.cloudflare.com/basin-pipelines/streams/manage-streams): `{ fields: [{ name,
 * type, required }] }` with types string, int32, int64, float32, float64, bool, timestamp, json, binary, list, struct.
 * Rows that don't match are accepted at ingest and dropped later (only visible in the user-error metrics), and a
 * schema can't be changed after the stream exists.
 *
 * `t` stays int64 (unix ms), exactly like the DuckDB tables, so the same SQL works on both backends. `props` and `exp`
 * stay strings (JSON text), not the `json` type: the game sends them as strings.
 */
import { EVENT_FIELDS, RECORDING_FIELDS, type FieldSpec } from "../schema.ts";

export interface BasinField {
	name: string;
	type: "string" | "int32" | "int64" | "bool";
	required: boolean;
}

export interface BasinStreamSchema {
	fields: BasinField[];
}

export function basinStreamSchema(fields: readonly FieldSpec[]): BasinStreamSchema {
	return { fields: fields.map((f) => ({ name: f.name, type: f.type, required: f.required })) };
}

export const BASIN_EVENTS_SCHEMA = basinStreamSchema(EVENT_FIELDS);
export const BASIN_RECORDINGS_SCHEMA = basinStreamSchema(RECORDING_FIELDS);

/** The files `bun run basin:schemas` writes (path relative to the repo root -> JSON text). */
export function basinSchemaFiles(): Record<string, string> {
	return {
		"basin/events.schema.json": `${JSON.stringify(BASIN_EVENTS_SCHEMA, null, "\t")}\n`,
		"basin/recordings.schema.json": `${JSON.stringify(BASIN_RECORDINGS_SCHEMA, null, "\t")}\n`,
	};
}

/** Default Basin names (the setup guide in the README uses them; all configurable in the store config). */
export const BASIN_DEFAULTS = {
	namespace: "typetorch",
	eventsTable: "events",
	recordingsTable: "recordings",
} as const;
