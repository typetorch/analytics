/** Light / dark / system theme: the `dark` class on <html> (shadcn's convention), remembered in localStorage. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Theme = "light" | "dark" | "system";

interface ThemeState {
	theme: Theme;
	resolved: "light" | "dark";
	setTheme(theme: Theme): void;
}

const STORAGE_KEY = "tt-explorer-theme";
const ThemeContext = createContext<ThemeState | null>(null);

function stored(): Theme {
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		return v === "light" || v === "dark" || v === "system" ? v : "system";
	} catch {
		return "system";
	}
}

const systemDark = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [theme, setThemeState] = useState<Theme>(stored);
	const [system, setSystem] = useState<"light" | "dark">(systemDark() ? "dark" : "light");

	useEffect(() => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		if (!media) return;
		const onChange = () => setSystem(media.matches ? "dark" : "light");
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	const resolved = theme === "system" ? system : theme;
	useEffect(() => {
		const root = document.documentElement;
		root.classList.toggle("dark", resolved === "dark");
		root.style.colorScheme = resolved;
	}, [resolved]);

	const value = useMemo<ThemeState>(
		() => ({
			theme,
			resolved,
			setTheme(next) {
				setThemeState(next);
				try {
					localStorage.setItem(STORAGE_KEY, next);
				} catch {
					// private mode: not remembered
				}
			},
		}),
		[theme, resolved],
	);
	return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
	const value = useContext(ThemeContext);
	if (!value) throw new Error("useTheme outside ThemeProvider");
	return value;
}
