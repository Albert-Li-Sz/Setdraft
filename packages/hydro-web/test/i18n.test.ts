import { describe, expect, it } from "vitest";
import { localeStorageKey, readLocale, translate, uiMessage } from "../src/i18n.tsx";
import { englishMessages } from "../src/locales/en.ts";

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
		for (const [source, english] of Object.entries(englishMessages)) {
			expect(placeholders(english), source).toEqual(placeholders(source));
		}
	});
});
