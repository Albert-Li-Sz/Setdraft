import { isSafeFlatName } from "@hydro-problem-make/authoring";
import type { HydroReferenceProgram } from "./sandbox.ts";

export interface AuthoringCase {
	id: string;
	purpose: "sample" | "boundary" | "random" | "stress";
	/** Public input filename for a multi-file answer-submission task. */
	submissionFile?: string;
	input?: string;
	generatorArgs?: string[];
	expectedOutput?: string;
	oracle?: boolean;
	timeLimitMs?: number;
	memoryLimitMb?: number;
}

export interface HydroAuthoringProject {
	type?: "default" | "interactive" | "submit_answer";
	multiPass?: number;
	answerMode?: "single" | "multi";
	reference: HydroReferenceProgram;
	oracle: HydroReferenceProgram;
	generator: string;
	validator: string;
	checker?: string;
	interactor?: string;
	queryLimitProbe?: HydroReferenceProgram;
	cases: AuthoringCase[];
	invalidInputs: string[];
	checkerProbes?: Array<{ caseId: string; output: string; accept: boolean; score?: number; description: string }>;
	wrongPrograms: Array<{ name: string; program: HydroReferenceProgram; maxScore?: number }>;
	timeLimitMs: number;
	memoryLimitMb: number;
	analysis: string;
}

export interface AuthoringCheck {
	stage: string;
	caseId?: string;
	passed: boolean;
	message: string;
}

export interface VerifiedAuthoringCase {
	id: string;
	input: string;
	output: string;
	durationMs: number;
	timeLimitMs: number;
	memoryLimitMb: number;
}

export interface HydroAuthoringReport {
	success: boolean;
	mode: HydroAuthoringVerificationMode;
	checks: AuthoringCheck[];
	cases: VerifiedAuthoringCase[];
	toolchain?: Record<string, string>;
	wrongScores?: Record<string, Record<string, number>>;
}

export type HydroAuthoringVerificationMode = "quick" | "full";

export interface AuthoringSummary {
	verificationId: string;
	revision?: number;
	type?: "default" | "interactive" | "submit_answer";
	success: boolean;
	testCases: number;
	generatedCases: number;
	oracleCases: number;
	validatorNegativeCases: number;
	checker: "default" | "testlib";
	checkerProbes: number;
	wrongPrograms: number;
}

export interface AuthoringEvidence {
	project: HydroAuthoringProject;
	report: HydroAuthoringReport;
	summary: AuthoringSummary;
}

