import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { createFauxCore, fauxAssistantMessage, fauxThinking, fauxToolCall } from "../../ai/src/providers/faux.ts";
import type { JsonValue } from "../../ai/src/types.ts";
import { buildAuthoringArchive } from "../src/authoring-archive.ts";
import { createHydroAgentExecutor } from "../src/executor.ts";
import { DockerHydroSandbox, type HydroSandbox } from "../src/sandbox.ts";
import { divisorProject, noInputProject } from "./authoring-fixtures.ts";

async function fixture(withSandbox: boolean | HydroSandbox = false, maxTokens = 16384) {
	const workspaceRoot = await mkdtemp(join(tmpdir(), "hydro-executor-"));
	const faux = createFauxCore({ provider: "hydro-faux", models: [{ id: "faux-1", maxTokens }] });
	const runtime = await ModelRuntime.create({
		modelsPath: null,
		authPath: join(workspaceRoot, "auth.json"),
		refreshOnCreate: false,
		allowModelNetwork: false,
	});
	runtime.registerProvider("hydro-faux", {
		api: faux.api,
		apiKey: "faux-only",
		baseUrl: faux.models[0].baseUrl,
		models: faux.models,
		streamSimple: faux.streamSimple,
	});
	const executor = await createHydroAgentExecutor({
		workspaceRoot,
		agentDir: join(workspaceRoot, "agent"),
		skillPath: fileURLToPath(new URL("../../../.pi/skills/hydro-problem-authoring/SKILL.md", import.meta.url)),
		modelRuntime: runtime,
		provider: "hydro-faux",
		sandbox: withSandbox === true ? new DockerHydroSandbox() : withSandbox || undefined,
	});
	return {
		workspaceRoot,
		faux,
		executor,
		async cleanup() {
			runtime.unregisterProvider("hydro-faux");
			await rm(workspaceRoot, { recursive: true, force: true });
		},
	};
}

