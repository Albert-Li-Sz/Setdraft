import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { shouldSendChatMessage } from "./chat-shortcut.ts";
import { readChatStream } from "./chat-stream.ts";
import {
	type AiConfiguration,
	apiUrl,
	type ChatConversation,
	type ChatImageUpload,
	readAiConfiguration,
	responseError,
} from "./platform.ts";

interface ChatSummary {
	id: string;
	title: string;
	updatedAt: string;
}

interface Props {
	apiOrigin: string;
	configured: boolean;
	projectSnapshot?: string;
}

interface PendingImage extends ChatImageUpload {
	localId: string;
	bytes: number;
}

const acceptedImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const maxImageBytes = 5 * 1024 * 1024;
const maxMessageImageBytes = 12 * 1024 * 1024;

async function readImage(file: File): Promise<PendingImage> {
	if (!acceptedImageTypes.includes(file.type)) throw new Error("图片只支持 PNG、JPEG、WebP 或 GIF。");
	if (file.size === 0 || file.size > maxImageBytes) throw new Error("单张图片须大于 0 且不能超过 5 MiB。");
	const name = file.name || "粘贴图片.png";
	if (name.length > 120) throw new Error("图片文件名不能超过 120 个字符。");
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			if (typeof reader.result !== "string") return reject(new Error("无法读取图片。"));
			const separator = reader.result.indexOf(",");
			if (separator < 0) return reject(new Error("无法读取图片。"));
			resolve(reader.result.slice(separator + 1));
		};
		reader.onerror = () => reject(new Error("无法读取图片。"));
		reader.readAsDataURL(file);
	});
	return { localId: crypto.randomUUID(), name, mimeType: file.type, data, bytes: file.size };
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
	const response = await fetch(url, init);
	const body = (await response.json()) as unknown;
	if (!response.ok) throw new Error(responseError(body));
	return body as T;
}

function profileForChat(configuration: AiConfiguration, chat?: ChatConversation): string {
	if (chat?.profileId && configuration.profiles.some((item) => item.id === chat.profileId)) return chat.profileId;
	return configuration.defaultProfileId ?? configuration.profiles[0]?.id ?? "";
}

