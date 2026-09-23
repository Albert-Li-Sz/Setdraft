import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { HydroAgentAttachment } from "./attachments.ts";
import { resetQuickFailure } from "./authoring-draft.ts";
import type { HydroReferenceProgram } from "./sandbox.ts";
import { createHydroAuthoringSession, type HydroAuthoringSessionOptions } from "./session.ts";
import type { BuiltProblemArtifact } from "./workspace.ts";

export type HydroAgentPhase =
	| "analyzing"
	| "authoring"
	| "quick_verification"
	| "full_verification"
	| "packaging"
	| "validating"
	| "clarification";

export type HydroAgentProgressEvent =
	| { type: "text_delta"; delta: string }
	| { type: "tool_started"; toolName: string }
	| { type: "tool_finished"; toolName: string; isError: boolean }
	| { type: "metrics"; metrics: HydroAgentMetrics }
	| { type: "judging_type"; judgingType: "default" | "interactive" | "submit_answer" }
	| { type: "phase"; phase: HydroAgentPhase; message: string };

export interface HydroAgentMetrics {
	modelTurns: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	modelWaitMs: number;
	sandboxMs: number;
	toolCalls: number;
	quickVerifications: number;
	fullVerifications: number;
}

export interface HydroAgentModelSettings {
	contextWindow: number;
	maxTokens: number;
}

export interface HydroAgentExecutionInput {
	runId: string;
	source: string;
	conversation?: HydroConversationMessage[];
	referenceProgram?: HydroReferenceProgram;
	attachments?: HydroAgentAttachment[];
	signal: AbortSignal;
	onEvent: (event: HydroAgentProgressEvent) => void;
}

export interface HydroConversationMessage {
	role: "user" | "assistant";
	content: string;
}

export interface HydroAgentExecutionOutcome {
	status: "succeeded" | "needs_input" | "failed";
	model: string;
	modelSettings?: HydroAgentModelSettings;
	assistantText: string;
	metrics?: HydroAgentMetrics;
	failureReason?: string;
	artifact?: BuiltProblemArtifact & { slug: string };
}

export interface HydroAgentReadiness {
	available: boolean;
	models: string[];
}

export interface HydroAgentExecutor {
	readiness: HydroAgentReadiness;
	execute(input: HydroAgentExecutionInput): Promise<HydroAgentExecutionOutcome>;
}

export interface CreateHydroAgentExecutorOptions extends Omit<HydroAuthoringSessionOptions, "modelRuntime" | "runId"> {
	modelRuntime?: ModelRuntime;
	provider?: string;
	modelId?: string;
}

function readBuiltArtifact(value: unknown): (BuiltProblemArtifact & { slug: string }) | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const details = (value as Record<string, unknown>).details;
	if (typeof details !== "object" || details === null) return undefined;
	const directory = (details as Record<string, unknown>).directory;
	const report = (details as Record<string, unknown>).report;
	if (typeof directory !== "string" || typeof report !== "object" || report === null) return undefined;
	const valid = (report as Record<string, unknown>).valid;
	const issues = (report as Record<string, unknown>).issues;
	if (valid !== true || !Array.isArray(issues)) return undefined;
	return {
		directory,
		report: report as BuiltProblemArtifact["report"],
		verification: (details as BuiltProblemArtifact).verification,
		authoring: (details as BuiltProblemArtifact).authoring,
		slug: basename(directory),
	};
}

export function buildHydroAuthoringPrompt(runId: string, source: string): string {
	return `为任务 ${runId} 制作 Hydro 题目。先调用 select_hydro_judging 判型并阅读简短指南，再直接分段调用 update_hydro_authoring；草稿齐全时会自动 quick。只修复失败字段。quick 成功后调用 finalize_hydro_authoring，一次完成 full 验证和打包。仅题意无法判定时调用 request_hydro_clarification。中文简答，不复述题面或长篇分析。

<problem-source>
${source}
</problem-source>`;
}

