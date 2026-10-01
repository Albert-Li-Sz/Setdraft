import type { ChatRequest } from "@setdraft/contracts";
import { useCallback, useDeferredValue, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppSidebar } from "./AppShell.tsx";
import { requestJson as jsonRequest } from "./api-client.ts";
import { authFetch } from "./auth-client.ts";
import { copyText, createClientId } from "./browser-capabilities.ts";
import { ChatMarkdown } from "./ChatMarkdown.tsx";
import {
	type ActiveChatRequest,
	activeChatRequest,
	cancelChatRequest,
	resumeChatRequest,
} from "./chat-request-lifecycle.ts";
import { shouldSendChatMessage } from "./chat-shortcut.ts";
import { type ChatStreamEvent, readChatStream } from "./chat-stream.ts";
import { transferFiles } from "./file-transfer.ts";
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
	active: boolean;
	paused: boolean;
	apiOrigin: string;
	configured: boolean;
	administrator?: boolean;
	projectSnapshot?: string;
}

interface PendingImage extends ChatImageUpload {
	localId: string;
	bytes: number;
}

const acceptedImageTypes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const maxImageBytes = 5 * 1024 * 1024;
const maxMessageImageBytes = 12 * 1024 * 1024;

async function readImage(file: File, progress: (loaded: number) => void): Promise<PendingImage> {
	if (!acceptedImageTypes.includes(file.type)) throw new Error("图片只支持 PNG、JPEG、WebP 或 GIF。");
	if (file.size === 0 || file.size > maxImageBytes) throw new Error("单张图片须大于 0 且不能超过 5 MiB。");
	const name = file.name || "粘贴图片.png";
	if (name.length > 120) throw new Error("图片文件名不能超过 120 个字符。");
	const data = await new Promise<string>((resolve, reject) => {
		const reader = new FileReader();
		reader.onprogress = (event) => progress(event.loaded);
		reader.onload = () => {
			if (typeof reader.result !== "string") return reject(new Error("无法读取图片。"));
			const separator = reader.result.indexOf(",");
			if (separator < 0) return reject(new Error("无法读取图片。"));
			resolve(reader.result.slice(separator + 1));
		};
		reader.onerror = () => reject(new Error("无法读取图片。"));
		reader.readAsDataURL(file);
	});
	return { localId: createClientId(), name, mimeType: file.type, data, bytes: file.size };
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
	const sidebar = useAppSidebar();
	const [chats, setChats] = useState<ChatSummary[]>([]);
	const [chat, setChat] = useState<ChatConversation>();
	const [configuration, setConfiguration] = useState<AiConfiguration>();
	const configured = configuration?.configured ?? props.configured;
	const [selectedProfileId, setSelectedProfileId] = useState("");
	const [input, setInput] = useState("");
	const [images, setImages] = useState<PendingImage[]>([]);
	const [readingImages, setReadingImages] = useState(false);
	const [copiedMessageId, setCopiedMessageId] = useState<string>();
	const [attachProject, setAttachProject] = useState(false);
	const [webSearch, setWebSearch] = useState(true);
	const [wide, setWide] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchPhase, setSearchPhase] = useState("");
	const [streaming, setStreaming] = useState("");
	const deferredStreaming = useDeferredValue(streaming);
	const [streamFailed, setStreamFailed] = useState(false);
	const [streamCancelled, setStreamCancelled] = useState(false);
	const [failedRequest, setFailedRequest] = useState<{ chatId: string; requestId: string }>();
	const [busy, setBusy] = useState(false);
	const [loading, setLoading] = useState(true);
	const [message, setMessage] = useState<UiMessage>("正在读取本地对话…");
	const [messageTone, setMessageTone] = useState<"pending" | "passed" | "failed">("pending");
	const controllerRef = useRef<AbortController | undefined>(undefined);
	const selectionRef = useRef<AbortController | undefined>(undefined);
	const viewEpoch = useRef(0);
	const pausedRef = useRef(props.paused);
	pausedRef.current = props.paused;
	const beginSelection = useCallback((controller = new AbortController()): AbortController => {
		selectionRef.current?.abort();
		viewEpoch.current++;
		selectionRef.current = controller;
		return controller;
	}, []);
	const ownsRequest = (controller: AbortController) => controllerRef.current === controller && !pausedRef.current;
	const activeRequestRef = useRef<ActiveChatRequest | undefined>(undefined);
	const messagesRef = useRef<HTMLDivElement | null>(null);
	const imageInputRef = useRef<HTMLInputElement | null>(null);
	const followOutputRef = useRef(true);
	const composingRef = useRef(false);
	const sendingRef = useRef(false);
	const readingImagesRef = useRef(false);
	const currentChatRef = useRef(chat);
	currentChatRef.current = chat;
	useEffect(() => {
		if (!props.active || props.paused) {
			selectionRef.current?.abort();
			viewEpoch.current++;
		}
		if (props.paused) {
			controllerRef.current?.abort();
			controllerRef.current = undefined;
			activeRequestRef.current = undefined;
			sendingRef.current = false;
			setBusy(false);
		}
	}, [props.active, props.paused]);

	const showMessage = useCallback((value: UiMessage, tone: "pending" | "passed" | "failed" = "pending"): void => {
		setMessage(value);
		setMessageTone(tone);
	}, []);

	useEffect(() => {
		const element = messagesRef.current;
		if (props.active && element && followOutputRef.current) element.scrollTop = element.scrollHeight;
	});

	useEffect(() => {
		const element = messagesRef.current;
		if (!element || !props.active) return;
		const observer = new ResizeObserver(() => {
			if (followOutputRef.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, [props.active]);

	useEffect(() => {
		if (!chat?.id || busy || props.paused) return;
		const chatId = chat.id;
		const controller = new AbortController();
		void jsonRequest<{ requests: ChatRequest[] }>(apiUrl(props.apiOrigin, `/chats/${chatId}/requests`), {
			signal: controller.signal,
		})
			.then((value) => {
				if (controller.signal.aborted) return;
				const latest = value.requests[0];
				if (
					latest &&
					latest.state !== "done" &&
					!chat.messages.some((item) => item.role === "assistant" && item.requestId === latest.id)
				) {
					setFailedRequest({ chatId, requestId: latest.id });
					setStreamFailed(latest.state === "failed");
					setStreamCancelled(latest.error === "已取消");
				} else setFailedRequest(undefined);
			})
			.catch(() => {});
		return () => controller.abort();
	}, [chat, busy, props.apiOrigin, props.paused]);

	useEffect(() => {
		if (props.paused || !props.active || controllerRef.current) return;
		const controller = beginSelection();
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
				const preferred = orderedChats.find((item) => item.id === currentChatRef.current?.id) ?? orderedChats[0];
				if (preferred) {
					if (currentChatRef.current?.id !== preferred.id) followOutputRef.current = true;
					const selected = await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, `/chats/${preferred.id}`), {
						signal: controller.signal,
					});
					if (!controller.signal.aborted) {
						setChat(selected);
						setWebSearch(selected?.webSearch ?? true);
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
		};
	}, [props.apiOrigin, showMessage, props.paused, props.active, beginSelection]);

	useEffect(() => () => controllerRef.current?.abort(), []);

	useEffect(() => {
		if (!props.active || props.paused || loading) return;
		const controller = new AbortController();
		// Settings can change while this page is hidden; refresh without touching the active stream.
		void jsonRequest<unknown>(apiUrl(props.apiOrigin, "/ai/config"), { signal: controller.signal })
			.then((value) => {
				if (controller.signal.aborted) return;
				const config = readAiConfiguration(value);
				if (!config) throw new Error("AI 配置列表格式无效。");
				setConfiguration(config);
				setSelectedProfileId((current) =>
					config.profiles.some((item) => item.id === current)
						? current
						: profileForChat(config, currentChatRef.current),
				);
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted)
					showMessage(error instanceof Error ? error.message : "对话读取失败。", "failed");
			});
		return () => controller.abort();
	}, [props.active, props.paused, props.apiOrigin, loading, showMessage]);

	async function refreshList(signal?: AbortSignal): Promise<void> {
		const list = await jsonRequest<{ chats: ChatSummary[] }>(apiUrl(props.apiOrigin, "/chats"), { signal });
		signal?.throwIfAborted();
		if (pausedRef.current) return;
		setChats(newestChats(list.chats));
	}

	async function create(preserveProfileSelection = false, signal?: AbortSignal): Promise<ChatConversation> {
		const controller = beginSelection();
		const selectionSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const created = await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, "/chats"), {
			method: "POST",
			signal: selectionSignal,
		});
		selectionSignal.throwIfAborted();
		if (pausedRef.current) throw new DOMException("Selection expired", "AbortError");
		setChat(created);
		setFailedRequest(undefined);
		if (configuration && !preserveProfileSelection) setSelectedProfileId(profileForChat(configuration, created));
		setStreaming("");
		setSearchPhase("");
		setStreamFailed(false);
		setStreamCancelled(false);
		if (!preserveProfileSelection) {
			setImages([]);
			setInput("");
		}
		setLoading(false);
		followOutputRef.current = true;
		await refreshList(selectionSignal);
		showMessage("已创建新对话。", "passed");
		return created;
	}

	async function open(id: string): Promise<void> {
		if (busy) return;
		const controller = beginSelection();
		try {
			const selected = await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, `/chats/${id}`), {
				signal: controller.signal,
			});
			controller.signal.throwIfAborted();
			setChat(selected);
			setWebSearch(selected?.webSearch ?? true);
			setFailedRequest(undefined);
			if (configuration) setSelectedProfileId(profileForChat(configuration, selected));
			setStreaming("");
			setStreamFailed(false);
			setStreamCancelled(false);
			setImages([]);
			setInput("");
			followOutputRef.current = true;
		} catch (error) {
			if (!controller.signal.aborted)
				showMessage(error instanceof Error ? error.message : "对话读取失败。", "failed");
		} finally {
			if (!controller.signal.aborted) setLoading(false);
		}
	}

	async function remove(id: string): Promise<void> {
		const epoch = viewEpoch.current;
		if (!window.confirm(t("删除这条 AI 对话及其全部消息？此操作无法撤销。"))) return;
		try {
			const response = await authFetch(apiUrl(props.apiOrigin, `/chats/${id}`), { method: "DELETE" });
			if (!response.ok) throw new Error(responseError(await response.json()));
			const remaining = chats.filter((item) => item.id !== id);
			if (pausedRef.current || epoch !== viewEpoch.current) return;
			setChats((current) => current.filter((item) => item.id !== id));
			if (currentChatRef.current?.id === id) {
				const selected = remaining[0]
					? await jsonRequest<ChatConversation>(apiUrl(props.apiOrigin, `/chats/${remaining[0].id}`))
					: undefined;
				if (pausedRef.current || epoch !== viewEpoch.current || currentChatRef.current?.id !== id) return;
				setChat(selected);
				setWebSearch(selected?.webSearch ?? true);
				setFailedRequest(undefined);
				setStreaming("");
				setStreamFailed(false);
				setStreamCancelled(false);
				if (configuration) setSelectedProfileId(profileForChat(configuration, selected));
			}
			showMessage("对话已删除。", "passed");
		} catch (error) {
			showMessage(error instanceof Error ? error.message : "删除失败。", "failed");
		}
	}

	async function addImages(files: File[]): Promise<void> {
		const epoch = viewEpoch.current;
		if (!files.length || readingImagesRef.current || busy) return;
		if (images.length + files.length > 4) {
			showMessage("每条消息最多添加 4 张图片。", "failed");
			return;
		}
		readingImagesRef.current = true;
		setReadingImages(true);
		try {
			const added = await transferFiles(files.map((file) => file.name).join(", "), async (report) => {
				const bytes = files.map(() => 0);
				const total = files.reduce((sum, file) => sum + file.size, 0);
				return Promise.all(
					files.map((file, index) =>
						readImage(file, (loaded) => {
							bytes[index] = loaded;
							report({
								phase: "reading",
								file: file.name,
								loaded: bytes.reduce((sum, value) => sum + value, 0),
								total,
							});
						}),
					),
				);
			});
			if (pausedRef.current || epoch !== viewEpoch.current) return;
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
			await copyText(content);
			setCopiedMessageId(id);
			showMessage("消息文字已复制。", "passed");
		} catch {
			showMessage("复制失败，请检查浏览器剪贴板权限。", "failed");
		}
	}

	async function send(): Promise<void> {
		const content = input.trim();
		if ((!content && images.length === 0) || loading || busy || readingImages || sendingRef.current) return;
		if (!selectedProfileId) {
			showMessage("请先在设置中添加 API / 模型配置。", "failed");
			return;
		}
		let activeChat = chat;
		let previousMessageCount = chat?.messages.length ?? 0;
		let partialText = "";
		const requestId = createClientId();
		sendingRef.current = true;
		setBusy(true);
		setStreaming("");
		setSearchPhase("");
		setStreamFailed(false);
		setStreamCancelled(false);
		followOutputRef.current = true;
		showMessage("模型正在回复…");
		const controller = new AbortController();
		controllerRef.current = controller;
		try {
			const current = chat ?? (await create(true, controller.signal));
			controller.signal.throwIfAborted();
			activeRequestRef.current = activeChatRequest({ chatId: current.id, requestId });
			activeChat = current;
			previousMessageCount = current.messages.length;
			const form = new FormData();
			form.set("requestId", requestId);
			form.set("attemptId", activeRequestRef.current.attemptId ?? requestId);
			form.set("message", content);
			form.set("webSearch", String(webSearch));
			if (searchQuery.trim()) form.set("searchQuery", searchQuery.trim());
			form.set("profileId", selectedProfileId);
			if (attachProject && props.projectSnapshot) form.set("contextSnapshot", props.projectSnapshot);
			for (const image of images) {
				const binary = atob(image.data);
				const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
				form.append("images", new File([bytes], image.name, { type: image.mimeType }));
			}
			const submit = (onUploadProgress?: (loaded: number, total?: number) => void) =>
				authFetch(apiUrl(props.apiOrigin, `/chats/${current.id}/messages`), {
					method: "POST",
					signal: controller.signal,
					body: form,
					onUploadProgress,
				});
			const response = images.length
				? await transferFiles(images.map((image) => image.name).join(", "), async (report) => {
						const response = await submit((loaded, total) =>
							report({ phase: total && loaded >= total ? "saving" : "uploading", loaded, total }),
						);
						if (!response.ok) throw new Error(responseError(await response.json()));
						return response;
					})
				: await submit();
			if (!response.ok) throw new Error(responseError(await response.json()));
			controller.signal.throwIfAborted();
			if (!ownsRequest(controller)) return;
			setInput("");
			setImages([]);
			let completed = false;
			let after = 0;
			let attempts = 0;
			const handleEvent = (event: ChatStreamEvent, sequence?: number) => {
				controller.signal.throwIfAborted();
				if (!ownsRequest(controller)) return;
				if (sequence !== undefined && sequence <= after) return;
				if (sequence !== undefined) after = sequence;
				if (event.type === "search") {
					setSearchPhase(event.phase);
					if (event.message) showMessage(event.message);
				} else if (event.type === "start") {
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
					const stream = await authFetch(
						apiUrl(props.apiOrigin, `/chats/${current.id}/requests/${requestId}/events?after=${after}`),
						{ signal: controller.signal },
					);
					if (!stream.ok || !stream.body) throw new Error("无法订阅 AI 回复。");
					await readChatStream(stream.body, handleEvent);
					if (completed) break;
					const status = await jsonRequest<ChatRequest>(
						apiUrl(props.apiOrigin, `/chats/${current.id}/requests/${requestId}`),
						{ signal: controller.signal },
					);
					controller.signal.throwIfAborted();
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
			await refreshList(controller.signal);
			showMessage("回复已保存到本地对话。", "passed");
		} catch (error) {
			if (!ownsRequest(controller)) return;
			let stoppedMessage = "发送已停止。";
			if (controller.signal.aborted && activeRequestRef.current) {
				try {
					const active = activeRequestRef.current;
					active.cancellation ??= cancelRequest(active);
					const state = await active.cancellation;
					if (!ownsRequest(controller)) return;
					stoppedMessage =
						state.state === "done"
							? "回复已完成并保存。"
							: state.error === "已取消"
								? "已停止生成。"
								: (state.error ?? "请求已结束。");
				} catch (cause) {
					stoppedMessage = cause instanceof Error ? cause.message : "无法确认后台停止，请在任务列表核对。";
				}
			}
			showMessage(
				controller.signal.aborted ? stoppedMessage : error instanceof Error ? error.message : "模型请求失败。",
				controller.signal.aborted ? "pending" : "failed",
			);
			setStreamFailed(partialText.length > 0);
			setStreamCancelled(controller.signal.aborted);
			if (!controller.signal.aborted && activeChat) setFailedRequest({ chatId: activeChat.id, requestId });
			if (!partialText) setStreaming("");
			if (activeChat) {
				const fallback = activeChat;
				const restored = await jsonRequest<ChatConversation>(
					apiUrl(props.apiOrigin, `/chats/${fallback.id}`),
				).catch(() => fallback);
				if (!ownsRequest(controller)) return;
				setChat(restored);
				if (restored.messages.length <= previousMessageCount) {
					setInput(content);
				}
			}
		} finally {
			if (controllerRef.current === controller) {
				sendingRef.current = false;
				setBusy(false);
				controllerRef.current = undefined;
				activeRequestRef.current = undefined;
			}
		}
	}

	async function resumeFailed(): Promise<void> {
		if (!failedRequest || failedRequest.chatId !== chat?.id || busy || props.paused) return;
		setBusy(true);
		followOutputRef.current = true;
		showMessage("模型正在回复…");
		setStreaming("");
		setStreamFailed(false);
		setStreamCancelled(false);
		const controller = new AbortController();
		controllerRef.current = controller;
		activeRequestRef.current = activeChatRequest(failedRequest);
		try {
			const base = `/chats/${failedRequest.chatId}/requests/${failedRequest.requestId}`;
			await resumeChatRequest(activeRequestRef.current, props.apiOrigin, controller.signal);
			controller.signal.throwIfAborted();
			let after = 0;
			let completed = false;
			let retries = 0;
			while (!completed && !controller.signal.aborted) {
				try {
					const response = await authFetch(apiUrl(props.apiOrigin, `${base}/events?after=${after}`), {
						signal: controller.signal,
					});
					if (!response.ok || !response.body) throw new Error("无法接收模型回复。");
					await readChatStream(response.body, (event, sequence) => {
						controller.signal.throwIfAborted();
						if (!ownsRequest(controller)) return;
						if (sequence !== undefined && sequence <= after) return;
						if (sequence !== undefined) after = sequence;
						if (event.type === "search") {
							setSearchPhase(event.phase);
							if (event.message) showMessage(event.message);
						} else if (event.type === "start") setChat(event.chat);
						else if (event.type === "delta") setStreaming((current) => current + event.delta);
						else if (event.type === "done") {
							setChat(event.chat);
							setStreaming("");
							completed = true;
						} else throw new Error(event.message);
					});
					if (!completed) {
						const status = await jsonRequest<ChatRequest>(apiUrl(props.apiOrigin, base), {
							signal: controller.signal,
						});
						controller.signal.throwIfAborted();
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
			await refreshList(controller.signal);
			showMessage("回复已保存到本地对话。", "passed");
		} catch (error) {
			if (!ownsRequest(controller)) return;
			if (controller.signal.aborted && activeRequestRef.current) {
				try {
					const active = activeRequestRef.current;
					active.cancellation ??= cancelRequest(active);
					const state = await active.cancellation;
					if (!ownsRequest(controller)) return;
					showMessage(
						state.state === "done"
							? "回复已完成并保存。"
							: state.error === "已取消"
								? "已停止生成。"
								: (state.error ?? "请求已结束。"),
					);
				} catch (cause) {
					showMessage(cause instanceof Error ? cause.message : "无法确认后台停止，请重新打开对话核对。", "failed");
				}
			} else showMessage(error instanceof Error ? error.message : "重试失败。", "failed");
			setStreamFailed(true);
			setStreamCancelled(controller.signal.aborted);
		} finally {
			if (controllerRef.current === controller) {
				activeRequestRef.current = undefined;
				controllerRef.current = undefined;
				setBusy(false);
			}
		}
	}

	const cancelRequest = (active: ActiveChatRequest) => cancelChatRequest(active, props.apiOrigin);

	async function stopGeneration(): Promise<void> {
		const active = activeRequestRef.current;
		if (active) active.cancellation ??= cancelRequest(active);
		controllerRef.current?.abort();
		if (!active) return;
		showMessage("正在确认后台停止…");
		try {
			const state = await active.cancellation;
			if (activeRequestRef.current !== active || pausedRef.current) return;
			if (state?.state === "failed") setFailedRequest({ chatId: active.chatId, requestId: active.requestId });
			showMessage(
				state?.state === "done"
					? "回复已完成并保存。"
					: state?.error === "已取消"
						? "已停止生成。"
						: (state?.error ?? "请求已结束。"),
			);
		} catch (cause) {
			setFailedRequest({ chatId: active.chatId, requestId: active.requestId });
			showMessage(cause instanceof Error ? cause.message : "无法确认后台停止，请重新打开对话核对。", "failed");
		}
	}

	return (
		<main className="page manual-chat-page" id="chat" hidden={!props.active} data-wide={wide}>
			<h1 className="visually-hidden">{t("AI 对话")}</h1>
			{props.active &&
				sidebar.target &&
				createPortal(
					<section className="manual-chat-list" aria-label={t("对话记录")}>
						<div className="manual-chat-list-heading">
							<h2>{t("对话记录")}</h2>
						</div>
						<div className="manual-chat-list-items">
							{chats.length === 0 && (
								<p className="manual-chat-list-empty">
									{loading ? t("正在读取对话…") : t("暂无对话。点击“新建对话”开始。")}
								</p>
							)}
							{chats.map((item) => (
								<div className={`manual-chat-list-item ${chat?.id === item.id ? "active" : ""}`} key={item.id}>
									<button
										type="button"
										onClick={() => {
											sidebar.close();
											void open(item.id);
										}}
									>
										{item.title}
									</button>
									<button
										className="text-button danger"
										type="button"
										aria-label={t("删除 {0}", item.title)}
										onClick={() => void remove(item.id)}
									>
										<Icon name="close" />
									</button>
								</div>
							))}
						</div>
					</section>,
					sidebar.target,
				)}
			<div className="chat-toolbar">
				<label className="manual-chat-profile">
					<select
						aria-label={t("当前对话模型")}
						value={selectedProfileId}
						disabled={busy || !configuration?.profiles.length}
						onChange={(event) => setSelectedProfileId(event.target.value)}
					>
						{!configuration?.profiles.length && <option value="">{t("选择模型")}</option>}
						{configuration?.profiles.map((profile) => (
							<option value={profile.id} key={profile.id}>
								{profile.name} · {profile.modelId}
							</option>
						))}
					</select>
				</label>
				<button
					className="button secondary"
					type="button"
					aria-pressed={wide}
					onClick={() => setWide((value) => !value)}
				>
					{t(wide ? "标准宽度" : "宽屏模式")}
				</button>
				<button
					className="icon-button"
					type="button"
					title={t("新建对话")}
					aria-label={t("新建对话")}
					disabled={busy}
					onClick={() =>
						void create().catch((error: unknown) => {
							if (!pausedRef.current && !(error instanceof Error && error.name === "AbortError"))
								showMessage(error instanceof Error ? error.message : "新建对话失败。", "failed");
						})
					}
				>
					<Icon name="compose" />
				</button>
			</div>
			<div className="manual-chat-layout">
				<section className={`manual-chat-main${!chat?.messages.length && !busy && !streaming ? " is-empty" : ""}`}>
					<div
						className="manual-chat-messages"
						ref={messagesRef}
						onScroll={(event) => {
							if (!props.active) return;
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
									{item.search && (
										<details className="chat-search-sources">
											<summary>
												{t("网络来源")} · {item.search.results.length}
												{item.searchStatus === "partial" && ` · ${t("部分引擎不可用")}`}
											</summary>
											<p>{item.search.query}</p>
											<ol>
												{item.search.results.map((source) => (
													<li key={source.id}>
														<a href={source.url} target="_blank" rel="noopener noreferrer">
															[{source.id}] {source.title}
														</a>
														<p>{source.snippet}</p>
													</li>
												))}
											</ol>
										</details>
									)}
									{item.searchError && <small className="chat-search-warning">{t(item.searchError)}</small>}
									{(item.finishReason === "refusal" || item.complete === false) && (
										<div className="chat-completion-status">
											<span>
												{t(
													item.finishReason === "refusal"
														? "模型拒绝了本次请求。"
														: "输出已达上限，内容不完整。",
												)}
											</span>
											{item.complete === false && (
												<button
													className="button secondary"
													type="button"
													disabled={busy}
													onClick={() => {
														setInput(t("请从上一条回复中断处继续。"));
														imageInputRef.current
															?.closest(".manual-chat-composer")
															?.querySelector("textarea")
															?.focus();
													}}
												>
													{t("续写")}
												</button>
											)}
										</div>
									)}
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
								<h2>{t("AI 对话")}</h2>
								<p>{t("输入问题，或附带当前题面与标程。")}</p>
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
												? t(streamCancelled ? "AI · 已取消（未保存）" : "AI · 生成失败（未保存）")
												: "AI"}
									</strong>
									{streaming && (
										<button type="button" onClick={() => void copyMessage("stream", streaming)}>
											{copiedMessageId === "stream" ? t("已复制") : t("复制")}
										</button>
									)}
								</div>
								{streaming ? (
									<ChatMarkdown content={deferredStreaming} />
								) : (
									<output className="manual-chat-waiting">
										<span className="thinking-dots" aria-hidden="true">
											<i />
											<i />
											<i />
										</span>
										<span>{t(searchPhase === "searching" ? "正在搜索网络资料…" : "正在等待模型输出…")}</span>
									</output>
								)}
								{busy && streaming && <output className="streaming-indicator" aria-label={t("生成中")} />}
							</article>
						)}
					</div>
					<div className="manual-chat-composer">
						<div className="composer-surface">
							<textarea
								value={input}
								disabled={busy || loading}
								onChange={(event) => setInput(event.target.value)}
								placeholder={t("输入问题，或粘贴图片…")}
								aria-label={t("消息内容")}
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
							{webSearch && (
								<label className="chat-search-query">
									<span>{t("搜索关键词")}</span>
									<input
										value={searchQuery}
										maxLength={500}
										disabled={busy}
										onChange={(event) => setSearchQuery(event.target.value)}
										placeholder={t("留空使用本条消息前 500 字；不会发送题目和附件")}
									/>
								</label>
							)}
							<div className="manual-chat-actions">
								<label className="manual-context-toggle">
									<input
										type="checkbox"
										checked={webSearch}
										disabled={busy}
										onChange={(event) => setWebSearch(event.target.checked)}
									/>
									{t("联网搜索")}
								</label>
								<label className="manual-context-toggle">
									<input
										type="checkbox"
										checked={attachProject}
										disabled={!props.projectSnapshot}
										onChange={(event) => setAttachProject(event.target.checked)}
									/>
									{t("附带当前题面与标程")}
								</label>

								<button
									className="icon-button manual-chat-upload"
									aria-label={t("上传图片")}
									title={t("上传图片")}
									type="button"
									disabled={busy || readingImages}
									onClick={() => imageInputRef.current?.click()}
								>
									<Icon name="attachment" />
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
										className="icon-button chat-send"
										type="button"
										aria-label={t("停止生成")}
										title={t("停止生成")}
										onClick={() => void stopGeneration()}
									>
										<Icon name="stop" />
									</button>
								)}
								<button
									className="icon-button chat-send"
									hidden={busy}
									aria-label={t("发送")}
									title={t("发送")}
									type="button"
									disabled={
										busy ||
										loading ||
										readingImages ||
										!configured ||
										!selectedProfileId ||
										(!input.trim() && images.length === 0)
									}
									onClick={() => void send()}
								>
									<Icon name="send" />
								</button>
							</div>
						</div>
						<div className="composer-footer">
							{!busy && failedRequest?.chatId === chat?.id && failedRequest && (
								<button
									className="icon-button chat-resume"
									type="button"
									aria-label={streamFailed ? t("重试并续接") : t("续接回复")}
									title={streamFailed ? t("重试并续接") : t("续接回复")}
									disabled={props.paused}
									onClick={() => void resumeFailed()}
								>
									<Icon name="resume" />
								</button>
							)}
							<p className="manual-chat-context-note">{t("Enter 发送 · Shift+Enter 换行")}</p>
						</div>
						{(!configured || messageTone === "failed") && (
							<output className="chat-status" aria-live="polite">
								{configured ? (
									t(message)
								) : props.administrator ? (
									<a href="#admin">{t("请先在管理员设置中配置 AI API。")}</a>
								) : (
									t("团队 AI 尚未配置，请联系管理员。")
								)}
							</output>
						)}
						<output className="visually-hidden" aria-live="polite">
							{t(message)}
						</output>
					</div>
				</section>
			</div>
		</main>
	);
}
