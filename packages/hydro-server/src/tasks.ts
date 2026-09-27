import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ContestFormat, TaskEvent, TaskKind, TaskRecord, TaskState } from "@setdraft/contracts";
import { sandboxBuildArgs } from "../sandbox/build-args.mjs";
import type { ContestStore } from "./contests.ts";
import { EventWriter } from "./event-writer.ts";
import type { ExecutionContext } from "./execution-context.ts";
import type { ExecutionScheduler } from "./execution-scheduler.ts";
import { ManualProjectError, type ManualProjectStore } from "./manual-projects.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

export type { TaskEvent, TaskKind, TaskRecord, TaskState } from "@setdraft/contracts";

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class TaskQueue {
	private readonly database: WorkspaceDatabase;
	private readonly projects: ManualProjectStore;
	private readonly contests: ContestStore;
	private readonly controllers = new Map<string, AbortController>();
	private readonly timer: NodeJS.Timeout;
	private closed = false;
	private readonly scheduling?: { scheduler: ExecutionScheduler; userId: string; enabled(): Promise<boolean> };
	private readonly waiting = new Map<string, AbortController>();
	private readonly slots = new Map<string, () => void>();
	private readonly running = new Set<Promise<void>>();

	constructor(
		projects: ManualProjectStore,
		contests: ContestStore,
		scheduling?: { scheduler: ExecutionScheduler; userId: string; enabled(): Promise<boolean> },
	) {
		this.scheduling = scheduling;
		this.projects = projects;
		this.contests = contests;
		this.database = projects.database;

		this.ready = this.recover();
		this.timer = setInterval(() => this.wake(), 500);
		this.timer.unref();
		this.wake();
	}
	readonly ready: Promise<void>;
	private pumping = false;
	private wake(): void {
		void this.ready
			.then(async () => {
				if (this.pumping || this.closed) return;
				this.pumping = true;
				try {
					await this.pump();
				} finally {
					this.pumping = false;
				}
			})
			.catch(() => console.error("Task queue unavailable."));
	}
	private async recover(): Promise<void> {
		for (const task of (await this.list()).filter((item) => item.state === "running")) {
			await this.finish(task.id, "interrupted", undefined, "服务进程中断；可以重试此任务。");
			const child = spawn("docker", ["rm", "-f", `setdraft-task-${task.id}`], { stdio: "ignore" });
			child.on("error", () => {});
		}
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		for (const controller of this.waiting.values()) controller.abort();
		for (const controller of this.controllers.values()) controller.abort();
		for (const release of this.slots.values()) release();
		this.slots.clear();
	}

	async idle(): Promise<void> {
		while (this.running.size) await Promise.all([...this.running]);
	}
	async cancelAll(): Promise<void> {
		const rows = (await this.database.sql.all(
			"SELECT id FROM tasks WHERE state IN ('queued','running')",
			[],
		)) as Array<{
			id: string;
		}>;
		for (const row of rows) await this.cancel(row.id).catch(() => undefined);
	}
	private releaseSlot(id: string): void {
		this.slots.get(id)?.();
		this.slots.delete(id);
	}

	private async fingerprint(kind: TaskKind, resource: string): Promise<string> {
		if (kind === "image-build") return digest({ image: this.projects.image });
		if (kind === "contest-export") return digest(await this.database.get("contest", resource));
		return digest({
			project: await this.database.get("project", resource),
			files: [
				...(await this.database.fileEntries("manual", resource)),
				...(await this.database.fileEntries("generated", resource)),
			],
		});
	}

	private async assertWritable(): Promise<void> {
		if (this.scheduling && (this.closed || !(await this.scheduling.enabled())))
			throw new ManualProjectError("任务服务不可用。", 403);
	}

	async submit(kind: TaskKind, resourceId: string, format?: ContestFormat, releaseName?: string): Promise<TaskRecord> {
		await this.assertWritable();
		const resourceTitle =
			kind === "image-build"
				? undefined
				: kind === "contest-export"
					? (await this.contests.get(resourceId)).title
					: (await this.projects.get(resourceId)).title;
		const now = new Date().toISOString();
		const task: TaskRecord = {
			id: randomUUID(),
			kind,
			resource:
				kind === "image-build" ? "image" : `${kind === "contest-export" ? "contest" : "project"}:${resourceId}`,
			format,
			releaseName,
			resourceTitle,
			state: "queued",
			fingerprint: await this.fingerprint(kind, resourceId),
			createdAt: now,
			updatedAt: now,
		};
		try {
			await this.database.transaction(async () => {
				await this.assertWritable();
				await this.database.sql.execute(
					"INSERT INTO tasks (id,kind,resource,format,state,fingerprint,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
					[task.id, task.kind, task.resource, task.format ?? null, task.state, task.fingerprint, now, now],
				);
				await this.database.put("task-options", task.id, { releaseName, resourceTitle });
				await this.emit(task.id, "queued", "任务已排队。", { kind, resourceId });
			});
		} catch (error) {
			if ((error as { code?: string }).code === "23505")
				throw new ManualProjectError("该题目或竞赛已有排队或运行中的任务。", 409);
			throw error;
		}
		this.wake();
		return task;
	}

	async get(id: string, includeResult = true): Promise<TaskRecord> {
		const row = (await this.database.sql.one("SELECT * FROM tasks WHERE id=$1", [id])) as
			| Record<string, unknown>
			| undefined;
		if (!row) throw new ManualProjectError("任务不存在。", 404);
		const options = await this.database.get<{ releaseName?: string; resourceTitle?: string }>("task-options", id);
		const [kind, resourceId] = String(row.resource).split(":");
		const title =
			kind === "project" || kind === "contest"
				? (await this.database.get<{ title: string }>(kind, resourceId))?.title
				: undefined;
		return {
			id: String(row.id),
			resourceTitle: title ?? options?.resourceTitle,
			releaseName: options?.releaseName,
			kind: row.kind as TaskKind,
			resource: String(row.resource),
			format: row.format as ContestFormat | undefined,
			state: row.state as TaskState,
			fingerprint: String(row.fingerprint),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			result: includeResult && row.result ? JSON.parse(String(row.result)) : undefined,
			error: row.error ? String(row.error) : undefined,
			ownerPid: row.owner_pid ? Number(row.owner_pid) : undefined,
		};
	}

	async list(): Promise<TaskRecord[]> {
		const rows = (await this.database.sql.all("SELECT id FROM tasks ORDER BY created_at DESC", [])) as Array<{
			id: string;
		}>;
		return Promise.all(rows.map(async (row) => await this.get(row.id, false)));
	}

	async events(id: string, after = 0): Promise<TaskEvent[]> {
		await this.get(id);
		return (
			(await this.database.sql.all(
				"SELECT * FROM task_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 500",
				[id, after],
			)) as Array<Record<string, unknown>>
		).map((row) => ({
			sequence: Number(row.sequence),
			taskId: String(row.task_id),
			type: String(row.type),
			message: String(row.message),
			createdAt: String(row.created_at),
			data: row.data ? JSON.parse(String(row.data)) : undefined,
		}));
	}

	async emit(id: string, type: string, message: string, data?: unknown): Promise<void> {
		await this.database.sql.execute(
			"INSERT INTO task_events (task_id,type,message,created_at,data) VALUES ($1,$2,$3,$4,$5)",
			[id, type, message.slice(0, 4000), new Date().toISOString(), data === undefined ? null : JSON.stringify(data)],
		);
	}

	private async finish(id: string, state: TaskState, result?: unknown, error?: string): Promise<void> {
		await this.database.transaction(async () => {
			const updated = await this.database.sql.execute(
				"UPDATE tasks SET state=$1,result=$2,error=$3,updated_at=$4,owner_pid=NULL WHERE id=$5 AND state IN ('queued','running')",
				[state, result === undefined ? null : JSON.stringify(result), error ?? null, new Date().toISOString(), id],
			);
			if (updated.rowCount)
				await this.emit(id, state, error ?? (state === "succeeded" ? "任务完成。" : "任务已结束。"), result);
		});
	}

	private async cancellationRequested(id: string, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted) return true;
		const row = (await this.database.sql.one("SELECT cancel_requested FROM tasks WHERE id=$1", [id])) as
			| { cancel_requested: number }
			| undefined;
		return Boolean(row?.cancel_requested);
	}

	async cancel(id: string): Promise<TaskRecord> {
		const state = await this.database.transaction(async () => {
			const task = await this.get(id);
			if (task.state === "queued") await this.finish(id, "cancelled", undefined, "任务已取消。");
			else if (task.state === "running") {
				await this.database.sql.execute("UPDATE tasks SET cancel_requested=1 WHERE id=$1", [id]);
				await this.emit(id, "cancelling", "正在停止沙盒。 ");
			} else throw new ManualProjectError("任务已经结束。", 409);
			return task.state;
		});
		if (state === "queued") {
			this.waiting.get(id)?.abort();
			this.releaseSlot(id);
			this.wake();
		} else {
			this.controllers.get(id)?.abort();
			const cleaner = spawn("docker", ["rm", "-f", `setdraft-task-${id}`], { stdio: "ignore" });
			cleaner.on("error", () => {});
		}
		return await this.get(id);
	}

	async retry(id: string): Promise<TaskRecord> {
		await this.assertWritable();
		const task = await this.get(id);
		if (!["failed", "cancelled", "stale", "interrupted"].includes(task.state))
			throw new ManualProjectError("当前任务不可重试。", 409);
		return await this.submit(task.kind, task.resource.split(":").at(-1) ?? "", task.format, task.releaseName);
	}

	async isRunning(resource: string): Promise<boolean> {
		return Boolean(
			await this.database.sql.one("SELECT 1 FROM tasks WHERE resource=$1 AND state='running'", [resource]),
		);
	}

	private async pump(): Promise<void> {
		if (this.closed || (this.scheduling && !(await this.scheduling.enabled()))) return;
		const cancelling = (await this.database.sql.all(
			"SELECT id FROM tasks WHERE state='running' AND cancel_requested=1 AND owner_pid=$1",
			[process.pid],
		)) as Array<{ id: string }>;
		for (const item of cancelling) this.controllers.get(item.id)?.abort();
		const running = (await this.database.sql.one(
			"SELECT count(*)::integer AS count FROM tasks WHERE state='running'",
			[],
		)) as {
			count: number;
		};
		if (running.count >= 2) return;
		const queued = (await this.database.sql.one(
			"SELECT id FROM tasks WHERE state='queued' ORDER BY created_at LIMIT 1",
			[],
		)) as { id: string } | undefined;
		if (!queued) return;
		if (this.scheduling && !this.slots.has(queued.id)) {
			if (!this.waiting.has(queued.id)) {
				const controller = new AbortController();
				this.waiting.set(queued.id, controller);
				void this.scheduling.scheduler
					.acquire(
						this.scheduling.userId,
						queued.id,
						controller.signal,
						(await this.get(queued.id)).kind === "image-build",
					)
					.then(async (release) => {
						this.waiting.delete(queued.id);
						if (this.closed || controller.signal.aborted || !(await this.scheduling?.enabled())) {
							release();
							return;
						}
						this.slots.set(queued.id, release);
						this.wake();
					})
					.catch(() => {
						this.waiting.delete(queued.id);
					});
			}
			return;
		}
		const task = await this.get(queued.id);
		const resourceId = task.resource.split(":").at(-1) ?? "";
		const started = await this.database.transaction(async () => {
			const current = (await this.database.sql.one(
				"SELECT count(*)::integer AS count FROM tasks WHERE state='running'",
				[],
			)) as { count: number };
			if (current.count >= 2) return false;
			const result = await this.database.sql.execute(
				"UPDATE tasks SET state='running',owner_pid=$1,updated_at=$2 WHERE id=$3 AND state='queued'",
				[process.pid, new Date().toISOString(), task.id],
			);
			if (!result.rowCount) return false;
			await this.emit(task.id, "running", "任务开始执行。 ");
			return true;
		});
		if (!started) {
			this.releaseSlot(task.id);
			return;
		}
		if (task.fingerprint !== (await this.fingerprint(task.kind, resourceId))) {
			await this.finish(task.id, "stale", undefined, "排队期间内容发生变化，请重试。 ");
			this.releaseSlot(task.id);
			queueMicrotask(() => this.wake());
			return;
		}
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		if (await this.cancellationRequested(task.id, controller.signal)) {
			await this.finish(task.id, "cancelled", undefined, "任务已取消。 ");
			this.controllers.delete(task.id);
			this.releaseSlot(task.id);
			this.wake();
			return;
		}
		const events = new EventWriter(() => controller.abort());
		const context: ExecutionContext = {
			id: task.id,
			signal: controller.signal,
			emit: (type, message, data) => events.append(() => this.emit(task.id, type, message, data)),
		};
		const work = (async () => {
			try {
				let result: unknown;
				if (task.kind === "generate") result = await this.projects.pipeline.generate(resourceId, context);
				else if (task.kind === "finalize")
					result = await this.projects.pipeline.finalize(resourceId, context, task.releaseName);
				else if (task.kind === "contest-export")
					result = await this.contests.export(resourceId, task.format ?? "hydro", context, task.releaseName);
				else result = await this.buildImage(context);
				await events.flush();
				if (await this.cancellationRequested(task.id, controller.signal)) {
					await this.finish(task.id, "cancelled", undefined, "任务已取消。 ");
					return;
				}
				await this.finish(task.id, "succeeded", result);
			} catch (error) {
				await events.flush().catch(() => undefined);
				const cancelled = await this.cancellationRequested(task.id, controller.signal);
				await this.finish(
					task.id,
					controller.signal.aborted || cancelled ? "cancelled" : "failed",
					undefined,
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				this.controllers.delete(task.id);
				this.releaseSlot(task.id);
				this.wake();
			}
		})();
		this.running.add(work);
		void work.then(
			() => this.running.delete(work),
			() => this.running.delete(work),
		);
		if (running.count + 1 < 2) queueMicrotask(() => this.wake());
	}

	private buildImage(context: ExecutionContext): Promise<{ image: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				"docker",
				[
					"build",
					"-t",
					this.projects.image,
					...sandboxBuildArgs(process.env),
					fileURLToPath(new URL("../sandbox", import.meta.url)),
				],
				{
					signal: context.signal,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			for (const stream of [child.stdout, child.stderr])
				stream.on("data", (value: Buffer) => context.emit("log", value.toString("utf8")));
			child.once("error", reject);
			child.once("close", (code) =>
				code === 0 ? resolve({ image: this.projects.image }) : reject(new Error(`Docker 镜像构建失败：${code}`)),
			);
		});
	}
}
