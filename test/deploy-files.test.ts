/**
 * The deploy files can't be run here (no Docker on this machine), so these checks read them: every file the Dockerfile
 * copies exists and isn't in .dockerignore, compose.yaml only sets variables the server reads, the example env file loads,
 * and nothing secret is baked in anywhere.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API } from "./harness.ts";

const root = join(import.meta.dir, "..");
const read = (file: string) => readFileSync(join(root, file), "utf8");
const configSource = read("src/server/config.ts");

describe("Dockerfile", () => {
	const lines = read("Dockerfile")
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l && !l.startsWith("#"));

	test("every COPY source from the build context exists and is not ignored", () => {
		const ignore = read(".dockerignore")
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter((l) => l && !l.startsWith("#"));
		const copies = lines.filter((l) => l.startsWith("COPY ") && !l.includes("--from"));
		expect(copies.length).toBeGreaterThanOrEqual(5);
		for (const line of copies) {
			const parts = line.split(/\s+/).slice(1, -1); // sources; the last word is the destination
			for (const source of parts) {
				const path = source.replace(/\/$/, "");
				expect([line, existsSync(join(root, path))]).toEqual([line, true]);
				// A source is ignored when it, or a folder above it, is listed (patterns here are root-relative).
				const segments = path.split("/");
				const ignored = segments.some((_, i) => ignore.includes(segments.slice(0, i + 1).join("/")));
				expect([line, ignored]).toEqual([line, false]);
			}
		}
	});

	test("builds the explorer, installs production dependencies, runs as the non-root bun user on /data, with a health check", () => {
		const text = lines.join("\n");
		expect(text).toContain("FROM oven/bun:1.3 AS explorer");
		expect(text).toContain("bun --bun run build");
		expect(text).toContain("bun install --frozen-lockfile --production");
		expect(text).toContain("COPY --from=explorer /build/web/dist ./web/dist");
		expect(text).toContain("USER bun");
		expect(text).toContain("TYPETORCH_DATA_DIR=/data");
		expect(text).toContain("chown bun:bun /data");
		expect(text).toMatch(/HEALTHCHECK[\s\S]*\/healthz/);
		expect(text).toContain("EXPOSE 8787");
		expect(text).toContain('CMD ["bun", "src/server/main.ts"]');
		// Debian, not Alpine: DuckDB's prebuilt binding needs glibc.
		expect(text).not.toMatch(/alpine/i);
		// The volume is declared after /data is chowned (later changes to a volume path are discarded).
		expect(text.indexOf("chown bun:bun /data")).toBeLessThan(text.indexOf("VOLUME /data"));
	});

	test("the explorer's lockfile and the server's lockfile are tracked and match their package files", () => {
		for (const dir of ["", "web/"]) {
			expect(existsSync(join(root, `${dir}bun.lock`))).toBe(true);
			expect(existsSync(join(root, `${dir}package.json`))).toBe(true);
		}
		expect(read("bun.lock")).toContain('"name": "@typetorch/backend"');
		expect(JSON.parse(read("package.json")).name).toBe("@typetorch/backend");
	});

	test("no secret is set in the image", () => {
		const text = read("Dockerfile");
		for (const name of ["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN", "ROBLOX_OAUTH_CLIENT_SECRET", "OPENCLOUD_API_KEY", "ROBLOX_WEBHOOK_SECRET"]) {
			expect(text.split(/\r?\n/).filter((l) => !l.trim().startsWith("#") && l.includes(`${name}=`))).toEqual([]);
		}
		expect(read(".dockerignore")).toContain("**/.env");
	});
});