export function validateAuthoringProject(project: HydroAuthoringProject): void {
	const problemType = project.type ?? "default";
	if (!["default", "interactive", "submit_answer"].includes(problemType))
		throw new Error("题型须为 default、interactive 或 submit_answer。");
	if (
		project.multiPass !== undefined &&
		(!Number.isInteger(project.multiPass) ||
			project.multiPass < 2 ||
			project.multiPass > 20 ||
			problemType !== "interactive")
	)
		throw new Error("当前本地多轮验收只支持 2–20 轮交互题。");
	if (
		problemType === "interactive" &&
		(!project.interactor?.trim() || !project.interactor.includes("registerInteraction("))
	)
		throw new Error("交互题需要调用 registerInteraction 的 C++ testlib 交互器。");
	if (problemType !== "interactive" && project.interactor !== undefined) throw new Error("只有交互题可以配置交互器。");
	if (problemType === "interactive" && project.checker !== undefined)
		throw new Error("交互题由 interactor 判分，不使用额外 checker。");
	if (problemType !== "interactive" && project.queryLimitProbe !== undefined)
		throw new Error("只有交互题可以配置查询次数反例。");
	if (problemType === "submit_answer" && !["single", "multi"].includes(project.answerMode ?? "single"))
		throw new Error("提答模式须为 single 或 multi。");
	if (problemType !== "submit_answer" && project.answerMode !== undefined)
		throw new Error("只有提答题可以配置 answerMode。");
	if (!project.analysis.trim()) throw new Error("请说明算法、独立对拍方法和测试覆盖计划。");
	for (const program of [
		project.reference,
		project.oracle,
		...project.wrongPrograms.map((item) => item.program),
		...(project.queryLimitProbe ? [project.queryLimitProbe] : []),
	]) {
		if (
			!["cpp17", "python3", "java"].includes(program.language) ||
			!program.code.trim() ||
			program.code.length > 200000
		)
			throw new Error("程序须为 C++17、Python 3 或 Java，且不超过 200000 字符。");
	}
	if (project.reference.code.trim() === project.oracle.code.trim())
		throw new Error("独立对拍程序不能复制标程；请使用暴力枚举或另一种独立算法。");
	for (const [role, code, registration] of [
		["generator", project.generator, "registerGen"],
		["validator", project.validator, "registerValidation"],
		...(project.checker ? [["checker", project.checker, "registerTestlibCmd"]] : []),
		...(project.interactor ? [["interactor", project.interactor, "registerInteraction"]] : []),
	]) {
		if (code.length > 200000 || !/#include\s*[<"]testlib\.h[>"]/.test(code) || !code.includes(`${registration}(`))
			throw new Error(`${role} 须为引用 testlib.h 并调用 ${registration} 的完整 C++ 程序。`);
	}
	if (project.cases.length < 1 || project.cases.length > 300)
		throw new Error("每次验证需要 1–300 个测试点，可通过 generatorArgs 指定种子和规模。");
	if (!project.cases.some((item) => item.generatorArgs)) throw new Error("至少一个测试点须由 testlib 生成器产生。");
	if (!project.cases.some((item) => item.oracle)) throw new Error("至少一个测试点须执行独立对拍。");
	const ids = new Set<string>();
	for (const item of project.cases) {
		if (!isSafeFlatName(item.id) || ids.has(item.id)) throw new Error("测试点 ID 必须是唯一的 ASCII 文件名。");
		ids.add(item.id);
		if (
			problemType === "submit_answer" &&
			project.answerMode === "multi" &&
			(!item.submissionFile || !isSafeFlatName(item.submissionFile))
		)
			throw new Error(`${item.id} 须指定 ZIP 内唯一的平面 ASCII 答案文件名。`);
		if (problemType !== "submit_answer" && item.submissionFile !== undefined)
			throw new Error("只有多文件提答题可以指定 submissionFile。");
		if ((item.input !== undefined) === (item.generatorArgs !== undefined))
			throw new Error(`${item.id} 需且仅需提供 input 或 generatorArgs。`);
		if (item.generatorArgs && (item.generatorArgs.length < 1 || item.generatorArgs.some((arg) => arg.includes("\0"))))
			throw new Error("生成器参数需要固定种子，且不能包含 NUL。");
		const time = item.timeLimitMs ?? project.timeLimitMs;
		const memory = item.memoryLimitMb ?? project.memoryLimitMb;
		if (
			!Number.isInteger(time) ||
			time < 50 ||
			time > 10000 ||
			!Number.isInteger(memory) ||
			memory < 32 ||
			memory > 512
		)
			throw new Error("验证限制为 50–10000 ms、32–512 MiB。");
	}
	if (!project.invalidInputs.length || project.invalidInputs.length > 100)
		throw new Error("需要 1–100 个非法输入反例，以验证输入校验器确实拒绝越界或格式错误。");
	if (!project.wrongPrograms.length || project.wrongPrograms.length > 10)
		throw new Error("需要 1–10 个已知错误程序，检验数据是否能区分常见错误。");
	if (new Set(project.wrongPrograms.map((item) => item.name)).size !== project.wrongPrograms.length)
		throw new Error("错误程序名称不能重复。");
	if (
		project.wrongPrograms.some(
			(item) =>
				item.maxScore !== undefined &&
				(!Number.isInteger(item.maxScore) || item.maxScore < 0 || item.maxScore > 99),
		)
	)
		throw new Error("错误程序的最高预期分数须为 0–99。");
	if (project.checker) {
		const probes = project.checkerProbes ?? [];
		if (!probes.some((probe) => probe.accept) || !probes.some((probe) => !probe.accept))
			throw new Error("SPJ 需要合法替代答案与非法答案两类探针。");
		if (probes.length > 100 || probes.some((probe) => !ids.has(probe.caseId)))
			throw new Error("SPJ 探针须引用已有测试点，最多 100 个。");
		if (
			probes.some(
				(probe) =>
					probe.score !== undefined && (!Number.isInteger(probe.score) || probe.score < 0 || probe.score > 100),
			)
		)
			throw new Error("SPJ 探针分数须为 0–100 的整数百分比。");
	}
	if (problemType === "submit_answer" && project.answerMode === "multi") {
		const filenames = project.cases.map((item) => item.submissionFile);
		if (new Set(filenames).size !== filenames.length) throw new Error("多文件提答题的 ZIP 答案文件名不能重复。");
	}
	if (problemType === "submit_answer" && project.answerMode !== "multi" && project.cases.length !== 1)
		throw new Error("单文件提答题只能包含一个完整答案测试点；分项计分请使用 SPJ。 ");
}
