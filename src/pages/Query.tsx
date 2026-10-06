import { useMutation, useQuery } from "@tanstack/react-query";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorState, JsonBlock, PageHeader, Section } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { fmtInt } from "@/lib/format";
import { useFilters, useParam } from "@/lib/hooks";
import type { SqlResult } from "@/lib/types";

/** Ctrl/Cmd+Enter runs. */
const runKey = (run: () => void) => (e: React.KeyboardEvent) => {
	if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
		e.preventDefault();
		run();
	}
};

function parseJson(text: string, what: string): object {
	if (!text.trim()) return {};
	try {
		const value = JSON.parse(text) as unknown;
		if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
		return value;
	} catch (error) {
		throw new Error(`${what} is not a JSON object: ${(error as Error).message}`);
	}
}

function NamedQuery() {
	const { apiFilters } = useFilters();
	const list = useQuery({ queryKey: ["queries"], queryFn: ({ signal }) => api.queries(signal), staleTime: Infinity });
	const [name, setName] = useParam("q", "overview");
	const [filters, setFilters] = useState(() => JSON.stringify(apiFilters, null, 2));
	const [options, setOptions] = useState("{}");
	useEffect(() => setFilters(JSON.stringify(apiFilters, null, 2)), [apiFilters]);
	const run = useMutation({ mutationFn: () => api.raw(name, { filters: parseJson(filters, "filters"), options: parseJson(options, "options") }) });
	const info = list.data?.find((q) => q.name === name);
	const go = () => run.mutate();
	return (
		<div className="space-y-4">
			<Section
				title="Named query"
				description={info ? `${info.summary} (default range ${info.defaultDays} days)` : "POST /v1/query/<name> with { filters, options }"}
				actions={
					<Button size="sm" onClick={go} disabled={run.isPending}>
						<Play />
						Run
					</Button>
				}
				contentClassName="space-y-3"
			>
				<Select value={name} onValueChange={setName}>
					<SelectTrigger size="sm" className="w-56" aria-label="Query">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{(list.data ?? [{ name, summary: "", defaultDays: 0 }]).map((q) => (
							<SelectItem key={q.name} value={q.name}>
								{q.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<div className="grid gap-3 lg:grid-cols-2">
					<Label className="flex-col items-stretch gap-1 text-xs text-muted-foreground">
						filters (from the filter bar; edit freely)
						<Textarea
							className="h-40 font-mono text-xs"
							value={filters}
							onChange={(e) => setFilters(e.target.value)}
							onKeyDown={runKey(go)}
							spellCheck={false}
						/>
					</Label>
					<Label className="flex-col items-stretch gap-1 text-xs text-muted-foreground">
						options, e.g. {`{ "pid": "..." }`} or {`{ "facet": "zone" }`}
						<Textarea
							className="h-40 font-mono text-xs"
							value={options}
							onChange={(e) => setOptions(e.target.value)}
							onKeyDown={runKey(go)}
							spellCheck={false}
						/>
					</Label>
				</div>
			</Section>
			{run.isError ? <ErrorState error={run.error} title="Query failed" /> : null}
			{run.data ? (
				<Section title="Result" description={`${run.data.ms} ms on the server`}>
					<JsonBlock value={run.data.result} />
				</Section>
			) : null}
		</div>
	);
}

const SAMPLE = `SELECT kind, name, COUNT(*) AS n, COUNT(DISTINCT pid) AS players
FROM events
WHERE t >= epoch_ms(now() - INTERVAL 7 DAY)
GROUP BY kind, name
ORDER BY n DESC`;

function cell(value: unknown): string {
	if (value === null || value === undefined) return "";
	return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function SqlTable({ data }: { data: SqlResult }) {
	return (
		<Section
			title={`${fmtInt(data.rows.length)} row${data.rows.length === 1 ? "" : "s"}${data.truncated ? " (more exist: raise the limit or narrow the query)" : ""}`}
			description={`${data.ms} ms on the server`}
		>
			<div className="max-h-[60vh] overflow-auto">
				<Table>
					<TableHeader>
						<TableRow>
							{data.columns.map((c, i) => (
								<TableHead key={`${c.name}-${i}`} title={c.type}>
									{c.name} <span className="text-[10px] font-normal text-muted-foreground">{c.type}</span>
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{data.rows.map((row, r) => (
							<TableRow key={r}>
								{row.map((v, c) => (
									<TableCell
										key={c}
										className={typeof v === "number" ? "text-right font-mono text-xs tabular-nums" : "max-w-96 truncate font-mono text-xs"}
										title={cell(v)}
									>
										{cell(v)}
									</TableCell>
								))}
							</TableRow>
						))}
					</TableBody>
				</Table>
			</div>
		</Section>
	);
}

function AdHocSql() {
	const [sql, setSql] = useState(SAMPLE);
	const [limit, setLimit] = useState(1000);
	const run = useMutation({ mutationFn: () => api.sql(sql, limit) });
	const go = () => run.mutate();
	return (
		<div className="space-y-4">
			<Section
				title="SQL (read-only)"
				description="One SELECT or WITH over the views events and recordings (DuckDB SQL; t is unix ms; props and exp are JSON text). Fleet rows show no props."
				actions={
					<>
						<Label className="text-xs text-muted-foreground">
							Limit
							<Input
								type="number"
								min={1}
								max={10000}
								className="h-8 w-24"
								value={limit}
								onChange={(e) => setLimit(Math.min(10_000, Math.max(1, Number(e.target.value) || 1000)))}
							/>
						</Label>
						<Button size="sm" onClick={go} disabled={run.isPending}>
							<Play />
							Run
						</Button>
					</>
				}
			>
				<Textarea
					className="h-48 font-mono text-xs"
					value={sql}
					onChange={(e) => setSql(e.target.value)}
					onKeyDown={runKey(go)}
					spellCheck={false}
					aria-label="SQL"
				/>
				<p className="mt-2 text-xs text-muted-foreground">
					Ctrl+Enter runs. Columns: t, kind, name, pid, sid, job, srv, place, art, seq, branch, channel, dev, newp, state, exp, sexp, src, props, rt.
				</p>
			</Section>
			{run.isError ? <ErrorState error={run.error} title="Query failed" /> : null}
			{run.data ? <SqlTable data={run.data} /> : null}
		</div>
	);
}

export default function Query() {
	const [tab, setTab] = useParam("tab", "named");
	return (
		<>
			<PageHeader title="Query" description="Run any named query with JSON options, or read-only SQL, and see the raw answer." />
			<Tabs value={tab} onValueChange={setTab}>
				<TabsList>
					<TabsTrigger value="named">Named query</TabsTrigger>
					<TabsTrigger value="sql">SQL</TabsTrigger>
				</TabsList>
				<TabsContent value="named" className="pt-2">
					<NamedQuery />
				</TabsContent>
				<TabsContent value="sql" className="pt-2">
					<AdHocSql />
				</TabsContent>
			</Tabs>
		</>
	);
}
