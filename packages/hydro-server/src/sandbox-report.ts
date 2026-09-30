import type { ManualCheck, ManualSandboxReport } from "@setdraft/contracts";

function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("沙箱报告结构无效。");
	return value as Record<string, unknown>;
}
function text(value: unknown, limit = 4000): string {
	if (typeof value !== "string" || value.length > limit) throw new Error("沙箱报告文本无效。");
	return value;
}
function flag(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("沙箱报告状态无效。");
	return value;
}
function count(value: unknown, limit = 100_000): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > limit)
		throw new Error("沙箱报告数值无效。");
	return value;
}

export function readSandboxCheck(value: unknown): ManualCheck {
	const item = object(value);
	const check: ManualCheck = { stage: text(item.stage, 100), passed: flag(item.passed), message: text(item.message) };
	if (item.caseId !== undefined && item.caseId !== null) check.caseId = text(item.caseId, 200);
	if (item.verdict !== undefined) {
		const verdict = text(item.verdict);
		if (!["AC", "WA", "CE", "RE", "TLE", "SYSTEM_ERROR"].includes(verdict)) throw new Error("沙箱报告判定无效。");
		check.verdict = verdict as ManualCheck["verdict"];
	}
	if (item.score !== undefined) check.score = count(item.score, 100);
	if (item.durationMs !== undefined) check.durationMs = count(item.durationMs, 86_400_000);
	if (item.logPath !== undefined) check.logPath = text(item.logPath, 500);
	return check;
}

export function readSandboxReport(value: unknown): ManualSandboxReport {
	const item = object(value);
	if (item.mode !== "generate" && item.mode !== "finalize") throw new Error("沙箱报告模式无效。");
	if (!Array.isArray(item.checks) || item.checks.length > 50_000) throw new Error("沙箱报告检查条目过多。");
	const checks = item.checks.map(readSandboxCheck);
	const report: ManualSandboxReport = {
		mode: item.mode,
		success: flag(item.success),
		checks,
		caseCount: count(item.caseCount),
		generatedCount: count(item.generatedCount),
		oracleCount: count(item.oracleCount),
		validatorUsed: flag(item.validatorUsed),
		checkerUsed: flag(item.checkerUsed),
	};
	if (report.success && (!checks.length || checks.some((check) => !check.passed)))
		throw new Error("沙箱报告结果不一致。");
	if (item.toolchain !== undefined) {
		const toolchain = object(item.toolchain);
		report.toolchain = { cpp: text(toolchain.cpp), python: text(toolchain.python), java: text(toolchain.java) };
	}
	return report;
}
