import type { ChatRequest } from "@setdraft/contracts";
import { apiUrl, requestJson } from "./api-client.ts";
import { createClientId } from "./browser-capabilities.ts";

export interface ChatRequestIdentity {
	chatId: string;
	requestId: string;
}
export interface ActiveChatRequest extends ChatRequestIdentity {
	attemptId?: string;
	cancellation?: Promise<ChatRequest>;
}

export function activeChatRequest(identity: ChatRequestIdentity): ActiveChatRequest {
	return { chatId: identity.chatId, requestId: identity.requestId, attemptId: identity.requestId };
}

export async function resumeChatRequest(active: ActiveChatRequest, origin: string, signal: AbortSignal): Promise<void> {
	signal.throwIfAborted();
	const base = apiUrl(origin, `/chats/${active.chatId}/requests/${active.requestId}`);
	const state = await requestJson<ChatRequest>(base, { signal });
	signal.throwIfAborted();
	active.attemptId = state.attemptId;
	if (state.state === "failed") {
		active.attemptId = createClientId();
		const accepted = await requestJson<ChatRequest>(`${base}/retry`, {
			method: "POST",
			signal,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ attemptId: active.attemptId }),
		});
		signal.throwIfAborted();
		if (accepted.attemptId !== active.attemptId || accepted.state === "failed")
			throw new Error(accepted.error ?? "重试轮次未被接受。");
	}
}

export async function cancelChatRequest(active: ActiveChatRequest, origin: string): Promise<ChatRequest> {
	const base = apiUrl(origin, `/chats/${active.chatId}/requests/${active.requestId}`);
	const signal = AbortSignal.timeout(10_000);
	const attemptId = active.attemptId ?? active.requestId;
	let state = await requestJson<ChatRequest>(`${base}/cancel`, {
		method: "POST",
		signal,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ attemptId }),
	});
	for (let attempt = 0; attempt < 50; attempt++) {
		if (state.attemptId !== attemptId) throw new Error("执行轮次已变化，无法确认本轮停止。请重新打开对话核对。");
		if (state.state === "done" || state.state === "failed") return state;
		await new Promise((resolve) => setTimeout(resolve, 100));
		state = await requestJson<ChatRequest>(base, { signal });
	}
	throw new Error("尚未确认后台停止，请重新打开对话核对请求状态。");
}
