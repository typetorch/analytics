// Node smoke test of the built server (dist/): starts `node dist/server/main.js` with a temp data folder, ingests a
// gzip batch, waits for the loader, runs a query, posts a fleet heartbeat and reads it back.
//   bun run build && node scripts/smoke.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = mkdtempSync(join(tmpdir(), "tt-smoke-"));
const INGEST = "smoke-ingest-token-0123456789abcdef";
const ADMIN = "smoke-admin-token-0123456789abcdef";
const port = 18000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
const env = {
	...process.env,
	TT_ANALYTICS_DATA: dir,
	TT_ANALYTICS_PORT: String(port),
	TT_ANALYTICS_INGEST_TOKENS: INGEST,
	TT_ANALYTICS_ADMIN_TOKEN: ADMIN,
	TT_ANALYTICS_LOAD_SECONDS: "0.5",
};
const child = spawn(process.execPath, [join(root, "dist", "server", "main.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (d) => (output += d));
child.stderr.on("data", (d) => (output += d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const check = (ok, what) => {
	if (!ok) throw new Error(`smoke: ${what}\n${output}`);
	console.log(`ok - ${what}`);
};

try {
	for (let i = 0; i < 100 && !output.includes("listening"); i++) await sleep(100);
	check(output.includes("listening"), `server started under ${process.version}`);
	const now = Date.now();
	const events = Array.from({ length: 50 }, (_, i) => ({ v: 1, t: now - 1000 + i, kind: "custom", name: "smoke", pid: `p${i % 5}`, sid: `s${i % 5}`, job: "job-1", art: "art-1", newp: true, state: "zone:Lobby|screen:|activity:idle" }));
	const r = await fetch(`${base}/v1/ingest`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-encoding": "gzip" }, body: gzipSync(JSON.stringify({ events })) });
	check(r.status === 202, "ingest answers 202");
	let players = 0;
	for (let i = 0; i < 50 && players !== 5; i++) {
		await sleep(200);
		const q = await fetch(`${base}/v1/query/overview`, { method: "POST", headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" }, body: "{}" });
		players = (await q.json()).result?.players ?? 0;
	}
	check(players === 5, "the loader loaded the batch and overview counts 5 players");
	const hb = await fetch(`${base}/v1/fleet/heartbeat`, { method: "POST", headers: { authorization: `Bearer ${INGEST}`, "content-type": "application/json" }, body: JSON.stringify({ j: "job-1", b: "prod", a: "art-1", n: 3, q: 1, h: "ok", k: "SECRET-CODE" }) });
	check(hb.status === 202, "fleet heartbeat answers 202 (node:sqlite)");
	const servers = await (await fetch(`${base}/v1/fleet/servers`, { headers: { authorization: `Bearer ${ADMIN}` } })).text();
	check(servers.includes('"job-1"') && !servers.includes("SECRET-CODE"), "fleet servers lists job-1 without the access code");
	console.log("smoke: all ok");
} finally {
	child.kill("SIGTERM");
	await sleep(1500);
	rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
