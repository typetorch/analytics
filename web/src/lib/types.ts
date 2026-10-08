/**
 * The analytics server's answers, as the explorer reads them. They mirror `analytics/src/queries/*.ts` and
 * `analytics/src/fleet/*` (a separate repo: copied, not imported). Keep them in step when a query changes.
 */

export type Device = "desktop" | "phone" | "tablet" | "console" | "vr" | "unknown";
export const DEVICES: Device[] = ["desktop", "phone", "tablet", "console", "vr", "unknown"];

/** What every query accepts (`analytics/src/sql/filters.ts`). */
export interface Filters {
	from?: string;
	to?: string;
	art?: string | string[];
	branch?: string | string[];
	channel?: string | string[];
	dev?: Device | Device[];
	players?: "new" | "returning";
	variant?: { experiment: string; variant: string | string[] };
	sexp?: string | string[];
	place?: number;
}

export interface Rate {
	rate: number;
	count: number;
	of: number;
}

export interface OverviewDay {
	date: string;
	players: number;
	newPlayers: number;
	sessions: number;
	playtimeHours: number;
}

export interface OverviewResult {
	from: string;
	to: string;
	players: number;
	newPlayers: number;
	returningPlayers: number;
	sessions: number;
	events: number;
	playtimeHours: number;
	avgSessionMinutes: number;
	playtimePerPlayerMinutes: number;
	days: OverviewDay[];
}

export interface RobloxResult {
	from: string;
	to: string;
	players: number;
	firstPlayBounce: Rate & { seconds: number };
	qualifiedPlays: Rate & { minutes: number };
	d1Retention: Rate;
	d7Retention: Rate;
	playtimePerUserMinutes: number;
	playDaysPerUser: number;
	payerConversion: Rate;
	robuxPerUser: number;
	robuxPerPayer: number;
	purchases: number;
}

export interface RetentionCohort {
	date: string;
	size: number;
	kept: Record<string, number | null>;
	keptPlayers: Record<string, number | null>;
}

export interface RetentionResult {
	from: string;
	to: string;
	days: number[];
	cohorts: RetentionCohort[];
	average: Record<string, number | null>;
}

export interface FunnelStep {
	step: number;
	label: string | null;
	reached: number;
	ofStart: number;
	fromPrevious: number;
	logged: number;
	medianSecondsFromStart: number | null;
}

export type FunnelResult =
	| { funnel: null; funnels: { name: string; players: number; events: number }[] }
	| { funnel: string; players: number; steps: FunnelStep[]; biggestDrop: { step: number; lost: number; share: number } | null };

export interface TimelineEvent {
	time: string;
	t: number;
	kind: string;
	name: string;
	sid: string;
	state: string | null;
	art: string;
	src: string | null;
	props: unknown;
}

export interface TimelineSession {
	sid: string;
	start: string;
	end: string;
	minutes: number;
	events: number;
	firstSession: boolean;
	art: string;
	dev: string | null;
}

export interface TimelineResult {
	pid: string;
	/** The UserId, when the server knows it. */
	uid?: number;
	sessions: TimelineSession[];
	events: TimelineEvent[];
	truncated: boolean;
}

export interface GraphNode {
	id: string;
	visits: number;
	players?: number;
	/** Total time in this state before moving on, ms (one session: all the time in it). */
	dwellMs: number;
	/** Top 5 custom / purchase / currency event names logged in this state. */
	events?: { kind: string; name: string; count: number }[];
	/** Funnel steps logged in this state. */
	steps?: { funnel: string; step: string; index: number | null; count: number; players: number }[];
}

/** One visit of a one-session graph, in order. */
export interface PathStep {
	step: number;
	state: string;
	at: string;
	ms: number;
}

export interface GraphEdge {
	from: string;
	to: string;
	count: number;
	players?: number;
	dwellMs: number;
	share: number;
}

