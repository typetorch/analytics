/**
 * Runs a game folder's own TypeTorch CLI (`@typetorch/cli` in its node_modules). The game's settings (analytics sink,
 * fleet API) live in the signed settings record (kernel 0.3.8, TypeTorch plans/20), which only the CLI can write: it
 * holds the game's signing keys and does the read-check-sign-write. This package never signs anything itself.
 *
 * Secrets never go on the command line: values come in on stdin (`typetorch settings set analytics -`), tokens through
 * the child's environment (TYPETORCH_FLEET_INGEST_TOKEN). The CLI prints no tokens, so its output is safe to show.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface CliRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** Runs one CLI command: argv (the CLI's own, after the program), in the game folder. Injectable for tests. */
export type RunCli = (command: string[], options: { cwd: string; stdin?: string; env?: Record<string, string> }) => Promise<CliRun>;

export interface TypeTorchCliOptions {
	/** The game repo: a folder with typetorch.json, signing keys set up, and `@typetorch/cli` installed. */
	gameDir: string;
	/** The command that starts the CLI, default `<this runtime> <gameDir>/node_modules/@typetorch/cli/<bin>`. */
	cli?: string[];
	/** Extra environment for the CLI (merged over this process's). */
	env?: Record<string, string>;
	/** Replaces the process spawn (tests). */
	run?: RunCli;
}

/** The game folder's CLI entry: `<gameDir>/node_modules/@typetorch/cli` + its package.json "bin". */
export function typetorchCliCommand(gameDir: string): string[] {
	const pkgPath = join(resolve(gameDir), "node_modules", "@typetorch", "cli", "package.json");
	if (!existsSync(pkgPath)) {
		throw new Error(`${gameDir} has no @typetorch/cli in node_modules: run \`bun install\` in the game folder (the CLI writes the game's settings)`);
	}
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
	const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.typetorch;
	if (!bin) throw new Error(`${pkgPath} names no "typetorch" bin`);
	return [process.execPath, join(dirname(pkgPath), bin)];
}

export const spawnCli: RunCli = (command, options) =>
	new Promise((done, fail) => {
		const [program, ...args] = command;
		const child = spawn(program!, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout!.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr!.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", fail);
		child.on("close", (code) => done({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }));
		child.stdin!.end(options.stdin ?? "");
	});

/** The last few non-empty lines of the CLI's error output, for an error message. */
function lastLines(text: string, count = 4): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").trim())
		.filter(Boolean)
		.slice(-count)
		.join(" / ");
}

/**
 * Runs `typetorch <args> --json` in the game folder and returns its JSON output. Throws with the CLI's own message
 * (e.g. "run `typetorch keys init`") when it fails.
 */
export async function runTypeTorch(options: TypeTorchCliOptions, args: string[], input: { stdin?: string; env?: Record<string, string> } = {}): Promise<Record<string, unknown>> {
	const command = [...(options.cli ?? typetorchCliCommand(options.gameDir)), ...args, "--json"];
	const run = options.run ?? spawnCli;
	const result = await run(command, { cwd: resolve(options.gameDir), stdin: input.stdin, env: { ...options.env, ...input.env } });
	if (result.code !== 0) {
		throw new Error(`typetorch ${args.join(" ")} failed (exit ${result.code}): ${lastLines(result.stderr) || lastLines(result.stdout) || "no output"}`);
	}
	const text = result.stdout.trim();
	const start = text.lastIndexOf("\n{");
	try {
		return JSON.parse(start >= 0 ? text.slice(start + 1) : text) as Record<string, unknown>;
	} catch {
		throw new Error(`typetorch ${args.join(" ")} printed no JSON (is the game's @typetorch/cli 0.8+?): ${lastLines(text) || "no output"}`);
	}
}
