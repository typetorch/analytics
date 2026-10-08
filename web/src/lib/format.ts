/** Number, share, time and duration formatting used across pages. */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function fmtInt(n: number | null | undefined): string {
	return n === null || n === undefined || !Number.isFinite(n) ? "–" : integer.format(n);
}

export function fmtNum(n: number | null | undefined, digits = 2): string {
	if (n === null || n === undefined || !Number.isFinite(n)) return "–";
	return digits === 2 ? decimal.format(n) : new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(n);
}

/** 0.4214 -> "42.1%". */
export function fmtPct(share: number | null | undefined, digits = 1): string {
	if (share === null || share === undefined || !Number.isFinite(share)) return "–";
	return `${(share * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

/** "45s", "2m 05s", "1h 03m" (same as analytics/src/graph.ts). */
export function fmtDuration(ms: number): string {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function fmtMinutes(minutes: number | null | undefined): string {
	if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return "–";
	return minutes < 1 ? `${Math.round(minutes * 60)}s` : minutes < 120 ? `${fmtNum(minutes, 1)} min` : `${fmtNum(minutes / 60, 1)} h`;
}

/** "2026-10-05 18:15:05" in UTC (the server's days are UTC). */
export function fmtTime(iso: string | number | null | undefined): string {
	if (iso === null || iso === undefined || iso === "") return "–";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? String(iso) : d.toISOString().replace("T", " ").slice(0, 19);
}

/** "12s ago", "5 min ago", "3 h ago", "2 d ago". */
export function fmtAgo(iso: string | number | null | undefined, now = Date.now()): string {
	if (iso === null || iso === undefined || iso === "") return "–";
	const t = new Date(iso).getTime();
	if (Number.isNaN(t)) return "–";
	const s = Math.max(0, Math.round((now - t) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)} min ago`;
	if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
	return `${Math.floor(s / 86_400)} d ago`;
}

/** A long id shortened for tables: "18245d7c…4c221da6". */
export function shortId(id: string | null | undefined, keep = 8): string {
	if (!id) return "–";
	return id.length > keep * 2 + 1 ? `${id.slice(0, keep)}…${id.slice(-keep)}` : id;
}

/** Props as one compact line. */
export function compactJson(value: unknown, max = 160): string {
	if (value === null || value === undefined) return "";
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** "1 player", "3 players". */
export function plural(n: number | null | undefined, word: string, many = `${word}s`): string {
	return `${fmtInt(n)} ${n === 1 ? word : many}`;
}

/** "1.2 MB", "340 KB", "2.1 GB" (1024-based). */
export function fmtBytes(bytes: number | null | undefined): string {
	if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "–";
	const units = ["B", "KB", "MB", "GB", "TB"];
	let v = bytes;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${i === 0 ? Math.round(v) : v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
