/**
 * /servers/<JobId> (plans/25): one fleet server, and READ-ONLY remote debug of it while it runs.
 *
 * A Roblox server can't be called into, so it pulls: this page tells the backend it watches the job (every 20 s while
 * the tab is visible), the server's next heartbeat reply says so (up to 30 s; at once when the backend can publish a
 * wake message: "Waking server..."), and the server long-polls for commands.
 * Each fetch on a tab is one audited, allow-listed, read-only command; its answer stays in this page's memory (gone on
 * reload). A closed, lost or unknown server shows what the fleet knows and sends no watch.
 */
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ErrorState, KeyValue, LoadingBlock, PageHeader, Section } from "@/components/common";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/lib/api";
import { isReadOnly, useAuth } from "@/lib/auth";
import { fmtAgo, fmtDuration, fmtInt, fmtTime, shortId } from "@/lib/format";
import { useParam } from "@/lib/hooks";
import { CONNECTED_GRACE_MS, useRemote, useRemoteRunner, useServerWatch } from "@/lib/remote-debug";
import type { DebugStatus, FleetServerDetail, RemotePlayers, RemoteStatus } from "@/lib/types";
import { DexTab } from "./server/DexTab";
import { AuditTab, BudgetTab, BuildsTab, ErrorsTab, ModulesTab, NetworkTab } from "./server/InfoTabs";
import { LogsTab, type PlayerLogRequest } from "./server/LogsTab";
import { PlayersTab } from "./server/PlayersTab";
import { DebugContext, type DebugContextValue, Tone, useFirstFetch } from "./server/shared";
import { StateTab } from "./server/StateTab";
import { ServerCharts, StatusTab } from "./server/StatusTab";

export const SERVER_TABS = [
	{ id: "status", label: "Status" },
	{ id: "logs", label: "Logs" },
	{ id: "players", label: "Players" },
	{ id: "state", label: "State" },
	{ id: "dex", label: "Dex" },
	{ id: "modules", label: "Modules" },
	{ id: "builds", label: "Builds" },
	{ id: "budget", label: "Budget" },
	{ id: "errors", label: "Errors" },
	{ id: "network", label: "Network" },
	{ id: "audit", label: "Audit" },
] as const;
type TabId = (typeof SERVER_TABS)[number]["id"];

export const CONNECTING_TEXT = "Connecting: the server picks this up at its next heartbeat, up to 30 s.";
/** Plans/25 "Instant wake": the backend sent the server a wake message (the watch reply's `wake`). */
export const WAKING_TEXT = "Waking server...";
/** The read-only web role: no debug session (the backend refuses its watches and commands). */
export const READ_ONLY_TEXT = "Read-only session: remote debug needs an owner.";

/** How the session looks from here: the backend's view, the last watch reply, and whether an answer came lately. */
export function sessionState(
	debug: DebugStatus | undefined,
	watch: DebugStatus | undefined,
	answeredAt: number | undefined,
	now = Date.now(),
): { connected: boolean; lastPollAt?: number } {
	const lastPollAt = Math.max(debug?.lastPollAt ?? 0, watch?.lastPollAt ?? 0) || undefined;
	const recent = answeredAt !== undefined && now - answeredAt < CONNECTED_GRACE_MS;
	return { connected: Boolean(debug?.connected || watch?.connected || recent), ...(lastPollAt ? { lastPollAt } : {}) };
}

/**
 * How often the page re-reads the server: quickly while it waits for the first poll (every second while a wake is on
 * its way: the server polls within seconds), slowly after.
 */
export function detailRefetch(data: FleetServerDetail | undefined, waking = false): number | false {
	if (!data) return false;
	if (data.state === "live") return data.debug.connected ? 15_000 : waking ? 1_000 : 5_000;
	return data.state === "lost" ? 30_000 : false;
}

export default function ServerPage() {
	const { jobId = "" } = useParams();
	// A different JobId starts from nothing (no answer of one server ever shows on another's page).
	return <ServerView key={jobId} job={jobId} />;
}

