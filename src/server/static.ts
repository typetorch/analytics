/**
 * Serves the built explorer (web/dist) at `/`: files by path, `index.html` for any other path without a file extension
 * (the explorer's client-side routes). Hashed assets are cached for a year, everything else must be revalidated.
 */
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".txt": "text/plain; charset=utf-8",
	".map": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json",
};

export class StaticSite {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	/** The response for a GET/HEAD path, or undefined when this is not a page or file for the explorer. */
	async serve(method: string, pathname: string): Promise<Response | undefined> {
		if (method !== "GET" && method !== "HEAD") return undefined;
		let path: string;
		try {
			path = decodeURIComponent(pathname);
		} catch {
			return undefined;
		}
		// No traversal, and no dotfiles (a stray .env in the build folder is never served).
		if (path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part.startsWith("."))) return undefined;
		const file = resolve(join(this.root, path));
		if (file !== this.root && !file.startsWith(this.root + sep)) return undefined;
		const ext = extname(path).toLowerCase();
		const direct = await this.read(file);
		if (direct) return this.respond(method, direct, ext, path.startsWith("/assets/"));
		// A missing file with an extension is a 404, not a page; anything else is an explorer route.
		if (ext) return undefined;
		const index = await this.read(join(this.root, "index.html"));
		return index ? this.respond(method, index, ".html", false) : undefined;
	}

	private async read(file: string): Promise<Buffer | undefined> {
		try {
			const info = await stat(file);
			if (!info.isFile()) return undefined;
			return await readFile(file);
		} catch {
			return undefined;
		}
	}

	private respond(method: string, body: Buffer, ext: string, immutable: boolean): Response {
		const headers: Record<string, string> = {
			"content-type": TYPES[ext] ?? "application/octet-stream",
			"content-length": String(body.length),
			"cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
		};
		return new Response(method === "HEAD" ? null : body, { status: 200, headers });
	}
}
