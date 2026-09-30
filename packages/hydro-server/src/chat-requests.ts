import { createHash } from "node:crypto";
import type { ChatRequest, ChatRequestEvent } from "@setdraft/contracts";
import type { ChatImageUpload, ChatService } from "./chat.ts";
import { ChatError } from "./chat.ts";
import { type ChatPolicy, chatPolicy } from "./chat-policy.ts";
import { EventWriter } from "./event-writer.ts";
import { ExecutionScheduler } from "./execution-scheduler.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

export type { ChatRequest, ChatRequestEvent } from "@setdraft/contracts";

interface StoredImage {
	name: string;
	mimeType: string;
	key: string;
}

interface StoredPayload {
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
	private closed = false;
	private readonly scheduling: { scheduler: ExecutionScheduler; userId: string; enabled(): Promise<boolean> };
	private readonly policy: ChatPolicy;
	private readonly admissions = new Map<string, () => void>();
	private readonly locks = new Map<string, Promise<void>>();
	private pruning?: Promise<void>;

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
				if (this.closed || controller.signal.aborted || !(await this.scheduling.enabled())) return;
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
				if (!this.closed && !controller.signal.aborted && (await this.scheduling.enabled()))
					await this.run(chatId, id, controller);
			} catch (error) {
				if (expired)
					await this.database.transaction(async () => {
						const result = await this.database.sql.execute(
							"UPDATE chat_requests SET state='failed',error=$1,updated_at=$2 WHERE id=$3 AND state='queued'",
							["排队超过时间上限，请稍后重试。", new Date().toISOString(), id],
						);
						if (result.rowCount) await this.emit(id, "error", { message: "排队超过时间上限，请稍后重试。" });
					});
				if (!controller.signal.aborted) throw error;
			} finally {
				clearTimeout(queueTimer);
				release?.();
				this.releaseAdmission(id);
				this.controllers.delete(id);
				await this.pruneHistory();
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
		while (this.running.size) await Promise.all([...this.running]);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const controller of this.controllers.values()) controller.abort();
		await this.ready;
		await this.idle();
	}

	constructor(
		database: WorkspaceDatabase,
		chat: ChatService,
		scheduling?: { scheduler: ExecutionScheduler; userId: string; enabled(): Promise<boolean>; policy?: ChatPolicy },
	) {
		this.policy = scheduling?.policy ?? chatPolicy();
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
				});
		}
		await this.pruneHistory();
	}

	/** Keep replay/retry payloads bounded; conversations themselves remain user-owned durable data. */
	private async pruneHistory(): Promise<void> {
		if (this.pruning) return this.pruning;
		this.pruning = (async () => {
			const removed = await this.database.transaction(async () => {
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
				return rows.length;
			});
			if (removed) await this.database.pruneBlobs();
		})();
		try {
			await this.pruning;
		} finally {
			this.pruning = undefined;
		}
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
	): Promise<ChatRequest> {
		await this.ready;
		return this.withRequestLock(id, async () => {
			await this.assertWritable();
			if (!/^[a-f0-9-]{36}$/u.test(id)) throw new ChatError("请求 ID 无效。", 422);
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

	async retry(chatId: string, id: string): Promise<ChatRequest> {
		await this.ready;
		return this.withRequestLock(id, async () => {
			await this.assertWritable();
			const request = await this.get(id, chatId);
			if (request.state !== "failed") throw new ChatError("此请求不可重试。", 409);
			if (this.controllers.has(id)) throw new ChatError("请求正在结束，请稍后重试。", 409);
			const row = await this.database.sql.one<{ payload: string; fingerprint: string }>(
				"SELECT payload,fingerprint FROM chat_requests WHERE id=$1",
				[id],
			);
			if (!row) throw new ChatError("请求不存在。", 404);
			if (!row.fingerprint) throw new ChatError("消息已在提交前取消，请重新发送。", 409);
			const payload = JSON.parse(row.payload) as StoredPayload;
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
					const result = await this.database.sql.execute(
						"UPDATE chat_requests SET state='queued',error=NULL,cancel_requested=0,updated_at=$1,owner_pid=$2 WHERE id=$3 AND state='failed'",
						[new Date().toISOString(), process.pid, id],
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

	async cancel(chatId: string, id: string): Promise<ChatRequest> {
		await this.ready;
		return this.withRequestLock(id, async () => {
			await this.assertWritable(true);
			if (!/^[a-f0-9-]{36}$/u.test(id)) throw new ChatError("请求 ID 无效。", 422);
			await this.chat.get(chatId);
			await this.database.transaction(async () => {
				const row = await this.database.sql.one<{ chat_id: string }>(
					"SELECT chat_id FROM chat_requests WHERE id=$1",
					[id],
				);
				if (row) {
					if (row.chat_id !== chatId) throw new ChatError("请求不存在。", 404);
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
					this.controllers.get(id)?.abort();
					this.releaseAdmission(id);
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

	private async run(chatId: string, id: string, controller: AbortController): Promise<void> {
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
			const completed = await this.database.transaction(async () => {
				const completed = await this.database.sql.execute(
					"UPDATE chat_requests SET state='done',updated_at=$1 WHERE id=$2 AND state='running' AND cancel_requested=0",
					[new Date().toISOString(), id],
				);
				if (!completed.rowCount) {
					const current = (await this.database.sql.one("SELECT state FROM chat_requests WHERE id=$1", [id])) as
						| { state: string }
						| undefined;
					if (current?.state === "running") {
						const cancelled = await this.database.sql.execute(
							"UPDATE chat_requests SET state='failed',error='已取消',updated_at=$1 WHERE id=$2 AND state='running'",
							[new Date().toISOString(), id],
						);
						if (cancelled.rowCount) await this.emit(id, "error", { message: "已取消" });
					}
					return false;
				}
				await this.emit(id, "done", { chat });
				await this.database.removeOwnerFiles("chat-request-image", id);
				return true;
			});
			if (!completed) return;
			await this.database.pruneBlobs();
		} catch (error) {
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
			await this.database.transaction(async () => {
				const failed = await this.database.sql.execute(
					"UPDATE chat_requests SET state='failed',error=$1,updated_at=$2 WHERE id=$3 AND state='running'",
					[message, new Date().toISOString(), id],
				);
				if (failed.rowCount) await this.emit(id, "error", { message });
			});
		} finally {
			clearTimeout(deadline);
			if (timeout) clearTimeout(timeout);
		}
	}
}
