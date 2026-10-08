import { describe, expect, test } from "bun:test";
import { deleteDataStoreEntry, getDataStoreEntry } from "../src/opencloud.ts";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateSettings, writeBackendSettings } from "../src/settings.ts";
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

describe("writeBackendSettings (typetorch backend setup through the game's TypeTorch CLI, 0.9+)", () => {
	const API = "api-key-not-real-0123456789abcdef0123";
	const ADMIN = "admin-token-not-real-0123456789abcdef";
	const base = { gameDir: "/games/demo", cli: ["bun", "cli.ts"], url: "https://abc.trycloudflare.com", apiKey: API, adminToken: ADMIN };

	test("runs `typetorch backend setup --url ... --json` in the game folder; both keys only in the child's environment", async () => {
		const { calls, run } = fakeCli({ stdout: { field: "backend", url: base.url, settingsSeq: 8, outcome: "written", pinged: true, owners: { state: "updated", seq: 8, owners: 1, sessionsEnded: 0 } } });
		const result = await writeBackendSettings({ ...base, run, flushSeconds: 15, recordShare: 1 });
		expect(result).toEqual({ written: true, seq: 8, pinged: true, owners: { state: "updated", seq: 8, owners: 1, sessionsEnded: 0 } });
		expect(calls).toHaveLength(1);
		expect(calls[0].command).toEqual(["bun", "cli.ts", "backend", "setup", "--url", base.url, "--flush-seconds", "15", "--record-share", "1", "--json"]);
		expect(calls[0].cwd).toBe(resolve("/games/demo"));
		expect(calls[0].env).toEqual({ TYPETORCH_API_KEY: API, TYPETORCH_ADMIN_TOKEN: ADMIN });
		expect(calls[0].command.join(" ")).not.toContain(API);
		expect(calls[0].command.join(" ")).not.toContain(ADMIN);
	});

	test("--no-ping and --force pass through; an unchanged record reports written: false; http and bad dials are refused first", async () => {
		const { calls, run } = fakeCli({ stdout: { outcome: "unchanged", settingsSeq: 8 } });
		expect(await writeBackendSettings({ ...base, cli: ["tt"], run, noPing: true, force: true })).toEqual({ written: false, seq: 8 });
		expect(calls[0].command).toEqual(["tt", "backend", "setup", "--url", base.url, "--no-ping", "--force", "--json"]);
		await expect(writeBackendSettings({ ...base, run, url: "http://insecure" })).rejects.toThrow("https");
		await expect(writeBackendSettings({ ...base, run, recordShare: 3 })).rejects.toThrow("recordShare");
		expect(calls).toHaveLength(1);
	});

	test("a refused endpoint check keeps the CLI's whole message: every failing step and its fix, no colors, no passing lines", async () => {
		const stderr = [
			"\u001b[2m  ok   backend url     abc.trycloudflare.com over https\u001b[0m",
			"\u001b[31merror: refusing to write settings.backend: 1 check failed, nothing was signed or written",
			"  FAIL backend healthz abc.trycloudflare.com/healthz didn't answer (ENOTFOUND)",
			"       fix: abc.trycloudflare.com no longer exists (quick tunnel URLs die with their cloudflared)",
			"Fix that and run it again, or pass --force to write it anyway.\u001b[0m",
		].join("\n");
		const { run } = fakeCli({ code: 1, stderr });
		const error = await writeBackendSettings({ ...base, run }).catch((e) => e);
		expect(error.message).toContain("failed (exit 1): error: refusing to write settings.backend");
		expect(error.message).toContain("FAIL backend healthz");
		expect(error.message).toContain("fix: abc.trycloudflare.com no longer exists");
		expect(error.message).not.toContain("backend url");
		expect(error.message).not.toContain("\u001b");
		expect(error.message).not.toContain(API);
	});

	test("a CLI failure carries the CLI's own message (e.g. no signing keys)", async () => {
		const { run } = fakeCli({ code: 1, stderr: "\u001b[31merror:\u001b[0m the settings record is signed with both prod keys: run `typetorch keys init`\n" });
		const error = await writeBackendSettings({ ...base, run }).catch((e) => e);
		expect(error.message).toContain("typetorch backend setup --url https://abc.trycloudflare.com failed (exit 1)");
		expect(error.message).toContain("run `typetorch keys init`");
	});

	test("a game CLI older than 0.9 (no backend command) is named, with the fix", async () => {
		const { run } = fakeCli({ code: 2, stderr: '\u001b[31munknown command "backend": did you mean "access"?\u001b[0m\ntypetorch 0.8.1: ...' });
		const error = await writeBackendSettings({ ...base, run }).catch((e) => e);
		expect(error.message).toContain("needs @typetorch/cli 0.9+");
		expect(error.message).toContain("--cli");
		const { run: noJson } = fakeCli({ stdout: "Usage: typetorch <command>" });
		await expect(writeBackendSettings({ ...base, run: noJson })).rejects.toThrow("0.9+");
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
