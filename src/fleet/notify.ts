/**
 * Alert notifications to one webhook (Discord, Slack, or generic JSON). Critical alerts only by default. The same
 * (code, branch, artifact) is sent at most once per 10 minutes, and at most `perMinute` posts go out per minute
 * (the rest are dropped and counted). The webhook URL is a secret: never logged, never in an error.
 *
 * The URL, the format and the levels may be functions (the backend's runtime settings): they are read for every alert,
 * so a change on the explorer's Settings page applies to the next one. No URL = alerts are skipped (counted).
 */
import type { Alert, AlertLevel } from "./service.ts";

export type WebhookFormat = "discord" | "slack" | "json";

export interface NotifierOptions {
	url: string | (() => string | undefined);
	format?: WebhookFormat | (() => WebhookFormat | undefined);
	levels?: Set<AlertLevel> | (() => ReadonlySet<AlertLevel>);
	dedupMs?: number;
	perMinute?: number;
	fetch?: typeof fetch;
	clock?: () => number;
	log?: (line: string) => void;
}

/** What a test send answered: never the URL or the receiver's body, only a status or an error name. */
export interface WebhookTestResult {
	ok: boolean;
	status?: number;
	error?: string;
}

export interface Notifier {
	notify(alert: Alert): void;
	/** Sends one alert now through the current webhook, ignoring levels, dedup and the throttle (the Settings page's test). */
	test(alert: Alert): Promise<WebhookTestResult>;
	/** Whether a webhook URL is set right now. */
	readonly configured: boolean;
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

const isHttps = (url: string): boolean => {
	try {
		return new URL(url).protocol === "https:";
	} catch {
		return false;
	}
};

export function createNotifier(options: NotifierOptions): Notifier {
	if (typeof options.url === "string" && !isHttps(options.url)) throw new Error("the fleet webhook URL must be https");
	const currentUrl = (): string | undefined => {
		const url = typeof options.url === "function" ? options.url() : options.url;
		// The settings only ever hold https URLs; anything else is never sent to.
		return url && isHttps(url) ? url : undefined;
	};
	const currentFormat = (url: string): WebhookFormat => (typeof options.format === "function" ? options.format() : options.format) ?? detectFormat(url);
	const currentLevels = (): ReadonlySet<AlertLevel> => (typeof options.levels === "function" ? options.levels() : options.levels) ?? new Set<AlertLevel>(["critical"]);
	const dedupMs = options.dedupMs ?? 10 * 60_000;
	const perMinute = options.perMinute ?? 20;
	const clock = options.clock ?? Date.now;
	const doFetch = options.fetch ?? fetch;
	const lastSent = new Map<string, number>();
	const sentTimes: number[] = [];
	let chain: Promise<void> = Promise.resolve();
	const stats = { sent: 0, deduped: 0, throttled: 0, failed: 0, skipped: 0 };

	const post = (url: string, alert: Alert): Promise<Response> =>
		doFetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(webhookBody(alert, currentFormat(url))),
			signal: AbortSignal.timeout(5000),
		});

	return {
		stats,
		get configured() {
			return currentUrl() !== undefined;
		},
		notify(alert) {
			const url = currentUrl();
			if (!url || !currentLevels().has(alert.level)) {
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
					const response = await post(url, alert);
					await response.body?.cancel().catch(() => {});
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
		async test(alert) {
			const url = currentUrl();
			if (!url) return { ok: false, error: "no alert webhook is set" };
			try {
				const response = await post(url, alert);
				await response.body?.cancel().catch(() => {});
				return response.ok ? { ok: true, status: response.status } : { ok: false, status: response.status, error: `the webhook answered HTTP ${response.status}` };
			} catch (error) {
				return { ok: false, error: `the webhook could not be reached (${(error as Error).name})` };
			}
		},
		flush: () => chain,
	};
}
