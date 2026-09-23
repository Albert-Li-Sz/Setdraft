import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HydroAgentExecutor } from "@hydro-problem-make/agent";
import { describe, expect, it, vi } from "vitest";
import { HydroRunManager } from "../src/runs.ts";

function fakeExecutor(execute: HydroAgentExecutor["execute"]): HydroAgentExecutor {
	return { readiness: { available: true, models: ["fake/model"] }, execute };
}

describe("HydroRunManager", () => {
	it("retries a failed task without requiring text and preserves the saved context", async () => {
		const inputs: Array<Parameters<HydroAgentExecutor["execute"]>[0]> = [];
		const manager = new HydroRunManager(
			fakeExecutor(async (input) => {
				inputs.push(input);
				input.onEvent({
					type: "metrics",
					metrics: {
						modelTurns: 2,
						inputTokens: 100,
						outputTokens: 50,
						cacheReadTokens: 10,
						modelWaitMs: 4000,
						sandboxMs: 1000,
						toolCalls: 3,
						quickVerifications: 1,
						fullVerifications: 0,
					},
				});
				return {
					status: "failed",
					model: "fake/model",
					assistantText: "validator failed",
					failureReason: "invalid validator",
				};
			}),
		);
		const first = manager.create("# Retry");
		await vi.waitFor(() => expect(manager.get(first.id)?.status).toBe("failed"));
		expect(manager.get(first.id)?.metrics?.quickVerifications).toBe(1);
		expect(manager.get(first.id)?.error).toBe("invalid validator");
		const resumed = manager.retry(first.id);
		expect(resumed.id).toBe(first.id);
		await vi.waitFor(() => expect(inputs).toHaveLength(2));
		expect(inputs[1].conversation).toEqual([{ role: "assistant", content: "validator failed" }]);
	});
	it("keeps the list index compact, stores details per run and drops streamed deltas after completion", async () => {
		const root = await mkdtemp(join(tmpdir(), "hydro-compact-"));
		try {
			let receivedAttachments: unknown;
			const manager = new HydroRunManager(
				fakeExecutor(async (input) => {
					receivedAttachments = input.attachments;
					input.onEvent({ type: "phase", phase: "authoring", message: "生成工程" });
					for (let index = 0; index < 1000; index++)
						input.onEvent({ type: "text_delta", delta: `large streamed response ${index}\n` });
					return { status: "failed", model: "fake/model", assistantText: "final response" };
				}),
				join(root, "runs.json"),
			);
			const attachments = [{ name: "diagram.png", contentBase64: "aGVsbG8=" }];
			const run = manager.create(`# Compact\n${"source ".repeat(1000)}`, undefined, attachments);
			await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("failed"));
			expect(receivedAttachments).toEqual(attachments);
			const index = await readFile(join(root, "runs.json"), "utf8");
			expect(index.length).toBeLessThan(3000);
			expect(index).not.toContain("large streamed response");
			expect(index).not.toContain("source ".repeat(100));
			const record = await readFile(join(root, "run-records", `${run.id}.json`), "utf8");
			expect(record).toContain("final response");
			expect(record).not.toContain("large streamed response");
			expect(manager.getEvents(run.id)?.some((event) => event.type === "text_delta")).toBe(false);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("deletes a terminal record and only its private files, including across restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "hydro-delete-"));
		try {
			const executor = fakeExecutor(async () => ({
				status: "needs_input",
				model: "fake/model",
				assistantText: "Question",
			}));
			const manager = new HydroRunManager(executor, join(root, "runs.json"));
			const first = manager.create("# Delete me");
			const second = manager.create("# Keep me");
			await vi.waitFor(() => expect(manager.get(second.id)?.status).toBe("needs_input"));
			for (const id of [first.id, second.id]) {
				for (const kind of ["artifacts", "sessions"]) {
					await mkdir(join(root, kind, id), { recursive: true });
					await writeFile(join(root, kind, id, "evidence.json"), "{}");
				}
			}
			expect(await manager.delete(first.id)).toBe(true);
			expect(await manager.delete(first.id)).toBe(false);
			expect(manager.get(first.id)).toBeUndefined();
			for (const kind of ["artifacts", "sessions"]) {
				await expect(stat(join(root, kind, first.id))).rejects.toMatchObject({ code: "ENOENT" });
				expect((await stat(join(root, kind, second.id, "evidence.json"))).isFile()).toBe(true);
			}
			expect(new HydroRunManager(executor, join(root, "runs.json")).list().map((run) => run.id)).toEqual([
				second.id,
			]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
	it("restores interrupted tasks and preserves attached programs across continuation and restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "hydro-runs-"));
		const storage = join(directory, "runs.json");
		try {
			await writeFile(
				storage,
				JSON.stringify({
					runs: [
						{
							id: "legacy-run",
							status: "running",
							source: "# 三连击",
							assistantText: "",
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						},
					],
				}),
			);
			const executor = fakeExecutor(async () => ({
				status: "needs_input",
				model: "fake/model",
				assistantText: "继续说明。",
			}));
			const manager = new HydroRunManager(executor, storage);
			expect(manager.get("legacy-run")).toMatchObject({ status: "needs_input" });
			const referenceProgram = { language: "python3" as const, code: "print(42)" };
			manager.continue("legacy-run", { message: "已添加标准程序。", referenceProgram });
			await vi.waitFor(() => expect(manager.get("legacy-run")?.status).toBe("needs_input"));
			const restored = new HydroRunManager(executor, storage);
			expect(restored.get("legacy-run")).toMatchObject({
				referenceProgram,
				conversation: [{ role: "user", content: "已添加标准程序。" }],
			});
			expect(restored.getEvents("legacy-run")).toHaveLength(3);
			expect(() => restored.continue("legacy-run", { message: " " })).toThrow("补充信息");
			restored.continue("legacy-run", { message: "移除原程序，由 Agent 重新编写。", referenceProgram: null });
			await vi.waitFor(() => expect(restored.get("legacy-run")?.status).toBe("needs_input"));
			expect(restored.get("legacy-run")?.referenceProgram).toBeUndefined();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("continues a needs_input task with its original ID and the clarification context", async () => {
		const inputs: Array<Parameters<HydroAgentExecutor["execute"]>[0]> = [];
		const manager = new HydroRunManager(
			fakeExecutor(async (input) => {
				inputs.push(input);
				return { status: "needs_input", model: "fake/model", assistantText: "请确认以三连击题面为准。" };
			}),
		);
		const first = manager.create("# 三连击");
		await vi.waitFor(() => expect(manager.get(first.id)?.status).toBe("needs_input"));
		const continued = manager.continue(first.id, { message: "以三连击为准，输入文件为空。" });
		expect(continued.id).toBe(first.id);
		await vi.waitFor(() => expect(inputs).toHaveLength(2));
		expect(inputs[1].source).toBe("# 三连击");
		expect(inputs[1].conversation).toEqual([
			{ role: "assistant", content: "请确认以三连击题面为准。" },
			{ role: "user", content: "以三连击为准，输入文件为空。" },
		]);
	});

	it("lists the newest authoring tasks first", async () => {
		const manager = new HydroRunManager(
			fakeExecutor(async () => ({ status: "needs_input", model: "fake/model", assistantText: "Question" })),
		);
		const first = manager.create("# First");
		const second = manager.create("# Second");
		await vi.waitFor(() => expect(manager.get(second.id)?.status).toBe("needs_input"));

		expect(manager.list().map((run) => run.id)).toEqual([second.id, first.id]);
	});

	it("runs multiple Agent workflows up to the configured limit and records replayable progress", async () => {
		let active = 0;
		let maxActive = 0;
		const releases = new Map<string, () => void>();
		const manager = new HydroRunManager(
			fakeExecutor(async (input) => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				input.onEvent({ type: "text_delta", delta: `processing ${input.runId}` });
				await new Promise<void>((resolve) => releases.set(input.runId, resolve));
				active -= 1;
				return { status: "needs_input", model: "fake/model", assistantText: "Need constraints." };
			}),
			undefined,
			2,
		);
		const first = manager.create("# First");
		const second = manager.create("# Second");
		const third = manager.create("# Third");
		await vi.waitFor(() => expect(releases.size).toBe(2));
		expect(manager.get(first.id)?.status).toBe("running");
		expect(manager.get(second.id)?.status).toBe("running");
		expect(manager.get(third.id)?.status).toBe("queued");
		releases.get(first.id)?.();
		await vi.waitFor(() => expect(releases.size).toBe(3));
		expect(manager.get(third.id)?.status).toBe("running");
		releases.get(second.id)?.();
		releases.get(third.id)?.();
		await vi.waitFor(() => {
			expect(manager.get(first.id)?.status).toBe("needs_input");
			expect(manager.get(second.id)?.status).toBe("needs_input");
			expect(manager.get(third.id)?.status).toBe("needs_input");
		});
		expect(maxActive).toBe(2);
		expect(manager.getMaxConcurrentRuns()).toBe(2);
		expect(
			manager
				.getEvents(first.id)
				?.map((event) => event.status)
				.filter(Boolean),
		).toEqual(["queued", "running", "needs_input"]);
		expect(manager.getEvents(first.id, 2)?.every((event) => event.sequence > 2)).toBe(true);
	});

	it("cancels an active run without allowing its late result to replace the terminal state", async () => {
		const manager = new HydroRunManager(
			fakeExecutor(
				(input) =>
					new Promise((resolve) => {
						input.signal.addEventListener("abort", () =>
							resolve({ status: "failed", model: "fake/model", assistantText: "aborted" }),
						);
					}),
			),
		);
		const run = manager.create("# Cancel me");
		await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("running"));
		await expect(manager.delete(run.id)).rejects.toThrow("运行");
		expect(manager.cancel(run.id)).toBe(true);
		await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("cancelled"));
		expect(manager.cancel(run.id)).toBe(false);
	});

	it("notifies subscribers and isolates listener failures", async () => {
		const manager = new HydroRunManager(
			fakeExecutor(async () => ({ status: "needs_input", model: "fake/model", assistantText: "Question" })),
		);
		const run = manager.create("# Subscribe");
		const statuses: string[] = [];
		manager.subscribe(run.id, () => {
			throw new Error("disconnected");
		});
		manager.subscribe(run.id, (event) => {
			if (event.status !== undefined) statuses.push(event.status);
		});
		await vi.waitFor(() => expect(manager.get(run.id)?.status).toBe("needs_input"));
		expect(statuses).toEqual(["needs_input"]);
	});
});
