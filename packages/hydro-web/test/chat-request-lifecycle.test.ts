import { afterEach, expect, it, vi } from "vitest";
import { authFetch } from "../src/auth-client.ts";
import { activeChatRequest, cancelChatRequest, resumeChatRequest } from "../src/chat-request-lifecycle.ts";

vi.mock("../src/auth-client.ts", () => ({ authFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());
function response(body: unknown) {
	return new Response(JSON.stringify(body));
}
it("isolates cancellation promises across two consecutive retry attempts", async () => {
	const failed = { chatId: "chat", requestId: "request", cancellation: Promise.resolve({}) };
	for (let i = 0; i < 2; i++) {
		const active = activeChatRequest(failed);
		expect(active.cancellation).toBeUndefined();
		vi.mocked(authFetch)
			.mockResolvedValueOnce(response({ state: "failed", attemptId: "previous" }))
			.mockImplementationOnce(async (_url, init) =>
				response({ state: "queued", attemptId: JSON.parse(String(init?.body)).attemptId }),
			)
			.mockImplementationOnce(async (_url, init) =>
				response({ state: "failed", attemptId: JSON.parse(String(init?.body)).attemptId }),
			);
		await resumeChatRequest(active, "", new AbortController().signal);
		active.cancellation = cancelChatRequest(active, "");
		await active.cancellation;
	}
	expect(vi.mocked(authFetch).mock.calls.filter(([url]) => String(url).endsWith("/cancel"))).toHaveLength(2);
});
it("does not dispatch a retry after cancellation during a delayed preflight response", async () => {
	let respond!: (value: Response) => void;
	vi.mocked(authFetch).mockImplementationOnce(
		() =>
			new Promise((resolve) => {
				respond = resolve;
			}),
	);
	const controller = new AbortController();
	const flight = resumeChatRequest(activeChatRequest({ chatId: "chat", requestId: "request" }), "", controller.signal);
	controller.abort();
	respond(response({ state: "failed", attemptId: "previous" }));
	await expect(flight).rejects.toMatchObject({ name: "AbortError" });
	expect(authFetch).toHaveBeenCalledOnce();
});
it("rejects cancellation during an accepted retry response and retains its attempt token", async () => {
	let respond!: (value: Response) => void;
	vi.mocked(authFetch)
		.mockResolvedValueOnce(response({ state: "failed", attemptId: "previous" }))
		.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					respond = resolve;
				}),
		);
	const active = activeChatRequest({ chatId: "chat", requestId: "request" });
	const controller = new AbortController();
	const flight = resumeChatRequest(active, "", controller.signal);
	await vi.waitFor(() => expect(authFetch).toHaveBeenCalledTimes(2));
	controller.abort();
	respond(response({ state: "queued", attemptId: active.attemptId }));
	await expect(flight).rejects.toMatchObject({ name: "AbortError" });
	expect(active.attemptId).toMatch(/^[a-f0-9-]{36}$/);
});
