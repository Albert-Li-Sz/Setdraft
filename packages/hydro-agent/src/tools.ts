import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HydroProblemSpec } from "@hydro-problem-make/authoring";
import { Type } from "typebox";
import { decodeAgentAttachments, type HydroAgentAttachment } from "./attachments.ts";
import { loadCompleteAuthoringProject, recordQuickFailure, updateAuthoringDraft } from "./authoring-draft.ts";
import type { AuthoringSummary, HydroAuthoringReport, HydroAuthoringVerificationMode } from "./authoring-project.ts";
import { authoringProjectPatchSchema, programSchema } from "./authoring-schema.ts";
import { groupAuthoringFailures } from "./failure-summary.ts";
import { cacheKey, readRunCache, writeRunCache } from "./run-cache.ts";
import type { HydroReferenceProgram, HydroSandbox } from "./sandbox.ts";
import { scoreHydroSubtasks } from "./scoring.ts";
import { verifyReferenceProgram } from "./verification.ts";
import {
	buildProblemArtifact,
	loadAuthoringEvidence,
	saveAuthoringEvidence,
	saveReferenceEvidence,
	validateProblemArtifact,
} from "./workspace.ts";

const testCaseSchema = Type.Object({
	inputFile: Type.String({ description: "Flat .in filename" }),
	input: Type.Optional(Type.String({ description: "Manual packing only; verified agent packages use caseId" })),
	outputFile: Type.String({ description: "Flat .out or .ans filename" }),
	output: Type.Optional(Type.String({ description: "Manual packing only; verified agent packages use caseId" })),
	caseId: Type.Optional(
		Type.String({
			description: "ID of a case from verify_hydro_authoring; input/output are loaded from verified files",
		}),
	),
	timeLimit: Type.Optional(Type.String()),
	memoryLimit: Type.Optional(Type.String()),
});

const subtaskSchema = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	type: Type.Union([Type.Literal("sum"), Type.Literal("min"), Type.Literal("max")]),
	score: Type.Integer({ minimum: 1, maximum: 100 }),
	dependsOn: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
	timeLimit: Type.Optional(Type.String()),
	memoryLimit: Type.Optional(Type.String()),
	cases: Type.Array(testCaseSchema, { minItems: 1 }),
});

const problemSchema = Type.Object({
	type: Type.Optional(
		Type.Union([Type.Literal("default"), Type.Literal("interactive"), Type.Literal("submit_answer")]),
	),
	multiPass: Type.Optional(Type.Integer({ minimum: 2, maximum: 20 })),
	answerMode: Type.Optional(Type.Union([Type.Literal("single"), Type.Literal("multi")])),
	interactor: Type.Optional(
		Type.String({ description: "Manual packaging only; verified runs use the tested interactor" }),
	),
	slug: Type.String({ description: "Flat ASCII problem slug" }),
	title: Type.String({ minLength: 1 }),
	pid: Type.Optional(Type.String()),
	tags: Type.Array(Type.String()),
	language: Type.String({ description: "Hydro statement language code such as zh" }),
	statement: Type.String({ minLength: 1 }),
	timeLimit: Type.String(),
	memoryLimit: Type.String(),
	subtasks: Type.Array(subtaskSchema, { minItems: 1 }),
	attachments: Type.Optional(
		Type.Array(
			Type.Object({
				name: Type.String({ description: "Flat ASCII attachment filename" }),
				content: Type.String({
					description: "UTF-8 attachment content; binary upload support is handled before this tool",
				}),
			}),
		),
	),
});

const modeGuides = {
	default:
		"普通程序题：reference/oracle 用不同算法。testlib 生成器从 argv[1] 读固定种子；validator 使用严格分隔符、边界及 inf.readEof()。多解或部分分数需 checker，调用 registerTestlibCmd；负例探针必须得 0 分。",
	interactive:
		"交互题：另写 interactor.cc，调用 registerInteraction(argc,argv)，通过 stdout 向选手发题、stdin 读回复，及时 flush；用 quitf(_ok/_wa) 给判定。多轮时按 HYDRO_MULTI_PASS 写 nextpass.in/state.txt，最多 20 轮；wrongPrograms 至少覆盖错误应答，另提供查询上限或超时反例。",
	submit_answer:
		"提答题：reference/oracle 是离线答案生成器。单文件模式仅一个完整答案点；多文件模式每个 case 指定 submissionFile，发布时 .in 写入 ZIP 内答案文件名，公开输入自动放 additional_file/<caseId>.input.txt。用错误或缺失文件探针、必要时 testlib 部分分数 checker。",
} as const;

