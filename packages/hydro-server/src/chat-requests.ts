import { createHash, randomUUID } from "node:crypto";
import type { ChatConversation, ChatRequest, ChatRequestEvent } from "@setdraft/contracts";
import type { ChatImageUpload, ChatService } from "./chat.ts";
import { ChatCompletionPending, ChatError } from "./chat.ts";
import { type ChatPolicy, chatPolicy } from "./chat-policy.ts";
import { EventWriter } from "./event-writer.ts";
import { ExecutionScheduler } from "./execution-scheduler.ts";
import { NOOP_OBSERVABILITY, type Observability, secondsSince, type TraceCarrier } from "./observability.ts";
import { TerminalSettlements } from "./terminal-settlements.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

export type { ChatRequest, ChatRequestEvent } from "@setdraft/contracts";

interface StoredImage {
	name: string;
	mimeType: string;
	key: string;
}

interface StoredPayload {
	telemetry?: TraceCarrier;
	attempt?: number;
	attemptId?: string;
	webSearch?: boolean;
	searchQuery?: string;
	message: string;
	contextSnapshot?: string;
	profileId?: string;
	images: StoredImage[];
}

export class ChatRequestQueue {
	private readonly database: WorkspaceDatabase;
	private readonly chat: ChatService;
	private readonly controllers = new Map<string, AbortController>();
	private readonly running = new Set<Promise<void>>();
	private readonly settlements = new TerminalSettlements();
	private closed = false;
	private readonly scheduling: { scheduler: ExecutionScheduler; userId: string; enabled(): Promise<boolean> };
	private readonly policy: ChatPolicy;
	private readonly admissions = new Map<string, () => void>();
	private readonly locks = new Map<string, Promise<void>>();
	private pruning?: Promise<void>;
	private readonly observability: Observability;

	private async withRequestLock<T>(id: string, run: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(id);
		let unlock = () => {};
		const gate = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		this.locks.set(id, gate);
		await previous;
		try {
			return await run();
		} finally {
			unlock();
			if (this.locks.get(id) === gate) this.locks.delete(id);
		}
	}

	private reserve(id: string, recovered = false): void {
		this.admissions.set(id, this.scheduling.scheduler.reserve(this.scheduling.userId, id, false, recovered));
	}
	private releaseAdmission(id: string): void {
		this.admissions.get(id)?.();
		this.admissions.delete(id);
	}

	private schedule(chatId: string, id: string): void {
		if (this.closed) {
			this.releaseAdmission(id);
			return;
		}
		const controller = new AbortController();
		this.controllers.set(id, controller);
		const work = Promise.resolve().then(async () => {
			let release: (() => void) | undefined;
			let queueTimer: NodeJS.Timeout | undefined;
			let expired = false;
			try {
				if (this.closed || controller.signal.aborted) return;
				if (!(await this.scheduling.enabled())) throw new ChatError("对话服务不可用。", 403);
				const row = await this.get(id, chatId);
				const remaining = Date.parse(row.updatedAt) + this.policy.queueTimeoutMs - Date.now();
				const expire = () => {
					expired = true;
					controller.abort();
				};
				if (remaining <= 0) expire();
				else {
					queueTimer = setTimeout(expire, remaining);
					queueTimer.unref();
				}
				release = await this.scheduling.scheduler.acquire(this.scheduling.userId, id, controller.signal);
				clearTimeout(queueTimer);
				if (!this.closed && !controller.signal.aborted) {
					if (!(await this.scheduling.enabled())) throw new ChatError("对话服务不可用。", 403);
					await this.run(chatId, id, controller);
				}
			} catch (error) {
				// Shutdown deliberately leaves unstarted work durable for recovery on the next process.
				if (this.closed && !expired) return;
				if (!this.settlements.has(id)) {
					const message = expired
						? "排队超过时间上限，请稍后重试。"
						: this.closed
							? "服务中断；请重试。"
							: controller.signal.aborted
								? "已取消"
								: error instanceof Error
									? error.message
									: "AI 请求失败。";
					await this.settlements.settle(id, async () => {
						const changed = await this.database.transaction(async () => {
							const result = await this.database.sql.execute(
								"UPDATE chat_requests SET state='failed',error=$1,updated_at=$2,owner_pid=NULL WHERE id=$3 AND state IN ('queued','running')",
								[message, new Date().toISOString(), id],
							);
							if (result.rowCount) await this.emit(id, "error", { message });
							return Boolean(result.rowCount);
						});
						this.releaseAdmission(id);
						if (changed && expired) await this.recordTerminal(id, "timeout").catch(() => undefined);
					});
				}
			} finally {
				clearTimeout(queueTimer);
				release?.();
				if (!this.settlements.has(id)) this.releaseAdmission(id);
				this.controllers.delete(id);
				await this.pruneHistory().catch(() => undefined);
			}
		});
		this.running.add(work);
		void work.then(
			() => this.running.delete(work),
			(error: unknown) => {
				this.running.delete(work);
				console.error("Chat request persistence failed:", error instanceof Error ? error.name : "unknown");
			},
		);
	}

