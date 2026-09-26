import { createHash } from "node:crypto";
import type { ChatRequest, ChatRequestEvent } from "@hydro-problem-make/contracts";

import type { ChatImageUpload, ChatService } from "./chat.ts";
import { ChatError } from "./chat.ts";
import type { WorkspaceDatabase } from "./workspace-db.ts";

export type { ChatRequest, ChatRequestEvent } from "@hydro-problem-make/contracts";

interface StoredImage {
	name: string;
	mimeType: string;
	key: string;
}

interface StoredPayload {
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

	private schedule(chatId: string, id: string): void {
		const work = Promise.resolve().then(() => (this.closed ? undefined : this.run(chatId, id)));
		this.running.add(work);
		void work.then(
			() => this.running.delete(work),
			(error: unknown) => {
				this.running.delete(work);
				console.error("Chat request persistence failed:", error);
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
		await this.idle();
	}

	constructor(database: WorkspaceDatabase, chat: ChatService) {
		this.database = database;
		this.chat = chat;

		const active = database.db
			.prepare("SELECT id,chat_id,state,owner_pid FROM chat_requests WHERE state IN ('queued','running')")
			.all() as Array<{ id: string; chat_id: string; state: "queued" | "running"; owner_pid: number | null }>;
		for (const request of active) {
			let alive = false;
			if (request.owner_pid) {
				try {
					process.kill(request.owner_pid, 0);
					alive = true;
				} catch {
					alive = false;
				}
			}
			if (request.state === "queued" && (!alive || request.owner_pid === process.pid)) {
				const recovered = database.db
					.prepare(
						"UPDATE chat_requests SET owner_pid=?,cancel_requested=0,updated_at=? WHERE id=? AND state='queued'",
					)
					.run(process.pid, new Date().toISOString(), request.id);
				if (recovered.changes) this.schedule(request.chat_id, request.id);
			} else if (request.state === "running" && !alive) {
				this.database.transaction(() => {
					const interrupted = database.db
						.prepare(
							"UPDATE chat_requests SET state='failed',error='服务中断；请重试。',updated_at=? WHERE id=? AND state='running'",
						)
						.run(new Date().toISOString(), request.id);
					if (interrupted.changes) this.emit(request.id, "error", { message: "服务中断；请重试。" });
				});
			}
		}
	}

	private assertWritable(): void {
		if (this.closed) throw new ChatError("对话服务正在关闭。", 503);
		if (this.database.migrationError) throw new ChatError("旧数据迁移失败，当前只读。", 503);
	}

	get(id: string, chatId: string): ChatRequest {
		const row = this.database.db.prepare("SELECT * FROM chat_requests WHERE id=? AND chat_id=?").get(id, chatId) as
			| Record<string, unknown>
			| undefined;
		if (!row) throw new ChatError("请求不存在。", 404);
		return {
			id,
			chatId,
			state: row.state as ChatRequest["state"],
			createdAt: String(row.created_at),
			updatedAt: String(row.updated_at),
			error: row.error ? String(row.error) : undefined,
		};
	}

	list(chatId: string): ChatRequest[] {
		const rows = this.database.db
			.prepare("SELECT id FROM chat_requests WHERE chat_id=? ORDER BY created_at DESC LIMIT 20")
			.all(chatId) as Array<{ id: string }>;
		return rows.map((item) => this.get(item.id, chatId));
	}

	events(id: string, chatId: string, after: number): ChatRequestEvent[] {
		this.get(id, chatId);
		return (
			this.database.db
				.prepare(
					"SELECT sequence,type,data FROM chat_request_events WHERE request_id=? AND sequence>? ORDER BY sequence LIMIT 500",
				)
				.all(id, after) as Array<{ sequence: number; type: ChatRequestEvent["type"]; data: string }>
		).map((row) => ({ sequence: row.sequence, type: row.type, data: JSON.parse(row.data) as unknown }));
	}

	private emit(id: string, type: ChatRequestEvent["type"], data: unknown): void {
		this.database.db
			.prepare("INSERT INTO chat_request_events (request_id,type,data) VALUES (?,?,?)")
			.run(id, type, JSON.stringify(data));
	}

	async submit(
		chatId: string,
		id: string,
		message: string,
		contextSnapshot?: string,
		profileId?: string,
		images: ChatImageUpload[] = [],
	): Promise<ChatRequest> {
		this.assertWritable();
		if (!/^[a-f0-9-]{36}$/u.test(id)) throw new ChatError("请求 ID 无效。", 422);
		await this.chat.get(chatId);
		const fingerprint = createHash("sha256")
			.update(
				JSON.stringify({
					message,
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
		const existing = this.database.db.prepare("SELECT chat_id,fingerprint FROM chat_requests WHERE id=?").get(id) as
			| { chat_id: string; fingerprint: string }
			| undefined;
		if (existing) {
			if (existing.chat_id !== chatId || existing.fingerprint !== fingerprint)
				throw new ChatError("请求 ID 已用于其他消息。", 409);
			return this.get(id, chatId);
		}
		const stored: StoredPayload = {
			message,
			contextSnapshot,
			profileId,
			images: images.map((image, index) => ({ name: image.name, mimeType: image.mimeType, key: String(index) })),
		};
		const now = new Date().toISOString();
		try {
			await this.database.commitFiles(
				images.map((image, index) => ({
					ownerKind: "chat-request-image",
					ownerId: id,
					name: String(index),
					source: { bytes: Buffer.from(image.data, "base64") },
				})),
				() => {
					if (!this.database.get("chat", chatId)) throw new ChatError("对话不存在。", 404);
					this.database.db
						.prepare(
							"INSERT INTO chat_requests (id,chat_id,payload,fingerprint,state,created_at,updated_at,owner_pid) VALUES (?,?,?,?,?,?,?,?)",
						)
						.run(id, chatId, JSON.stringify(stored), fingerprint, "queued", now, now, process.pid);
				},
			);
		} catch (error) {
			if (String(error).includes("UNIQUE constraint")) {
				const concurrent = this.database.db
					.prepare("SELECT chat_id,fingerprint FROM chat_requests WHERE id=?")
					.get(id) as { chat_id: string; fingerprint: string } | undefined;
				if (concurrent) {
					if (concurrent.chat_id === chatId && concurrent.fingerprint === fingerprint) return this.get(id, chatId);
					throw new ChatError("请求 ID 已用于其他消息。", 409);
				}
				throw new ChatError("当前对话仍在回复，请等待完成。", 409);
			}
			throw error;
		}
		this.schedule(chatId, id);
		return this.get(id, chatId);
	}

	async retry(chatId: string, id: string): Promise<ChatRequest> {
		this.assertWritable();
		const request = this.get(id, chatId);
		if (request.state !== "failed") throw new ChatError("此请求不可重试。", 409);
		try {
			this.database.transaction(() => {
				const result = this.database.db
					.prepare(
						"UPDATE chat_requests SET state='queued',error=NULL,cancel_requested=0,updated_at=?,owner_pid=? WHERE id=? AND state='failed'",
					)
					.run(new Date().toISOString(), process.pid, id);
				if (!result.changes) throw new ChatError("此请求不可重试。", 409);
				this.database.db.prepare("DELETE FROM chat_request_events WHERE request_id=?").run(id);
			});
		} catch (error) {
			if (String(error).includes("UNIQUE constraint")) throw new ChatError("当前对话仍在回复，请等待完成。", 409);
			throw error;
		}
		this.schedule(chatId, id);
		return this.get(id, chatId);
	}

	async cancel(chatId: string, id: string): Promise<ChatRequest> {
		this.assertWritable();
		const request = this.get(id, chatId);
		if (request.state === "queued") {
			const cancelled = this.database.transaction(() => {
				const cancelled = this.database.db
					.prepare(
						"UPDATE chat_requests SET state='failed',error='已取消',updated_at=? WHERE id=? AND state='queued'",
					)
					.run(new Date().toISOString(), id);
				if (cancelled.changes) {
					this.emit(id, "error", { message: "已取消" });
					return true;
				}
				return false;
			});
			if (cancelled) return this.get(id, chatId);
		}
		const current = this.get(id, chatId);
		if (current.state === "running") {
			const requested = this.database.db
				.prepare("UPDATE chat_requests SET cancel_requested=1,updated_at=? WHERE id=? AND state='running'")
				.run(new Date().toISOString(), id);
			if (!requested.changes) throw new ChatError("请求已经结束。", 409);
			this.controllers.get(id)?.abort();
			return this.get(id, chatId);
		}
		throw new ChatError("请求已经结束。", 409);
	}

	private async run(chatId: string, id: string): Promise<void> {
		const row = this.database.db.prepare("SELECT payload,state FROM chat_requests WHERE id=?").get(id) as
			| { payload: string; state: string }
			| undefined;
		if (!row || row.state !== "queued") return;
		const started = this.database.db
			.prepare(
				"UPDATE chat_requests SET state='running',cancel_requested=0,owner_pid=?,updated_at=? WHERE id=? AND state='queued'",
			)
			.run(process.pid, new Date().toISOString(), id);
		if (!started.changes) return;
		const controller = new AbortController();
		this.controllers.set(id, controller);
		let timeout: NodeJS.Timeout | undefined;
		let timedOut = false;
		const arm = () => {
			if (timeout) clearTimeout(timeout);
			timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, 45_000);
			timeout.unref();
		};
		arm();
		try {
			const payload = JSON.parse(row.payload) as StoredPayload;
			const images = await Promise.all(
				payload.images.map(
					async (item): Promise<ChatImageUpload> => ({
						name: item.name,
						mimeType: item.mimeType,
						data: (await this.database.readBuffer("chat-request-image", id, item.key)).toString("base64"),
					}),
				),
			);
			const chat = await this.chat.send(
				chatId,
				payload.message,
				payload.contextSnapshot,
				{
					onStart: (started) => {
						arm();
						this.emit(id, "start", { chat: started });
					},
					onDelta: (delta) => {
						arm();
						this.emit(id, "delta", { delta });
					},
				},
				controller.signal,
				payload.profileId,
				images,
				id,
			);
			const completed = this.database.transaction(() => {
				const completed = this.database.db
					.prepare(
						"UPDATE chat_requests SET state='done',updated_at=? WHERE id=? AND state='running' AND cancel_requested=0",
					)
					.run(new Date().toISOString(), id);
				if (!completed.changes) {
					const current = this.database.db.prepare("SELECT state FROM chat_requests WHERE id=?").get(id) as
						| { state: string }
						| undefined;
					if (current?.state === "running") {
						const cancelled = this.database.db
							.prepare(
								"UPDATE chat_requests SET state='failed',error='已取消',updated_at=? WHERE id=? AND state='running'",
							)
							.run(new Date().toISOString(), id);
						if (cancelled.changes) this.emit(id, "error", { message: "已取消" });
					}
					return false;
				}
				this.emit(id, "done", { chat });
				this.database.removeOwnerFiles("chat-request-image", id);
				return true;
			});
			if (!completed) return;
			await this.database.pruneBlobs();
		} catch (error) {
			const cancelled = !timedOut && controller.signal.aborted;
			const message = cancelled
				? "已取消"
				: timedOut
					? "模型连续 45 秒未返回内容，已中止；可重试。"
					: error instanceof Error
						? error.message
						: "AI 请求失败。";
			this.database.transaction(() => {
				const failed = this.database.db
					.prepare("UPDATE chat_requests SET state='failed',error=?,updated_at=? WHERE id=? AND state='running'")
					.run(message, new Date().toISOString(), id);
				if (failed.changes) this.emit(id, "error", { message });
			});
		} finally {
			if (timeout) clearTimeout(timeout);
			this.controllers.delete(id);
		}
	}
}