export function createHydroAuthoringTools(
	workspaceRoot: string,
	runId: string,
	options: {
		sandbox?: HydroSandbox;
		referenceProgram?: HydroReferenceProgram;
		attachments?: HydroAgentAttachment[];
	} = {},
): ToolDefinition[] {
	let referenceProgram = options.referenceProgram;
	const uploadedAttachments = decodeAgentAttachments(options.attachments ?? []);
	const selectModeTool = defineTool({
		name: "select_hydro_judging",
		label: "选择 Hydro 题型",
		description:
			"Call once after reading the current statement. Returns a concise mode-specific authoring guide; do not ask the user to classify a complete statement.",
		parameters: Type.Object({
			type: Type.Union([Type.Literal("default"), Type.Literal("interactive"), Type.Literal("submit_answer")]),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			return { content: [{ type: "text", text: modeGuides[params.type] }], details: { type: params.type } };
		},
	});
	async function verifyDraft(mode: HydroAuthoringVerificationMode, signal?: AbortSignal) {
		if (!options.sandbox?.verifyProject) throw new Error("当前沙箱未启用 testlib 制题，请更新沙箱镜像。");
		const { revision, project } = await loadCompleteAuthoringProject(workspaceRoot, runId);
		const key = cacheKey({ mode, project });
		let report = await readRunCache<HydroAuthoringReport>(workspaceRoot, runId, "authoring", key);
		const cacheHit = report !== undefined;
		if (!report) {
			try {
				report = await options.sandbox.verifyProject(project, { mode, signal });
			} catch (error) {
				report = {
					success: false,
					mode,
					checks: [
						{ stage: "project", passed: false, message: error instanceof Error ? error.message : String(error) },
					],
					cases: [],
				};
			}
			await writeRunCache(workspaceRoot, runId, "authoring", key, report);
		}
		const verificationId = mode === "full" && report.success ? randomUUID() : undefined;
		const summary: AuthoringSummary = {
			verificationId: verificationId ?? "",
			revision,
			type: project.type ?? "default",
			success: report.success,
			testCases: report.cases.length,
			generatedCases: report.checks.filter((item) => item.stage === "generator" && item.passed).length,
			oracleCases: report.checks.filter((item) => item.stage === "oracle" && item.passed).length,
			validatorNegativeCases: report.checks.filter((item) => item.stage === "validator-negative" && item.passed)
				.length,
			checker: project.checker ? "testlib" : "default",
			checkerProbes: report.checks.filter((item) => item.stage === "checker-probe" && item.passed).length,
			wrongPrograms: report.checks.filter((item) => item.stage === "wrong-program-killed" && item.passed).length,
		};
		if (verificationId) await saveAuthoringEvidence(workspaceRoot, runId, { project, report, summary });
		const failures = groupAuthoringFailures(report.checks);
		const streak =
			mode === "quick"
				? await recordQuickFailure(workspaceRoot, runId, revision, failures)
				: { stalled: false, repeatedRevisions: 0 };
		return {
			...summary,
			verificationId,
			mode,
			revision,
			cacheHit,
			failures,
			stalled: streak.stalled,
			repeatedRevisions: streak.repeatedRevisions,
			cases: report.cases.map(({ id, input, output, durationMs }) => ({
				id,
				inputBytes: Buffer.byteLength(input),
				outputBytes: Buffer.byteLength(output),
				durationMs,
			})),
		};
	}
	const buildTool = defineTool({
		name: "build_hydro_problem",
		label: "Build Hydro problem",
		description:
			"Validate a complete normalized problem specification and materialize a new Hydro release directory.",
		promptSnippet: "Build a validated Hydro release directory from a complete structured problem specification",
		promptGuidelines: [
			"Call build_hydro_problem only after the statement, limits, scoring, test data, and attachments are complete.",
			"A successful tool result includes package structure and any standard-program checks; report independent algorithm and live-Hydro evidence separately.",
		],
		parameters: Type.Object({
			problem: problemSchema,
			verificationId: Type.Optional(
				Type.String({
					description: "Successful verify_hydro_authoring result; required for sandbox-backed Agent releases",
				}),
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			if (options.sandbox && !params.verificationId)
				throw new Error(
					"请先调用 verify_hydro_authoring 完成 testlib 数据生成、输入校验、独立对拍和错误程序验证，再用 verificationId 与 caseId 打包。",
				);
			const evidence = params.verificationId
				? await loadAuthoringEvidence(workspaceRoot, runId, params.verificationId)
				: undefined;
			if (evidence && (!evidence.report.success || !evidence.summary.success || evidence.report.mode !== "full"))
				throw new Error("制题验证尚未通过，请修复失败项后重新验证。");
			if (evidence) {
				const current = await loadCompleteAuthoringProject(workspaceRoot, runId);
				if (
					evidence.summary.revision !== current.revision ||
					cacheKey(evidence.project) !== cacheKey(current.project)
				)
					throw new Error("草稿在完整验证后已修改，请重新运行 full 验证。");
				for (const wrong of evidence.project.wrongPrograms) {
					if (wrong.maxScore === undefined) continue;
					const actualScore = scoreHydroSubtasks(
						params.problem.subtasks,
						evidence.report.wrongScores?.[wrong.name] ?? {},
					);
					if (actualScore > wrong.maxScore)
						throw new Error(`${wrong.name} 预计得 ${actualScore} 分，超过预期上限 ${wrong.maxScore} 分。`);
				}
			}
			const usedIds = new Set<string>();
			const attachmentNames = new Set<string>();
			const attachments: Array<NonNullable<HydroProblemSpec["attachments"]>[number]> = [];
			if (
				evidence &&
				((params.problem.type ?? "default") !== (evidence.project.type ?? "default") ||
					params.problem.multiPass !== evidence.project.multiPass ||
					params.problem.answerMode !== evidence.project.answerMode)
			)
				throw new Error("发布题型、多轮配置或提答模式与已验证工程不一致。");
			const publicInputs =
				evidence?.project.type === "submit_answer"
					? evidence.report.cases
							.filter((item) => item.input.length > 0)
							.map((item) => ({ name: `${item.id}.input.txt`, content: item.input }))
					: [];
			for (const attachment of [...(params.problem.attachments ?? []), ...uploadedAttachments, ...publicInputs]) {
				if (attachmentNames.has(attachment.name)) throw new Error(`附件名称重复：${attachment.name}`);
				attachmentNames.add(attachment.name);
				attachments.push(attachment);
			}
			const problem: HydroProblemSpec = {
				...params.problem,
				attachments: attachments.length ? attachments : undefined,
				checker: evidence?.project.checker ? { type: "testlib", source: evidence.project.checker } : undefined,
				interactor: evidence?.project.interactor ?? params.problem.interactor,
				subtasks: params.problem.subtasks.map((subtask) => ({
					...subtask,
					cases: subtask.cases.map((item) => {
						if (!evidence) {
							if (item.input === undefined || item.output === undefined)
								throw new Error("手工打包需要完整输入输出。");
							return { ...item, input: item.input, output: item.output };
						}
						const verified = evidence.report.cases.find((value) => value.id === item.caseId);
						if (!verified || usedIds.has(verified.id))
							throw new Error(`测试点 ${item.caseId} 未验证或重复使用。`);
						usedIds.add(verified.id);
						const time = item.timeLimit ?? subtask.timeLimit ?? params.problem.timeLimit;
						const memory = item.memoryLimit ?? subtask.memoryLimit ?? params.problem.memoryLimit;
						const timeMs = Math.ceil(Number.parseFloat(time) * (time.endsWith("ms") ? 1 : 1000));
						const unit = memory.toLowerCase().match(/[kmg]/)?.[0];
						const memoryMb = Math.ceil(
							Number.parseFloat(memory) * (unit === "g" ? 1024 : unit === "k" ? 1 / 1024 : 1),
						);
						if (timeMs !== verified.timeLimitMs || memoryMb !== verified.memoryLimitMb)
							throw new Error(`测试点 ${verified.id} 的发布限制须与验证限制一致，请重新验证或使用原限制。`);
						const releaseInput =
							evidence.project.type === "submit_answer"
								? evidence.project.answerMode === "multi"
									? `${evidence.project.cases.find((entry) => entry.id === verified.id)?.submissionFile ?? ""}\n`
									: ""
								: verified.input;
						if (
							(item.input !== undefined && item.input !== releaseInput) ||
							(item.output !== undefined && item.output !== verified.output)
						)
							throw new Error("不能修改已验证的数据；只需提供 caseId，平台自动读取输入输出。");
						return { ...item, input: releaseInput, output: verified.output };
					}),
				})),
			};
			if (evidence && usedIds.size !== evidence.report.cases.length)
				throw new Error("必须打包本次验证的全部测试点，避免丢失边界或反例。");
			const verification = evidence
				? {
						success: true,
						compiled: true,
						compileOutput: "",
						cases: evidence.report.cases.map((item, index) => ({
							index,
							status: "passed" as const,
							stdout: "",
							stderr: "",
							exitCode: 0,
							durationMs: item.durationMs,
						})),
					}
				: referenceProgram
					? await verifyReferenceProgramRequired(referenceProgram, problem, signal)
					: undefined;
			if (verification && !verification.success)
				throw new Error(`标准程序未通过测试点，修正后再打包：${JSON.stringify(verification)}`);
			const artifact = await buildProblemArtifact(workspaceRoot, runId, problem);
			return {
				content: [
					{
						type: "text",
						text: `Hydro package directory created and validated: ${artifact.directory}`,
					},
				],
				details: { ...artifact, verification, authoring: evidence?.summary },
			};
		},
	});

	const validateTool = defineTool({
		name: "validate_hydro_package",
		label: "Validate Hydro package",
		description: "Inspect an existing generated Hydro release directory and return structured validation evidence.",
		promptSnippet: "Validate a generated Hydro release directory before export",
		parameters: Type.Object({
			slug: Type.String({ description: "Problem slug inside the run's Hydro artifacts" }),
		}),
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			const report = await validateProblemArtifact(workspaceRoot, runId, params.slug);
			return {
				content: [{ type: "text", text: JSON.stringify(report) }],
				details: report,
			};
		},
	});

	async function verifyReferenceProgramRequired(
		program: HydroReferenceProgram,
		problem: HydroProblemSpec,
		signal?: AbortSignal,
	) {
		if (!options.sandbox) throw new Error("标准程序验证需要已配置的 Linux 沙箱。");
		const report = await verifyReferenceProgram(options.sandbox, program, problem, signal);
		await saveReferenceEvidence(workspaceRoot, runId, program, report);
		return report;
	}

	const clarificationTool = defineTool({
		name: "request_hydro_clarification",
		label: "请求补充题意",
		description:
			"Only use when the current statement truly lacks information required to determine valid input or accepted output. Never use it for missing programs, generators, validators, tests or metadata that you can author yourself.",
		promptSnippet: "Request one structured clarification only for irreducibly missing problem semantics",
		parameters: Type.Object({
			question: Type.String({ minLength: 1, maxLength: 1000 }),
			missingFields: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
				minItems: 1,
				maxItems: 10,
			}),
		}),
		executionMode: "sequential",
		async execute(_id, params) {
			return {
				content: [{ type: "text", text: params.question }],
				details: { clarificationRequested: true, ...params },
			};
		},
	});

	if (!options.sandbox) return [selectModeTool, buildTool, validateTool, clarificationTool];
	const sandbox = options.sandbox;
	const updateTool = defineTool({
		name: "update_hydro_authoring",
		label: "更新制题工程",
		description:
			"Create or patch the persistent authoring draft. Submit logical sections in several small calls. Arrays replace their previous value. When complete, the same call automatically runs quick sandbox verification and returns grouped failures; patch only failed fields.",
		promptSnippet: "Stage or repair one part of the persistent Hydro authoring project",
		parameters: Type.Object({ patch: authoringProjectPatchSchema }),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const result = await updateAuthoringDraft(workspaceRoot, runId, params.patch);
			const quick = result.complete ? await verifyDraft("quick", signal) : undefined;
			const details = { ...result, quick, stalled: quick?.stalled === true };
			return {
				content: [{ type: "text", text: JSON.stringify(details) }],
				details,
			};
		},
	});
	const verifyTool = defineTool({
		name: "verify_hydro_authoring",
		label: "testlib 制题验证",
		description:
			"Verify the persistent draft created by update_hydro_authoring. Use quick mode while repairing, then full mode exactly once before packaging. Full success returns a verificationId and verified case IDs.",
		promptSnippet: "Quick-check the staged project, then run the full Linux sandbox verification",
		parameters: Type.Object({
			mode: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("full")])),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const result = await verifyDraft(params.mode ?? "quick", signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: result,
			};
		},
	});
	const finalizeParameters = Type.Object({ problem: problemSchema });
	const finalizeTool = defineTool<typeof finalizeParameters, unknown>({
		name: "finalize_hydro_authoring",
		label: "完整验收并打包",
		description:
			"Run full sandbox verification, build the Hydro release, then validate its directory in one call. Only success provides a downloadable artifact. Use after the last automatic quick check succeeds.",
		promptSnippet: "Finalize the current draft with full verification, Hydro packaging and directory validation",
		parameters: finalizeParameters,
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const full = await verifyDraft("full", signal);
			if (!full.success || !full.verificationId)
				return {
					content: [
						{ type: "text", text: JSON.stringify({ success: false, stage: "full", failures: full.failures }) },
					],
					details: { success: false, stage: "full", failures: full.failures },
				};
			const built = await buildTool.execute(
				_id,
				{ problem: params.problem, verificationId: full.verificationId },
				signal,
				undefined,
				undefined as never,
			);
			const artifact = built.details as { directory: string; report: { valid: boolean } };
			const directoryReport = await validateProblemArtifact(workspaceRoot, runId, params.problem.slug);
			if (!directoryReport.valid || !artifact.report.valid)
				return {
					content: [
						{
							type: "text",
							text: JSON.stringify({ success: false, stage: "directory", report: directoryReport }),
						},
					],
					details: { success: false, stage: "directory", report: directoryReport },
				};
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							verificationId: full.verificationId,
							directory: artifact.directory,
							report: directoryReport,
						}),
					},
				],
				details: { ...built.details, success: true, verificationId: full.verificationId },
			};
		},
	});
	const runTool = defineTool({
		name: "run_reference_program",
		label: "运行标准程序",
		description:
			"Explore programs in the Linux sandbox. You may replace unrelated or incorrect uploaded code by providing program. Use role=candidate for wrong solutions or experiments without selecting them as the reference. Empty input means no-input problem. For final release use verify_hydro_authoring.",
		promptSnippet: "Run standard programs to generate answers or verify test data in the Linux sandbox",
		parameters: Type.Object({
			role: Type.Optional(Type.Union([Type.Literal("reference"), Type.Literal("candidate")])),
			program: Type.Optional(programSchema),
			cases: Type.Array(Type.Object({ input: Type.String(), expectedOutput: Type.Optional(Type.String()) }), {
				minItems: 1,
				maxItems: 100,
			}),
			timeLimitMs: Type.Optional(Type.Integer({ minimum: 50, maximum: 10000 })),
			memoryLimitMb: Type.Optional(Type.Integer({ minimum: 32, maximum: 512 })),
		}),
		executionMode: "sequential",
		async execute(_id, params, signal) {
			const program = params.program ?? referenceProgram;
			if (!program) throw new Error("请根据题面编写程序并通过 program 参数提交。");
			const request = { ...params, program };
			const key = cacheKey(request);
			let report = await readRunCache<Awaited<ReturnType<HydroSandbox["run"]>>>(
				workspaceRoot,
				runId,
				"program",
				key,
			);
			const cacheHit = report !== undefined;
			if (!report) {
				report = await sandbox.run(request, signal);
				await writeRunCache(workspaceRoot, runId, "program", key, report);
			}
			if (params.role !== "candidate" && report.success) {
				referenceProgram = program;
				await saveReferenceEvidence(workspaceRoot, runId, program, report);
			}
			const details = { ...report, cacheHit };
			return { content: [{ type: "text", text: JSON.stringify(details) }], details };
		},
	});
	return [selectModeTool, runTool, updateTool, verifyTool, finalizeTool, buildTool, validateTool, clarificationTool];
}
