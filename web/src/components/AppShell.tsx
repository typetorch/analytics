/** The frame: navigation on the left, the header (server status, theme) and the shared filter bar on top. */
import { useQuery } from "@tanstack/react-query";
import {
	Activity,
	CalendarRange,
	Compass,
	FlaskConical,
	Gamepad2,
	LayoutDashboard,
	ListFilter,
	Monitor,
	Moon,
	Server,
	Sun,
	Terminal,
	Users,
	Workflow,
	type LucideIcon,
} from "lucide-react";
import { Suspense } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { cn } from "cn";
import { FilterBar } from "@/components/FilterBar";
import { FindPlayer } from "@/components/Identity";
import { LoadingBlock } from "@/components/common";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { api, ApiError } from "@/lib/api";
import { FILTER_KEYS } from "@/lib/filters";
import { fmtInt } from "@/lib/format";
import { useTheme, type Theme } from "@/lib/theme";

export interface NavItem {
	path: string;
	label: string;
	icon: LucideIcon;
	/** The page doesn't use the shared filters (Fleet is live, Query has its own). */
	noFilters?: boolean;
}

export const NAV: NavItem[] = [
	{ path: "/", label: "Overview", icon: LayoutDashboard },
	{ path: "/roblox", label: "Roblox", icon: Gamepad2 },
	{ path: "/retention", label: "Retention", icon: CalendarRange },
	{ path: "/funnels", label: "Funnels", icon: ListFilter },
	{ path: "/players", label: "Players", icon: Users },
	{ path: "/flow", label: "Flow", icon: Workflow },
	{ path: "/experiments", label: "Experiments", icon: FlaskConical },
	{ path: "/first-session", label: "First session", icon: Compass },
	{ path: "/events", label: "Events", icon: Activity },
	{ path: "/fleet", label: "Fleet", icon: Server, noFilters: true },
	{ path: "/query", label: "Query", icon: Terminal },
];

/** Links keep the filter parameters (and drop page-only ones like pid). */
function useFilterSearch(): string {
	const { search } = useLocation();
	const params = new URLSearchParams(search);
	const kept = new URLSearchParams();
	for (const key of FILTER_KEYS) {
		const v = params.get(key);
		if (v) kept.set(key, v);
	}
	const text = kept.toString();
	return text ? `?${text}` : "";
}

function ServerStatus() {
	const health = useQuery({ queryKey: ["health"], queryFn: ({ signal }) => api.health(signal), refetchInterval: 30_000, retry: false });
	let tone = "bg-muted-foreground";
	let text = "connecting";
	let title = "";
	if (health.isError) {
		tone = "bg-[var(--status-critical)]";
		const e = health.error;
		text =
			e instanceof ApiError && e.status === 503
				? "no admin token"
				: e instanceof ApiError && (e.status === 502 || e.status === 504 || e.status === 0)
					? "server down"
					: "error";
		title = e.message;
	} else if (health.data) {
		tone = "bg-[var(--status-good)]";
		const live = health.data.analytics?.live;
		text = live ? `connected · ${fmtInt(live.events)} live rows` : "connected";
		title = [health.data.runtime, health.data.rssMb ? `${health.data.rssMb} MB` : ""].filter(Boolean).join(", ");
	}
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground" title={title}>
			<span className={cn("size-2 rounded-full", tone)} aria-hidden />
			<span>{text}</span>
		</div>
	);
}

function ThemeToggle() {
	const { theme, resolved, setTheme } = useTheme();
	const Icon = theme === "system" ? Monitor : resolved === "dark" ? Moon : Sun;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label="Theme">
					<Icon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				<DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as Theme)}>
					<DropdownMenuRadioItem value="light">Light</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="dark">Dark</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="system">System</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function AppShell() {
	const search = useFilterSearch();
	const { pathname } = useLocation();
	const current = NAV.find((n) => (n.path === "/" ? pathname === "/" : pathname.startsWith(n.path)));
	return (
		<div className="flex min-h-svh">
			<aside className="sticky top-0 hidden h-svh w-52 shrink-0 flex-col border-r bg-sidebar px-3 py-4 md:flex">
				<div className="px-2 pb-4">
					<div className="text-sm font-semibold">TypeTorch</div>
					<div className="text-xs text-muted-foreground">Analytics explorer</div>
				</div>
				<nav className="flex flex-col gap-0.5">
					{NAV.map((item) => (
						<NavLink
							key={item.path}
							to={{ pathname: item.path, search }}
							end={item.path === "/"}
							className={({ isActive }) =>
								cn(
									"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
									isActive && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
								)
							}
						>
							<item.icon className="size-4" />
							{item.label}
						</NavLink>
					))}
				</nav>
			</aside>
			<div className="flex min-w-0 flex-1 flex-col">
				<header className="sticky top-0 z-10 border-b bg-background/95 backdrop-blur">
					<div className="flex items-center justify-between gap-3 px-4 py-2">
						<nav className="-mx-1 flex gap-1 overflow-x-auto md:hidden">
							{NAV.map((item) => (
								<NavLink
									key={item.path}
									to={{ pathname: item.path, search }}
									end={item.path === "/"}
									className={({ isActive }) =>
										cn("rounded-md px-2 py-1 text-xs whitespace-nowrap", isActive ? "bg-muted font-medium" : "text-muted-foreground")
									}
								>
									{item.label}
								</NavLink>
							))}
						</nav>
						<div className="hidden text-sm font-medium md:block">{current?.label}</div>
						<div className="flex items-center gap-3">
							<FindPlayer />
							<ServerStatus />
							<ThemeToggle />
						</div>
					</div>
					{current?.noFilters ? null : (
						<div className="border-t px-4 py-2">
							<FilterBar />
						</div>
					)}
				</header>
				<main className="flex-1 space-y-4 p-4">
					<Suspense fallback={<LoadingBlock rows={6} />}>
						<Outlet />
					</Suspense>
				</main>
			</div>
		</div>
	);
}