export interface GraphData {
	kind: "player" | "flow";
	facet: string;
	pid?: string;
	/** One session's graph. */
	sid?: string;
	/** Key moments are nodes too (ids starting with "@"). */
	moments?: boolean;
	nodes: GraphNode[];
	edges: GraphEdge[];
	hiddenEdges: number;
	/** One session: the visits in order; ended = it's over (the path ends in left). */
	path?: PathStep[];
	ended?: boolean;
}

export type Facet = "all" | "zone" | "screen" | "activity";
export const FACETS: Facet[] = ["all", "zone", "screen", "activity"];

export interface VariantStats {
	variant: string;
	players: number;
	returned: { rate: number; count: number };
	payers: { rate: number; count: number };
	playtimeMinutes: number;
	robuxPerPlayer: number;
	sessionsPerPlayer: number;
}

export interface Comparison {
	variant: string;
	metric: "returned" | "payers" | "playtime" | "robux" | "sessions";
	control: number;
	value: number;
	diff: number;
	lift: number | null;
	sure: number;
	method: string;
	words: string;
}

export type ExperimentResult =
	| { experiment: null; experiments: { experiment: string; variant: string; players: number }[] }
	| {
			experiment: string;
			scope: "player" | "server";
			control: string | null;
			variants: VariantStats[];
			comparisons: Comparison[];
			mixedPlayers: number;
	  };

export interface ConfusionResult {
	firstSessions: number;
	players: number;
	earlyLeave: { zone: string; sessions: number; early: number; share: number }[];
	screenLoops: { screen: string; sessions: number; loopSessions: number; share: number; opens: number }[];
	backAndForth: { a: string; b: string; sessions: number; flagged: number; share: number }[];
	recordings: {
		available: boolean;
		reason?: string;
		sessions?: number;
		failedSessions?: number;
		idle?: { zone: string; count: number; avgSeconds: number }[];
		cameraSpin?: { zone: string; count: number }[];
		repeatedClicks?: { button: string; count: number; avgPresses: number }[];
	};
}

export interface TopEventsResult {
	events: { kind: string; name: string; count: number; players: number }[];
}

export interface PlayerSummary {
	pid: string;
	firstSeen: string;
	lastSeen: string;
	sessions: number;
	events: number;
	playtimeMinutes: number;
	newInRange: boolean;
	/** The UserId, when the server knows it (identity rows). */
	uid?: number;
}

export interface PlayersResult {
	players: PlayerSummary[];
}

export interface ValueCount {
	value: string;
	events: number;
	lastSeen: string;
}

export interface ValuesResult {
	branch: ValueCount[];
	art: ValueCount[];
	channel: ValueCount[];
	dev: ValueCount[];
}

export interface EventRow {
	time: string;
	t: number;
	kind: string;
	name: string;
	pid: string | null;
	sid: string | null;
	job: string;
	state: string | null;
	art: string;
	branch: string | null;
	dev: string | null;
	src: string | null;
	props: unknown;
}

export interface EventsResult {
	events: EventRow[];
}

export interface BenchmarkPeriod {
	from: string;
	to: string;
	players: number;
	dau: number;
	avgPlaytimeMinutes: number | null;
	d1Retention: Rate;
	d7Retention: Rate;
	payerConversion: Rate;
	arppu: number | null;
	robux: number;
	playThrough: Rate & { minutes: number };
}

export interface BenchmarksResult {
	days: number;
	current: BenchmarkPeriod;
	previous: BenchmarkPeriod;
}

export interface RealtimeWindow {
	sessions: number;
	avgSessionMinutes: number | null;
	clientErrors: number;
	errorsPerSession: number | null;
	clientFps: number | null;
	serverMemoryMb: number | null;
}

export interface RealtimeResult {
	hours: number;
	current: RealtimeWindow;
	previous: RealtimeWindow;
	ccu: { now: number; series: { hour: string; avg: number; peak: number }[]; currentAvg: number; previousAvg: number };
}

export interface TrendValues {
	newUsers: number;
	dau: number;
	playtimeMinutes: number | null;
	robux: number;
	d1: number | null;
}

