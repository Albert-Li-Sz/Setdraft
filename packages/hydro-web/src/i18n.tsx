import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { englishMessages } from "./locales/en.ts";

export type Locale = "zh-CN" | "en";
export type UiMessage = string | { key: string; values: readonly MessageValue[] };
type MessageValue = UiMessage | number;
export const localeStorageKey = "hydro-problem-make.locale";

export function uiMessage(key: string, ...values: MessageValue[]): UiMessage {
	return { key, values };
}

export function translate(locale: Locale, value: UiMessage, ...parameters: MessageValue[]): string {
	const key = typeof value === "string" ? value : value.key;
	const values = typeof value === "string" ? parameters : value.values;
	const normalized = key.replace(/\s+/gu, " ").trim();
	const translated = englishMessages[normalized];
	const template =
		locale === "en" && translated !== undefined
			? `${key.match(/^\s*/u)?.[0] ?? ""}${translated}${key.match(/\s*$/u)?.[0] ?? ""}`
			: key;
	return template.replace(/\{(\d+)\}/gu, (placeholder, index: string) => {
		const parameter = values[Number(index)];
		if (parameter === undefined) return placeholder;
		return typeof parameter === "object" ? translate(locale, parameter) : String(parameter);
	});
}

export function readLocale(storage?: Pick<Storage, "getItem">): Locale {
	try {
		return storage?.getItem(localeStorageKey) === "en" ? "en" : "zh-CN";
	} catch {
		return "zh-CN";
	}
}

const LocaleContext = createContext({
	locale: "zh-CN" as Locale,
	setLocale: (_locale: Locale): void => {},
	t: (value: UiMessage, ...parameters: MessageValue[]) => translate("zh-CN", value, ...parameters),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
	const [locale, updateLocale] = useState<Locale>(() => {
		try {
			return readLocale(window.localStorage);
		} catch {
			return "zh-CN";
		}
	});
	const setLocale = useCallback((next: Locale) => {
		updateLocale(next);
		try {
			localStorage.setItem(localeStorageKey, next);
		} catch {
			// The current session still works when browser storage is unavailable.
		}
	}, []);
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);
	useEffect(() => {
		const sync = (event: StorageEvent) => {
			if (event.key === localeStorageKey) updateLocale(event.newValue === "en" ? "en" : "zh-CN");
		};
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, []);
	const value = useMemo(
		() => ({
			locale,
			setLocale,
			t: (text: UiMessage, ...parameters: MessageValue[]) => translate(locale, text, ...parameters),
		}),
		[locale, setLocale],
	);
	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
	return useContext(LocaleContext);
}

export function LocaleSwitcher() {
	const { locale, setLocale, t } = useLocale();
	return (
		<fieldset className="locale-switcher" aria-label={t("界面语言")}>
			<button type="button" lang="zh-CN" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>
				中文
			</button>
			<span aria-hidden="true" />
			<button type="button" lang="en" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
				EN
			</button>
		</fieldset>
	);
}
