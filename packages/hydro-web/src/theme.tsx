import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useState } from "react";
import { useLocale } from "./i18n.tsx";

export type ThemeMode = "system" | "light" | "dark";
export const themeStorageKey = "setdraft.theme";
export function readThemeMode(storage?: Pick<Storage, "getItem">): ThemeMode {
	try {
		const value = storage?.getItem(themeStorageKey);
		return value === "light" || value === "dark" ? value : "system";
	} catch {
		return "system";
	}
}
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): "light" | "dark" {
	return mode === "system" ? (prefersDark ? "dark" : "light") : mode;
}
const ThemeContext = createContext({
	mode: "system" as ThemeMode,
	dark: false,
	setMode: (_mode: ThemeMode): void => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [mode, updateMode] = useState(() => {
		try {
			return readThemeMode(window.localStorage);
		} catch {
			return "system" as const;
		}
	});
	const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
	const dark = resolveTheme(mode, systemDark) === "dark";
	const setMode = useCallback((next: ThemeMode) => {
		updateMode(next);
		try {
			localStorage.setItem(themeStorageKey, next);
		} catch {
			/* The current session still applies. */
		}
	}, []);
	useLayoutEffect(() => {
		document.documentElement.dataset.theme = dark ? "dark" : "light";
		document.documentElement.style.colorScheme = dark ? "dark" : "light";
		document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#131b1a" : "#ffffff");
	}, [dark]);
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const changed = () => setSystemDark(media.matches);
		const stored = (event: StorageEvent) => {
			if (event.key !== themeStorageKey && event.key !== null) return;
			try {
				updateMode(readThemeMode(window.localStorage));
			} catch {
				updateMode("system");
			}
		};
		changed();
		media.addEventListener("change", changed);
		window.addEventListener("storage", stored);
		return () => {
			media.removeEventListener("change", changed);
			window.removeEventListener("storage", stored);
		};
	}, []);
	return <ThemeContext.Provider value={{ mode, dark, setMode }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
export function ThemeSwitcher() {
	const { mode, setMode } = useTheme();
	const { t } = useLocale();
	return (
		<select
			className="theme-switcher"
			aria-label={t("主题模式")}
			title={t("主题模式")}
			value={mode}
			onChange={(event) => setMode(event.target.value as ThemeMode)}
		>
			<option value="system">{t("跟随系统")}</option>
			<option value="light">{t("浅色模式")}</option>
			<option value="dark">{t("深色模式")}</option>
		</select>
	);
}