describe("Pi authoring executor", () => {
	it("auto-checks a complete staged draft and finalizes in one call", async () => {
		const modes: string[] = [];
		const fakeSandbox: HydroSandbox = {
			status: async () => ({ available: true, image: "faux", message: "ready" }),
			run: async () => {
				throw new Error("Unexpected exploratory run");
			},
			verifyProject: async (_project, options) => {
				modes.push(options?.mode ?? "full");
				return {
					success: true,
					mode: options?.mode ?? "full",
					checks: [
						{ stage: "generator", passed: true, message: "ok" },
						{ stage: "oracle", passed: true, message: "ok" },
						{ stage: "validator-negative", passed: true, message: "ok" },
						{ stage: "wrong-program-killed", passed: true, message: "ok" },
					],
					cases: [
						{ id: "empty", input: "", output: "42\n", durationMs: 1, timeLimitMs: 1000, memoryLimitMb: 256 },
					],
				};
			},
		};
		const f = await fixture(fakeSandbox);
		try {
			const { reference, ...rest } = noInputProject;
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("select_hydro_judging", { type: "default" }), { stopReason: "toolUse" }),
				fauxAssistantMessage(fauxToolCall("update_hydro_authoring", { patch: { reference } }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(fauxToolCall("update_hydro_authoring", { patch: rest as JsonValue }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("finalize_hydro_authoring", {
						problem: {
							slug: "forty-two",
							title: "42",
							tags: [],
							language: "zh",
							statement: "输出 42。",
							timeLimit: "1s",
							memoryLimit: "256m",
							subtasks: [
								{
									id: 1,
									type: "sum",
									score: 100,
									cases: [{ caseId: "empty", inputFile: "1.in", outputFile: "1.out" }],
								},
							],
						},
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("验证通过。"),
			]);
			const result = await f.executor.execute({
				runId: "auto-finalize",
				source: "输出 42。",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(result.status, JSON.stringify(result)).toBe("succeeded");
			expect(modes).toEqual(["quick", "full"]);
			expect(result.metrics).toMatchObject({ quickVerifications: 1, fullVerifications: 1 });
		} finally {
			await f.cleanup();
		}
	});

	it("stops after the same quick failure on three distinct revisions", async () => {
		const fakeSandbox: HydroSandbox = {
			status: async () => ({ available: true, image: "faux", message: "ready" }),
			run: async () => {
				throw new Error("Unexpected exploratory run");
			},
			verifyProject: async () => ({
				success: false,
				mode: "quick",
				checks: [
					{
						stage: "compile:validator",
						passed: false,
						message: "/work/validator/main.cpp:12:3: error: invalid validator",
					},
				],
				cases: [],
			}),
		};
		const f = await fixture(fakeSandbox);
		try {
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("update_hydro_authoring", { patch: noInputProject as JsonValue }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage(
					fauxToolCall("update_hydro_authoring", {
						patch: { validator: `${noInputProject.validator}\n// revision 2` },
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("update_hydro_authoring", {
						patch: { validator: `${noInputProject.validator}\n// revision 3` },
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("继续分析。"),
			]);
			const result = await f.executor.execute({
				runId: "same-failure",
				source: "输出 42。",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(result.status).toBe("failed");
			expect(result.assistantText).toContain("连续三个不同草稿版本");
			expect(result.failureReason).toContain("invalid validator");
		} finally {
			await f.cleanup();
		}
	});
	it("shows the grouped validation cause when a repair attempt ends without a package", async () => {
		const fakeSandbox: HydroSandbox = {
			status: async () => ({ available: true, image: "faux", message: "ready" }),
			run: async () => {
				throw new Error("Unexpected exploratory run");
			},
			verifyProject: async () => ({
				success: false,
				mode: "quick",
				checks: [
					{ stage: "compile:validator", passed: false, message: "error: wrong testlib API" },
					{ stage: "compile:validator", passed: false, message: "error: wrong testlib API" },
				],
				cases: [],
			}),
		};
		const f = await fixture(fakeSandbox);
		try {
			f.faux.setResponses([
				fauxAssistantMessage(fauxToolCall("update_hydro_authoring", { patch: noInputProject as JsonValue }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("暂时无法修复。"),
				fauxAssistantMessage("仍未修复。"),
				fauxAssistantMessage("稍后再试。"),
			]);
			const result = await f.executor.execute({
				runId: "quick-diagnosis",
				source: "输出 42。",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(result.status).toBe("failed");
			expect(result.failureReason).toContain("compile:validator：error: wrong testlib API（重复 2 次）");
		} finally {
			await f.cleanup();
		}
	});
	it("restores its Pi transcript when a user answers a clarification", async () => {
		const f = await fixture();
		try {
			f.faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("request_hydro_clarification", {
						question: "请确认题面。",
						missingFields: ["完整题意"],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("请确认题面。"),
			]);
			const input = {
				runId: "continued",
				source: "# 三连击",
				signal: new AbortController().signal,
				onEvent: () => {},
			};
			expect(await f.executor.execute(input)).toMatchObject({
				status: "needs_input",
				assistantText: "请确认题面。",
			});
			let contextText = "";
			f.faux.setResponses([
				(context) => {
					contextText = JSON.stringify(context);
					return fauxAssistantMessage("收到补充。");
				},
			]);
			await f.executor.execute({
				...input,
				conversation: [
					{ role: "assistant", content: "请确认题面。" },
					{ role: "user", content: "以三连击为准。" },
				],
			});
			expect(contextText).toContain("# 三连击");
			expect(contextText).toContain("请确认题面。");
			expect(contextText).toContain("以三连击为准。");
			expect(
				(await readdir(join(f.workspaceRoot, "sessions", "continued"))).filter((name) => name.endsWith(".jsonl")),
			).toHaveLength(1);
		} finally {
			await f.cleanup();
		}
	});

	it("does not classify an unstructured model question as missing user input", async () => {
		const f = await fixture();
		try {
			f.faux.setResponses([fauxAssistantMessage("请上传标准程序。")]);
			const result = await f.executor.execute({
				runId: "plain-question",
				source: "# A+B\n输入两个整数，输出和。",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(result.status).toBe("failed");
			expect(result.assistantText).toContain("未通过结构化工具指出缺失语义");
		} finally {
			await f.cleanup();
		}
	});

	it("reports provider errors as failed rather than asking for problem information", async () => {
		const f = await fixture();
		try {
			f.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid credentials" })]);
			const result = await f.executor.execute({
				runId: "api-error",
				source: "# 三连击",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(result.status).toBe("failed");
			expect(result.assistantText).toContain("invalid credentials");
		} finally {
			await f.cleanup();
		}
	});

	it("prompts the model to continue immediately after an output-length stop", async () => {
		const f = await fixture(false, 1);
		try {
			let recoveryPrompt = "";
			f.faux.setResponses([
				fauxAssistantMessage(fauxThinking("xxxx"), { stopReason: "length" }),
				(context) => {
					recoveryPrompt = JSON.stringify(context.messages.filter((message) => message.role === "user"));
					return fauxAssistantMessage(
						fauxToolCall("request_hydro_clarification", {
							question: "请补充缺失的输入范围。",
							missingFields: ["输入范围"],
						}),
						{ stopReason: "toolUse" },
					);
				},
				fauxAssistantMessage("请补充缺失的输入范围。"),
			]);
			const result = await f.executor.execute({
				runId: "length-recovery",
				source: "# 测试题",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(f.faux.state.callCount).toBe(3);
			expect(recoveryPrompt).toContain("update_hydro_authoring");
			expect(result).toMatchObject({
				status: "needs_input",
				assistantText: "请补充缺失的输入范围。",
			});
		} finally {
			await f.cleanup();
		}
	});

	it("reports repeated output-length stops as a model failure", async () => {
		const f = await fixture(false, 1);
		try {
			f.faux.setResponses([
				fauxAssistantMessage(fauxThinking("xxxx"), { stopReason: "length" }),
				fauxAssistantMessage(fauxThinking("xxxx"), { stopReason: "length" }),
				fauxAssistantMessage(fauxThinking("xxxx"), { stopReason: "length" }),
			]);
			const result = await f.executor.execute({
				runId: "length-exhausted",
				source: "# 测试题",
				signal: new AbortController().signal,
				onEvent: () => {},
			});
			expect(f.faux.state.callCount).toBe(3);
			expect(result.status).toBe("failed");
			expect(result.assistantText).toContain("模型输出长度已连续达到上限");
		} finally {
			await f.cleanup();
		}
	});

	it.runIf(process.env.HYDRO_TEST_SANDBOX === "1")(
		"lets the agent replace an unrelated uploaded program after following the statement",
		async () => {
			const f = await fixture(true);
			try {
				const problem = {
					slug: "answer",
					title: "Answer",
					language: "zh",
					tags: [],
					statement: "输出 42。",
					timeLimit: "1s",
					memoryLimit: "256m",
					subtasks: [
						{
							id: 1,
							type: "sum",
							score: 100,
							cases: [{ inputFile: "1.in", caseId: "empty", outputFile: "1.out" }],
						},
					],
				};
				const build = () =>
					fauxAssistantMessage(fauxToolCall("build_hydro_problem", { problem }), { stopReason: "toolUse" });
				f.faux.setResponses([build(), fauxAssistantMessage("请更新标准程序。")]);
				const input = {
					runId: "reference-update",
					source: "# Answer\n输出 42。",
					signal: new AbortController().signal,
					onEvent: () => {},
				};
				const failed = await f.executor.execute({
					...input,
					referenceProgram: { language: "python3", code: "print(41)" },
				});
				expect(failed.status).toBe("failed");
				expect(failed.artifact).toBeUndefined();
				f.faux.setResponses([
					fauxAssistantMessage(
						fauxToolCall("run_reference_program", {
							program: { language: "python3", code: "print(42)" },
							cases: [{ input: "", expectedOutput: "42\n" }],
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(
						fauxToolCall("update_hydro_authoring", {
							patch: JSON.parse(JSON.stringify(noInputProject)) as JsonValue,
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(fauxToolCall("verify_hydro_authoring", { mode: "full" }), {
						stopReason: "toolUse",
					}),
					(context) => {
						const result = [...context.messages]
							.reverse()
							.find((item) => item.role === "toolResult" && item.toolName === "verify_hydro_authoring");
						if (!result || result.role !== "toolResult") throw new Error("Missing verification tool result");
						const summary = JSON.parse(
							result.content
								.filter((item) => item.type === "text")
								.map((item) => item.text)
								.join(""),
						) as { verificationId: string; success: boolean };
						expect(summary.success, JSON.stringify(summary)).toBe(true);
						return fauxAssistantMessage(
							fauxToolCall("build_hydro_problem", { problem, verificationId: summary.verificationId }),
							{ stopReason: "toolUse" },
						);
					},
					fauxAssistantMessage("已完成。"),
				]);
				const success = await f.executor.execute({
					...input,
					conversation: [
						{ role: "assistant", content: failed.assistantText },
						{ role: "user", content: "以题面为准，自动编写正确标程。" },
					],
					referenceProgram: { language: "python3", code: "print(41)" },
				});
				expect(success.status, JSON.stringify(success)).toBe("succeeded");
				expect(success.artifact?.verification).toMatchObject({ success: true, cases: [{ status: "passed" }] });
				expect(success.artifact?.authoring).toMatchObject({
					success: true,
					oracleCases: 1,
					generatedCases: 1,
					wrongPrograms: 1,
				});
				const directory = success.artifact?.directory;
				if (!directory) throw new Error("Missing artifact");
				expect(await readFile(join(directory, "testdata/1.in"), "utf8")).toBe("");
				expect(await readdir(directory)).not.toContain("reference.json");
				expect(
					await readFile(join(f.workspaceRoot, "artifacts/reference-update/authoring/reference.json"), "utf8"),
				).toContain("print(42)");
			} finally {
				await f.cleanup();
			}
		},
		45_000,
	);

	it.runIf(process.env.HYDRO_TEST_SANDBOX === "1")(
		"packages only verified SPJ data and exports the complete private authoring project",
		async () => {
			const f = await fixture(true);
			try {
				let verificationId = "";
				const problem = {
					slug: "divisor",
					title: "Divisor",
					tags: [],
					language: "zh",
					statement: "给定 n，输出任意正因子。",
					timeLimit: "1s",
					memoryLimit: "256m",
					subtasks: [
						{
							id: 1,
							type: "sum",
							score: 100,
							cases: divisorProject.cases.map((item, index) => ({
								caseId: item.id,
								inputFile: `${index + 1}.in`,
								outputFile: `${index + 1}.out`,
							})),
						},
					],
				};
				f.faux.setResponses([
					fauxAssistantMessage(
						fauxToolCall("update_hydro_authoring", {
							patch: JSON.parse(JSON.stringify(divisorProject)) as JsonValue,
						}),
						{
							stopReason: "toolUse",
						},
					),
					fauxAssistantMessage(fauxToolCall("verify_hydro_authoring", { mode: "full" }), {
						stopReason: "toolUse",
					}),
					(context) => {
						const result = [...context.messages]
							.reverse()
							.find((item) => item.role === "toolResult" && item.toolName === "verify_hydro_authoring");
						if (!result || result.role !== "toolResult") throw new Error("Missing verification tool result");
						const summary = JSON.parse(
							result.content
								.filter((item) => item.type === "text")
								.map((item) => item.text)
								.join(""),
						) as { verificationId: string; success: boolean };
						expect(summary.success, JSON.stringify(summary)).toBe(true);
						verificationId = summary.verificationId;
						return fauxAssistantMessage(
							fauxToolCall("build_hydro_problem", { problem: { ...problem, timeLimit: "2s" }, verificationId }),
							{ stopReason: "toolUse" },
						);
					},
					(context) => {
						const result = [...context.messages].reverse().find((item) => item.role === "toolResult");
						expect(result).toMatchObject({ isError: true });
						return fauxAssistantMessage(fauxToolCall("build_hydro_problem", { problem, verificationId }), {
							stopReason: "toolUse",
						});
					},
					fauxAssistantMessage("已生成标程、testlib 数据和 C++ SPJ。"),
				]);
				const result = await f.executor.execute({
					runId: "spj",
					source: "任意正因子",
					signal: new AbortController().signal,
					onEvent: () => {},
				});
				expect(result.status, JSON.stringify(result)).toBe("succeeded");
				expect(result.artifact?.authoring).toMatchObject({ checker: "testlib", testCases: 2, checkerProbes: 4 });
				if (!result.artifact) throw new Error("No artifact");
				const config = await readFile(join(result.artifact.directory, "testdata/config.yaml"), "utf8");
				expect(config).toContain("checker_type: testlib");
				expect(config).toContain("checker: checker.cc");
				expect(await readFile(join(result.artifact.directory, "testdata/checker.cc"), "utf8")).toBe(
					divisorProject.checker,
				);
				const archive = Buffer.from(await buildAuthoringArchive(result.artifact.directory, "spj", verificationId));
				for (const name of [
					"reference/main.py",
					"oracle/main.py",
					"generator.cc",
					"validator.cc",
					"checker.cc",
					"project.json",
					"testlib.h",
					"testlib-LICENSE.txt",
					"data/sample.in",
					"report.json",
				])
					expect(archive.includes(Buffer.from(name)), name).toBe(true);
			} finally {
				await f.cleanup();
			}
		},
		90_000,
	);

	it.runIf(process.env.HYDRO_TEST_SANDBOX === "1")(
		"automatically continues a failed authoring attempt to repair and build",
		async () => {
			const f = await fixture(true);
			try {
				let repairPrompt = "";
				f.faux.setResponses([
					fauxAssistantMessage(
						fauxToolCall("update_hydro_authoring", {
							patch: {
								...noInputProject,
								reference: { language: "python3", code: "print(41)" },
							},
						}),
						{ stopReason: "toolUse" },
					),
					fauxAssistantMessage(fauxToolCall("verify_hydro_authoring", { mode: "full" }), {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("标程输出有误。"),
					(context) => {
						repairPrompt = JSON.stringify(context.messages.filter((item) => item.role === "user"));
						return fauxAssistantMessage(
							fauxToolCall("update_hydro_authoring", { patch: { reference: noInputProject.reference } }),
							{ stopReason: "toolUse" },
						);
					},
					fauxAssistantMessage(fauxToolCall("verify_hydro_authoring", { mode: "full" }), {
						stopReason: "toolUse",
					}),
					(context) => {
						const result = [...context.messages]
							.reverse()
							.find((item) => item.role === "toolResult" && item.toolName === "verify_hydro_authoring");
						if (!result || result.role !== "toolResult") throw new Error("Missing verification result");
						const summary = JSON.parse(
							result.content
								.filter((item) => item.type === "text")
								.map((item) => item.text)
								.join(""),
						) as { verificationId: string };
						return fauxAssistantMessage(
							fauxToolCall("build_hydro_problem", {
								verificationId: summary.verificationId,
								problem: {
									slug: "repaired",
									title: "42",
									language: "zh",
									tags: [],
									statement: "输出 42。",
									timeLimit: "1s",
									memoryLimit: "256m",
									subtasks: [
										{
											id: 1,
											type: "sum",
											score: 100,
											cases: [{ caseId: "empty", inputFile: "1.in", outputFile: "1.out" }],
										},
									],
								},
							}),
							{ stopReason: "toolUse" },
						);
					},
					fauxAssistantMessage("修正完成并打包。"),
				]);
				const result = await f.executor.execute({
					runId: "auto-repair",
					source: "输出 42。",
					signal: new AbortController().signal,
					onEvent: () => {},
				});
				expect(result.status, JSON.stringify(result)).toBe("succeeded");
				expect(repairPrompt).toContain("修复失败部分");
			} finally {
				await f.cleanup();
			}
		},
		90_000,
	);
});
