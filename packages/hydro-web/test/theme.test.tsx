import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { readThemeMode, resolveTheme, ThemeSwitcher, themeStorageKey } from "../src/theme.tsx";

it("defaults to the system theme and tolerates blocked or invalid saved preferences", () => {
	for (const value of [null, "system", "invalid"]) expect(readThemeMode({ getItem: () => value })).toBe("system");
	expect(readThemeMode()).toBe("system");
	expect(
		readThemeMode({
			getItem: () => {
				throw new Error("Blocked storage");
			},
		}),
	).toBe("system");
	for (const mode of ["light", "dark"] as const)
		expect(readThemeMode({ getItem: (key) => (key === themeStorageKey ? mode : null) })).toBe(mode);
	expect(resolveTheme("system", true)).toBe("dark");
	expect(resolveTheme("system", false)).toBe("light");
	expect(resolveTheme("light", true)).toBe("light");
	expect(resolveTheme("dark", false)).toBe("dark");
});
it("exposes an accessible system/light/dark selector", () => {
	const html = renderToStaticMarkup(<ThemeSwitcher />);
	expect(html).toContain('aria-label="主题模式"');
	for (const mode of ["system", "light", "dark"]) expect(html).toContain(`value="${mode}"`);
});