function newestChats(chats: ChatSummary[]): ChatSummary[] {
	return [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function AiChatPage(props: Props) {
	const [chats, setChats] = useState<ChatSummary[]>([]);
	const [chat, setChat] = useState<ChatConversation>();
	const [configuration, setConfiguration] = useState<AiConfiguration>();
	const [selectedProfileId, setSelectedProfileId] = useState("");
	const [input, setInput] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [readingImages, setReadingImages] = useState(false);
	const [copiedMessageId, setCopiedMessageId] = useState<string>();
	const [attachProject, setAttachProject] = useState(false);
	const [streaming, setStreaming] = useState("");
	const [streamFailed, setStreamFailed] = useState(false);
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [historyCollapsed, setHistoryCollapsed] = useState(false);
	const [message, setMessage] = useState("正在读取本地对话…");
	const [messageTone, setMessageTone] = useState<"pending" | "passed" | "failed">("pending");
	const controllerRef = useRef<AbortController | undefined>(undefined);
	const messagesRef = useRef<HTMLDivElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const followOutputRef = useRef(true);
	const composingRef = useRef(false);
	const sendingRef = useRef(false);
	const readingImagesRef = useRef(false);

	const showMessage = useCallback((value: string, tone: "pending" | "passed" | "failed" = "pending"): void => {
		setMessage(value);
		setMessageTone(tone);
	}, []);

	useEffect(() => {
		const element = messagesRef.current;
		if (element && followOutputRef.current) element.scrollTop = element.scrollHeight;
	});

	useEffect(() => {
		const element = messagesRef.current;
		if (!element) return;
		const observer = new ResizeObserver(() => {
			if (followOutputRef.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const controller = new AbortController();
		setLoading(true);
		void (async () => {
			try {
				const [list, configValue] = await Promise.all([
					jsonRequest<{ chats: ChatSummary[] }>(apiUrl(props.apiOrigin, "/chats"), {
						signal: controller.signal,
					}),
					jsonRequest<unknown>(apiUrl(props.apiOrigin, "/ai/config"), { signal: controller.signal }),
				]);
				if (controller.signal.aborted) return;
				const config = readAiConfiguration(configValue);
				if (!config) throw new Error("AI 配置列表格式无效。");
				setConfiguration(config);
				const orderedChats = newestChats(list.chats);
				setChats(orderedChats);
				if (orderedChats[0]) {
					followOutputRef.current = true;
					const selected = await jsonRequest<ChatConversation>(
						apiUrl(props.apiOrigin, `/chats/${orderedChats[0].id}`),
						{ signal: controller.signal },
					);
					if (!controller.signal.aborted) {
						setChat(selected);
						setSelectedProfileId(profileForChat(config, selected));
					}
				} else setSelectedProfileId(profileForChat(config));
				showMessage(list.chats.length ? "对话记录保存在本地。" : "新建对话后即可开始。");
			} catch (error) {
				if (!controller.signal.aborted)
					showMessage(error instanceof Error ? error.message : "对话读取失败。", "failed");
			} finally {
				if (!controller.signal.aborted) setLoading(false);
			}
		})();
		return () => {
			controller.abort();
			controllerRef.current?.abort();
		};
	}, [props.apiOrigin, showMessage]);

	async function refreshList(): Promise<void> {
		const list = await jsonRequest<{ chats: ChatSummary[] }>(apiUrl(props.apiOrigin, "/chats"));
		setChats(newestChats(list.chats));
	}

	async function create(preserveProfileSelection = false): Promise<ChatConversation> {
		const created = await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, "/chats"), { method: "POST" });
		setChat(created);
		if (configuration && !preserveProfileSelection) setSelectedProfileId(profileForChat(configuration, created));
		setStreaming("");
		setStreamFailed(false);
		followOutputRef.current = true;
		await refreshList();
		showMessage("已创建新对话。", "passed");
		return created;
	}

	async function open(id: string): Promise<void> {
		if (busy) return;
		try {
			const selected = await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, `/chats/${id}`));
			setChat(selected);
			if (configuration) setSelectedProfileId(profileForChat(configuration, selected));
			setStreaming("");
			setStreamFailed(false);
			followOutputRef.current = true;
		} catch (error) {
			showMessage(error instanceof Error ? error.message : "对话读取失败。", "failed");
		}
	}

	async function remove(id: string): Promise<void> {
		if (!window.confirm("删除这条 AI 对话及其全部消息？此操作无法撤销。")) return;
		try {
			const response = await fetch(apiUrl(props.apiOrigin, `/chats/${id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			const remaining = chats.filter((item) => item.id !== id);
			setChats(remaining);
			if (chat?.id === id) {
				const selected = remaining[0]
					? await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, `/chats/${remaining[0].id}`))
					: undefined;
				setChat(selected);
				if (configuration) setSelectedProfileId(profileForChat(configuration, selected));
			}
			showMessage("对话已删除。", "passed");
		} catch (error) {
			showMessage(error instanceof Error ? error.message : "删除失败。", "failed");
		}
	}

	async function addImages(files: File[]): Promise<void> {
		if (!files.length || readingImagesRef.current || busy) return;
		if (images.length + files.length > 4) {
			showMessage("每条消息最多添加 4 张图片。", "failed");
			return;
		}
		readingImagesRef.current = true;
		setReadingImages(true);
		try {
			const added = await Promise.all(files.map(readImage));
			if ([...images, ...added].reduce((total, item) => total + item.bytes, 0) > maxMessageImageBytes) {
				throw new Error("每条消息的图片合计不能超过 12 MiB。");
			}
			setImages((current) => [...current, ...added]);
			showMessage(`已添加 ${added.length} 张图片；发送时将交给当前模型分析。`, "passed");
		} catch (error) {
			showMessage(error instanceof Error ? error.message : "图片读取失败。", "failed");
		} finally {
			readingImagesRef.current = false;
			setReadingImages(false);
		}
	}

	async function copyMessage(id: string, content: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(content);
			setCopiedMessageId(id);
			showMessage("消息文字已复制。", "passed");
		} catch {
			showMessage("复制失败，请检查浏览器剪贴板权限。", "failed");
		}
	}

	async function send(): Promise<void> {
		const content = input.trim();
		if ((!content && images.length === 0) || busy || readingImages || sendingRef.current) return;
		if (!selectedProfileId) {
			showMessage("请先在设置中添加 API / 模型配置。", "failed");
			return;
		}
		let activeChat = chat;
		let previousMessageCount = chat?.messages.length ?? 0;
		let partialText = "";
		sendingRef.current = true;
		setBusy(true);
		setStreaming("");
		setStreamFailed(false);
		followOutputRef.current = true;
		showMessage("模型正在回复…");
		const controller = new AbortController();
		controllerRef.current = controller;
		try {
			const current = chat ?? (await create(true));
			activeChat = current;
			previousMessageCount = current.messages.length;
			const response = await fetch(apiUrl(props.apiOrigin, `/chats/${current.id}/messages`), {
				method: "POST",
				signal: controller.signal,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					message: content,
					images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })),
					profileId: selectedProfileId,
					contextSnapshot: attachProject ? props.projectSnapshot : undefined,
				}),
			});
			if (!response.ok) throw new Error(responseError(await response.json()));
			if (!response.body) throw new Error("服务端未返回流式响应。");
			let completed = false;
			await readChatStream(response.body, (event) => {
				if (event.type === "start") {
					setInput("");
					setImages([]);
					activeChat = event.chat;
					setChat(event.chat);
					setSelectedProfileId(event.chat.profileId ?? selectedProfileId);
					setChats((current) => [
						{ id: event.chat.id, title: event.chat.title, updatedAt: event.chat.updatedAt },
						...current.filter((item) => item.id !== event.chat.id),
					]);
					showMessage("模型正在回复…");
				} else if (event.type === "delta") {
					partialText += event.delta;
					setStreaming((value) => value + event.delta);
				} else if (event.type === "done") {
					setChat(event.chat);
					setSelectedProfileId(event.chat.profileId ?? selectedProfileId);
					setStreaming("");
					completed = true;
				} else {
					throw new Error(event.message);
				}
			});
			if (!completed) throw new Error("模型连接提前中断。");
			await refreshList();
			showMessage("回复已保存到本地对话。", "passed");
		} catch (error) {
			showMessage(
				controller.signal.aborted ? "已停止生成。" : error instanceof Error ? error.message : "模型请求失败。",
				controller.signal.aborted ? "pending" : "failed",
			);
			setStreamFailed(partialText.length > 0);
			if (!partialText) setStreaming("");
			if (activeChat) {
				const fallback = activeChat;
				const restored = await jsonRequest<ChatConversation>(
					apiUrl(props.apiOrigin, `/chats/${fallback.id}`),
				).catch(() => fallback);
				setChat(restored);
				if (restored.messages.length <= previousMessageCount) {
					setInput(content);
				}
			}
		} finally {
			sendingRef.current = false;
			setBusy(false);
			controllerRef.current = undefined;
		}
	}

	return (
		<main className="page manual-chat-page" id="chat">
			<div className="breadcrumb">工作区 / AI 对话</div>
			<section className="page-heading">
				<div>
					<div className="eyebrow">独立助手</div>
					<h1>AI 对话</h1>
					<p>讨论题意、数据与程序；回复不会自动修改草稿。</p>
				</div>
				<button
					className="button secondary"
					type="button"
					onClick={() =>
						void create().catch((error: unknown) =>
							showMessage(error instanceof Error ? error.message : "新建对话失败。", "failed"),
						)
					}
					disabled={busy}
				>
					新建对话
				</button>
			</section>
			<output className={`notice ${props.configured ? messageTone : "failed"}`} aria-live="polite">
				<span className="notice-dot" />
				{props.configured ? message : "请先在设置中配置 AI API。"}
			</output>
			<div className={`manual-chat-layout${historyCollapsed ? " history-collapsed" : ""}`}>
				<aside className="card manual-chat-list" aria-label="对话记录">
					<div className="manual-chat-list-heading">
						{!historyCollapsed && <span>对话记录</span>}
						<button
							type="button"
							className="manual-chat-list-toggle"
							aria-label={historyCollapsed ? "展开对话记录" : "折叠对话记录"}
							aria-controls="manual-chat-history"
							aria-expanded={!historyCollapsed}
							title={historyCollapsed ? "展开对话记录" : "折叠对话记录"}
							onClick={() => setHistoryCollapsed((current) => !current)}
						>
							{historyCollapsed ? "›" : "‹"}
						</button>
					</div>
					<div className="manual-chat-list-items" id="manual-chat-history" hidden={historyCollapsed}>
						{chats.length === 0 && (
							<p className="manual-chat-list-empty">
								{loading ? "正在读取对话…" : "暂无对话。点击“新建对话”开始。"}
							</p>
						)}
						{chats.map((item) => (
							<div className={`manual-chat-list-item ${chat?.id === item.id ? "active" : ""}`} key={item.id}>
								<button type="button" onClick={() => void open(item.id)}>
									{item.title}
								</button>
								<button
									className="text-button danger"
									type="button"
									aria-label={`删除 ${item.title}`}
									onClick={() => void remove(item.id)}
								>
									删除
								</button>
							</div>
						))}
					</div>
				</aside>
				<section className="card manual-chat-main">
					<div
						className="manual-chat-messages"
						ref={messagesRef}
						onScroll={(event) => {
							const element = event.currentTarget;
							followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
						}}
					>
						{chat?.messages.length ? (
							chat.messages.map((item) => (
								<article className={`manual-chat-message ${item.role}`} key={item.id}>
									<div className="manual-chat-message-heading">
										<strong>
											{item.role === "user" ? "你" : item.modelId ? `AI · ${item.modelId}` : "AI"}
										</strong>
										{item.content && (
											<button type="button" onClick={() => void copyMessage(item.id, item.content)}>
												{copiedMessageId === item.id ? "已复制" : "复制"}
											</button>
										)}
									</div>
									{item.content && <ChatMarkdown content={item.content} />}
									{item.images && item.images.length > 0 && (
										<div className="manual-chat-message-images">
											{item.images.map((image) => (
												<a
													href={apiUrl(props.apiOrigin, `/chats/${chat.id}/images/${image.id}`)}
													target="_blank"
													rel="noreferrer"
													key={image.id}
												>
													<img
														src={apiUrl(props.apiOrigin, `/chats/${chat.id}/images/${image.id}`)}
														alt={image.name}
													/>
													<span>{image.name}</span>
												</a>
											))}
										</div>
									)}
									{item.contextSnapshot && <small>已附带当前题目只读快照</small>}
								</article>
							))
						) : !busy ? (
							<div className="manual-chat-empty">
								可以直接提问，也可以勾选当前题目快照，让模型看到题面与标程。
							</div>
						) : null}
						{(busy || streaming) && (
							<article className="manual-chat-message assistant" aria-live="polite">
								<div className="manual-chat-message-heading">
									<strong>
										{busy
											? `AI · ${configuration?.profiles.find((item) => item.id === selectedProfileId)?.modelId ?? "生成中"} · 生成中`
											: streamFailed
												? "AI · 生成中断（未保存）"
												: "AI"}
									</strong>
									{streaming && (
										<button type="button" onClick={() => void copyMessage("stream", streaming)}>
											{copiedMessageId === "stream" ? "已复制" : "复制"}
										</button>
									)}
								</div>
								{streaming ? (
									<ChatMarkdown content={streaming} />
								) : (
									<p className="manual-chat-waiting">正在等待模型输出…</p>
								)}
							</article>
						)}
					</div>
					<div className="manual-chat-composer">
						<textarea
							value={input}
							disabled={busy}
							onChange={(event) => setInput(event.target.value)}
							placeholder="输入问题，或粘贴图片…"
							onPaste={(event) => {
								const files = Array.from(event.clipboardData.items)
									.filter((item) => item.kind === "file" && item.type.startsWith("image/"))
									.map((item) => item.getAsFile())
									.filter((file): file is File => file !== null);
								if (files.length) {
									event.preventDefault();
									void addImages(files);
								}
							}}
							onCompositionStart={() => {
								composingRef.current = true;
							}}
							onCompositionEnd={() => {
								composingRef.current = false;
							}}
							onKeyDown={(event) => {
								if (
									shouldSendChatMessage({
										key: event.key,
										shiftKey: event.shiftKey,
										isComposing: composingRef.current || event.nativeEvent.isComposing,
										repeat: event.repeat,
										keyCode: event.nativeEvent.keyCode,
									})
								) {
									event.preventDefault();
									void send();
								}
							}}
						/>
						{images.length > 0 && (
							<div className="manual-chat-pending-images">
								{images.map((image) => (
									<div className="manual-chat-pending-image" key={image.localId}>
										<img src={`data:${image.mimeType};base64,${image.data}`} alt={image.name} />
										<span title={image.name}>{image.name}</span>
										<button
											type="button"
											aria-label={`移除 ${image.name}`}
											disabled={busy}
											onClick={() =>
												setImages((current) => current.filter((item) => item.localId !== image.localId))
											}
										>
											×
										</button>
									</div>
								))}
							</div>
						)}
						<div className="manual-chat-actions">
							<label className="manual-context-toggle">
								<input
									type="checkbox"
									checked={attachProject}
									disabled={!props.projectSnapshot}
									onChange={(event) => setAttachProject(event.target.checked)}
								/>
								附带当前题面与标程
							</label>
							<label className="manual-chat-profile">
								<span>模型</span>
								<select
									aria-label="当前对话模型"
									value={selectedProfileId}
									disabled={busy || !configuration?.profiles.length}
									onChange={(event) => setSelectedProfileId(event.target.value)}
								>
									{configuration?.profiles.map((profile) => (
										<option value={profile.id} key={profile.id}>
											{profile.name} · {profile.modelId}
										</option>
									))}
								</select>
							</label>
							<button
								className="button secondary manual-chat-upload"
								type="button"
								disabled={busy || readingImages}
								onClick={() => imageInputRef.current?.click()}
							>
								上传图片
							</button>
							<input
								ref={imageInputRef}
								className="manual-chat-upload-input"
								type="file"
								accept="image/png,image/jpeg,image/webp,image/gif"
								multiple
								disabled={busy || readingImages}
								onChange={(event) => {
									const files = Array.from(event.target.files ?? []);
									event.target.value = "";
									void addImages(files);
								}}
							/>
							{busy && (
								<button
									className="button secondary"
									type="button"
									onClick={() => controllerRef.current?.abort()}
								>
									停止生成
								</button>
							)}
							<button
								className="button primary"
								type="button"
								disabled={
									busy ||
									readingImages ||
									!props.configured ||
									!selectedProfileId ||
									(!input.trim() && images.length === 0)
								}
								onClick={() => void send()}
							>
								{busy ? "回复中…" : "发送"}
							</button>
						</div>
						<p className="manual-chat-context-note">
							同一对话自动保留上下文 · Enter 发送 · Shift+Enter 换行 · 可粘贴图片
						</p>
					</div>
				</section>
			</div>
		</main>
	);
}
