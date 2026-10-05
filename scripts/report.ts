/**
 * A quick look at your analytics in the terminal: `bun scripts/report.ts --env-file <server env file> [--pid <pid>]`
 * (also `bun run report -- --env-file ...`).
 *
 * Asks the running analytics server (host/port and admin token from the same env file the server uses) for the main
 * queries and prints them: overview, Roblox-style numbers, top events, the onboarding funnel, experiments, live
 * servers, and one player's timeline and node graph (Mermaid). Without `--pid` it picks the player seen last in the
 * server's raw archive. Prints no tokens.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { Graph } from "../src/graph.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
};
const envFile = flag("--env-file");
if (!envFile) {
	console.error("usage: bun scripts/report.ts --env-file <server env file> [--pid <pid>]");
	process.exit(2);
}

const env = new Map<string, string>();
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
	if (line.trimStart().startsWith("#")) continue;
	const eq = line.indexOf("=");
	if (eq > 0) env.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1"));
}
const base = `http://${env.get("TT_ANALYTICS_HOST") ?? "127.0.0.1"}:${env.get("TT_ANALYTICS_PORT") ?? "8787"}`;
const token = env.get("TT_ANALYTICS_ADMIN_TOKEN");
if (!token) throw new Error(`TT_ANALYTICS_ADMIN_TOKEN is missing from ${envFile}`);
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function query(name: string, options: Record<string, unknown> = {}): Promise<any> {
	const response = await fetch(`${base}/v1/query/${name}`, { method: "POST", headers, body: JSON.stringify({ filters: {}, options }) });
	const body = (await response.json()) as { result?: unknown; error?: string };
	if (!response.ok) return { error: body.error ?? `HTTP ${response.status}` };
	return body.result;
}

/** The pid seen last in the raw archive (newest file first). */
function lastPid(): string | undefined {
	const archive = join(resolve(env.get("TT_ANALYTICS_DATA") ?? "data"), "raw", "archive");
	if (!existsSync(archive)) return undefined;
	const files = readdirSync(archive)
		.sort()
		.reverse()
		.flatMap((day) => readdirSync(join(archive, day)).filter((f) => f.startsWith("events-")).sort().reverse().map((f) => join(archive, day, f)));
	for (const file of files) {
		const text = (file.endsWith(".gz") ? gunzipSync(readFileSync(file)) : readFileSync(file)).toString("utf8");
		const rows = text.trim().split("\n").reverse();
		for (const line of rows) {
			try {
				const pid = (JSON.parse(line) as { pid?: string }).pid;
				if (pid) return pid;
			} catch {}
		}
	}
	return undefined;
}

const pct = (r?: { rate?: number; count?: number; of?: number } | null) =>
	r && typeof r.rate === "number" ? `${(r.rate * 100).toFixed(1)}% (${r.count}/${r.of})` : "n/a";
const title = (text: string) => console.log(`\n== ${text}`);

const overview = await query("overview");
title("Overview (30 days)");
if (overview.error) console.log(overview.error);
else {
	console.log(`players ${overview.players} (new ${overview.newPlayers}, returning ${overview.returningPlayers}), sessions ${overview.sessions}, events ${overview.events}`);
	console.log(`playtime ${overview.playtimeHours} h, average session ${overview.avgSessionMinutes} min`);
	for (const d of overview.days ?? []) console.log(`  ${d.date}  players ${d.players}  new ${d.newPlayers}  sessions ${d.sessions}`);
}

const roblox = await query("roblox");
title("Roblox-style numbers");
if (roblox.error) console.log(roblox.error);
else {
	console.log(`first-play bounce ${pct(roblox.firstPlayBounce)}   qualified plays ${pct(roblox.qualifiedPlays)}`);
	console.log(`D1 ${pct(roblox.d1Retention)}   D7 ${pct(roblox.d7Retention)}   payer conversion ${pct(roblox.payerConversion)}`);
}

const top = await query("top-events");
title("Top events (7 days)");
for (const e of top.events ?? []) console.log(`  ${String(e.count).padStart(6)}  ${e.kind}/${e.name}  (${e.players} players)`);

const funnel = await query("funnel", { funnel: "onboarding" });
title("Onboarding funnel");
if (funnel.error) console.log(funnel.error);
else for (const s of funnel.steps ?? []) console.log(`  step ${s.step} ${s.label ?? ""}: ${s.reached} players (${Math.round((s.ofStart ?? 0) * 100)}% of start)`);

const experiments = await query("experiment");
title("Experiments");
if (experiments.error) console.log(experiments.error);
else if (experiments.experiments) for (const e of experiments.experiments) console.log(`  ${e.name ?? e.experiment}: ${JSON.stringify(e).slice(0, 160)}`);
else console.log(`  ${JSON.stringify(experiments).slice(0, 400)}`);

const fleet = (await (await fetch(`${base}/v1/fleet/servers`, { headers })).json()) as { servers?: any[] };
title("Live servers (fleet)");
for (const s of fleet.servers ?? []) console.log(`  ${s.job}  ${s.branch} ${s.artifact} #${s.appliedSeq}  ${s.health}  ${s.players}/${s.maxPlayers} players  kernel ${s.kernel}`);
if (!fleet.servers?.length) console.log("  none");

const pid = flag("--pid") ?? lastPid();
title(`Player ${pid ?? "(none found)"}`);
if (pid) {
	const timeline = await query("timeline", { pid });
	if (timeline.error) console.log(timeline.error);
	for (const s of timeline.sessions ?? []) {
		console.log(`  session ${s.start} (${s.minutes} min, ${s.events} events${s.firstSession ? ", first session" : ""}) on ${s.art}, ${s.dev}`);
		for (const e of (timeline.events ?? []).filter((e: any) => e.sid === s.sid).slice(-40)) {
			const props = e.props && typeof e.props === "object" && Object.keys(e.props).length ? `  ${JSON.stringify(e.props).slice(0, 80)}` : "";
			console.log(`    ${String(e.time).slice(11, 19)}  ${e.kind}/${e.name}${e.state ? `  [${e.state}]` : ""}${props}`);
		}
	}
	const graph = await query("player-graph", { pid });
	if (graph.error) console.log(graph.error);
	else {
		console.log("\n  node graph (paste into any Mermaid viewer, e.g. https://mermaid.live):\n");
		console.log(Graph.fromJSON(graph).toMermaid());
	}
}