export async function createHydroAgentExecutor(options: CreateHydroAgentExecutorOptions): Promise<HydroAgentExecutor> {
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ refreshOnCreate: false }));
	const availableModels = await modelRuntime.getAvailable();
	const selectedModel =
		options.provider === undefined && options.modelId === undefined
			? availableModels[0]
			: availableModels.find(
					(model) =>
						(options.provider === undefined || model.provider === options.provider) &&
						(options.modelId === undefined || model.id === options.modelId),
				);
	const readiness = {
		available: selectedModel !== undefined,
		models: availableModels.map((model) => `${model.provider}/${model.id}`),
	};
	return {
		readiness,
		async execute(input) {
			if (selectedModel === undefined) {
				return {
					status: "failed",
					model: "unavailable",
					assistantText: "No configured Pi model is available.",
				};
			}
			const sessionDirectory = join(options.workspaceRoot, "sessions", input.runId);
			await mkdir(sessionDirectory, { recursive: true });
			const sessionManager = SessionManager.continueRecent(options.workspaceRoot, sessionDirectory);
			const sessionEntries = sessionManager.getEntries();
			const hasHistory = sessionEntries.some((entry) => entry.type === "message");
			if (hasHistory) await resetQuickFailure(options.workspaceRoot, input.runId);
			const previousAssistantWasTruncated =
				sessionEntries
					.flatMap((entry) =>
						entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : [],
					)
					.at(-1)?.stopReason === "length";
			const { session } = await createHydroAuthoringSession({
				...options,
				modelRuntime,
				runId: input.runId,
				sessionManager,
				referenceProgram: input.referenceProgram,
				attachments: input.attachments,
			});
			await session.setModel(selectedModel);
			let assistantText = "";
			let artifact: (BuiltProblemArtifact & { slug: string }) | undefined;
			let toolFailed = false;
			let attemptedAuthoring = false;
			let providerError: string | undefined;
			let clarificationQuestion: string | undefined;
			let stalledDiagnostic: string | undefined;
			let latestFailureReason: string | undefined;
			let lastAssistantStopReason: string | undefined;
			const metrics: HydroAgentMetrics = {
				modelTurns: 0,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				modelWaitMs: 0,
				sandboxMs: 0,
				toolCalls: 0,
				quickVerifications: 0,
				fullVerifications: 0,
			};
			const toolStarts = new Map<string, number>();
			let lastModelStartedAt = Date.now();
			const emitMetrics = (): void => input.onEvent({ type: "metrics", metrics: { ...metrics } });
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
					assistantText += event.assistantMessageEvent.delta;
					input.onEvent({ type: "text_delta", delta: event.assistantMessageEvent.delta });
				} else if (event.type === "message_end" && event.message.role === "assistant") {
					metrics.modelTurns += 1;
					metrics.inputTokens += event.message.usage.input;
					metrics.outputTokens += event.message.usage.output;
					metrics.cacheReadTokens += event.message.usage.cacheRead;
					metrics.modelWaitMs += Math.max(0, Date.now() - lastModelStartedAt);
					lastModelStartedAt = Date.now();
					emitMetrics();
					lastAssistantStopReason = event.message.stopReason;
					if (event.message.stopReason === "error")
						providerError = event.message.errorMessage ?? "AI API 返回错误。";
				} else if (event.type === "tool_execution_start") {
					metrics.toolCalls += 1;
					toolStarts.set(event.toolCallId, Date.now());
					const phase = toolPhase(event.toolName, event.args);
					if (phase) input.onEvent({ type: "phase", ...phase });
					input.onEvent({ type: "tool_started", toolName: event.toolName });
				} else if (event.type === "tool_execution_end") {
					metrics.sandboxMs += Math.max(0, Date.now() - (toolStarts.get(event.toolCallId) ?? Date.now()));
					toolStarts.delete(event.toolCallId);
					lastModelStartedAt = Date.now();
					if (event.toolName === "verify_hydro_authoring") {
						const mode = (event.result.details as { mode?: string } | undefined)?.mode;
						if (mode === "full") metrics.fullVerifications += 1;
						else metrics.quickVerifications += 1;
					}
					if (event.toolName === "update_hydro_authoring") {
						const details = event.result.details as
							| {
									quick?: {
										success?: boolean;
										stalled?: boolean;
										failures?: Array<{ stage: string; message: string; count: number }>;
									};
							  }
							| undefined;
						if (details?.quick) metrics.quickVerifications += 1;
						if (details?.quick?.success === false) {
							attemptedAuthoring = true;
							latestFailureReason = describeAuthoringFailures(details.quick.failures);
						} else if (details?.quick?.success === true) latestFailureReason = undefined;
						if (details?.quick?.stalled) {
							stalledDiagnostic =
								details.quick.failures?.[0]?.message ?? "同一验证错误连续出现在三个不同草稿版本。";
							void session.abort();
						}
					}
					if (event.toolName === "finalize_hydro_authoring") {
						metrics.fullVerifications += 1;
						const details = event.result.details as
							| {
									success?: boolean;
									failures?: Array<{ stage: string; message: string; count: number }>;
									report?: { issues?: Array<{ message: string }> };
							  }
							| undefined;
						if (details?.success === false) {
							attemptedAuthoring = true;
							latestFailureReason =
								describeAuthoringFailures(details.failures) ?? details.report?.issues?.[0]?.message;
						} else if (details?.success === true) latestFailureReason = undefined;
					}
					if (event.toolName === "select_hydro_judging" && !event.isError) {
						const selected = (event.result.details as { type?: string } | undefined)?.type;
						if (selected === "default" || selected === "interactive" || selected === "submit_answer")
							input.onEvent({ type: "judging_type", judgingType: selected });
					}
					emitMetrics();
					input.onEvent({ type: "tool_finished", toolName: event.toolName, isError: event.isError });
					input.onEvent({ type: "phase", phase: "analyzing", message: "等待模型继续生成" });
					if (event.isError) {
						toolFailed = true;
						const toolResultText = (event.result.content as Array<{ type: string; text?: string }>).find(
							(item) => item.type === "text",
						)?.text;
						latestFailureReason = toolResultText?.slice(0, 800) ?? latestFailureReason;
					}
					if (event.toolName === "verify_hydro_authoring") {
						attemptedAuthoring = true;
						const details: unknown = event.result.details;
						if (
							typeof details === "object" &&
							details !== null &&
							(details as Record<string, unknown>).success === false
						) {
							toolFailed = true;
							latestFailureReason = describeAuthoringFailures(
								(details as { failures?: Array<{ stage: string; message: string; count: number }> }).failures,
							);
						} else if (
							typeof details === "object" &&
							details !== null &&
							(details as { success?: boolean }).success
						)
							latestFailureReason = undefined;
					}
					if (event.toolName === "request_hydro_clarification" && !event.isError) {
						const details: unknown = event.result.details;
						if (
							typeof details === "object" &&
							details !== null &&
							(details as Record<string, unknown>).clarificationRequested === true &&
							typeof (details as Record<string, unknown>).question === "string"
						)
							clarificationQuestion = (details as Record<string, string>).question;
					}
					if (
						(event.toolName === "build_hydro_problem" || event.toolName === "finalize_hydro_authoring") &&
						!event.isError
					) {
						artifact = readBuiltArtifact(event.result) ?? artifact;
					}
				}
			});
			const abort = (): void => {
				void session.abort();
			};
			input.signal.addEventListener("abort", abort, { once: true });
			try {
				if (input.signal.aborted) throw new Error("Hydro authoring run was cancelled.");
				input.onEvent({ type: "phase", phase: "analyzing", message: "分析题意与输入输出语义" });
				const conversation = input.conversation ?? [];
				const clarification = conversation.at(-1)?.role === "user" ? conversation.at(-1)?.content : undefined;
				let prompt = previousAssistantWasTruncated
					? `上一轮在调用工具前达到输出长度上限。停止长篇分析和复述，立即用多个小型 update_hydro_authoring 调用保存工程，再快速验证、完整验证并打包。${clarification ? `\n\n用户最新补充：\n${clarification}` : ""}`
					: hasHistory
						? `继续当前草稿，只修复上一轮未通过的字段；完成后调用 finalize_hydro_authoring。${clarification ? `\n\n用户补充：\n${clarification}` : ""}`
						: `${buildHydroAuthoringPrompt(input.runId, input.source)}${conversation.length > 0 ? `\n\n此前问答：\n${conversation.map((message) => `${message.role}: ${message.content}`).join("\n\n")}` : ""}`;
				if (!hasHistory && input.referenceProgram)
					prompt += `\n\n用户附带的程序材料（${input.referenceProgram.language}）如下，可能属于旧题或有错误。以当前题面与用户补充为准；检验发现冲突时说明原因并自行编写、替换正确标程，无需用户上传新代码。旧代码可用 role=candidate 检验。\n${input.referenceProgram.code}`;
				else if (!hasHistory)
					prompt +=
						"\n\n当前未附加程序；请自行编写标程、独立对拍程序、testlib 生成器与 validator，必要时编写 C++ testlib SPJ。";
				if (!hasHistory && input.attachments?.length)
					prompt += `\n\n用户上传了 ${input.attachments.length} 个附件：${input.attachments.map((item) => item.name).join("、")}。它们会由平台在打包时自动注入，无需在工具参数中重写内容。`;
				if (!hasHistory)
					prompt +=
						"\n\n草稿完整后的 update 会自动 quick；不要再单独调用 quick。quick 通过后只需调用 finalize_hydro_authoring。测试数据和源码只发送一次，后续按失败字段局部修改。";
				lastModelStartedAt = Date.now();
				await session.prompt(prompt);
				for (
					let recovery = 0;
					recovery < 2 &&
					lastAssistantStopReason === "length" &&
					!providerError &&
					!stalledDiagnostic &&
					!input.signal.aborted;
					recovery++
				) {
					lastAssistantStopReason = undefined;
					lastModelStartedAt = Date.now();
					await session.prompt(
						"上一轮输出达到长度上限。立即调用工具保存下一部分；草稿完整会自动 quick，通过后调用 finalize_hydro_authoring。仅真正缺失题意时请求澄清。",
					);
				}
				const lengthRecoveryExhausted = lastAssistantStopReason === "length";
				for (
					let repair = 0;
					repair < 2 &&
					attemptedAuthoring &&
					!artifact &&
					!providerError &&
					!stalledDiagnostic &&
					!lengthRecoveryExhausted &&
					!input.signal.aborted;
					repair++
				) {
					attemptedAuthoring = false;
					assistantText += "\n\n";
					input.onEvent({ type: "text_delta", delta: "\n\n" });
					lastModelStartedAt = Date.now();
					await session.prompt(
						"继续完成制题。仅修复失败部分的字段，update 会自动 quick；成功后调用 finalize_hydro_authoring。题意完整时不要追问。",
					);
				}
				const emptyResponse = assistantText.trim().length === 0;
				const fallbackError = lengthRecoveryExhausted
					? "模型输出长度已连续达到上限，未能进入制题工具。请重试；系统会保留题面与当前进度。"
					: emptyResponse &&
							artifact === undefined &&
							clarificationQuestion === undefined &&
							!toolFailed &&
							!providerError
						? "模型未生成可执行的制题步骤。请重试当前任务。"
						: artifact === undefined && clarificationQuestion === undefined && !toolFailed && !providerError
							? "模型未完成制题，也未通过结构化工具指出缺失语义。请重试当前任务。"
							: undefined;
				const failed = Boolean(
					toolFailed || providerError || fallbackError || stalledDiagnostic || latestFailureReason,
				);
				return {
					status:
						artifact !== undefined
							? "succeeded"
							: failed
								? "failed"
								: clarificationQuestion !== undefined
									? "needs_input"
									: "failed",
					model: `${selectedModel.provider}/${selectedModel.id}`,
					modelSettings: { contextWindow: selectedModel.contextWindow, maxTokens: selectedModel.maxTokens },
					assistantText: stalledDiagnostic
						? `${assistantText}\n\n连续三个不同草稿版本出现同一失败，已停止自动重试：${stalledDiagnostic}`.trim()
						: providerError
							? `${assistantText}\n\nAI API 错误：${providerError}`.trim()
							: fallbackError
								? `${assistantText}\n\n${fallbackError}`.trim()
								: clarificationQuestion && !assistantText.trim()
									? clarificationQuestion
									: assistantText,
					artifact,
					metrics,
					failureReason:
						artifact === undefined && failed
							? (stalledDiagnostic ?? latestFailureReason ?? providerError ?? fallbackError)
							: undefined,
				};
			} finally {
				input.signal.removeEventListener("abort", abort);
				unsubscribe();
				session.dispose();
			}
		},
	};
}

