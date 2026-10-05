/**
 * The heavy jobs on a big day: N synthetic events for yesterday are written as raw files, loaded into the live file,
 * exported to Parquet by the nightly job (sorted by pid, t; rollups), and then queried. DuckDB as on a 1 GB VPS:
 * memory_limit 400MB, 1-2 threads; `--cpus 1` pins this process to one core.
 *
 *   bun scripts/nightly-bench.ts --rows 5000000 --cpus 1
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Warehouse } from "../src/server/warehouse.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: number) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? Number(args[i + 1]) : fallback;
};
const rows = opt("rows", 2_000_000);
const pinCpus = opt("cpus", 0);
const threads = opt("threads", 2);
const DAY = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), "tt-nightly-"));
if (pinCpus > 0) {
	const mask = (1 << pinCpus) - 1;
	if (process.platform === "win32") spawnSync("powershell", ["-NoProfile", "-Command", `(Get-Process -Id ${process.pid}).ProcessorAffinity = ${mask}`]);
	else spawnSync("taskset", ["-p", mask.toString(16), String(process.pid)]);
}

let peakRss = 0;
const sampler = setInterval(() => (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 50);
const mb = (bytes: number) => Math.round(bytes / 1048576);
const today = Math.floor(Date.now() / DAY) * DAY;
let now = today - DAY + 12 * 3_600_000;
const timed = async <T>(label: string, job: () => Promise<T>) => {
	peakRss = process.memoryUsage().rss;
	const t0 = performance.now();
	const out = await job();
	const s = Math.round((performance.now() - t0) / 100) / 10;
	return { label, seconds: s, peakRssMb: mb(peakRss), out };
};

const results: Record<string, unknown>[] = [];
const warehouse = await Warehouse.open({
	dataDir: dir,
	memoryLimit: "400MB",
	threads,
	keepDays: 400,
	rawKeepDays: 14,
	compactMb: 256,
	queryTimeoutSeconds: 600,
	queryConcurrency: 2,
	fsyncMs: 1000,
	clock: () => now,
});
try {
	// Raw files: 5 players' worth of sessions per pid bucket, a day of events, ~330 bytes a row.
	const incoming = join(dir, "raw", "incoming");
	mkdirSync(incoming, { recursive: true });
	const perFile = 250_000;
	const players = Math.max(100, Math.floor(rows / 100));
	const gen = await timed("generate raw files", async () => {
		let written = 0;
		let file = 0;
		while (written < rows) {
			const n = Math.min(perFile, rows - written);
			const out = createWriteStream(join(incoming, `events-${today - DAY + file}-${file}.ndjson`));
			let chunk = "";
			for (let i = 0; i < n; i++) {
				const k = written + i;
				const p = k % players;
				const t = today - DAY + Math.floor((k / rows) * DAY);
				chunk += `${JSON.stringify({
					v: 1,
					t,
					kind: ["custom", "zone", "state", "tech", "funnel", "purchase"][k % 6],
					name: ["quest_done", "enter", "screen", "client_perf", "onboarding", "product"][k % 6],
					pid: `p${p}`,
					sid: `s${p}_${Math.floor(t / 3_600_000)}`,
					job: `job-${p % 300}`,
					srv: "public",
					place: 1001,
					art: "a1b2c3d-1f2e3d",
					seq: 42,
					branch: "prod",
					channel: "prod",
					dev: "phone",
					newp: k % 50 === 0,
					state: `zone:Z${(k >> 3) % 6}|screen:|activity:round`,
					exp: `{"onboarding":"${p % 2 ? "short" : "long"}"}`,
					src: "server",
					props: `{"step":${k % 5},"robux":${k % 6 === 5 ? 99 : 0}}`,
					rt: t,
				})}\n`;
				if (chunk.length > 1 << 20) {
					if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
					chunk = "";
				}
			}
			out.end(chunk);
			await new Promise((r) => out.once("finish", r));
			written += n;
			file++;
		}
		return readdirSync(incoming).reduce((s, f) => s + statSync(join(incoming, f)).size, 0);
	});
	results.push({ step: gen.label, seconds: gen.seconds, rawMb: mb(gen.out) });
	const load = await timed("load raw -> live.duckdb", () => warehouse.load());
	results.push({ step: load.label, seconds: load.seconds, peakRssMb: load.peakRssMb, rows: load.out.rows, liveDuckdbMb: mb(statSync(join(dir, "live.duckdb")).size) });
	now = today + 10 * 60_000;
	const nightly = await timed("nightly: export to Parquet + rollups", () => warehouse.nightly());
	const parquet = statSync(join(dir, "events", `${new Date(today - DAY).toISOString().slice(0, 10)}.parquet`)).size;
	results.push({ step: nightly.label, seconds: nightly.seconds, peakRssMb: nightly.peakRssMb, parquetMb: mb(parquet), days: nightly.out.days, compacted: nightly.out.compacted });
	for (const [name, options] of [
		["overview", {}],
		["roblox", {}],
		["retention", {}],
		["flow", { facet: "zone" }],
		["experiment", { experiment: "onboarding" }],
		["timeline", { pid: "p7" }],
	] as const) {
		const q = await timed(`query ${name}`, () => warehouse.query(name, { from: today - 30 * DAY, to: today }, options));
		results.push({ step: q.label, seconds: q.seconds, peakRssMb: q.peakRssMb });
	}
} finally {
	clearInterval(sampler);
	await warehouse.close();
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
console.log(JSON.stringify({ rows, threads, cpus: pinCpus || "all", runtime: typeof process.versions.bun === "string" ? `bun ${process.versions.bun}` : `node ${process.version}`, results }, null, 2));
