/** Copy to the clipboard and save a file from the page. Both can fail (insecure origin, blocked), so both say so. */

export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// fall through to the old way
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.opacity = "0";
		document.body.appendChild(area);
		area.select();
		const ok = typeof document.execCommand === "function" && document.execCommand("copy");
		area.remove();
		return ok;
	} catch {
		return false;
	}
}

/** Saves `text` as a file. A UTF-8 byte order mark first makes Excel read CSV with accents and dashes right. */
export function downloadText(filename: string, text: string, mime = "text/csv", bom = true): boolean {
	try {
		const blob = new Blob([bom ? "﻿" : "", text], { type: `${mime};charset=utf-8` });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = filename;
		link.rel = "noopener";
		document.body.appendChild(link);
		link.click();
		link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
		return true;
	} catch {
		return false;
	}
}

/** "fleet-servers-2026-10-09.csv" */
export function exportFilename(id: string, ext: string, now = new Date()): string {
	return `${id.replace(/[^\w.-]+/g, "-")}-${now.toISOString().slice(0, 10)}.${ext}`;
}
