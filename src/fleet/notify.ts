/**
 * Alert notifications to one webhook (Discord, Slack, or generic JSON). Critical alerts only by default. The same
 * (code, branch, artifact) is sent at most once per 10 minutes, and at most `perMinute` posts go out per minute
 * (the rest are dropped and counted). The webhook URL is a secret: never logged.
 */
import type { Alert, AlertLevel } from "./service.ts";

export type WebhookFormat = "discord" | "slack" | "json";

export interface NotifierOptions {
	url: string;
	format?: WebhookFormat;
	levels?: Set<AlertLevel>;
	dedupMs?: number;
	perMinute?: number;
	fetch?: typeof fetch;
	clock?: () => number;
	log?: (line: string) => void;
}

export interface Notifier {
	notify(alert: Alert): void;
	/** Resolves when queued posts are done (tests, shutdown). */
	flush(): Promise<void>;
	readonly stats: { sent: number; deduped: number; throttled: number; failed: number; skipped: number };
}

export function detectFormat(url: string): WebhookFormat {
	const host = new URL(url).hostname;
	if (host === "discord.com" || host === "discordapp.com" || host.endsWith(".discord.com")) return "discord";
	if (host === "hooks.slack.com") return "slack";
	return "json";
}

export function alertText(alert: Alert): string {
	const where = [alert.branch, alert.artifact, alert.seq !== null ? `seq ${alert.seq}` : null, alert.job].filter(Boolean).join(", ");
	return `${alert.level === "critical" ? "CRITICAL" : alert.level === "warning" ? "Warning" : "Info"}: ${alert.code}${where ? ` (${where})` : ""}: ${alert.message}`;
}

export function webhookBody(alert: Alert, format: WebhookFormat): unknown {
	const line = alertText(alert);
	if (format === "discord") return { content: line.slice(0, 1900), allowed_mentions: { parse: [] } };
	if (format === "slack") return { text: line.slice(0, 3000) };
	return { alert };
}

export function createNotifier(options: NotifierOptions): Notifier {
	const url = options.url;
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") throw new Error("the fleet webhook URL must be https");
	const format = options.format ?? detectFormat(url);
	const levels: Set<AlertLevel> = options.levels ?? new Set<AlertLevel>(["critical"]);
	const dedupMs = options.dedupMs ?? 10 * 60_000;
	const perMinute = options.perMinute ?? 20;
	const clock = options.clock ?? Date.now;
	const doFetch = options.fetch ?? fetch;
	const lastSent = new Map<string, number>();
	const sentTimes: number[] = [];
	let chain: Promise<void> = Promise.resolve();
	const stats = { sent: 0, deduped: 0, throttled: 0, failed: 0, skipped: 0 };
	return {
		stats,
		notify(alert) {
			if (!levels.has(alert.level)) {
				stats.skipped++;
				return;
			}
			const now = clock();
			const key = `${alert.code}\u0000${alert.branch ?? ""}\u0000${alert.artifact ?? ""}`;
			if (now - (lastSent.get(key) ?? -Infinity) < dedupMs) {
				stats.deduped++;
				return;
			}
			while (sentTimes.length && now - sentTimes[0] > 60_000) sentTimes.shift();
			if (sentTimes.length >= perMinute) {
				stats.throttled++;
				return;
			}
			lastSent.set(key, now);
			sentTimes.push(now);
			if (lastSent.size > 10_000) for (const [k, t] of lastSent) if (now - t > dedupMs) lastSent.delete(k);
			chain = chain.then(async () => {
				try {
					const response = await doFetch(url, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(webhookBody(alert, format)),
						signal: AbortSignal.timeout(5000),
					});
					if (response.ok) stats.sent++;
					else {
						stats.failed++;
						options.log?.(`fleet webhook answered ${response.status} for alert ${alert.id}`);
					}
				} catch (error) {
					stats.failed++;
					options.log?.(`fleet webhook failed for alert ${alert.id}: ${(error as Error).name}`);
				}
			});
		},
		flush: () => chain,
	};
}
