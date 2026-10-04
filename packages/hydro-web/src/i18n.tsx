import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { authoringInsightMessages } from "./locales/authoring-insights-en.ts";
import { englishMessages } from "./locales/en.ts";
import { improvementsMessages } from "./locales/improvements-en.ts";
import { problemTypeMessages } from "./locales/problem-types-en.ts";
import { systemMessages } from "./locales/system-en.ts";
import { verificationMessages } from "./locales/verification-en.ts";

export type Locale = "zh-CN" | "en";
export type UiMessage = string | { key: string; values: readonly MessageValue[] };
type MessageValue = UiMessage | number;
export const localeStorageKey = "setdraft.locale";

export function uiMessage(key: string, ...values: MessageValue[]): UiMessage {
	return { key, values };
}

export function translate(locale: Locale, value: UiMessage, ...parameters: MessageValue[]): string {
	const key = typeof value === "string" ? value : value.key;
	const values = typeof value === "string" ? parameters : value.values;
	const normalized = key.replace(/\s+/gu, " ").trim();
	const translated =
		systemMessages[normalized] ??
		authoringInsightMessages[normalized] ??
		problemTypeMessages[normalized] ??
		improvementsMessages[normalized] ??
		verificationMessages[normalized] ??
		englishMessages[normalized];
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
		return (storage?.getItem(localeStorageKey) ?? storage?.getItem("hydro-problem-make.locale")) === "en"
			? "en"
			: "zh-CN";
	} catch {
		return "zh-CN";
	}
}

export function userLocaleStorageKey(userId: string): string {
	return `${localeStorageKey}.user:${userId}`;
}

export function readUserLocale(userId: string, accountLocale: Locale, storage?: Pick<Storage, "getItem">): Locale {
	try {
		const stored: unknown = JSON.parse(storage?.getItem(userLocaleStorageKey(userId)) ?? "null");
		if (
			stored &&
			typeof stored === "object" &&
			"accountLocale" in stored &&
			stored.accountLocale === accountLocale &&
			"locale" in stored &&
			(stored.locale === "en" || stored.locale === "zh-CN")
		) {
			return stored.locale;
		}
	} catch {
		// Fall back to the account preference when storage is unavailable or corrupt.
	}
	return accountLocale;
}

const LocaleContext = createContext({
	locale: "zh-CN" as Locale,
	setLocale: (_locale: Locale): void => {},
	applyAccountLocale: (_userId: string | undefined, _locale: Locale): void => {},
	t: (value: UiMessage, ...parameters: MessageValue[]) => translate("zh-CN", value, ...parameters),
});

export function LocaleProvider({ children }: { children: ReactNode }) {
	const account = useRef<{ userId: string; locale: Locale } | undefined>(undefined);
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
			if (account.current) {
				localStorage.setItem(
					userLocaleStorageKey(account.current.userId),
					JSON.stringify({ locale: next, accountLocale: account.current.locale }),
				);
			}
			localStorage.setItem(localeStorageKey, next);
		} catch {
			// The current session still works when browser storage is unavailable.
		}
	}, []);
	const applyAccountLocale = useCallback((userId: string | undefined, next: Locale) => {
		account.current = userId ? { userId, locale: next } : undefined;
		if (!userId) return;
		try {
			updateLocale(readUserLocale(userId, next, window.localStorage));
		} catch {
			updateLocale(next);
		}
	}, []);
	useEffect(() => {
		document.documentElement.lang = locale;
		document.title = translate(locale, "Setdraft · 题序");
	}, [locale]);
	useEffect(() => {
		const sync = (event: StorageEvent) => {
			const current = account.current;
			if (current) {
				if (event.key === null || event.key === userLocaleStorageKey(current.userId)) {
					try {
						updateLocale(readUserLocale(current.userId, current.locale, window.localStorage));
					} catch {
						updateLocale(current.locale);
					}
				}
			} else if (event.key === localeStorageKey) {
				updateLocale(event.newValue === "en" ? "en" : "zh-CN");
			}
		};
		window.addEventListener("storage", sync);
		return () => window.removeEventListener("storage", sync);
	}, []);
	const value = useMemo(
		() => ({
			locale,
			setLocale,
			applyAccountLocale,
			t: (text: UiMessage, ...parameters: MessageValue[]) => translate(locale, text, ...parameters),
		}),
		[locale, setLocale, applyAccountLocale],
	);
	return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
	return useContext(LocaleContext);
}

export function LocaleSwitcher() {
	const { locale, setLocale, t } = useLocale();
	return (
		<fieldset className="locale-switcher" data-locale={locale} aria-label={t("界面语言")}>
			<button type="button" lang="zh-CN" aria-pressed={locale === "zh-CN"} onClick={() => setLocale("zh-CN")}>
				中文
			</button>
			<button type="button" lang="en" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
				EN
			</button>
		</fieldset>
	);
}
