import type { ManualCheck, ManualSandboxReport, RoundResult } from "@setdraft/contracts";

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
		if (!["AC", "WA", "CE", "RE", "TLE", "MLE", "SYSTEM_ERROR"].includes(verdict))
			throw new Error("沙箱报告判定无效。");
		check.verdict = verdict as ManualCheck["verdict"];
	}
	if (item.score !== undefined) check.score = count(item.score, 100);
	if (item.scoreRatio !== undefined) {
		if (
			typeof item.scoreRatio !== "number" ||
			!Number.isFinite(item.scoreRatio) ||
			item.scoreRatio < 0 ||
			item.scoreRatio > 1
		)
			throw new Error("沙箱报告数值无效。");
		check.scoreRatio = item.scoreRatio;
	}
	if (item.durationMs !== undefined) check.durationMs = count(item.durationMs, 86_400_000);
	if (item.memoryBytes !== undefined) check.memoryBytes = count(item.memoryBytes, 1024 * 1024 * 1024 * 128);
	if (item.logPath !== undefined) check.logPath = text(item.logPath, 500);
	if (item.failedRound !== undefined) {
		if (item.failedRound !== 1 && item.failedRound !== 2) throw new Error("失败轮次无效。");
		check.failedRound = item.failedRound;
	}
	if (item.rounds !== undefined) check.rounds = readRoundResults(item.rounds);
	return check;
}

export function readRoundResults(value: unknown): RoundResult[] {
	if (!Array.isArray(value) || value.length !== 2) throw new Error("通信轮次结果无效。");
	return value.map((raw, index) => {
		const item = object(raw);
		if (item.round !== index + 1 || (item.state !== "complete" && item.state !== "skipped"))
			throw new Error("通信轮次结果无效。");
		const check = readSandboxCheck({ ...item, rounds: undefined, stage: "round", passed: item.verdict === "AC" });
		const paths = item.artifacts ?? [];
		if (
			(check.logPath !== undefined && !/^logs\/[A-Za-z0-9_.:-]+$/u.test(check.logPath)) ||
			(index === 0 && item.state !== "complete") ||
			(item.state === "complete" && !check.verdict) ||
			(item.state === "skipped" && check.verdict !== undefined) ||
			!Array.isArray(paths) ||
			paths.length > 10 ||
			paths.some((path) => typeof path !== "string" || !/^logs\/[A-Za-z0-9_.:-]+$/u.test(path))
		)
			throw new Error("通信诊断路径无效。");
		return {
			round: item.round as 1 | 2,
			state: item.state,
			verdict: check.verdict,
			score: check.score,
			message: check.message,
			durationMs: check.durationMs,
			memoryBytes: check.memoryBytes,
			logPath: check.logPath,
			artifacts: paths as string[],
		};
	});
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
	if (item.interactorUsed !== undefined) report.interactorUsed = flag(item.interactorUsed);
	if (item.communicationUsed !== undefined) report.communicationUsed = flag(item.communicationUsed);
	if (item.toolchain !== undefined) {
		const toolchain = object(item.toolchain);
		report.toolchain = { cpp: text(toolchain.cpp), python: text(toolchain.python), java: text(toolchain.java) };
	}
	return report;
}
