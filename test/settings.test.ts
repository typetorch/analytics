import { describe, expect, test } from "bun:test";
import { deleteDataStoreEntry, getDataStoreEntry } from "../src/opencloud.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SETTINGS_FIELD, validateSettings, writeFleetSettings, writeSettings } from "../src/settings.ts";
import { typetorchCliCommand, type RunCli } from "../src/typetorch-cli.ts";

const KEY = "test-api-key-not-real-0000";
const good = {
	backend: "basin" as const,
	events: "https://abc123.ingest.cloudflare.com",
	recordings: "https://def456.ingest.cloudflare.com",
	token: "send-only-token-0123456789",
	recordShare: 0.5,
	experiments: { onboarding: { active: true, weights: [1, 1] }, shop: { variant: "big" } },
};

function recorder(responses: { status: number; body?: unknown }[]) {
	const calls: { method: string; url: string; headers: Headers; body: unknown }[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ method: String(init?.method), url: String(input), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
		const next = responses.shift() ?? { status: 500 };
		return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status });
	}) as typeof fetch;
	return { calls, fetchImpl };
}

describe("validateSettings", () => {
	test("accepts good settings and drops unknown fields", () => {
		expect(validateSettings({ ...good, extra: 1 })).toEqual(good);
		expect(validateSettings({ backend: "duckdb", events: "https://a.example.com/v1/ingest" })).toEqual({ backend: "duckdb", events: "https://a.example.com/v1/ingest" });
	});
	test.each([
		[{ backend: "sqlite" }, "backend"],
		[{ events: "http://insecure.example.com" }, "https"],
		[{ events: "https://user:pw@x.example.com" }, "credentials"],
		[{ recordings: undefined }, "recordings stream"],
		[{ recordShare: 2 }, "recordShare"],
		[{ token: "short" }, "token"],
		[{ experiments: { onboarding: { weights: [0, 0] } } }, "weights"],
		[{ experiments: { onboarding: { active: "yes" } } }, "active"],
		[{ experiments: { onboarding: { variant: "a b" } } }, "variant"],
		[{ experiments: { "bad name": {} } }, "experiment name"],
		[{ flushSeconds: 2 }, "flushSeconds"],
		[{ techEvery: 5 }, "techEvery"],
	])("refuses %p", (over, message) => {
		expect(() => validateSettings({ ...good, ...over })).toThrow(message);
	});
});

function fakeCli(reply: { code?: number; stdout?: unknown; stderr?: string } = {}) {
	const calls: { command: string[]; cwd: string; stdin?: string; env?: Record<string, string> }[] = [];
	const run: RunCli = async (command, options) => {
		calls.push({ command, ...options });
		const stdout = reply.stdout === undefined ? "" : typeof reply.stdout === "string" ? reply.stdout : JSON.stringify(reply.stdout, null, 2);
		return { code: reply.code ?? 0, stdout, stderr: reply.stderr ?? "" };
	};
	return { calls, run };
}