function Header({ job, detail, placeVersion }: { job: string; detail?: FleetServerDetail; placeVersion?: number }) {
	const s = detail?.server;
	const uptime = s?.startedAt ? Date.now() - new Date(s.startedAt).getTime() : undefined;
	return (
		<>
			<PageHeader
				title={`Server ${shortId(job, 6)}`}
				description={<span className="font-mono text-xs break-all">{job}</span>}
				actions={
					<Button asChild variant="outline" size="sm">
						<Link to="/fleet">
							<ArrowLeft aria-hidden />
							Fleet
						</Link>
					</Button>
				}
			/>
			{s ? (
				<div className="flex flex-wrap gap-x-6 gap-y-1.5">
					<KeyValue label="Branch">{s.branch ?? "–"}</KeyValue>
					<KeyValue label="Build">{s.artifact ?? "–"}</KeyValue>
					<KeyValue label="Kernel">{s.kernel ?? "–"}</KeyValue>
					<KeyValue label="Players">
						{fmtInt(s.players)} / {fmtInt(s.maxPlayers)}
					</KeyValue>
					<KeyValue label="Up">{uptime !== undefined && uptime >= 0 ? fmtDuration(uptime) : "–"}</KeyValue>
					<KeyValue label="Health">
						<span title={s.lastError ?? undefined}>{s.health ?? "unknown"}</span>
					</KeyValue>
					<KeyValue label="Place version">{placeVersion ?? "–"}</KeyValue>
					<KeyValue label="Last heartbeat">{fmtAgo(s.lastSeen)}</KeyValue>
					<KeyValue label="Type">{s.serverType ?? "–"}</KeyValue>
				</div>
			) : null}
		</>
	);
}

function Connection({ live, connected, lastPollAt, watchError, watching, waking }: { live: boolean; connected: boolean; lastPollAt?: number; watchError?: string; watching: boolean; waking: boolean }) {
	if (!live) return null;
	if (watchError) return <Tone tone="bg-[var(--status-critical)]">Watch refused: {watchError}</Tone>;
	if (connected)
		return (
			<Tone tone="bg-[var(--status-good)]">
				Connected{lastPollAt ? `, last poll ${fmtTime(lastPollAt).slice(11)} UTC` : ""}
			</Tone>
		);
	return <Tone tone="bg-[var(--status-warning)]">{waking ? WAKING_TEXT : watching ? CONNECTING_TEXT : "Opening a session"}</Tone>;
}

function Gone({ detail }: { detail: FleetServerDetail }) {
	const s = detail.server;
	if (detail.state === "unknown")
		return (
			<Alert>
				<AlertTitle>No heartbeat from this JobId</AlertTitle>
				<AlertDescription>The fleet keeps a server for a day after it goes. Nothing to debug.</AlertDescription>
			</Alert>
		);
	const text =
		detail.state === "closed"
			? `This server closed at ${fmtTime(s?.closedAt ?? s?.lastSeen)} UTC: nothing to debug.`
			: `This server stopped sending heartbeats at ${fmtTime(s?.lostAt ?? s?.lastSeen)} UTC: nothing to debug.`;
	return (
		<Alert>
			<AlertTitle>{detail.state === "closed" ? "Closed" : "Lost"}</AlertTitle>
			<AlertDescription>{text}</AlertDescription>
		</Alert>
	);
}

