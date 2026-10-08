/** `bun run local` takes its keys from the game repo's .env. Fake folders and fake values only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gameEnvFile, planLocalRun, readGameEnv } from "../src/game-env.ts";
import { loadConfig } from "../src/server/config.ts";
import { ADMIN, API } from "./harness.ts";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "tt-gameenv-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const envFile = (lines: string[]) => writeFileSync(join(dir, ".env"), `${lines.join("\n")}\n`);
const plan = (extra: { env?: Record<string, string>; publicUrl?: string } = {}) =>
	planLocalRun({ gameDir: dir, env: { PATH: "/bin", ...extra.env }, port: 8787, dataDir: "/backend/data", ...(extra.publicUrl ? { publicUrl: extra.publicUrl } : {}) });

describe("reading the game's .env", () => {
	test("the file, the process environment over it, TYPETORCH_ENV_FILE as an override", () => {
		envFile([`TYPETORCH_API_KEY=${API}`, `TYPETORCH_ADMIN_TOKEN="${ADMIN}"`, "OPENCLOUD_API_KEY=unrelated-open-cloud-key", "# a comment"]);
		const read = readGameEnv(dir, {});
		expect(read.exists).toBe(true);
		expect(read.values).toEqual({ TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN });
		expect(readGameEnv(dir, { TYPETORCH_ADMIN_TOKEN: "from-process" }).values.TYPETORCH_ADMIN_TOKEN).toBe("from-process");
		const other = join(dir, "other.env");
		writeFileSync(other, "TYPETORCH_API_KEY=in-other-file\n");
		expect(gameEnvFile(dir, { TYPETORCH_ENV_FILE: other })).toBe(other);
		expect(readGameEnv(dir, { TYPETORCH_ENV_FILE: other }).values).toEqual({ TYPETORCH_API_KEY: "in-other-file" });
		expect(readGameEnv(join(dir, "nowhere"), {}).exists).toBe(false);
	});
});

describe("planLocalRun", () => {
	test("the server gets the keys, data in the backend's folder, the public URL on localhost; Roblox sign-in only with both OAuth values", () => {
		envFile([`TYPETORCH_API_KEY=${API}`, `TYPETORCH_ADMIN_TOKEN=${ADMIN}`]);
		const p = plan({ env: { TT_ANALYTICS_ADMIN_TOKEN: "old", TYPETORCH_FLEET_TOKEN: "old2", OPENCLOUD_API_KEY: "must-not-reach-the-server" } });
		expect(p.problems).toEqual([]);
		expect(p.serverEnv).toMatchObject({ TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN, TYPETORCH_DATA_DIR: "/backend/data", HOST: "127.0.0.1", PORT: "8787", TYPETORCH_PUBLIC_URL: "http://localhost:8787" });
		expect(p.serverEnv).not.toHaveProperty("TT_ANALYTICS_ADMIN_TOKEN");
		expect(p.serverEnv).not.toHaveProperty("TYPETORCH_FLEET_TOKEN");
		expect(p.serverEnv).not.toHaveProperty("ROBLOX_OAUTH_CLIENT_ID");
		expect(p.notes.join(" ")).toContain("Sign in with Roblox is off");
		// The environment the plan builds is one the backend accepts, without warnings.
		const config = loadConfig([], { ...p.serverEnv, TYPETORCH_EXPLORER: "off" });
		expect(config.warnings).toEqual([]);
		expect(config.apiKeys).toEqual([API]);
		expect(config.publicUrl).toBe("http://localhost:8787");

		envFile([`TYPETORCH_API_KEY=${API}`, `TYPETORCH_ADMIN_TOKEN=${ADMIN}`, "ROBLOX_OAUTH_CLIENT_ID=1234567890", "ROBLOX_OAUTH_CLIENT_SECRET=fake-oauth-secret-for-tests"]);
		const on = plan();
		expect(on.serverEnv).toMatchObject({ ROBLOX_OAUTH_CLIENT_ID: "1234567890", ROBLOX_OAUTH_CLIENT_SECRET: "fake-oauth-secret-for-tests" });
		expect(on.notes.join(" ")).toContain("Sign in with Roblox is on");
		expect(on.notes.join(" ")).not.toContain("fake-oauth-secret-for-tests");
		expect(loadConfig([], { ...on.serverEnv, TYPETORCH_EXPLORER: "off" }).robloxOAuth).toEqual({ clientId: "1234567890", clientSecret: "fake-oauth-secret-for-tests" });

		// One of the two: off, no error.
		envFile([`TYPETORCH_API_KEY=${API}`, `TYPETORCH_ADMIN_TOKEN=${ADMIN}`, "ROBLOX_OAUTH_CLIENT_ID=1234567890"]);
		const half = plan();
		expect(half.problems).toEqual([]);
		expect(half.serverEnv).not.toHaveProperty("ROBLOX_OAUTH_CLIENT_ID");
	});

	test("the port and a custom public URL", () => {
		envFile([`TYPETORCH_API_KEY=${API}`, `TYPETORCH_ADMIN_TOKEN=${ADMIN}`]);
		const p = planLocalRun({ gameDir: dir, env: {}, port: 9100, dataDir: "/d", publicUrl: "https://example.test/" });
		expect(p.serverEnv).toMatchObject({ PORT: "9100", TYPETORCH_PUBLIC_URL: "https://example.test" });
		expect(planLocalRun({ gameDir: dir, env: {}, port: 9100, dataDir: "/d" }).publicUrl).toBe("http://localhost:9100");
	});

	test("missing, short or equal keys: a plain problem with the fix, never a value", () => {
		envFile(["OPENCLOUD_API_KEY=unrelated"]);
		let p = plan();
		expect(p.problems.length).toBe(2);
		expect(p.problems[0]).toContain("TYPETORCH_API_KEY is missing");
		expect(p.problems[0]).toContain(join(dir, ".env"));
		expect(p.problems[0]).toContain("openssl rand -hex 32");
		expect(p.problems[1]).toContain("TYPETORCH_ADMIN_TOKEN is missing");
		expect(p.serverEnv).not.toHaveProperty("TYPETORCH_API_KEY");

		envFile(["TYPETORCH_API_KEY=short-secret", `TYPETORCH_ADMIN_TOKEN=${ADMIN}`]);
		p = plan();
		expect(p.problems.length).toBe(1);
		expect(p.problems[0]).toContain("shorter than 32");
		expect(p.problems.join(" ")).not.toContain("short-secret");

		envFile([`TYPETORCH_API_KEY=${API}`, `TYPETORCH_ADMIN_TOKEN=${API}`]);
		p = plan();
		expect(p.problems.join(" ")).toContain("same value");
		expect(p.problems.join(" ")).not.toContain(API);

		p = planLocalRun({ gameDir: join(dir, "nowhere"), env: {}, port: 8787, dataDir: "/d" });
		expect(p.problems.length).toBe(1);
		expect(p.problems[0]).toContain("does not exist");
	});

	test("without --game the keys may come from the process environment, else the fix says to use --game", () => {
		const p = planLocalRun({ env: { TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN }, port: 8787, dataDir: "/d" });
		expect(p.problems).toEqual([]);
		expect(p.serverEnv.TYPETORCH_API_KEY).toBe(API);
		const none = planLocalRun({ env: {}, port: 8787, dataDir: "/d" });
		expect(none.problems.length).toBe(2);
		expect(none.problems[0]).toContain("--game");
	});
});