describe("compose.yaml", () => {
	const text = read("compose.yaml");

	test("one volume on /data, a health check on /healthz, port 8787, the two secrets required", () => {
		expect(text).toContain("typetorch-data:/data");
		expect(text.match(/^volumes:\n {2}[a-z-]+:/m)).not.toBeNull();
		expect(text).toContain("/healthz");
		expect(text).toContain('- "8787"');
		expect(text).toMatch(/TYPETORCH_API_KEY: \$\{TYPETORCH_API_KEY:\?/);
		expect(text).toMatch(/TYPETORCH_ADMIN_TOKEN: \$\{TYPETORCH_ADMIN_TOKEN:\?/);
		expect(text).toContain("stop_grace_period: 60s");
		// The port is published only by the local override, so a Coolify host's own 8787 is never taken.
		expect(text).not.toMatch(/^\s+ports:/m);
		expect(read("compose.local.yaml")).toContain("127.0.0.1:");
	});

	test("it passes TYPETORCH_RUNTIME_SETTINGS through (the way back in after a Settings page lockout must reach the container)", () => {
		expect(text).toMatch(/^ {6}TYPETORCH_RUNTIME_SETTINGS: \$\{TYPETORCH_RUNTIME_SETTINGS:-on\}$/m);
	});

	test("every variable it sets is one the server reads", () => {
		const names = [...text.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] as string);
		expect(names.length).toBeGreaterThan(10);
		for (const name of names) expect([name, configSource.includes(`"${name}"`) || configSource.includes(`env.${name}`)]).toEqual([name, true]);
	});

	test("the defaults it passes (empty values) leave the optional features off without errors", () => {
		const env: Record<string, string> = { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_EXPLORER: "off" };
		for (const m of text.matchAll(/^ {6}([A-Z][A-Z0-9_]+): \$\{[A-Z0-9_]+(?::-([^}]*))?\}/gm)) {
			if (m[1] === "TYPETORCH_API_KEY" || m[1] === "TYPETORCH_ADMIN_TOKEN") continue;
			env[m[1] as string] = m[2] ?? "";
		}
		const config = loadConfig([], env);
		expect(config.warnings).toEqual([]);
		expect(config).toMatchObject({ trustProxy: 1, tokenLogin: true, memoryLimit: "400MB", threads: 2 });
		expect(config.robloxOAuth).toBeUndefined();
		expect(config.adminAllowIps).toBeUndefined();
		expect(config.publicUrl).toBeUndefined();
	});
});

describe("server/ files", () => {
	test("the env example loads once the two secrets are filled in, with no warnings, and lists every required name", () => {
		const text = read("server/backend.env.example")
			.replace("TYPETORCH_API_KEY=\n", `TYPETORCH_API_KEY=${API}\n`)
			.replace("TYPETORCH_ADMIN_TOKEN=\n", `TYPETORCH_ADMIN_TOKEN=${ADMIN}\n`);
		const file = join(root, ".scratch", "env-example-check.env");
		mkdirSync(join(root, ".scratch"), { recursive: true });
		writeFileSync(file, text);
		try {
			const config = loadConfig(["--env-file", file], { TYPETORCH_EXPLORER: "off" });
			expect(config.warnings).toEqual([]);
			expect(config.apiKeys).toEqual([API]);
			expect(config.dataDir.replace(/\\/g, "/")).toContain("/var/lib/typetorch-backend");
			expect(config.trustProxy).toBe(1);
		} finally {
			rmSync(file, { force: true });
		}
		for (const name of ["TYPETORCH_API_KEY", "TYPETORCH_ADMIN_TOKEN", "TYPETORCH_PUBLIC_URL", "TYPETORCH_TRUST_PROXY", "TYPETORCH_ADMIN_ALLOW_IPS", "ROBLOX_OAUTH_CLIENT_ID", "ROBLOX_OAUTH_CLIENT_SECRET"]) {
			expect(read("server/backend.env.example")).toContain(`${name}=`);
		}
	});

	test("the unit and the example use the backend's names and paths; no old names are left", () => {
		const unit = read("server/typetorch-backend.service");
		expect(unit).toContain("EnvironmentFile=/etc/typetorch/backend.env");
		expect(unit).toContain("WorkingDirectory=/opt/typetorch-backend");
		expect(unit).toContain("ReadWritePaths=/var/lib/typetorch-backend");
		for (const file of ["server/typetorch-backend.service", "server/backend.env.example", "server/Caddyfile", "Dockerfile", "compose.yaml"]) {
			expect([file, /TT_ANALYTICS_|TT_FLEET_|TT_SERVER_PARTS/.test(read(file))]).toEqual([file, false]);
		}
		expect(existsSync(join(root, "server/Dockerfile"))).toBe(false);
	});
});