	/** Wait for storage cleanup as well as terminal request state before closing the database. */
	async idle(): Promise<void> {
		while (this.running.size) await Promise.allSettled([...this.running]);
		await this.settlements.flush();
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const controller of this.controllers.values()) controller.abort();
		await this.ready;
		await this.idle();
		this.settlements.stop();
	}

	constructor(
		database: WorkspaceDatabase,
		chat: ChatService,
		scheduling?: {
			scheduler: ExecutionScheduler;
			userId: string;
			enabled(): Promise<boolean>;
			policy?: ChatPolicy;
			observability?: Observability;
		},
	) {
		this.policy = scheduling?.policy ?? chatPolicy();
		this.observability = scheduling?.observability ?? NOOP_OBSERVABILITY;
		this.scheduling = scheduling ?? {
			scheduler: new ExecutionScheduler(this.policy.concurrency, this.policy),
			userId: "local",
			enabled: async () => true,
		};
		this.database = database;
		this.chat = chat;

		this.ready = this.recover();
	}
	readonly ready: Promise<void>;
	private async recover(): Promise<void> {
		const active = await this.database.sql.all<{ id: string; chat_id: string; state: string }>(
			"SELECT id,chat_id,state FROM chat_requests WHERE state IN ('queued','running') ORDER BY updated_at,id",
		);
		for (const request of active) {
			if (request.state === "queued") {
				this.reserve(request.id, true);
				this.schedule(request.chat_id, request.id);
			} else
				await this.database.transaction(async () => {
					await this.database.sql.execute(
						"UPDATE chat_requests SET state='failed',error='服务中断；请重试。',updated_at=$1 WHERE id=$2",
						[new Date().toISOString(), request.id],
					);
					await this.emit(request.id, "error", { message: "服务中断；请重试。" });
					await this.recordTerminal(request.id, "interrupted", true);
				});
		}
		await this.pruneHistory();
	}

	/** Keep replay/retry payloads bounded; conversations themselves remain user-owned durable data. */
	private async pruneHistory(): Promise<void> {
		if (this.pruning) return this.pruning;
		this.pruning = (async () => {
			const removed = await this.database.transaction(() => this.pruneRecords());
			if (removed) await this.database.pruneBlobs();
		})();
		try {
			await this.pruning;
		} finally {
			this.pruning = undefined;
		}
	}

	/** Called inside the workspace commit lock, including admission of cancellation tombstones. */
	private async pruneRecords(): Promise<number> {
		const rows = await this.database.sql.all<{ id: string }>(
			"SELECT id FROM chat_requests WHERE state IN ('done','failed') AND (updated_at<$1 OR (fingerprint<>'' AND id IN (SELECT id FROM chat_requests WHERE state IN ('done','failed') AND fingerprint<>'' ORDER BY updated_at DESC,id DESC OFFSET $2))) FOR UPDATE",
			[new Date(Date.now() - this.policy.retentionMs).toISOString(), this.policy.maxRetainedRequests],
		);
		for (const row of rows) {
			await this.database.removeOwnerFiles("chat-request-image", row.id);
			await this.database.delete("search-cache", `request:${row.id}`);
			await this.database.sql.execute("DELETE FROM chat_request_events WHERE request_id=$1", [row.id]);
			await this.database.sql.execute("DELETE FROM chat_requests WHERE id=$1", [row.id]);
		}
		await this.database.sql.execute(
			"DELETE FROM documents WHERE kind='chat-cancellation' AND ((body->>'createdAt')<$1 OR NOT EXISTS (SELECT 1 FROM chat_requests WHERE id=documents.body->>'requestId'))",
			[new Date(Date.now() - this.policy.retentionMs).toISOString()],
		);
		return rows.length;
	}

	async cancelAll(): Promise<void> {
		const rows = (await this.database.sql.all(
			"SELECT id,chat_id FROM chat_requests WHERE state IN ('queued','running')",
			[],
		)) as Array<{ id: string; chat_id: string }>;
		for (const row of rows) await this.cancel(row.chat_id, row.id).catch(() => undefined);
	}

	private async assertWritable(cancelling = false): Promise<void> {
		if (!cancelling && !(await this.scheduling.enabled())) throw new ChatError("对话服务不可用。", 403);
		if (this.closed) throw new ChatError("对话服务正在关闭。", 503);
	}

	async get(id: string, chatId: string): Promise<ChatRequest> {
		const row = (await this.database.sql.one("SELECT * FROM chat_requests WHERE id=$1 AND chat_id=$2", [
			id,
			chatId,
		])) as Record<string, unknown> | undefined;
		if (!row) throw new ChatError("请求不存在。", 404);
		return this.snapshot(row);
	}

	private snapshot(row: Record<string, unknown>): ChatRequest {
		return {
			id: String(row.id),
			attemptId: (JSON.parse(String(row.payload)) as { attemptId?: string }).attemptId ?? String(row.id),
			chatId: String(row.chat_id),
			state: row.state as ChatRequest["state"],
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			error: row.error ? String(row.error) : undefined,
		};
	}

	async list(chatId: string): Promise<ChatRequest[]> {
		const rows = await this.database.sql.all<Record<string, unknown>>(
			"SELECT * FROM chat_requests WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 20",
			[chatId],
		);
		return rows.map((row) => this.snapshot(row));
	}

	async events(id: string, chatId: string, after: number): Promise<ChatRequestEvent[]> {
		await this.get(id, chatId);
		return (
			(await this.database.sql.all(
				"SELECT sequence,type,data FROM chat_request_events WHERE request_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 500",
				[id, after],
			)) as Array<{ sequence: number; type: ChatRequestEvent["type"]; data: string }>
		).map((row) => ({ sequence: row.sequence, type: row.type, data: JSON.parse(row.data) as unknown }));
	}

	private async emit(id: string, type: ChatRequestEvent["type"], data: unknown): Promise<void> {
		await this.database.sql.execute("INSERT INTO chat_request_events (request_id,type,data) VALUES ($1,$2,$3)", [
			id,
			type,
			JSON.stringify(data),
		]);
	}

	async submit(
		chatId: string,
		id: string,
		message: string,
		contextSnapshot?: string,
		profileId?: string,
		images: ChatImageUpload[] = [],
		webSearch = false,
		searchQuery?: string,
		attemptId = id,
	): Promise<ChatRequest> {
		await this.ready;
		return this.withRequestLock(id, async () => {
			await this.assertWritable();
			if (!/^[a-f0-9-]{36}$/u.test(id)) throw new ChatError("请求 ID 无效。", 422);
			if (!/^[a-f0-9-]{36}$/u.test(attemptId)) throw new ChatError("执行轮次 ID 无效。", 422);
			const conversation = await this.chat.get(chatId);
			const fingerprint = createHash("sha256")
				.update(
					JSON.stringify({
						message,
						webSearch,
						searchQuery,
						contextSnapshot,
						profileId,
						images: images.map((item) => [
							item.name,
							item.mimeType,
							createHash("sha256").update(item.data).digest("hex"),
						]),
					}),
				)
				.digest("hex");
			const existing = (await this.database.sql.one("SELECT chat_id,fingerprint FROM chat_requests WHERE id=$1", [
				id,
			])) as { chat_id: string; fingerprint: string } | undefined;
			if (existing) {
				if (existing.chat_id === chatId && existing.fingerprint === "") return await this.get(id, chatId);
				if (existing.chat_id !== chatId || existing.fingerprint !== fingerprint)
					throw new ChatError("请求 ID 已用于其他消息。", 409);
				return await this.get(id, chatId);
			}
			const { decodedImages } = this.chat.validateInput(
				conversation,
				message,
				contextSnapshot,
				profileId,
				images,
				searchQuery,
			);
			const stored: StoredPayload = {
				attemptId,
				attempt: 1,
				telemetry: this.observability.capture(),
				webSearch,
				searchQuery,
				message,
				contextSnapshot,
				profileId,
				images: images.map((image, index) => ({ name: image.name, mimeType: image.mimeType, key: String(index) })),
			};
			const now = new Date().toISOString();
			this.reserve(id);
			try {
				await this.database.commitFiles(
					decodedImages.map((image, index) => ({
						ownerKind: "chat-request-image",
						ownerId: id,
						name: String(index),
						source: { bytes: image.bytes },
					})),
					async () => {
						await this.assertWritable();
						if (!(await this.database.get("chat", chatId))) throw new ChatError("对话不存在。", 404);
						await this.database.sql.execute(
							"INSERT INTO chat_requests (id,chat_id,payload,fingerprint,state,created_at,updated_at,owner_pid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
							[id, chatId, JSON.stringify(stored), fingerprint, "queued", now, now, process.pid],
						);
					},
				);
			} catch (error) {
				this.releaseAdmission(id);
				if ((error as { code?: string }).code === "23505") {
					const concurrent = (await this.database.sql.one(
						"SELECT chat_id,fingerprint FROM chat_requests WHERE id=$1",
						[id],
					)) as { chat_id: string; fingerprint: string } | undefined;
					if (concurrent) {
						if (concurrent.chat_id === chatId && concurrent.fingerprint === fingerprint)
							return await this.get(id, chatId);
						throw new ChatError("请求 ID 已用于其他消息。", 409);
					}
					throw new ChatError("当前对话仍在回复，请等待完成。", 409);
				}
				throw error;
			}
			this.schedule(chatId, id);
			return await this.get(id, chatId);
		});
	}

	async retry(chatId: string, id: string, attemptId: string = randomUUID()): Promise<ChatRequest> {
		await this.ready;
		return this.withRequestLock(id, async () => {
			await this.assertWritable();
			const request = await this.get(id, chatId);
			if (!/^[a-f0-9-]{36}$/u.test(attemptId)) throw new ChatError("执行轮次 ID 无效。", 422);
			if (await this.database.get("chat-cancellation", `${id}:${attemptId}`))
				return { ...request, attemptId, state: "failed", error: "已取消" };
			if (request.attemptId === attemptId) return request;
			if (request.state !== "failed") throw new ChatError("此请求不可重试。", 409);
			if (this.controllers.has(id)) throw new ChatError("请求正在结束，请稍后重试。", 409);
			const row = await this.database.sql.one<{ payload: string; fingerprint: string }>(
				"SELECT payload,fingerprint FROM chat_requests WHERE id=$1",
				[id],
			);
			if (!row) throw new ChatError("请求不存在。", 404);
			if (!row.fingerprint) throw new ChatError("消息已在提交前取消，请重新发送。", 409);
			const payload = JSON.parse(row.payload) as StoredPayload;
			payload.attemptId = attemptId;
			payload.attempt = (payload.attempt ?? 1) + 1;
			payload.telemetry = this.observability.capture();
			this.chat.validateInput(
				await this.chat.get(chatId),
				payload.message,
				payload.contextSnapshot,
				payload.profileId,
				await this.loadImages(payload, id),
				payload.searchQuery,
			);
			this.reserve(id);
			try {
				await this.database.transaction(async () => {
					const conversation = await this.chat.get(chatId);
					const index = conversation.messages.findIndex((item) => item.role === "user" && item.requestId === id);
					if (
						(index >= 0 && index !== conversation.messages.length - 1) ||
						(index < 0 && conversation.messages.some((item) => item.createdAt > request.createdAt))
					)
						throw new ChatError("此失败请求已有后续对话，请发送新消息。", 409);
					const result = await this.database.sql.execute(
						"UPDATE chat_requests SET state='queued',error=NULL,cancel_requested=0,updated_at=$1,owner_pid=$2,payload=$4 WHERE id=$3 AND state='failed'",
						[new Date().toISOString(), process.pid, id, JSON.stringify(payload)],
					);
					if (!result.rowCount) throw new ChatError("此请求不可重试。", 409);
					await this.database.sql.execute("DELETE FROM chat_request_events WHERE request_id=$1", [id]);
				});
			} catch (error) {
				this.releaseAdmission(id);
				if ((error as { code?: string }).code === "23505")
					throw new ChatError("当前对话仍在回复，请等待完成。", 409);
				throw error;
			}
			this.schedule(chatId, id);
			return await this.get(id, chatId);
		});
	}

	async cancel(chatId: string, id: string, attemptId?: string): Promise<ChatRequest> {
		await this.ready;
		return this.withRequestLock(id, async () => {
			await this.assertWritable(true);
			if (!/^[a-f0-9-]{36}$/u.test(id)) throw new ChatError("请求 ID 无效。", 422);
			await this.chat.get(chatId);
			if (attemptId !== undefined && !/^[a-f0-9-]{36}$/u.test(attemptId))
				throw new ChatError("执行轮次 ID 无效。", 422);
			await this.database.transaction(async () => {
				await this.pruneRecords();
				const row = await this.database.sql.one<{ chat_id: string; payload: string }>(
					"SELECT chat_id,payload FROM chat_requests WHERE id=$1",
					[id],
				);
				if (row) {
					if (row.chat_id !== chatId) throw new ChatError("请求不存在。", 404);
					const payload = JSON.parse(row.payload) as StoredPayload;
					if (!attemptId && (payload.attempt ?? 1) > 1)
						throw new ChatError("取消重试请求必须提供本次执行轮次。", 409);
					const currentAttempt = payload.attemptId ?? id;
					if (
						attemptId &&
						attemptId !== currentAttempt &&
						!(await this.database.get("chat-cancellation", `${id}:${attemptId}`))
					) {
						const retained = await this.database.sql.one<{ count: number }>(
							"SELECT count(*)::integer AS count FROM documents WHERE kind='chat-cancellation'",
						);
						if ((retained?.count ?? 0) >= this.policy.maxRetainedRequests)
							throw new ChatError("取消轮次记录已达上限，请稍后重试。", 429);
						await this.database.put("chat-cancellation", `${id}:${attemptId}`, {
							requestId: id,
							chatId,
							attemptId,
							createdAt: new Date().toISOString(),
						});
						await this.database.sql.execute("UPDATE chat_requests SET updated_at=$1 WHERE id=$2", [
							new Date().toISOString(),
							id,
						]);
					}
					return;
				}
				const retained = await this.database.sql.one<{ count: number }>(
					"SELECT count(*)::integer AS count FROM chat_requests WHERE fingerprint=''",
					[],
				);
				if ((retained?.count ?? 0) >= this.policy.maxRetainedRequests)
					throw new ChatError("提交前取消记录已达上限，请稍后重试。", 429);
				const now = new Date().toISOString();
				await this.database.sql.execute(
					"INSERT INTO chat_requests (id,chat_id,payload,fingerprint,state,error,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7)",
					[id, chatId, "{}", "", "failed", "已取消", now],
				);
				await this.emit(id, "error", { message: "已取消" });
			});
			const request = await this.get(id, chatId);
			if (attemptId && attemptId !== request.attemptId)
				return { ...request, attemptId, state: "failed", error: "已取消" };
			if (request.state === "queued") {
				const cancelled = await this.database.transaction(async () => {
					const cancelled = await this.database.sql.execute(
						"UPDATE chat_requests SET state='failed',error='已取消',updated_at=$1 WHERE id=$2 AND state='queued'",
						[new Date().toISOString(), id],
					);
					if (cancelled.rowCount) {
						await this.emit(id, "error", { message: "已取消" });
						return true;
					}
					return false;
				});
				if (cancelled) {
					try {
						await this.recordTerminal(id, "cancelled").catch(() => undefined);
					} finally {
						this.controllers.get(id)?.abort();
						this.releaseAdmission(id);
					}
					return await this.get(id, chatId);
				}
			}
			const current = await this.get(id, chatId);
			if (current.state === "running") {
				const requested = await this.database.sql.execute(
					"UPDATE chat_requests SET cancel_requested=1,updated_at=$1 WHERE id=$2 AND state='running'",
					[new Date().toISOString(), id],
				);
				if (!requested.rowCount) return await this.get(id, chatId);
				this.controllers.get(id)?.abort();
				return await this.get(id, chatId);
			}
			return current;
		});
	}

	private async loadImages(payload: StoredPayload, id: string): Promise<ChatImageUpload[]> {
		return Promise.all(
			payload.images.map(async (item) => ({
				name: item.name,
				mimeType: item.mimeType,
				data: (await this.database.readBuffer("chat-request-image", id, item.key)).toString("base64"),
			})),
		);
	}

	private async recordTerminal(
		id: string,
		result: "timeout" | "cancelled" | "interrupted",
		recovered = false,
	): Promise<void> {
		const row = await this.database.sql.one<{ payload: string; created_at: string }>(
			"SELECT payload,created_at FROM chat_requests WHERE id=$1",
			[id],
		);
		if (!row) return;
		const payload = JSON.parse(row.payload) as StoredPayload;
		const labels = { "task.kind": "chat", "task.state": "failed", "operation.result": result };
		await this.observability.withPropagation(payload.telemetry, () =>
			this.observability.startSpan(
				{
					name: recovered ? "chat.recover" : "chat.queue.end",
					attributes: { ...labels, "chat.request.id": id, "task.recovered": recovered },
				},
				(span) => {
					span.setStatus({ status: "error" });
					this.observability.metric("setdraft.task.results", 1, labels);
					if (!recovered)
						this.observability.metric(
							"setdraft.queue.wait",
							Math.max(0, (Date.now() - Date.parse(row.created_at)) / 1000),
							{ "queue.kind": "ai" },
						);
					this.observability.log("chat.terminal", { ...labels, "chat.request.id": id });
				},
			),
		);
	}

	private async run(chatId: string, id: string, controller: AbortController): Promise<void> {
		const row = await this.database.sql.one<{ payload: string; updated_at: string }>(
			"SELECT payload,updated_at FROM chat_requests WHERE id=$1 AND state='queued'",
			[id],
		);
		if (!row) return;
		const payload = JSON.parse(row.payload) as StoredPayload;
		await this.observability.withPropagation(payload.telemetry, () =>
			this.observability.startSpan(
				{
					name: "chat.execute",
					attributes: { "chat.request.id": id, "task.kind": "chat", "task.attempt": payload.attempt ?? 1 },
				},
				async (span) => {
					const start = performance.now();
					const wait = Math.max(0, (Date.now() - Date.parse(row.updated_at)) / 1000);
					span.setAttributes({ "task.queue_wait": wait });
					this.observability.metric("setdraft.queue.wait", wait, { "queue.kind": "ai" });
					try {
						await this.runAttempt(chatId, id, controller);
					} finally {
						const current = await this.get(id, chatId).catch(() => ({ state: "running", error: undefined }));
						const result =
							current.state === "done"
								? "succeeded"
								: this.closed
									? "interrupted"
									: current.error === "已取消"
										? "cancelled"
										: current.error?.includes("时间上限") || current.error?.includes("45 秒")
											? "timeout"
											: "failed";
						const labels = {
							"task.kind": "chat",
							"task.state": this.settlements.has(id) ? "settlement-pending" : current.state,
							"operation.result": result,
						};
						span.setAttributes(labels);
						if (current.state !== "done") span.setStatus({ status: "error" });
						this.observability.metric("setdraft.task.duration", secondsSince(start), labels);
						this.observability.metric("setdraft.task.results", 1, labels);
						this.observability.log("chat.complete", { ...labels, "chat.request.id": id });
					}
				},
			),
		);
	}

	private async runAttempt(chatId: string, id: string, controller: AbortController): Promise<void> {
		const row = (await this.database.sql.one("SELECT payload,state FROM chat_requests WHERE id=$1", [id])) as
			| { payload: string; state: string }
			| undefined;
		if (!row || row.state !== "queued") return;
		const started = await this.database.sql.execute(
			"UPDATE chat_requests SET state='running',cancel_requested=0,owner_pid=$1,updated_at=$2 WHERE id=$3 AND state='queued'",
			[process.pid, new Date().toISOString(), id],
		);
		if (!started.rowCount) return;
		let timeout: NodeJS.Timeout | undefined;
		let timedOut = false;
		let runTimedOut = false;
		const deadline = setTimeout(() => {
			runTimedOut = true;
			controller.abort();
		}, this.policy.runTimeoutMs);
		deadline.unref();
		const arm = () => {
			if (timeout) clearTimeout(timeout);
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, 45_000);
			timeout.unref();
		};
		arm();
		const events = new EventWriter(() => controller.abort());
		try {
			const payload = JSON.parse(row.payload) as StoredPayload;
			const images = await this.loadImages(payload, id);
			const chat = await this.chat.send(
				chatId,
				payload.message,
				payload.contextSnapshot,
				{
					onStart: (started) => {
						arm();
						events.append(() => this.emit(id, "start", { chat: started }));
					},
					onDelta: (delta) => {
						arm();
						events.append(() => this.emit(id, "delta", { delta }));
					},
					onSearch: (phase, query, message) => {
						arm();
						events.append(() => this.emit(id, "search", { phase, query, message }));
					},
				},
				controller.signal,
				payload.profileId,
				images,
				id,
				payload.webSearch,
				payload.searchQuery,
			);
			await events.flush();
			await this.complete(id, async () => chat);
		} catch (error) {
			if (error instanceof ChatCompletionPending) {
				await events.flush().catch(() => undefined);
				await this.complete(id, error.commit);
				return;
			}
			await events.flush().catch(() => undefined);
			const cancelled = !timedOut && !runTimedOut && controller.signal.aborted;
			const message = runTimedOut
				? "模型运行超过时间上限，已中止；可重试。"
				: cancelled
					? "已取消"
					: timedOut
						? "模型连续 45 秒未返回内容，已中止；可重试。"
						: error instanceof Error
							? error.message
							: "AI 请求失败。";
			await this.settlements.settle(id, async () => {
				await this.database.transaction(async () => {
					const failed = await this.database.sql.execute(
						"UPDATE chat_requests SET state='failed',error=$1,updated_at=$2 WHERE id=$3 AND state='running'",
						[message, new Date().toISOString(), id],
					);
					if (failed.rowCount) await this.emit(id, "error", { message });
				});
				this.releaseAdmission(id);
			});
		} finally {
			clearTimeout(deadline);
			if (timeout) clearTimeout(timeout);
		}
	}
	private async complete(id: string, load: () => Promise<ChatConversation>): Promise<void> {
		await this.settlements.settle(id, async () => {
			await this.database.transaction(async () => {
				const completed = await this.database.sql.execute(
					"UPDATE chat_requests SET state='done',updated_at=$1 WHERE id=$2 AND state='running' AND cancel_requested=0",
					[new Date().toISOString(), id],
				);
				if (completed.rowCount) {
					await this.emit(id, "done", { chat: await load() });
					await this.database.removeOwnerFiles("chat-request-image", id);
				} else {
					const cancelled = await this.database.sql.execute(
						"UPDATE chat_requests SET state='failed',error='已取消',updated_at=$1 WHERE id=$2 AND state='running'",
						[new Date().toISOString(), id],
					);
					if (cancelled.rowCount) await this.emit(id, "error", { message: "已取消" });
				}
			});
			this.releaseAdmission(id);
			void this.database.pruneBlobs().catch(() => undefined);
		});
	}
}