function ServerView({ job }: { job: string }) {
	// A wake is on its way (set below from the watch reply; state, so the refetch interval changes at once).
	const [waking, setWaking] = useState(false);
	const detail = useQuery({
		queryKey: ["fleet", "server", job],
		queryFn: ({ signal }) => api.fleetServer(job, signal),
		refetchInterval: (query) => detailRefetch(query.state.data, waking),
	});
	const d = detail.data;
	const live = d?.state === "live";
	// The read-only web role sees the server (its heartbeats, the audit) but opens no debug session: a watch wakes the
	// server and a fetch runs a command on it, and the backend refuses both to that role.
	const readOnly = isReadOnly(useAuth());
	const watch = useServerWatch(job, live && !readOnly);
	const [answeredAt, setAnsweredAt] = useState<number | undefined>();
	const onAnswer = useCallback(() => setAnsweredAt(Date.now()), []);
	const call = useRemoteRunner(job, onAnswer);
	const session = sessionState(d?.debug, watch.reply, answeredAt);
	const ready = live && !readOnly && session.connected;
	const wakingNow = live && !session.connected && watch.reply?.wake === true;
	if (wakingNow !== waking) setWaking(wakingNow);

	const [tabParam, setTab] = useParam("tab", "status");
	// (the remote ops below are declared before any early return: hooks run in the same order every render)
	// The audit (who sent which command, from which address) is for owners; a viewer's page has no fetches anyway.
	const tabs = readOnly ? SERVER_TABS.filter((t) => t.id !== "audit") : SERVER_TABS;
	const tab: TabId = tabs.some((t) => t.id === tabParam) ? (tabParam as TabId) : "status";
	const status = useRemote<RemoteStatus>(call, "status");
	// Once, as soon as the server polls, whatever the tab: the header's place version and the Status tab come from it.
	useFirstFetch(ready, status.run);
	const players = useRemote<RemotePlayers>(call, "players");
	const [logRequest, setLogRequest] = useState<PlayerLogRequest | undefined>();
	const showLogs = useCallback(
		(userId: number) => {
			setLogRequest((r) => ({ userId, n: (r?.n ?? 0) + 1 }));
			setTab("logs");
		},
		[setTab],
	);
	const context = useMemo<DebugContextValue>(
		() => ({ job, call, ready, waitReason: readOnly ? READ_ONLY_TEXT : live ? (wakingNow ? WAKING_TEXT : CONNECTING_TEXT) : "This server isn't running." }),
		[job, call, ready, live, wakingNow, readOnly],
	);

	if (detail.isPending)
		return (
			<>
				<Header job={job} />
				<LoadingBlock rows={4} />
			</>
		);
	if (detail.isError)
		return (
			<>
				<Header job={job} />
				<ErrorState error={detail.error} title="Could not load this server" />
			</>
		);
	const data = detail.data;
	return (
		<DebugContext.Provider value={context}>
			<Header job={job} detail={data} placeVersion={status.data?.status?.placeVersion} />
			{!live ? (
				<>
					<Gone detail={data} />
					{data.server ? (
						<Section title="Last hour" description="TPS, memory and players from its heartbeats.">
							<ServerCharts job={job} live={false} />
						</Section>
					) : null}
				</>
			) : (
				<>
					<div className="flex flex-wrap items-center justify-between gap-2">
						{readOnly ? (
							<Tone tone="bg-muted-foreground">{READ_ONLY_TEXT}</Tone>
						) : (
							<Connection live={live} connected={session.connected} lastPollAt={session.lastPollAt} watchError={watch.error} watching={watch.reply !== undefined} waking={wakingNow} />
						)}
						<span className="text-xs text-muted-foreground">
							{readOnly ? "Heartbeats and the audit only: no commands go to the server from this session." : "Read only. Every fetch is one audited command; answers stay in this page (gone on reload)."}
						</span>
					</div>
					<Tabs value={tab} onValueChange={setTab} className="gap-4">
						<div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:thin]">
							<TabsList className="w-max" aria-label="Server debug">
								{tabs.map((t) => (
									<TabsTrigger key={t.id} value={t.id} className="px-2.5">
										{t.label}
									</TabsTrigger>
								))}
							</TabsList>
						</div>
						<TabsContent value="status" forceMount className="data-[state=inactive]:hidden">
							<StatusTab active={tab === "status"} job={job} live={live} status={status} />
						</TabsContent>
						<TabsContent value="logs" forceMount className="data-[state=inactive]:hidden">
							<LogsTab active={tab === "logs"} players={players} request={logRequest} />
						</TabsContent>
						<TabsContent value="players" forceMount className="data-[state=inactive]:hidden">
							<PlayersTab active={tab === "players"} players={players} onLogs={showLogs} />
						</TabsContent>
						<TabsContent value="state" forceMount className="data-[state=inactive]:hidden">
							<StateTab active={tab === "state"} />
						</TabsContent>
						<TabsContent value="dex" forceMount className="data-[state=inactive]:hidden">
							<DexTab active={tab === "dex"} />
						</TabsContent>
						<TabsContent value="modules" forceMount className="data-[state=inactive]:hidden">
							<ModulesTab active={tab === "modules"} />
						</TabsContent>
						<TabsContent value="builds" forceMount className="data-[state=inactive]:hidden">
							<BuildsTab active={tab === "builds"} />
						</TabsContent>
						<TabsContent value="budget" forceMount className="data-[state=inactive]:hidden">
							<BudgetTab active={tab === "budget"} />
						</TabsContent>
						<TabsContent value="errors" forceMount className="data-[state=inactive]:hidden">
							<ErrorsTab active={tab === "errors"} />
						</TabsContent>
						<TabsContent value="network" forceMount className="data-[state=inactive]:hidden">
							<NetworkTab active={tab === "network"} />
						</TabsContent>
						<TabsContent value="audit" forceMount className="data-[state=inactive]:hidden">
							{readOnly ? null : <AuditTab active={tab === "audit"} job={job} />}
						</TabsContent>
					</Tabs>
				</>
			)}
		</DebugContext.Provider>
	);
}
