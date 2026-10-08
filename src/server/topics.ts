/** The bus' topics and what each carries. Every message has passed validation at the HTTP edge. */
import { EventBus } from "../bus.ts";
import type { ErrorBatch } from "../errors/parse.ts";
import type { Alert, DeployMessage, HeartbeatMessage } from "../fleet/service.ts";
import type { EventRow, RecordingRow } from "../schema.ts";

export interface EventsMessage {
	events: EventRow[];
	recordings: RecordingRow[];
	/** Rows of this request that failed validation. */
	rejected: number;
	/** Receive time, unix ms (the `rt` stamped into the raw file). */
	rt: number;
}

export interface ErrorMessage extends ErrorBatch {
	/** Receive time, unix ms. */
	at: number;
	/** The sender's address (for the per-sender new-kind quota; never sent to the explorer). */
	ip?: string;
}

export interface BackendTopics {
	/** Analytics rows from POST /v1/ingest. */
	events: EventsMessage;
	/** Fleet heartbeats and closing notices. */
	heartbeat: HeartbeatMessage;
	/** Deploy reports (from game servers) and deploy starts (from the CLI). */
	deploy: DeployMessage;
	/** Stored alerts (game, CLI and the server's own sweeps). */
	alert: Alert;
	/** Error log batches from POST /v1/errors. */
	error: ErrorMessage;
}

export type BackendBus = EventBus<BackendTopics>;
export const TOPICS = ["events", "heartbeat", "deploy", "alert", "error"] as const satisfies readonly (keyof BackendTopics)[];
export type Topic = (typeof TOPICS)[number];
