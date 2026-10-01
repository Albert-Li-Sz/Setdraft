import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ContestStore } from "../src/contests.ts";
import { ExecutionScheduler } from "../src/execution-scheduler.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { runManualSandbox } from "../src/manual-sandbox.ts";
import { sandboxPolicy } from "../src/sandbox-policy.ts";
import { cleanupSandboxStage, confirmSandboxCleanup, SandboxCleanupError } from "../src/sandbox-runtime.ts";
import { TaskQueue } from "../src/tasks.ts";

const docker = vi.hoisted(() => ({
	available: false,
	calls: 0,
	spawned: false,
	child: undefined as EventEmitter | undefined,
}));
vi.mock("node:child_process", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:child_process")>()),
	spawn: vi.fn(() => {
		const child = new EventEmitter();
		const process = Object.assign(child, {
			stdout: new PassThrough(),
			stderr: new PassThrough(),
			kill: () => {
				queueMicrotask(() => child.emit("close", 137));
				return true;
			},
		});
		docker.spawned = true;
		docker.child = child;
		return process;
	}),
	execFile: vi.fn((_file: string, _args: string[], _options: unknown, callback: (error: Error | null) => void) => {
		docker.calls++;
		queueMicrotask(() => callback(docker.available ? null : new Error("Docker daemon unavailable")));
	}),
}));
let root: string;
const queues: TaskQueue[] = [];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-cleanup-"));
	docker.available = false;
	docker.calls = 0;
	docker.spawned = false;
	docker.child = undefined;
});
it.each(["close", "error"])("confirms daemon cleanup after an unexpected Docker CLI %s", async (event) => {
	docker.available = true;
	const running = runManualSandbox({
		mode: "generate",
		stage: join(root, "unexpected"),
		image: "faux",
		reference: { language: "python3", code: "print(1)" },
		generatorStandard: "cpp17",
		checkerStandard: "cpp17",
		validatorStandard: "cpp17",
		timeLimitMs: 1000,
		memoryLimitMb: 256,
		maxFileBytes: 1024,
	});
	const failed = expect(running).rejects.toThrow(event === "error" ? "CLI failed" : "Docker exited");
	await vi.waitFor(() => expect(docker.spawned).toBe(true));
	if (event === "error") docker.child?.emit("error", new Error("CLI failed"));
	docker.child?.emit("close", 125);
	await failed;
	expect(docker.calls).toBeGreaterThan(0);
});
afterEach(async () => {
	docker.available = true;
	for (const q of queues) q.close();
	await Promise.all(queues.splice(0).map((q) => q.idle()));
	await rm(root, { recursive: true, force: true });
});
it("retains a mount and its parent after repeated Docker errors and removes them only after confirmation", async () => {
	const mount = join(root, "stage", "validator");
	await mkdir(mount, { recursive: true });
	const error = new SandboxCleanupError(["setdraft-test-retained"], [mount]);
	await expect(confirmSandboxCleanup(error)).rejects.toThrow("清理失败");
	await expect(confirmSandboxCleanup(error)).rejects.toThrow("清理失败");
	await cleanupSandboxStage(join(root, "stage"));
	expect((await stat(mount)).isDirectory()).toBe(true);
	docker.available = true;
	await confirmSandboxCleanup(error);
	await expect(stat(join(root, "stage"))).rejects.toMatchObject({ code: "ENOENT" });
	expect(docker.calls).toBe(3);
});
it("persists cleanup pending, holds capacity, pauses admission and resumes after Docker recovery", async () => {
	const projects = new ManualProjectStore({ root });
	const policy = { ...sandboxPolicy({}), concurrency: 1 };
	const scheduler = new ExecutionScheduler(1, policy);
	const queue = new TaskQueue(projects, new ContestStore(projects), {
		scheduler,
		policy,
		userId: "alice",
		enabled: async () => true,
	});
	queues.push(queue);
	await queue.ready;
	const project = await projects.create("acm");
	const mount = join(root, "retained-stage");
	await mkdir(mount);
	vi.spyOn(projects.pipeline, "generate").mockImplementation(async (id, context) => {
		try {
			return {
				project: await projects.get(id),
				report: await runManualSandbox({
					mode: "generate",
					stage: mount,
					image: "faux",
					context,
					reference: { language: "python3", code: "print(1)" },
					generatorStandard: "cpp17",
					checkerStandard: "cpp17",
					validatorStandard: "cpp17",
					timeLimitMs: 1000,
					memoryLimitMb: 256,
					maxFileBytes: 1024,
				}),
			};
		} finally {
			await cleanupSandboxStage(mount);
		}
	});
	const task = await queue.submit("generate", project.id);
	await vi.waitFor(() => expect(docker.spawned).toBe(true));
	const otherProjects = new ManualProjectStore({ root: join(root, "bob") });
	const otherQueue = new TaskQueue(otherProjects, new ContestStore(otherProjects), {
		scheduler,
		policy,
		userId: "bob",
		enabled: async () => true,
	});
	queues.push(otherQueue);
	await otherQueue.ready;
	const nextRun = vi.spyOn(otherProjects.pipeline, "generate").mockImplementation(async (id) => ({
		project: await otherProjects.get(id),
		report: {
			mode: "generate",
			success: true,
			checks: [],
			caseCount: 0,
			generatedCount: 0,
			oracleCount: 0,
			validatorUsed: false,
			checkerUsed: false,
		},
	}));
	const next = await otherQueue.submit("generate", (await otherProjects.create("acm")).id);
	await queue.cancel(task.id);
	await vi.waitFor(
		async () => expect(await queue.get(task.id)).toMatchObject({ state: "running", cleanupPending: true }),
		{ timeout: 3000 },
	);
	await queue.idle();
	expect(scheduler.status("alice")).toMatchObject({ running: 1, outstanding: 2, paused: true });
	expect((await stat(mount)).isDirectory()).toBe(true);
	expect((await otherQueue.get(next.id)).state).toBe("queued");
	expect(nextRun).not.toHaveBeenCalled();
	await expect(queue.submit("generate", (await projects.create("acm")).id)).rejects.toMatchObject({ statusCode: 503 });
	const initialRemovals = docker.calls;
	await vi.waitFor(() => expect(docker.calls).toBeGreaterThan(initialRemovals), { timeout: 3000 });
	expect((await queue.get(task.id)).state).toBe("running");
	docker.available = true;
	await vi.waitFor(async () => expect((await queue.get(task.id)).state).toBe("cancelled"), { timeout: 5000 });
	await vi.waitFor(async () => expect((await otherQueue.get(next.id)).state).toBe("succeeded"), { timeout: 3000 });
	await otherQueue.idle();
	expect(scheduler.status("alice")).toMatchObject({ running: 0, outstanding: 0, paused: false });
	expect(await projects.database.list("sandbox-cleanup")).toEqual([]);
	await expect(stat(mount)).rejects.toMatchObject({ code: "ENOENT" });
});