describe("writeSettings (through the game's TypeTorch CLI)", () => {
	test("runs `typetorch settings set analytics - --json` in the game folder, the value on stdin, never in argv", async () => {
		const { calls, run } = fakeCli({ stdout: { outcome: "written", seq: 8, pinged: true, fields: ["analytics"] } });
		const result = await writeSettings({ gameDir: "/games/demo", cli: ["bun", "cli.ts"], run, settings: good });
		expect(result).toEqual({ value: good, written: true, seq: 8, pinged: true });
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toEqual(["bun", "cli.ts", "settings", "set", SETTINGS_FIELD, "-", "--json"]);
		expect(calls[0].cwd).toBe(resolve("/games/demo"));
		expect(JSON.parse(calls[0].stdin!)).toEqual(good);
		expect(calls[0].command.join(" ")).not.toContain(good.token);
	});

	test("--no-ping passes through; an unchanged record reports written: false", async () => {
		const { calls, run } = fakeCli({ stdout: { outcome: "unchanged", seq: 8, pinged: false, fields: [] } });
		expect(await writeSettings({ gameDir: ".", cli: ["tt"], run, settings: good, noPing: true })).toEqual({ value: good, written: false, seq: 8 });
		expect(calls[0].command).toEqual(["tt", "settings", "set", "analytics", "-", "--no-ping", "--json"]);
	});

	test("dry run validates and runs nothing", async () => {
		const { calls, run } = fakeCli();
		expect(await writeSettings({ gameDir: ".", cli: ["tt"], run, settings: good, dryRun: true })).toEqual({ value: good, written: false });
		expect(calls).toEqual([]);
		await expect(writeSettings({ gameDir: ".", cli: ["tt"], run, settings: { ...good, recordShare: 3 }, dryRun: true })).rejects.toThrow("recordShare");
	});

	test("a CLI failure carries the CLI's own message (e.g. no signing keys)", async () => {
		const { run } = fakeCli({ code: 1, stderr: "\u001b[31merror:\u001b[0m the settings record is signed with both prod keys: run `typetorch keys init`\n" });
		const error = await writeSettings({ gameDir: ".", cli: ["tt"], run, settings: good }).catch((e) => e);
		expect(error.message).toContain("typetorch settings set analytics - failed (exit 1)");
		expect(error.message).toContain("run `typetorch keys init`");
		expect(error.message).not.toContain("\u001b");
	});

	test("--force passes through (write although the CLI's endpoint checks failed)", async () => {
		const { calls, run } = fakeCli({ stdout: { outcome: "written", seq: 2 } });
		await writeSettings({ gameDir: ".", cli: ["tt"], run, settings: good, noPing: true, force: true });
		expect(calls[0].command).toEqual(["tt", "settings", "set", "analytics", "-", "--no-ping", "--force", "--json"]);
	});

	test("a refused endpoint check keeps the CLI's whole message: every failing step and its fix, no colors, no passing lines", async () => {
		const stderr = [
			"\u001b[2m  ok   fleet url     abc.trycloudflare.com over https\u001b[0m",
			"\u001b[31merror: refusing to write settings.analytics: 1 check failed, nothing was signed or written",
			"  FAIL analytics healthz abc.trycloudflare.com/healthz didn't answer (ENOTFOUND)",
			"       fix: abc.trycloudflare.com no longer exists (quick tunnel URLs die with their cloudflared); start it again on the dev PC: bun run local",
			"Fix that and run it again, or pass --force to write it anyway.\u001b[0m",
		].join("\n");
		const { run } = fakeCli({ code: 1, stderr });
		const error = await writeSettings({ gameDir: ".", cli: ["tt"], run, settings: good }).catch((e) => e);
		expect(error.message).toContain("failed (exit 1): error: refusing to write settings.analytics");
		expect(error.message).toContain("FAIL analytics healthz");
		expect(error.message).toContain("fix: abc.trycloudflare.com no longer exists");
		expect(error.message).toContain("--force");
		expect(error.message).not.toContain("fleet url");
		expect(error.message).not.toContain("\u001b");
	});

	test("an old CLI that prints no JSON is named", async () => {
		const { run } = fakeCli({ stdout: "Usage: typetorch <command>" });
		await expect(writeSettings({ gameDir: ".", cli: ["tt"], run, settings: good })).rejects.toThrow("0.8+");
	});

	test("without cli, the game's node_modules/@typetorch/cli bin runs with this runtime", () => {
		const dir = mkdtempSync(join(tmpdir(), "tt-analytics-cli-"));
		try {
			expect(() => typetorchCliCommand(dir)).toThrow("bun install");
			mkdirSync(join(dir, "node_modules", "@typetorch", "cli"), { recursive: true });
			writeFileSync(join(dir, "node_modules", "@typetorch", "cli", "package.json"), JSON.stringify({ bin: { typetorch: "dist/index.js" } }));
			expect(typetorchCliCommand(dir)).toEqual([process.execPath, join(dir, "node_modules", "@typetorch", "cli", "dist/index.js")]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("writeFleetSettings", () => {
	test("runs `typetorch fleet setup --url` with the ingest token in the child's environment only", async () => {
		const { calls, run } = fakeCli({ stdout: { field: "fleet", url: "https://a.trycloudflare.com", settingsSeq: 9, outcome: "written" } });
		const token = "ingest-token-not-real-0123456789";
		expect(await writeFleetSettings({ gameDir: ".", cli: ["tt"], run, url: "https://a.trycloudflare.com", ingestToken: token })).toEqual({ written: true, seq: 9 });
		expect(calls[0].command).toEqual(["tt", "fleet", "setup", "--url", "https://a.trycloudflare.com", "--json"]);
		expect(calls[0].env).toEqual({ TYPETORCH_FLEET_INGEST_TOKEN: token });
		await writeFleetSettings({ gameDir: ".", cli: ["tt"], run, url: "https://a.trycloudflare.com", ingestToken: token, force: true });
		expect(calls[1].command).toEqual(["tt", "fleet", "setup", "--url", "https://a.trycloudflare.com", "--force", "--json"]);
		expect(calls[0].command.join(" ")).not.toContain(token);
		await expect(writeFleetSettings({ gameDir: ".", cli: ["tt"], run, url: "http://insecure", ingestToken: token })).rejects.toThrow("https");
	});
});

describe("DataStore entries", () => {
	test("get: value, 404 -> undefined, the key is URL-encoded", async () => {
		const { calls, fetchImpl } = recorder([{ status: 200, body: { value: { pid: "p_abc", first: 1 } } }, { status: 404 }]);
		expect(await getDataStoreEntry({ apiKey: KEY, fetch: fetchImpl, universeId: 9, dataStore: "TypeTorchAnalytics", entry: "p/123" })).toEqual({ pid: "p_abc", first: 1 });
		expect(await getDataStoreEntry({ apiKey: KEY, fetch: fetchImpl, universeId: 9, dataStore: "TypeTorchAnalytics", entry: "p/456" })).toBeUndefined();
		expect(calls[0].url).toBe("https://apis.roblox.com/cloud/v2/universes/9/data-stores/TypeTorchAnalytics/entries/p%2F123");
	});
	test("delete: 404 counts as done", async () => {
		const { fetchImpl } = recorder([{ status: 404 }]);
		await deleteDataStoreEntry({ apiKey: KEY, fetch: fetchImpl, universeId: 9, dataStore: "TypeTorchAnalytics", entry: "p/1" });
	});
});