export interface TrendsResult {
	from: string;
	to: string;
	window: number;
	sources: string[];
	days: { date: string; total: TrendValues; bySource: Record<string, TrendValues> }[];
}

/** Every named query and its result. */
export interface QueryResults {
	overview: OverviewResult;
	roblox: RobloxResult;
	retention: RetentionResult;
	funnel: FunnelResult;
	timeline: TimelineResult;
	"player-graph": GraphData;
	flow: GraphData;
	experiment: ExperimentResult;
	confusion: ConfusionResult;
	"top-events": TopEventsResult;
	servers: unknown;
	deployReport: unknown;
	players: PlayersResult;
	values: ValuesResult;
	events: EventsResult;
	benchmarks: BenchmarksResult;
	realtime: RealtimeResult;
	trends: TrendsResult;
}

export type QueryName = keyof QueryResults;

export interface QueryInfo {
	name: string;
	summary: string;
	defaultDays: number;
}

// Fleet (analytics/src/fleet) -------------------------------------------------------------------------------------------

export interface FleetServer {
	job: string;
	serverType: string | null;
	branch: string | null;
	channel?: string | null;
	artifact: string | null;
	players: number | null;
	maxPlayers: number | null;
	startedAt: string | null;
	lastWrite?: string | null;
	lastSeen?: string | null;
	ageSeconds?: number;
	appliedSeq: number | null;
	generation: number | null;
	health: string | null;
	lastError: string | null;
	kernel: string | null;
	experiment: boolean | null;
	placeId?: number | null;
	serverVersion?: number | null;
}

export interface FleetServers {
	servers: FleetServer[];
	players: number;
	byArtifact: { artifact: string; servers: number; players: number }[];
	byHealth: Record<string, number>;
}

export interface FleetAlert {
	id: number;
	at: number;
	level: "critical" | "warning" | "info";
	code: string;
	message: string;
	branch?: string | null;
	artifact?: string | null;
	job?: string | null;
	seq?: number | null;
	acked: boolean;
	source?: "game" | "cli" | "server";
	createdAt?: string;
	details?: Record<string, unknown> | null;
}

export interface FleetReportResult {
	result: string;
	servers: number;
	players: number;
	medianSeconds: number | null;
	maxSeconds: number | null;
}

export interface FleetReports {
	seq: number | null;
	branch: string | null;
	artifact: string | null;
	startedAt: string | null;
	firstReport?: string | null;
	lastReport?: string | null;
	reported: number;
	results: FleetReportResult[];
	errors: { error: string; servers: number; exampleJob: string }[];
	behind: FleetServer[];
	stuck: string[];
	reports?: { seq: number; job: string; result: string; error: string | null; seconds: number | null; at: number; kernel?: string | null }[];
}

export interface Health {
	ok: boolean;
	runtime?: string;
	uptimeSeconds?: number;
	rssMb?: number;
	analytics?: { loaderLagSeconds: number; live: { events: number; recordings: number }; loadedRows: number };
	fleet?: { servers: number; alerts: number; unacked: number; streams: number };
}

/** pid <-> UserId on the analytics server (identity rows). */
export interface Identity {
	pid: string;
	uid: number;
	firstSeen: string;
	lastSeen: string;
}

export interface BackfillResult {
	scanned: number;
	added: number;
	known: number;
	nextPageToken?: string;
}

export interface SqlResult {
	columns: { name: string; type: string }[];
	rows: unknown[][];
	truncated: boolean;
	ms: number;
}

export interface StoragePart {
	key: string;
	label: string;
	bytes: number;
	files: number;
	oldest?: string;
	newest?: string;
	days?: number;
}

export interface StorageReport {
	at: string;
	cacheSeconds: number;
	totalBytes: number;
	parts: StoragePart[];
	rows: { liveEvents: number; liveRecordings: number; parquetEvents: number; parquetRecordings: number } | null;
	growth: { todayBytes: number; avgPerDayBytes: number | null; days: { date: string; bytes: number }[] } | null;
	disk: { freeBytes: number; totalBytes: number } | null;
}