it("fails startup closed for persisted cleanup and recovers it after Docker is restored", async () => {
	const projects = new ManualProjectStore({ root });
	const mount = join(root, "recovery-stage");
	await mkdir(mount);
	const taskId = "00000000-0000-4000-8000-000000000001";
	const record = {
		taskId,
		containers: [`setdraft-task-${taskId}`],
		directories: [mount],
		finalState: "cancelled",
		error: "任务已取消。",
		attempts: 8,
		nextRetryAt: 0,
	};
	const now = new Date().toISOString();
	await projects.database.sql.execute(
		"INSERT INTO tasks(id,kind,resource,state,fingerprint,created_at,updated_at) VALUES($1,'generate','project:missing','running','hash',$2,$2)",
		[taskId, now],
	);
	await projects.database.put("sandbox-cleanup", taskId, record);
	const scheduler = new ExecutionScheduler(1, sandboxPolicy({}));
	const failed = new TaskQueue(projects, new ContestStore(projects), {
		scheduler,
		userId: "alice",
		enabled: async () => true,
	});
	queues.push(failed);
	await expect(failed.ready).rejects.toThrow("清理失败");
	failed.close();
	expect(scheduler.status("alice").paused).toBe(true);
	expect((await stat(mount)).isDirectory()).toBe(true);
	docker.available = true;
	const recovered = new TaskQueue(projects, new ContestStore(projects));
	queues.push(recovered);
	await recovered.ready;
	expect(await recovered.get(taskId)).toMatchObject({ state: "cancelled", cleanupPending: false });
	expect(await projects.database.list("sandbox-cleanup")).toEqual([]);
	await expect(stat(mount)).rejects.toMatchObject({ code: "ENOENT" });
});
