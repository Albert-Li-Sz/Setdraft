import { describe, expect, it } from "vitest";
import {
	localeStorageKey,
	readLocale,
	readUserLocale,
	translate,
	uiMessage,
	userLocaleStorageKey,
} from "../src/i18n.tsx";
import { authoringInsightMessages } from "../src/locales/authoring-insights-en.ts";
import { englishMessages } from "../src/locales/en.ts";
import { improvementsMessages } from "../src/locales/improvements-en.ts";
import { problemTypeMessages } from "../src/locales/problem-types-en.ts";
import { systemMessages } from "../src/locales/system-en.ts";

describe("interface localization", () => {
	it("renders stored notifications in the current language without translating user content", () => {
		const title = "题面与样例 {1} <script>";
		const notice = uiMessage("已打开“{0}”。", title);
		expect(translate("zh-CN", notice)).toBe(`已打开“${title}”。`);
		expect(translate("en", notice)).toBe(`Opened “${title}”.`);
		expect(translate("zh-CN", notice)).toBe(`已打开“${title}”。`);
	});

	it("translates nested fallback labels and keeps surrounding spaces", () => {
		expect(translate("en", uiMessage("已打开“{0}”。", uiMessage("未命名题目")))).toBe("Opened “Untitled problem”.");
		expect(translate("en", " · 默认")).toBe(" · Default");
		expect(translate("en", "compiler.cpp: 原始诊断 {0}")).toBe("compiler.cpp: 原始诊断 {0}");
	});

	it("restores valid preferences and tolerates unavailable browser storage", () => {
		expect(readLocale({ getItem: (key) => (key === localeStorageKey ? "en" : null) })).toBe("en");
		for (const value of ["zh-CN", "fr", "", null]) expect(readLocale({ getItem: () => value })).toBe("zh-CN");
		expect(readLocale()).toBe("zh-CN");
		expect(
			readLocale({
				getItem: () => {
					throw new Error("Storage blocked");
				},
			}),
		).toBe("zh-CN");
	});

	it("preserves all message parameters in the English catalog", () => {
		const placeholders = (text: string) => [...text.matchAll(/\{\d+\}/gu)].map(([match]) => match).sort();
		for (const [source, english] of Object.entries({
			...authoringInsightMessages,
			...englishMessages,
			...improvementsMessages,
			...problemTypeMessages,
			...systemMessages,
		})) {
			expect(placeholders(english), source).toEqual(placeholders(source));
		}
	});

	it("restores a user's device choice independently of the global login preference", () => {
		const storage = {
			getItem: (key: string) =>
				key === userLocaleStorageKey("alice") ? JSON.stringify({ locale: "en", accountLocale: "zh-CN" }) : "zh-CN",
		};
		expect(readUserLocale("alice", "zh-CN", storage)).toBe("en");
	});

	it("keeps one user's local language from overriding another account", () => {
		const storage = {
			getItem: (key: string) =>
				key === userLocaleStorageKey("alice") ? JSON.stringify({ locale: "en", accountLocale: "zh-CN" }) : null,
		};
		expect(readUserLocale("bob", "zh-CN", storage)).toBe("zh-CN");
		expect(readUserLocale("bob", "en", storage)).toBe("en");
	});

	it("honors a changed account preference instead of restoring an obsolete local choice", () => {
		const storage = { getItem: () => JSON.stringify({ locale: "zh-CN", accountLocale: "zh-CN" }) };
		expect(readUserLocale("alice", "en", storage)).toBe("en");
	});

	it("ignores malformed or unsupported user preferences", () => {
		for (const stored of [null, "{", "null", "[]", '{"locale":"fr","accountLocale":"en"}', '"en"']) {
			expect(readUserLocale("alice", "en", { getItem: () => stored })).toBe("en");
		}
	});

	it("uses the account language when storage is unavailable", () => {
		expect(readUserLocale("alice", "en")).toBe("en");
		expect(
			readUserLocale("alice", "en", {
				getItem: () => {
					throw new Error("Storage blocked");
				},
			}),
		).toBe("en");
	});
});
