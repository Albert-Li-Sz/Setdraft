import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AuthoringSummary,
	HydroAgentExecutor,
	HydroAiConfigurationController,
	HydroAiConfigurationInput,
	HydroAiConfigurationSnapshot,
	HydroSandbox,
} from "@hydro-problem-make/agent";
import {
	type HydroProblemSpec,
	validateHydroDirectory,
	writeHydroProblemDirectory,
} from "@hydro-problem-make/authoring";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProblemArtifact, saveAuthoringEvidence } from "../../hydro-agent/src/workspace.ts";
import { noInputProject } from "../../hydro-agent/test/authoring-fixtures.ts";
import type { HydroLiveVerifier } from "../src/live-hydro.ts";
import { HydroRunManager } from "../src/runs.ts";
import { createHydroServer } from "../src/server.ts";

const servers: ReturnType<typeof createHydroServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startServer(
	runManager?: HydroRunManager,
	aiConfiguration?: HydroAiConfigurationController,
	sandbox?: HydroSandbox,
	liveVerifier?: HydroLiveVerifier,
): Promise<string> {
	const server = createHydroServer({ runManager, aiConfiguration, sandbox, liveVerifier });
	servers.push(server);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address() as AddressInfo;
	return `http://127.0.0.1:${address.port}`;
}

function requestBody() {
	return {
		problem: {
			slug: "sum",
			title: "A + B",
			tags: ["入门"],
			language: "zh",
			statement: "# A + B\n",
			timeLimit: "1s",
			memoryLimit: "256m",
			subtasks: [
				{
					id: 1,
					type: "sum",
					score: 100,
					cases: [{ inputFile: "1.in", input: "1 2\n", outputFile: "1.out", output: "3\n" }],
				},
			],
		},
	};
}

const artifactSpec = {
	slug: "agent-sum",
	title: "Agent Sum",
	tags: [],
	language: "zh",
	statement: "# Agent Sum\n",
	timeLimit: "1s",
	memoryLimit: "256m",
	subtasks: [
		{
			id: 1,
			type: "sum",
			score: 100,
			cases: [{ inputFile: "1.in", input: "1 2\n", outputFile: "1.out", output: "3\n" }],
		},
	],
} satisfies HydroProblemSpec;

