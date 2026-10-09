/** The sidebar's list: small muted group headers (collapsible), an icon and a short label per page, the open page filled in. */
import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo } from "react";
import { Link, useLocation } from "react-router";
import { cn } from "cn";
import { useAuth } from "@/lib/auth";
import { findNavItem, visibleGroups, type NavGroup, type NavItem } from "@/lib/nav";
import { setGroupCollapsed, useCollapsedGroups } from "@/lib/nav-state";

function NavLinkItem({ item, active, search, onNavigate }: { item: NavItem; active: boolean; search: string; onNavigate?: () => void }) {
	return (
		<li>
			<Link
				to={{ pathname: item.path, search }}
				aria-current={active ? "page" : undefined}
				onClick={onNavigate}
				className={cn(
					"flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/75 outline-none transition-colors hover:bg-sidebar-foreground/5 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/60",
					active && "bg-sidebar-foreground/10 font-medium text-sidebar-foreground hover:bg-sidebar-foreground/10",
				)}
			>
				<item.icon className={cn("size-4 shrink-0", !active && "text-muted-foreground")} aria-hidden />
				<span className="truncate">{item.label}</span>
			</Link>
		</li>
	);
}

function NavSection({
	group,
	first,
	collapsed,
	activeItem,
	search,
	onNavigate,
}: {
	group: NavGroup;
	first: boolean;
	collapsed: boolean;
	activeItem: NavItem | undefined;
	search: string;
	onNavigate?: () => void;
}) {
	const listId = useId();
	// A group without a header (the top of the list) can't be closed.
	const open = !group.label || !collapsed;
	const holdsActive = activeItem !== undefined && group.items.includes(activeItem);
	return (
		<div className={cn(!first && "mt-2 border-t border-sidebar-border pt-2")} data-group={group.id}>
			{group.label ? (
				<button
					type="button"
					aria-expanded={open}
					aria-controls={open ? listId : undefined}
					onClick={() => setGroupCollapsed(group.id, open)}
					className={cn(
						"flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground outline-none transition-colors hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring/60",
						// Closed with the open page inside: say where it is.
						!open && holdsActive && "text-sidebar-foreground",
					)}
				>
					<span className="truncate">{group.label}</span>
					<ChevronDown className={cn("size-3.5 shrink-0 transition-transform duration-150", !open && "-rotate-90")} aria-hidden />
				</button>
			) : null}
			{open ? (
				<ul id={listId} className={cn("flex flex-col gap-0.5", group.label && "mt-0.5 animate-in fade-in-0 slide-in-from-top-1 duration-150")}>
					{group.items.map((item) => (
						<NavLinkItem key={item.path} item={item} active={item === activeItem} search={search} onNavigate={onNavigate} />
					))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * `search` is the query string the links carry (the shared filters). `onNavigate` runs on a click on a page (the mobile
 * drawer closes itself with it).
 */
export function SidebarNav({ search = "", onNavigate }: { search?: string; onNavigate?: () => void }) {
	const auth = useAuth();
	const { pathname } = useLocation();
	const collapsed = useCollapsedGroups();
	const groups = useMemo(() => visibleGroups(auth), [auth]);
	const activeItem = useMemo(() => findNavItem(pathname, groups.flatMap((g) => g.items)), [pathname, groups]);
	const activeGroup = groups.find((g) => activeItem && g.items.includes(activeItem))?.id;

	// Landing on a page inside a closed group (a link, Find player, a reload) opens that group; closing it by hand sticks.
	useEffect(() => {
		if (activeGroup) setGroupCollapsed(activeGroup, false);
	}, [activeGroup]);

	return (
		<nav aria-label="Main" className="flex flex-col">
			{groups.map((group, i) => (
				<NavSection
					key={group.id}
					group={group}
					first={i === 0}
					collapsed={Boolean(collapsed[group.id])}
					activeItem={activeItem}
					search={search}
					onNavigate={onNavigate}
				/>
			))}
		</nav>
	);
}