function describeAuthoringFailures(
	failures: readonly { stage: string; message: string; count: number }[] | undefined,
): string | undefined {
	if (!failures?.length) return undefined;
	return failures
		.slice(0, 3)
		.map((item) => `${item.stage}：${item.message.slice(0, 500)}${item.count > 1 ? `（重复 ${item.count} 次）` : ""}`)
		.join("\n");
}

function toolPhase(toolName: string, args: unknown): { phase: HydroAgentPhase; message: string } | undefined {
	switch (toolName) {
		case "update_hydro_authoring":
			return { phase: "authoring", message: "生成或修复制题工程" };
		case "verify_hydro_authoring":
			return typeof args === "object" && args !== null && (args as Record<string, unknown>).mode === "full"
				? { phase: "full_verification", message: "运行完整算法、数据与 testlib 验证" }
				: { phase: "quick_verification", message: "运行快速算法与数据验证" };
		case "build_hydro_problem":
			return { phase: "packaging", message: "生成 Hydro 导入包" };
		case "validate_hydro_package":
			return { phase: "validating", message: "检查 Hydro 包结构" };
		case "finalize_hydro_authoring":
			return { phase: "full_verification", message: "完整验证、生成 Hydro 包并检查目录" };
		case "request_hydro_clarification":
			return { phase: "clarification", message: "等待补充缺失的题意语义" };
		default:
			return undefined;
	}
}
