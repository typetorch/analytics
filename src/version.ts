import { readFileSync } from "node:fs";

/** Package name and version, read from package.json next to src/ (or dist/). */
function read(): { name: string; version: string } {
	try {
		const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name?: string; version?: string };
		return { name: pkg.name ?? "@typetorch/backend", version: pkg.version ?? "0.0.0" };
	} catch {
		return { name: "@typetorch/backend", version: "0.0.0" };
	}
}

export const PACKAGE = read();
