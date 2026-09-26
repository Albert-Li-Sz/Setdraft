import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ContestFormat, TaskEvent, TaskKind, TaskRecord, TaskState } from "@hydro-problem-make/contracts";
import type { ContestStore } from "./contests.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { ManualProjectError, type ManualProjectStore } from "./manual-projects.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

export type { TaskEvent, TaskKind, TaskRecord, TaskState } from "@hydro-problem-make/contracts";

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

	constructor(projects: ManualProjectStore, contests: ContestStore) {
		this.projects = projects;
		this.contests = contests;
		this.database = projects.database;

		for (const task of this.list().filter((item) => item.state === "running")) {
			let alive = false;
			try {
				if (task.ownerPid) {
					process.kill(task.ownerPid, 0);
					alive = true;
				}
			} catch {
				alive = false;
			}
			if (!alive) {
				this.finish(task.id, "interrupted", undefined, "服务进程中断；可以重试此任务。");
				const child = spawn("docker", ["rm", "-f", `hydro-task-${task.id}`], { stdio: "ignore" });
				child.on("error", () => {});
			}
		}
		this.timer = setInterval(() => this.pump(), 500);
		this.timer.unref();
		queueMicrotask(() => this.pump());
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
	}

	private fingerprint(kind: TaskKind, resource: string): string {
		if (kind === "image-build") return digest({ image: this.projects.image });
		if (kind === "contest-export") return digest(this.database.get("contest", resource));
		return digest({
			project: this.database.get("project", resource),
			files: [...this.database.fileEntries("manual", resource), ...this.database.fileEntries("generated", resource)],
		});
	}

	private assertWritable(): void {
		if (this.database.migrationError) throw new ManualProjectError("旧数据迁移失败，当前只读。", 503);
	}

	async submit(kind: TaskKind, resourceId: string, format?: ContestFormat): Promise<TaskRecord> {
		this.assertWritable();
		if (kind === "contest-export") await this.contests.get(resourceId);
		else if (kind !== "image-build") await this.projects.get(resourceId);
		const now = new Date().toISOString();
		const task: TaskRecord = {
			id: randomUUID(),
			kind,
			resource:
				kind === "image-build" ? "image" : `${kind === "contest-export" ? "contest" : "project"}:${resourceId}`,
			format,
			state: "queued",
			fingerprint: this.fingerprint(kind, resourceId),
			createdAt: now,
			updatedAt: now,
		};
		try {
			this.database.transaction(() => {
				this.database.db
					.prepare(
						"INSERT INTO tasks (id,kind,resource,format,state,fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
					)
					.run(task.id, task.kind, task.resource, task.format ?? null, task.state, task.fingerprint, now, now);
				this.emit(task.id, "queued", "任务已排队。", { kind, resourceId });
			});
		} catch (error) {
			if (String(error).includes("UNIQUE constraint"))
				throw new ManualProjectError("该题目或竞赛已有排队或运行中的任务。", 409);
			throw error;
		}
		this.pump();
		return task;
	}

	get(id: string): TaskRecord {
		const row = this.database.db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as
			| Record<string, unknown>
			| undefined;
		if (!row) throw new ManualProjectError("任务不存在。", 404);
		return {
			id: String(row.id),
			kind: row.kind as TaskKind,
			resource: String(row.resource),
			format: row.format as ContestFormat | undefined,
			state: row.state as TaskState,
			fingerprint: String(row.fingerprint),
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			result: row.result ? JSON.parse(String(row.result)) : undefined,
			error: row.error ? String(row.error) : undefined,
			ownerPid: row.owner_pid ? Number(row.owner_pid) : undefined,
		};
	}

	list(): TaskRecord[] {
		const rows = this.database.db.prepare("SELECT id FROM tasks ORDER BY created_at DESC LIMIT 100").all() as Array<{
			id: string;
		}>;
		return rows.map((row) => this.get(row.id));
	}

	events(id: string, after = 0): TaskEvent[] {
		this.get(id);
		return (
			this.database.db
				.prepare("SELECT * FROM task_events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 500")
				.all(id, after) as Array<Record<string, unknown>>
		).map((row) => ({
			sequence: Number(row.sequence),
			taskId: String(row.task_id),
			type: String(row.type),
			message: String(row.message),
			createdAt: String(row.created_at),
			data: row.data ? JSON.parse(String(row.data)) : undefined,
		}));
	}

	emit(id: string, type: string, message: string, data?: unknown): void {
		this.database.db
			.prepare("INSERT INTO task_events (task_id,type,message,created_at,data) VALUES (?,?,?,?,?)")
			.run(
				id,
				type,
				message.slice(0, 4000),
				new Date().toISOString(),
				data === undefined ? null : JSON.stringify(data),
			);
	}

	private finish(id: string, state: TaskState, result?: unknown, error?: string): void {
		this.database.transaction(() => {
			const updated = this.database.db
				.prepare(
					"UPDATE tasks SET state=?,result=?,error=?,updated_at=?,owner_pid=NULL WHERE id=? AND state IN ('queued','running')",
				)
				.run(
					state,
					result === undefined ? null : JSON.stringify(result),
					error ?? null,
					new Date().toISOString(),
					id,
				);
			if (updated.changes)
				this.emit(id, state, error ?? (state === "succeeded" ? "任务完成。" : "任务已结束。"), result);
		});
	}

	private cancellationRequested(id: string, signal?: AbortSignal): boolean {
		if (signal?.aborted) return true;
		const row = this.database.db.prepare("SELECT cancel_requested FROM tasks WHERE id=?").get(id) as
			| { cancel_requested: number }
			| undefined;
		return Boolean(row?.cancel_requested);
	}

	async cancel(id: string): Promise<TaskRecord> {
		this.assertWritable();
		const state = this.database.transaction(() => {
			const task = this.get(id);
			if (task.state === "queued") this.finish(id, "cancelled", undefined, "任务已取消。");
			else if (task.state === "running") {
				this.database.db.prepare("UPDATE tasks SET cancel_requested=1 WHERE id=?").run(id);
				this.emit(id, "cancelling", "正在停止沙盒。 ");
			} else throw new ManualProjectError("任务已经结束。", 409);
			return task.state;
		});
		if (state === "queued") this.pump();
		else {
			this.controllers.get(id)?.abort();
			const cleaner = spawn("docker", ["rm", "-f", `hydro-task-${id}`], { stdio: "ignore" });
			cleaner.on("error", () => {});
		}
		return this.get(id);
	}

	async retry(id: string): Promise<TaskRecord> {
		this.assertWritable();
		const task = this.get(id);
		if (!["failed", "cancelled", "stale", "interrupted"].includes(task.state))
			throw new ManualProjectError("当前任务不可重试。", 409);
		return this.submit(task.kind, task.resource.split(":").at(-1) ?? "", task.format);
	}

	isRunning(resource: string): boolean {
		return Boolean(
			this.database.db.prepare("SELECT 1 FROM tasks WHERE resource=? AND state='running'").get(resource),
		);
	}

	private pump(): void {
		if (this.closed) return;
		const cancelling = this.database.db
			.prepare("SELECT id FROM tasks WHERE state='running' AND cancel_requested=1 AND owner_pid=?")
			.all(process.pid) as Array<{ id: string }>;
		for (const item of cancelling) this.controllers.get(item.id)?.abort();
		const running = this.database.db.prepare("SELECT count(*) AS count FROM tasks WHERE state='running'").get() as {
			count: number;
		};
		if (running.count >= 2) return;
		const queued = this.database.db
			.prepare("SELECT id FROM tasks WHERE state='queued' ORDER BY created_at LIMIT 1")
			.get() as { id: string } | undefined;
		if (!queued) return;
		const task = this.get(queued.id);
		const resourceId = task.resource.split(":").at(-1) ?? "";
		const started = this.database.transaction(() => {
			const current = this.database.db
				.prepare("SELECT count(*) AS count FROM tasks WHERE state='running'")
				.get() as { count: number };
			if (current.count >= 2) return false;
			const result = this.database.db
				.prepare("UPDATE tasks SET state='running',owner_pid=?,updated_at=? WHERE id=? AND state='queued'")
				.run(process.pid, new Date().toISOString(), task.id);
			if (!result.changes) return false;
			this.emit(task.id, "running", "任务开始执行。 ");
			return true;
		});
		if (!started) return;
		if (task.fingerprint !== this.fingerprint(task.kind, resourceId)) {
			this.finish(task.id, "stale", undefined, "排队期间草稿发生变化，请重试。 ");
			queueMicrotask(() => this.pump());
			return;
		}
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		if (this.cancellationRequested(task.id, controller.signal)) {
			this.finish(task.id, "cancelled", undefined, "任务已取消。 ");
			this.controllers.delete(task.id);
			this.pump();
			return;
		}
		const context: ExecutionContext = {
			id: task.id,
			signal: controller.signal,
			emit: (type, message, data) => this.emit(task.id, type, message, data),
		};
		void (async () => {
			try {
				let result: unknown;
				if (task.kind === "generate") result = await this.projects.pipeline.generate(resourceId, context);
				else if (task.kind === "finalize") result = await this.projects.pipeline.finalize(resourceId, context);
				else if (task.kind === "contest-export")
					result = await this.contests.export(resourceId, task.format ?? "hydro", context);
				else result = await this.buildImage(context);
				if (this.cancellationRequested(task.id, controller.signal)) {
					this.finish(task.id, "cancelled", undefined, "任务已取消。 ");
					return;
				}
				this.finish(task.id, "succeeded", result);
			} catch (error) {
				const cancelled = this.cancellationRequested(task.id, controller.signal);
				this.finish(
					task.id,
					controller.signal.aborted || cancelled ? "cancelled" : "failed",
					undefined,
					error instanceof Error ? error.message : String(error),
				);
			} finally {
				this.controllers.delete(task.id);
				this.pump();
			}
		})();
		if (running.count + 1 < 2) queueMicrotask(() => this.pump());
	}

	private buildImage(context: ExecutionContext): Promise<{ image: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn(
				"docker",
				["build", "-t", this.projects.image, fileURLToPath(new URL("../sandbox", import.meta.url))],
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