describe("Hydro HTTP API", () => {
	it("runs an optional live Hydro import and judging adapter and stores its evidence", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "hydro-live-api-"));
		try {
			const manager = new HydroRunManager(
				{
					readiness: { available: true, models: ["fake/model"] },
					async execute(input) {
						const summary: AuthoringSummary = {
							verificationId: "verified",
							success: true,
							testCases: 1,
							generatedCases: 1,
							oracleCases: 1,
							validatorNegativeCases: 1,
							checker: "default",
							checkerProbes: 0,
							wrongPrograms: 1,
						};
						await saveAuthoringEvidence(workspace, input.runId, {
							project: noInputProject,
							summary,
							report: { success: true, mode: "full", checks: [], cases: [] },
						});
						const artifact = await buildProblemArtifact(workspace, input.runId, artifactSpec);
						return {
							status: "succeeded",
							model: "fake/model",
							assistantText: "done",
							artifact: { ...artifact, slug: artifactSpec.slug, authoring: summary },
						};
					},
				},
				join(workspace, "runs.json"),
			);
			const verifier: HydroLiveVerifier = {
				status: () => ({ configured: true, message: "fake Hydro" }),
				async verify(request) {
					expect(request.authoringProject.wrongPrograms).toHaveLength(1);
					return {
						success: true,
						startedAt: "2026-01-01T00:00:00.000Z",
						finishedAt: "2026-01-01T00:00:01.000Z",
						import: { success: true, message: "imported" },
						reference: { name: "reference", verdict: "AC", score: 100, accepted: true },
						wrongPrograms: [{ name: "prints 41", verdict: "WA", score: 0, accepted: false }],
						message: "passed",
					};
				},
			};
			const origin = await startServer(manager, undefined, undefined, verifier);
			const run = manager.create("输出 42。");
			await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("succeeded"));
			const report = await fetch(`${origin}/api/runs/${run.id}/authoring-report`);
			expect(report.status).toBe(200);
			expect(await report.json()).toMatchObject({ success: true, mode: "full" });
			const response = await fetch(`${origin}/api/runs/${run.id}/live-verify`, { method: "POST" });
			expect(response.status).toBe(200);
			expect(await response.json()).toMatchObject({ success: true, reference: { verdict: "AC", score: 100 } });
			expect(manager.get(run.id)?.artifact?.liveVerification?.success).toBe(true);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("downloads private authoring sources and provenance for the selected completed run", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "hydro-authoring-api-"));
		try {
			const manager = new HydroRunManager({
				readiness: { available: true, models: ["fake/model"] },
				async execute(input) {
					const summary: AuthoringSummary = {
						verificationId: "verified",
						success: true,
						testCases: 1,
						generatedCases: 1,
						oracleCases: 1,
						validatorNegativeCases: 1,
						checker: "default",
						checkerProbes: 0,
						wrongPrograms: 1,
					};
					await saveAuthoringEvidence(workspace, input.runId, {
						project: noInputProject,
						summary,
						report: {
							success: true,
							mode: "full",
							checks: [],
							cases: [
								{
									id: "empty",
									input: "",
									output: "42\n",
									timeLimitMs: 1000,
									memoryLimitMb: 256,
									durationMs: 5,
								},
							],
						},
					});
					const artifact = await buildProblemArtifact(workspace, input.runId, {
						...artifactSpec,
						statement: "输出 42。",
						subtasks: [
							{
								id: 1,
								type: "sum",
								score: 100,
								cases: [{ inputFile: "1.in", outputFile: "1.out", input: "", output: "42\n" }],
							},
						],
					});
					return {
						status: "succeeded",
						model: "fake/model",
						assistantText: "done",
						artifact: { ...artifact, slug: artifactSpec.slug, authoring: summary },
					};
				},
			});
			const origin = await startServer(manager);
			const run = manager.create("原始题面：输出 42。");
			await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("succeeded"));
			const response = await fetch(`${origin}/api/runs/${run.id}/authoring`);
			expect(response.status).toBe(200);
			expect(response.headers.get("content-disposition")).toContain(".authoring.zip");
			const archive = Buffer.from(await response.arrayBuffer());
			for (const text of [
				"reference/main.py",
				"validator.cc",
				"project.json",
				"testlib.h",
				"manifest.json",
				"original-statement.md",
				"原始题面：输出 42。",
			])
				expect(archive.includes(Buffer.from(text)), text).toBe(true);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
	it("continues a waiting task, forwards its standard program and downloads the completed package", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "hydro-continue-"));
		try {
			const inputs: Array<Parameters<HydroAgentExecutor["execute"]>[0]> = [];
			const manager = new HydroRunManager({
				readiness: { available: true, models: ["fake/model"] },
				async execute(input) {
					inputs.push(input);
					if (inputs.length === 1)
						return { status: "needs_input", model: "fake/model", assistantText: "请补充。" };
					const directory = await writeHydroProblemDirectory(artifactSpec, workspace);
					return {
						status: "succeeded",
						model: "fake/model",
						assistantText: "完成",
						artifact: { directory, slug: artifactSpec.slug, report: await validateHydroDirectory(directory) },
					};
				},
			});
			const origin = await startServer(manager);
			const created = manager.create("# 原始题面");
			await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe("needs_input"));
			const after = manager.get(created.id)?.lastEventSequence;
			const referenceProgram = { language: "python3", code: "print(3)" };
			const continued = await fetch(`${origin}/api/runs/${created.id}/continue`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "以原题面为准。", referenceProgram }),
			});
			expect(continued.status).toBe(202);
			expect(await continued.json()).toMatchObject({ id: created.id });
			await vi.waitFor(() => expect(manager.get(created.id)?.status).toBe("succeeded"));
			expect(inputs[1]).toMatchObject({
				referenceProgram,
				conversation: [
					{ role: "assistant", content: "请补充。" },
					{ role: "user", content: "以原题面为准。" },
				],
			});
			const replay = await (await fetch(`${origin}/api/runs/${created.id}/events?after=${after}`)).text();
			expect(replay).not.toContain('"status":"needs_input"');
			expect(replay).toContain('"status":"succeeded"');
			const archive = await fetch(`${origin}/api/runs/${created.id}/archive`);
			expect(archive.status).toBe(200);
			expect(archive.headers.get("content-type")).toBe("application/zip");
			await archive.arrayBuffer();
			const again = await fetch(`${origin}/api/runs/${created.id}/continue`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message: "再试一次" }),
			});
			expect(again.status).toBe(409);
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("runs standard programs through the sandbox endpoint and rejects malformed requests", async () => {
		const calls: unknown[] = [];
		const sandbox: HydroSandbox = {
			async status() {
				return { available: true, image: "test", message: "ready" };
			},
			async run(request) {
				calls.push(request);
				return {
					compiled: true,
					success: true,
					compileOutput: "",
					cases: [{ index: 0, status: "generated", stdout: "42\n", stderr: "", exitCode: 0, durationMs: 5 }],
				};
			},
		};
		const origin = await startServer(undefined, undefined, sandbox);
		const response = await fetch(`${origin}/api/sandbox/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ program: { language: "python3", code: "print(42)" }, cases: [{ input: "" }] }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ success: true, cases: [{ status: "generated", stdout: "42\n" }] });
		expect(calls).toHaveLength(1);
		const invalid = await fetch(`${origin}/api/sandbox/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ program: { language: "sh", code: "echo 42" }, cases: [] }),
		});
		expect(invalid.status).toBe(400);
		expect(calls).toHaveLength(1);
	});
	it("configures the Pi Agent model through the local web API without returning the key", async () => {
		const provider = { id: "openai", name: "OpenAI", models: [{ id: "gpt-test", name: "GPT Test" }] };
		let configured: HydroAiConfigurationInput | undefined;
		let snapshot: HydroAiConfigurationSnapshot = {
			configured: false,
			apiKeyConfigured: false,
			providers: [provider],
		};
		const aiConfiguration: HydroAiConfigurationController = {
			getSnapshot: () => snapshot,
			async configure(input) {
				configured = input;
				snapshot = {
					configured: true,
					provider: input.provider,
					modelId: input.modelId,
					baseUrl: input.baseUrl,
					contextWindow: input.contextWindow,
					maxTokens: input.maxTokens,
					apiKeyConfigured: input.apiKey !== undefined,
					providers: [provider],
				};
				return snapshot;
			},
			async clear() {
				snapshot = { configured: false, apiKeyConfigured: false, providers: [provider] };
				return snapshot;
			},
		};
		const origin = await startServer(undefined, aiConfiguration);
		const initial = await fetch(`${origin}/api/ai/config`);
		expect(initial.status).toBe(200);
		expect(await initial.json()).toEqual(snapshot);

		const saved = await fetch(`${origin}/api/ai/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				provider: "openai",
				modelId: "gpt-test",
				apiKey: "secret-value",
				baseUrl: "https://gateway.example/v1",
				contextWindow: 262_144,
				maxTokens: 32_768,
			}),
		});
		expect(saved.status).toBe(200);
		expect(configured).toEqual({
			provider: "openai",
			modelId: "gpt-test",
			apiKey: "secret-value",
			baseUrl: "https://gateway.example/v1",
			contextWindow: 262_144,
			maxTokens: 32_768,
		});
		expect(JSON.stringify(await saved.json())).not.toContain("secret-value");

		const invalidLength = await fetch(`${origin}/api/ai/config`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "openai", modelId: "gpt-test", contextWindow: "262144" }),
		});
		expect(invalidLength.status).toBe(400);

		const cleared = await fetch(`${origin}/api/ai/config`, { method: "DELETE" });
		expect(cleared.status).toBe(200);
		expect(await cleared.json()).toMatchObject({ configured: false, apiKeyConfigured: false });
	});

	it("reports explicit capabilities", async () => {
		const origin = await startServer();
		const response = await fetch(`${origin}/api/health`);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			status: "ok",
			capabilities: { validate: true, deterministicArchive: true, agentGeneration: false },
		});
	});

	it("allows local browser origins to use a separately hosted API", async () => {
		const origin = await startServer();
		const browserOrigin = "http://127.0.0.1:5173";
		const preflight = await fetch(`${origin}/api/health`, {
			method: "OPTIONS",
			headers: { origin: browserOrigin, "access-control-request-method": "GET" },
		});
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe(browserOrigin);

		const health = await fetch(`${origin}/api/health`, { headers: { origin: browserOrigin } });
		expect(health.headers.get("access-control-allow-origin")).toBe(browserOrigin);

		const remote = await fetch(`${origin}/api/health`, { headers: { origin: "https://untrusted.example" } });
		expect(remote.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("lists authoring task history even when Agent generation is disabled", async () => {
		const plainOrigin = await startServer();
		const empty = await fetch(`${plainOrigin}/api/runs`);
		expect(empty.status).toBe(200);
		expect(await empty.json()).toEqual({ runs: [] });

		const executor: HydroAgentExecutor = {
			readiness: { available: true, models: ["fake/model"] },
			async execute() {
				return { status: "needs_input", model: "fake/model", assistantText: "Need constraints." };
			},
		};
		const origin = await startServer(new HydroRunManager(executor));
		const created = (await (
			await fetch(`${origin}/api/runs`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ source: "# Sum" }),
			})
		).json()) as { id: string };
		await vi.waitFor(async () => {
			const history = (await (await fetch(`${origin}/api/runs`)).json()) as { runs: Array<{ id: string }> };
			expect(history.runs.map((run) => run.id)).toEqual([created.id]);
		});
		expect((await fetch(`${origin}/api/runs/${created.id}`, { method: "DELETE" })).status).toBe(204);
		expect((await fetch(`${origin}/api/runs/${created.id}`)).status).toBe(404);
		expect(await (await fetch(`${origin}/api/runs`)).json()).toEqual({ runs: [] });
	});

	it("preserves a testlib checker in manual archive requests", async () => {
		const origin = await startServer();
		const body = requestBody();
		const source =
			'#include "testlib.h"\nint main(int argc,char** argv){registerTestlibCmd(argc,argv);quitf(_ok,"ok");}';
		const response = await fetch(`${origin}/api/problems/archive`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ problem: { ...body.problem, checker: { type: "testlib", source } } }),
		});
		expect(response.status).toBe(200);
		const zip = Buffer.from(await response.arrayBuffer());
		expect(zip.includes(Buffer.from("checker_type: testlib"))).toBe(true);
		expect(zip.includes(Buffer.from("testdata/checker.cc"))).toBe(true);
		expect(zip.includes(Buffer.from(source))).toBe(true);
	});

	it("validates and returns a deterministic Hydro archive", async () => {
		const origin = await startServer();
		const request = {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(requestBody()),
		};
		const validation = await fetch(`${origin}/api/problems/validate`, request);
		expect(await validation.json()).toEqual({ valid: true, issues: [] });

		const first = await fetch(`${origin}/api/problems/archive`, request);
		const second = await fetch(`${origin}/api/problems/archive`, request);
		expect(first.status).toBe(200);
		expect(first.headers.get("content-type")).toBe("application/zip");
		expect(Buffer.from(await first.arrayBuffer())).toEqual(Buffer.from(await second.arrayBuffer()));
	});

	it("returns structured errors for malformed and invalid problems", async () => {
		const origin = await startServer();
		const malformed = await fetch(`${origin}/api/problems/validate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ problem: { title: 42 } }),
		});
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({ error: "INVALID_REQUEST" });

		const invalidBody = requestBody();
		invalidBody.problem.subtasks[0].score = 99;
		const invalid = await fetch(`${origin}/api/problems/archive`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(invalidBody),
		});
		expect(invalid.status).toBe(422);
		expect(await invalid.json()).toMatchObject({
			error: "INVALID_PROBLEM",
			report: { valid: false, issues: [{ code: "INVALID_TOTAL_SCORE" }] },
		});
	});

	it("keeps Agent generation opt-in and exposes a queued run when configured", async () => {
		const plainOrigin = await startServer();
		const unavailable = await fetch(`${plainOrigin}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "# Sum" }),
		});
		expect(unavailable.status).toBe(503);

		const executor: HydroAgentExecutor = {
			readiness: { available: true, models: ["fake/model"] },
			async execute(input) {
				input.onEvent({ type: "text_delta", delta: "Need constraints." });
				return { status: "needs_input", model: "fake/model", assistantText: "Need constraints." };
			},
		};
		const origin = await startServer(new HydroRunManager(executor));
		const createdResponse = await fetch(`${origin}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ source: "# Sum" }),
		});
		expect(createdResponse.status).toBe(202);
		const created = (await createdResponse.json()) as { id: string };
		await vi.waitFor(async () => {
			const status = (await (await fetch(`${origin}/api/runs/${created.id}`)).json()) as { status: string };
			expect(status.status).toBe("needs_input");
		});
		const events = await fetch(`${origin}/api/runs/${created.id}/events`);
		expect(events.headers.get("content-type")).toContain("text/event-stream");
		expect(await events.text()).toContain('"status":"needs_input"');
	});

	it("accepts binary attachments for Agent workflows", async () => {
		let received: Parameters<HydroAgentExecutor["execute"]>[0]["attachments"];
		const manager = new HydroRunManager({
			readiness: { available: true, models: ["fake/model"] },
			async execute(input) {
				received = input.attachments;
				return { status: "failed", model: "fake/model", assistantText: "stopped" };
			},
		});
		const origin = await startServer(manager);
		const response = await fetch(`${origin}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "# Attachment",
				attachments: [{ name: "diagram.png", contentBase64: "aGVsbG8=" }],
			}),
		});
		expect(response.status).toBe(202);
		await vi.waitFor(() => expect(received).toEqual([{ name: "diagram.png", contentBase64: "aGVsbG8=" }]));
		const invalid = await fetch(`${origin}/api/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				source: "# Bad attachment",
				attachments: [{ name: "../diagram.png", contentBase64: "aGVsbG8=" }],
			}),
		});
		expect(invalid.status).toBe(400);
	});

	it("downloads a revalidated archive produced by an Agent run without exposing its server path", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "hydro-server-agent-"));
		try {
			const directory = await writeHydroProblemDirectory(artifactSpec, workspace);
			const report = await validateHydroDirectory(directory);
			const executor: HydroAgentExecutor = {
				readiness: { available: true, models: ["fake/model"] },
				async execute() {
					return {
						status: "succeeded",
						model: "fake/model",
						assistantText: "Built.",
						artifact: { directory, slug: artifactSpec.slug, report },
					};
				},
			};
			const origin = await startServer(new HydroRunManager(executor));
			const created = (await (
				await fetch(`${origin}/api/runs`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ source: "# Agent Sum" }),
				})
			).json()) as { id: string };
			let runBody: Record<string, unknown> = {};
			await vi.waitFor(async () => {
				runBody = (await (await fetch(`${origin}/api/runs/${created.id}`)).json()) as Record<string, unknown>;
				expect(runBody.status).toBe("succeeded");
			});
			expect(JSON.stringify(runBody)).not.toContain(directory);
			const archive = await fetch(`${origin}/api/runs/${created.id}/archive`);
			expect(archive.status).toBe(200);
			expect(Buffer.from(await archive.arrayBuffer()).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});
