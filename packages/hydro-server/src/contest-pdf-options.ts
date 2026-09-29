import { type ContestPdfOptions, defaultContestPdfOptions } from "@setdraft/contracts";
import { ManualProjectError } from "./project-error.ts";

export function readContestPdfOptions(value: unknown): ContestPdfOptions {
	if (value === undefined) return { ...defaultContestPdfOptions };
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new ManualProjectError("竞赛 PDF 配置无效。", 422);
	const input = value as Record<string, unknown>;
	const result = { ...defaultContestPdfOptions };
	for (const field of ["enabled", "titlePage", "problemList", "headerFooter"] as const) {
		if (typeof input[field] !== "boolean") throw new ManualProjectError(`PDF ${field} 必须是开关。`, 422);
		result[field] = input[field];
	}
	for (const field of ["subtitle", "author", "date", "coverNotes"] as const) {
		const maximum = field === "coverNotes" ? 20_000 : 200;
		if (typeof input[field] !== "string" || input[field].length > maximum)
			throw new ManualProjectError(`PDF ${field} 必须是不超过 ${maximum} 字符的文本。`, 422);
		result[field] = input[field];
	}
	if (input.language !== "zh" && input.language !== "en") throw new ManualProjectError("PDF 语言无效。", 422);
	result.language = input.language;
	for (const field of ["titlePageLanguage", "problemLanguage"] as const) {
		if (input[field] !== "auto" && input[field] !== "zh" && input[field] !== "en")
			throw new ManualProjectError("PDF 分区语言无效。", 422);
		result[field] = input[field];
	}
	return result;
}
