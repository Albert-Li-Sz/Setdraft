import type { ChatRequest } from "@hydro-problem-make/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { requestJson as jsonRequest } from "./api-client.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import { shouldSendChatMessage } from "./chat-shortcut.ts";
import { type ChatStreamEvent, readChatStream } from "./chat-stream.ts";
import { Icon } from "./Icon.tsx";
import { type UiMessage, uiMessage, useLocale } from "./i18n.tsx";
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

function profileForChat(configuration: AiConfiguration, chat?: ChatConversation): string {
	if (chat?.profileId && configuration.profiles.some((item) => item.id === chat.profileId)) return chat.profileId;
	return configuration.defaultProfileId ?? configuration.profiles[0]?.id ?? "";
}

function newestChats(chats: ChatSummary[]): ChatSummary[] {
	return [...chats].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function AiChatPage(props: Props) {
	const { t } = useLocale();
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
	const [failedRequest, setFailedRequest] = useState<{ chatId: string; requestId: string }>();
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [historyCollapsed, setHistoryCollapsed] = useState(false);
	const [message, setMessage] = useState<UiMessage>("正在读取本地对话…");
	const [messageTone, setMessageTone] = useState<"pending" | "passed" | "failed">("pending");
	const controllerRef = useRef<AbortController | undefined>(undefined);
	const activeRequestRef = useRef<{ chatId: string; requestId: string } | undefined>(undefined);
	const messagesRef = useRef<HTMLDivElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const followOutputRef = useRef(true);
	const composingRef = useRef(false);
	const sendingRef = useRef(false);
	const readingImagesRef = useRef(false);

	const showMessage = useCallback((value: UiMessage, tone: "pending" | "passed" | "failed" = "pending"): void => {
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
		if (!chat?.id || busy) return;
		const chatId = chat.id;
		const controller = new AbortController();
		void jsonRequest<{ requests: Array<{ id: string; state: string }> }>(
			apiUrl(props.apiOrigin, `/chats/${chatId}/requests`),
			{ signal: controller.signal },
		)
			.then((value) => {
				if (controller.signal.aborted) return;
				const latest = value.requests[0];
				if (
					latest &&
					latest.state !== "done" &&
					!chat.messages.some((item) => item.role === "assistant" && item.requestId === latest.id)
				) {
					setFailedRequest({ chatId, requestId: latest.id });
				}
			})
			.catch(() => {});
		return () => controller.abort();
	}, [chat, busy, props.apiOrigin]);

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
		if (!window.confirm(t("删除这条 AI 对话及其全部消息？此操作无法撤销。"))) return;
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
			showMessage(uiMessage("已添加 {0} 张图片；发送时将交给当前模型分析。", added.length), "passed");
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
		const requestId = crypto.randomUUID();
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
			const form = new FormData();
			form.set("requestId", requestId);
			form.set("message", content);
			form.set("profileId", selectedProfileId);
			if (attachProject && props.projectSnapshot) form.set("contextSnapshot", props.projectSnapshot);
			for (const image of images) {
				const binary = atob(image.data);
				const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
				form.append("images", new File([bytes], image.name, { type: image.mimeType }));
			}
			const response = await fetch(apiUrl(props.apiOrigin, `/chats/${current.id}/messages`), {
				method: "POST",
				signal: controller.signal,
				body: form,
			});
			if (!response.ok) throw new Error(responseError(await response.json()));
			activeRequestRef.current = { chatId: current.id, requestId };
			setInput("");
			setImages([]);
			let completed = false;
			let after = 0;
			let attempts = 0;
			const handleEvent = (event: ChatStreamEvent, sequence?: number) => {
				if (sequence !== undefined && sequence <= after) return;
				if (sequence !== undefined) after = sequence;
				if (event.type === "start") {
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
			};
			while (!completed && !controller.signal.aborted) {
				try {
					const stream = await fetch(
						apiUrl(props.apiOrigin, `/chats/${current.id}/requests/${requestId}/events?after=${after}`),
						{ signal: controller.signal },
					);
					if (!stream.ok || !stream.body) throw new Error("无法订阅 AI 回复。");
					await readChatStream(stream.body, handleEvent);
					if (completed) break;
					const status = await jsonRequest<ChatRequest>(
						apiUrl(props.apiOrigin, `/chats/${current.id}/requests/${requestId}`),
					);
					if (status.state === "failed") throw new Error(status.error ?? "模型请求失败。");
					attempts = 0;
				} catch (error) {
					if (controller.signal.aborted) throw error;
					if (++attempts > 5) throw error;
				}
				if (!completed) await new Promise((resolve) => setTimeout(resolve, 500));
			}
			if (!completed) throw new Error("模型连接提前中断。");
			setFailedRequest(undefined);
			await refreshList();
			showMessage("回复已保存到本地对话。", "passed");
		} catch (error) {
			showMessage(
				controller.signal.aborted ? "已停止生成。" : error instanceof Error ? error.message : "模型请求失败。",
				controller.signal.aborted ? "pending" : "failed",
			);
			setStreamFailed(partialText.length > 0);
			if (!controller.signal.aborted && activeChat) setFailedRequest({ chatId: activeChat.id, requestId });
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
			activeRequestRef.current = undefined;
		}
	}

	async function resumeFailed(): Promise<void> {
		if (!failedRequest || busy) return;
		setBusy(true);
		setStreaming("");
		setStreamFailed(false);
		const controller = new AbortController();
		controllerRef.current = controller;
		activeRequestRef.current = failedRequest;
		try {
			const base = `/chats/${failedRequest.chatId}/requests/${failedRequest.requestId}`;
			const state = await jsonRequest<ChatRequest>(apiUrl(props.apiOrigin, base));
			if (state.state === "failed") await jsonRequest(apiUrl(props.apiOrigin, `${base}/retry`), { method: "POST" });
			let after = 0;
			let completed = false;
			let retries = 0;
			while (!completed && !controller.signal.aborted) {
				try {
					const response = await fetch(apiUrl(props.apiOrigin, `${base}/events?after=${after}`), {
						signal: controller.signal,
					});
					if (!response.ok || !response.body) throw new Error("无法接收模型回复。");
					await readChatStream(response.body, (event, sequence) => {
						if (sequence !== undefined && sequence <= after) return;
						if (sequence !== undefined) after = sequence;
						if (event.type === "start") setChat(event.chat);
						else if (event.type === "delta") setStreaming((current) => current + event.delta);
						else if (event.type === "done") {
							setChat(event.chat);
							setStreaming("");
							completed = true;
						} else throw new Error(event.message);
					});
					if (!completed) {
						const status = await jsonRequest<ChatRequest>(apiUrl(props.apiOrigin, base));
						if (status.state === "failed") throw new Error(status.error ?? "模型请求失败。");
					}
					retries = 0;
				} catch (error) {
					if (controller.signal.aborted || ++retries > 5) throw error;
				}
				if (!completed) await new Promise((resolve) => setTimeout(resolve, 500));
			}
			if (!completed) throw new Error("模型连接提前中断。");
			setFailedRequest(undefined);
			await refreshList();
			showMessage("回复已保存到本地对话。", "passed");
		} catch (error) {
			showMessage(error instanceof Error ? error.message : "重试失败。", "failed");
			setStreamFailed(true);
		} finally {
			activeRequestRef.current = undefined;
			controllerRef.current = undefined;
			setBusy(false);
		}
	}

	async function stopGeneration(): Promise<void> {
		const active = activeRequestRef.current;
		controllerRef.current?.abort();
		if (!active) return;
		try {
			await fetch(apiUrl(props.apiOrigin, `/chats/${active.chatId}/requests/${active.requestId}/cancel`), {
				method: "POST",
			});
			for (let attempt = 0; attempt < 20; attempt++) {
				const response = await fetch(
					apiUrl(props.apiOrigin, `/chats/${active.chatId}/requests/${active.requestId}`),
				);
				if (response.ok) {
					const state = (await response.json()) as { state: string };
					if (state.state === "failed") {
						setFailedRequest(active);
						break;
					}
					if (state.state === "done") break;
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
		} catch {
			setFailedRequest(active);
		}
	}

	return (
		<main className="page manual-chat-page" id="chat">
			<div className="breadcrumb">{t("工作区 / AI 对话")}</div>
			<section className="page-heading">
				<div>
					<div className="eyebrow">{t("独立助手")}</div>
					<h1>{t("AI 对话")}</h1>
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
					{t("新建对话")}
				</button>
			</section>
			<output className={`notice ${props.configured ? messageTone : "failed"}`} aria-live="polite">
				<span className="notice-dot" />
				{props.configured ? t(message) : t("请先在设置中配置 AI API。")}
			</output>
			<div className={`manual-chat-layout${historyCollapsed ? " history-collapsed" : ""}`}>
				<aside className="card manual-chat-list" aria-label={t("对话记录")}>
					<div className="manual-chat-list-heading">
						{!historyCollapsed && <span>{t("对话记录")}</span>}
						<button
							type="button"
							className="manual-chat-list-toggle"
							aria-label={historyCollapsed ? t("展开对话记录") : t("折叠对话记录")}
							aria-controls="manual-chat-history"
							aria-expanded={!historyCollapsed}
							title={historyCollapsed ? t("展开对话记录") : t("折叠对话记录")}
							onClick={() => setHistoryCollapsed((current) => !current)}
						>
							{historyCollapsed ? "›" : "‹"}
						</button>
					</div>
					<div className="manual-chat-list-items" id="manual-chat-history" hidden={historyCollapsed}>
						{chats.length === 0 && (
							<p className="manual-chat-list-empty">
								{loading ? t("正在读取对话…") : t("暂无对话。点击“新建对话”开始。")}
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
									aria-label={t("删除 {0}", item.title)}
									onClick={() => void remove(item.id)}
								>
									{t("删除")}
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
											{item.role === "user" ? t("你") : item.modelId ? `AI · ${item.modelId}` : "AI"}
										</strong>
										{item.content && (
											<button type="button" onClick={() => void copyMessage(item.id, item.content)}>
												{copiedMessageId === item.id ? t("已复制") : t("复制")}
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
									{item.contextSnapshot && <small>{t("已附带当前题目只读快照")}</small>}
									{item.usage && (
										<small>{t("输入 {0} · 输出 {1} tokens", item.usage.input, item.usage.output)}</small>
									)}
								</article>
							))
						) : !busy ? (
							<div className="manual-chat-empty">
								<Icon name="spark" />
								<h2>{t("一起，把想法想清楚。")}</h2>
								<p>{t("可以直接提问，也可以勾选当前题目快照，让模型看到题面与标程。")}</p>
							</div>
						) : null}
						{(busy || streaming) && (
							<article className="manual-chat-message assistant" aria-live="polite">
								<div className="manual-chat-message-heading">
									<strong>
										{busy
											? t(
													"AI · {0} · 生成中",
													configuration?.profiles.find((item) => item.id === selectedProfileId)?.modelId ??
														t("生成中"),
												)
											: streamFailed
												? t("AI · 生成中断（未保存）")
												: "AI"}
									</strong>
									{streaming && (
										<button type="button" onClick={() => void copyMessage("stream", streaming)}>
											{copiedMessageId === "stream" ? t("已复制") : t("复制")}
										</button>
									)}
								</div>
								{streaming ? (
									<ChatMarkdown content={streaming} />
								) : (
									<p className="manual-chat-waiting">{t("正在等待模型输出…")}</p>
								)}
							</article>
						)}
					</div>
					<div className="manual-chat-composer">
						<textarea
							value={input}
							disabled={busy}
							onChange={(event) => setInput(event.target.value)}
							placeholder={t("输入问题，或粘贴图片…")}
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
											aria-label={t("移除 {0}", image.name)}
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
								{t("附带当前题面与标程")}
							</label>
							<label className="manual-chat-profile">
								<span>{t("模型")}</span>
								<select
									aria-label={t("当前对话模型")}
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
								{t("上传图片")}
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
								<button className="button secondary" type="button" onClick={() => void stopGeneration()}>
									{t("停止生成")}
								</button>
							)}
							{!busy && failedRequest && (
								<button className="button secondary" type="button" onClick={() => void resumeFailed()}>
									{streamFailed ? t("重试并续接") : t("续接回复")}
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
								{busy ? t("回复中…") : t("发送")}
							</button>
						</div>
						<p className="manual-chat-context-note">
							{t("同一对话自动保留上下文 · Enter 发送 · Shift+Enter 换行 · 可粘贴图片")}
						</p>
					</div>
				</section>
			</div>
		</main>
	);
}
