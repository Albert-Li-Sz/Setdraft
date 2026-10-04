import {
	cppLanguages,
	isProblemType,
	isProtocolSamples,
	type ManualProject,
	resolveProblemType,
	synchronizeProblemType,
	usesProtocol,
} from "@setdraft/contracts";
import { ManualProjectError } from "./project-error.ts";

/** Apply canonical configuration atomically, validating legacy compatibility views. */
export function updateProblemType(project: ManualProject, input: Record<string, unknown>): void {
	const previous = JSON.stringify([project.problemType, project.communication, project.interactionInputMode]);
	if (input.problemType !== undefined && !isProblemType(input.problemType))
		throw new ManualProjectError("题型无效。", 422);
	if (input.judgingMode !== undefined && input.judgingMode !== "default" && input.judgingMode !== "interactive")
		throw new ManualProjectError("判题模式无效。", 422);
	if (input.checkerMode !== undefined && input.checkerMode !== "text" && input.checkerMode !== "custom")
		throw new ManualProjectError("Checker 模式无效。", 422);
	if (
		project.problemType === "communication" &&
		input.problemType === undefined &&
		(input.judgingMode !== undefined || input.checkerMode !== undefined)
	)
		throw new ManualProjectError("旧客户端不能修改通信题配置，请刷新页面。", 409);
	if (input.communication !== undefined) {
		const config = input.communication;
		if (!config || typeof config !== "object" || Array.isArray(config))
			throw new ManualProjectError("通信配置无效。", 422);
		const value = config as Record<string, unknown>;
		if (
			typeof value.judgeSource !== "string" ||
			value.judgeSource.length > 200_000 ||
			!cppLanguages.some((language) => language === value.judgeStandard) ||
			!["interactive", "text", "custom"].includes(String(value.secondRound))
		)
			throw new ManualProjectError("通信裁判或第二轮判定配置无效。", 422);
		project.communication = {
			judgeSource: value.judgeSource,
			judgeStandard: value.judgeStandard as NonNullable<ManualProject["communication"]>["judgeStandard"],
			secondRound: value.secondRound as NonNullable<ManualProject["communication"]>["secondRound"],
		};
	}
	if (isProblemType(input.problemType)) project.problemType = input.problemType;
	else if (input.judgingMode !== undefined || input.checkerMode !== undefined)
		project.problemType = resolveProblemType({
			judgingMode:
				input.judgingMode === "interactive" || input.judgingMode === "default"
					? input.judgingMode
					: project.judgingMode,
			checkerMode:
				input.checkerMode === "text" || input.checkerMode === "custom" ? input.checkerMode : project.checkerMode,
		});
	if (input.interactionInputMode !== undefined) {
		if (input.interactionInputMode !== "provided" && input.interactionInputMode !== "empty")
			throw new ManualProjectError("测试输入来源无效。", 422);
		project.interactionInputMode = input.interactionInputMode;
	}
	synchronizeProblemType(project);
	if (
		input.problemType !== undefined &&
		((input.judgingMode !== undefined && input.judgingMode !== (usesProtocol(project) ? "interactive" : "default")) ||
			(input.checkerMode !== undefined && input.checkerMode !== project.checkerMode))
	)
		throw new ManualProjectError("题型与旧判题字段冲突。", 422);
	if (input.protocolSamples !== undefined) {
		if (!isProtocolSamples(input.protocolSamples) || JSON.stringify(input.protocolSamples).length > 1_000_000)
			throw new ManualProjectError("协议样例无效或超过容量限制。", 422);
		project.protocolSamples = input.protocolSamples;
		synchronizeProblemType(project);
	}
	if (JSON.stringify([project.problemType, project.communication, project.interactionInputMode]) !== previous)
		project.lastReport = undefined;
}
