import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ContestFormat, TaskEvent, TaskKind, TaskRecord, TaskState } from "@setdraft/contracts";
import { sandboxBuildArgs } from "../sandbox/build-args.mjs";
import type { ContestStore } from "./contests.ts";
import { EventWriter } from "./event-writer.ts";
import type { ExecutionContext } from "./execution-context.ts";
import { type ExecutionScheduler, QueueAdmissionError } from "./execution-scheduler.ts";
import { ManualProjectError, type ManualProjectStore } from "./manual-projects.ts";
import { removeTaskContainer } from "./manual-sandbox.ts";
import { type SandboxPolicy, sandboxPolicy } from "./sandbox-policy.ts";
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
	private readonly admissions = new Map<string, () => void>();
	private readonly running = new Set<Promise<void>>();
	readonly policy: SandboxPolicy;

	constructor(
		projects: ManualProjectStore,
		contests: ContestStore,
		scheduling?: {
			scheduler: ExecutionScheduler;
			userId: string;
			enabled(): Promise<boolean>;
			policy?: SandboxPolicy;
		},
	) {
		this.scheduling = scheduling;
		this.policy = scheduling?.policy ?? sandboxPolicy({});
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
	private repump = false;
	private wake(): void {
		void this.ready
			.then(async () => {
				if (this.closed) return;
				if (this.pumping) {
					this.repump = true;
					return;
				}
				this.pumping = true;
				try {
					do {
						this.repump = false;
						await this.pump();
					} while (this.repump && !this.closed);
				} finally {
					this.pumping = false;
				}
			})
			.catch(() => console.error("Task queue unavailable."));
	}
	private async recover(): Promise<void> {
		for (const task of await this.list()) {
			if (task.state === "queued") this.reserve(task, true);
			if (task.state === "running") {
				await removeTaskContainer(task.id);
				await this.finish(task.id, "interrupted", undefined, "服务进程中断；可以重试此任务。");
			}
		}
	}

	close(): void {
		this.closed = true;
		clearInterval(this.timer);
		for (const controller of this.waiting.values()) controller.abort();
		for (const controller of this.controllers.values()) controller.abort();
		for (const id of this.slots.keys()) if (!this.controllers.has(id)) this.releaseSlot(id);
		for (const id of this.admissions.keys()) if (!this.controllers.has(id)) this.releaseAdmission(id);
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
	private reserve(task: TaskRecord, recovered = false): void {
		if (!this.scheduling) return;
		try {
			this.admissions.set(
				task.id,
				this.scheduling.scheduler.reserve(this.scheduling.userId, task.id, task.kind === "image-build", recovered),
			);
		} catch (error) {
			if (error instanceof QueueAdmissionError) throw new ManualProjectError(error.message, error.statusCode);
			throw error;
		}
	}
	private releaseAdmission(id: string): void {
		this.admissions.get(id)?.();
		this.admissions.delete(id);
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
		await this.ready;
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
		this.reserve(task);
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
			this.releaseAdmission(task.id);
			if ((error as { code?: string }).code === "23505")
				throw new ManualProjectError("该题目或竞赛已有排队或运行中的任务。", 409);
			throw error;
		}
		this.wake();
		return await this.get(task.id);
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
		let queue: TaskRecord["queue"];
		if (row.state === "queued") {
			const ahead = await this.database.sql.one<{ count: number }>(
				"SELECT count(*)::integer AS count FROM tasks WHERE state='queued' AND (created_at<$1 OR (created_at=$1 AND id<$2))",
				[row.created_at, id],
			);
			const status = this.scheduling?.scheduler.status(this.scheduling.userId);
			const position = (ahead?.count ?? 0) + 1;
			queue = {
				position,
				running: status?.running ?? this.controllers.size,
				concurrency: this.policy.concurrency,
				reason: this.slots.has(id)
					? "dispatch"
					: position > this.policy.concurrencyPerUser || status?.userAtCapacity
						? "user"
						: status?.maintenance
							? "maintenance"
							: "capacity",
				expiresAt: new Date(Date.parse(String(row.created_at)) + this.policy.queueTimeoutMs).toISOString(),
			};
		}
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
			queue,
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

	private async finish(
		id: string,
		state: TaskState,
		result?: unknown,
		error?: string,
		onlyQueued = false,
	): Promise<boolean> {
		return await this.database.transaction(async () => {
			const updated = await this.database.sql.execute(
				"UPDATE tasks SET state=$1,result=$2,error=$3,updated_at=$4,owner_pid=NULL WHERE id=$5 AND state IN ('queued','running') AND (NOT $6::boolean OR state='queued')",
				[
					state,
					result === undefined ? null : JSON.stringify(result),
					error ?? null,
					new Date().toISOString(),
					id,
					onlyQueued,
				],
			);
			if (updated.rowCount)
				await this.emit(id, state, error ?? (state === "succeeded" ? "任务完成。" : "任务已结束。"), result);
			return Boolean(updated.rowCount);
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
			this.controllers.get(id)?.abort();
			this.releaseSlot(id);
			this.releaseAdmission(id);
			this.wake();
		} else {
			this.controllers.get(id)?.abort();
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
		const expired = (await this.database.sql.all("SELECT id FROM tasks WHERE state='queued' AND created_at<=$1", [
			new Date(Date.now() - this.policy.queueTimeoutMs).toISOString(),
		])) as Array<{ id: string }>;
		for (const task of expired) {
			if (!(await this.finish(task.id, "failed", undefined, "排队超过时间上限，请稍后重试。", true))) continue;
			this.waiting.get(task.id)?.abort();
			this.releaseSlot(task.id);
			this.releaseAdmission(task.id);
		}
		const cancelling = (await this.database.sql.all(
			"SELECT id FROM tasks WHERE state='running' AND cancel_requested=1 AND owner_pid=$1",
			[process.pid],
		)) as Array<{ id: string }>;
		for (const item of cancelling) this.controllers.get(item.id)?.abort();
		const localLimit = this.scheduling
			? Math.min(this.policy.concurrency, this.policy.concurrencyPerUser)
			: this.policy.concurrency;
		if (this.controllers.size >= localLimit) return;
		const queued = await this.database.sql.all<{ id: string }>(
			"SELECT id FROM tasks WHERE state='queued' ORDER BY created_at,id LIMIT $1",
			[localLimit],
		);
		for (const task of queued) await this.dispatch(task, localLimit);
	}

	private async dispatch(queued: { id: string }, localLimit: number): Promise<void> {
		if (this.controllers.has(queued.id) || this.controllers.size >= localLimit) return;
		if (this.scheduling && !this.slots.has(queued.id)) {
			if (!this.waiting.has(queued.id)) {
				const dispatched = new Set([...this.controllers.keys(), ...this.waiting.keys(), ...this.slots.keys()]);
				if (dispatched.size >= localLimit) return;
				const pending = await this.get(queued.id);
				if (this.closed || pending.state !== "queued") return;
				const controller = new AbortController();
				this.waiting.set(queued.id, controller);
				void this.scheduling.scheduler
					.acquire(this.scheduling.userId, queued.id, controller.signal, pending.kind === "image-build")
					.then(async (release) => {
						try {
							const enabled = await this.scheduling?.enabled();
							if (!enabled || this.closed || controller.signal.aborted) return;
							this.slots.set(queued.id, release);
							this.wake();
						} finally {
							if (!this.slots.has(queued.id)) release();
						}
					})
					.catch(() => {})
					.finally(() => this.waiting.delete(queued.id));
			}
			return;
		}
		const task = await this.get(queued.id);
		if (this.closed) {
			this.releaseSlot(task.id);
			return;
		}
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		const work = this.execute(task, controller);
		this.running.add(work);
		void work
			.catch(() => console.error("Task completion could not be persisted."))
			.finally(() => this.running.delete(work));
	}

	private async execute(task: TaskRecord, controller: AbortController): Promise<void> {
		const resourceId = task.resource.split(":").at(-1) ?? "";
		let timeout: NodeJS.Timeout | undefined;
		let timedOut = false;
		let settled = false;
		const events = new EventWriter(() => controller.abort());
		const end = async (state: TaskState, result?: unknown, error?: string) => {
			await this.finish(task.id, state, result, error);
			settled = true;
		};
		try {
			const started = await this.database.transaction(async () => {
				if (this.closed || controller.signal.aborted) return false;
				const result = await this.database.sql.execute(
					"UPDATE tasks SET state='running',owner_pid=$1,updated_at=$2 WHERE id=$3 AND state='queued'",
					[process.pid, new Date().toISOString(), task.id],
				);
				if (!result.rowCount) return false;
				await this.emit(task.id, "running", "任务开始执行。");
				return true;
			});
			if (!started) return;
			timeout = setTimeout(
				() => {
					timedOut = true;
					controller.abort(new Error("任务运行超过时间上限，请检查程序后重试。"));
				},
				task.kind === "image-build" ? this.policy.buildTimeoutMs : this.policy.runTimeoutMs,
			);
			timeout.unref();
			const currentFingerprint = await this.fingerprint(task.kind, resourceId);
			if (await this.cancellationRequested(task.id, controller.signal)) {
				controller.abort();
				controller.signal.throwIfAborted();
			}
			if (task.fingerprint !== currentFingerprint) {
				await end("stale", undefined, "排队期间内容发生变化，请重试。");
				return;
			}
			const context: ExecutionContext = {
				id: task.id,
				signal: controller.signal,
				emit: (type, message, data) => events.append(() => this.emit(task.id, type, message, data)),
			};
			let result: unknown;
			if (task.kind === "generate") result = await this.projects.pipeline.generate(resourceId, context);
			else if (task.kind === "finalize")
				result = await this.projects.pipeline.finalize(resourceId, context, task.releaseName);
			else if (task.kind === "contest-export")
				result = await this.contests.export(resourceId, task.format ?? "hydro", context, task.releaseName);
			else result = await this.buildImage(context);
			await events.flush();
			if (timedOut) await end("failed", undefined, "任务运行超过时间上限，请检查程序后重试。");
			else if (this.closed) await end("interrupted", undefined, "服务进程中断；可以重试此任务。");
			else if (await this.cancellationRequested(task.id, controller.signal))
				await end("cancelled", undefined, "任务已取消。");
			else await end("succeeded", result);
		} catch (error) {
			await events.flush().catch(() => undefined);
			const cancelled = await this.cancellationRequested(task.id, controller.signal);
			await end(
				timedOut ? "failed" : this.closed ? "interrupted" : cancelled ? "cancelled" : "failed",
				undefined,
				timedOut
					? "任务运行超过时间上限，请检查程序后重试。"
					: this.closed
						? "服务进程中断；可以重试此任务。"
						: cancelled
							? "任务已取消。"
							: error instanceof Error
								? error.message
								: String(error),
			);
		} finally {
			if (timeout) clearTimeout(timeout);
			this.controllers.delete(task.id);
			this.releaseSlot(task.id);
			if (settled || this.closed) this.releaseAdmission(task.id);
			this.wake();
		}
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
			let failure: Error | undefined;
			let killTimer: NodeJS.Timeout | undefined;
			child.once("error", (error) => {
				failure = error;
				if (context.signal.aborted) killTimer = setTimeout(() => child.kill("SIGKILL"), 2000);
			});
			child.once("close", (code) => {
				if (killTimer) clearTimeout(killTimer);
				if (failure) reject(failure);
				else if (code === 0) resolve({ image: this.projects.image });
				else reject(new Error(`Docker 镜像构建失败：${code}`));
			});
		});
	}
}
