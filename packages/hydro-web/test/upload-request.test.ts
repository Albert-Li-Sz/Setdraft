import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthClient, AuthenticationRequired } from "../src/auth-client.ts";
import { transferFiles, transfers } from "../src/file-transfer.ts";
import { limitAmount } from "../src/limit-input.ts";
import { uploadRequest } from "../src/upload-request.ts";

class TestXHR {
	static current: TestXHR;
	headers = new Headers();
	body?: unknown;
	status = 200;
	response = new TextEncoder().encode('{"saved":true}').buffer;
	responseType = "";
	withCredentials = false;
	upload: { onprogress?: (event: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
	onload?: () => void;
	onerror?: () => void;
	onabort?: () => void;
	constructor() {
		TestXHR.current = this;
	}
	open() {}
	setRequestHeader(key: string, value: string) {
		this.headers.set(key, value);
	}
	getAllResponseHeaders() {
		return "content-type: application/json\r\nx-setdraft-user: alice\r\n";
	}
	send(body: unknown) {
		this.body = body;
	}
	abort() {
		this.onabort?.();
	}
}
afterEach(() => {
	vi.unstubAllGlobals();
	transfers.clear();
});

describe("progress uploads", () => {
	it("reports actual bytes and preserves authentication, response headers and cancellation", async () => {
		vi.stubGlobal("XMLHttpRequest", TestXHR);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					setupRequired: false,
					csrfToken: "csrf",
					user: { id: "alice", enabled: true, mustChangePassword: false },
				}),
			),
		);
		const client = new AuthClient();
		await client.refresh();
		const report = vi.fn();
		const controller = new AbortController();
		const pending = client.fetch("/api/projects/p/files/1.in", {
			method: "PUT",
			body: new Blob(["abc"]),
			onUploadProgress: report,
			signal: controller.signal,
		});
		expect(TestXHR.current.headers.get("x-csrf-token")).toBe("csrf");
		TestXHR.current.upload.onprogress?.({ loaded: 2, total: 3, lengthComputable: true });
		expect(report).toHaveBeenCalledWith(2, 3);
		TestXHR.current.onload?.();
		const response = await pending;
		expect(response.headers.get("x-setdraft-user")).toBe("alice");
		expect(await response.json()).toEqual({ saved: true });
		const cancelled = client.fetch("/api/projects/p/files/2.in", {
			method: "PUT",
			body: "abc",
			onUploadProgress: report,
			signal: controller.signal,
		});
		const rejection = expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejection;
	});
	it("locks the workspace when an upload receives 401", async () => {
		vi.stubGlobal("XMLHttpRequest", TestXHR);
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				Response.json({
					setupRequired: false,
					csrfToken: "csrf",
					user: { id: "alice", enabled: true, mustChangePassword: false },
				}),
			),
		);
		const client = new AuthClient();
		await client.refresh();
		const pending = client.fetch("/api/projects/p", { method: "PUT", onUploadProgress: () => {} });
		TestXHR.current.status = 401;
		TestXHR.current.onload?.();
		await expect(pending).rejects.toBeInstanceOf(AuthenticationRequired);
		expect(client.getSnapshot().status).toBe("locked");
	});
	it("propagates network errors and supports an empty response body", async () => {
		vi.stubGlobal("XMLHttpRequest", TestXHR);
		const pending = uploadRequest("/api/test", {}, () => {});
		TestXHR.current.onerror?.();
		await expect(pending).rejects.toThrow("网络");
		const empty = uploadRequest("/api/test", {}, () => {});
		TestXHR.current.status = 204;
		TestXHR.current.onload?.();
		expect(await (await empty).text()).toBe("");
	});
	it("does not resurrect another account's progress after clearing its session", async () => {
		let finish!: () => void;
		const pending = transferFiles("alice.pdf", async (report) => {
			report({ phase: "uploading", loaded: 1, total: 10 });
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			report({ phase: "saving" });
		});
		expect(transfers.getSnapshot()?.loaded).toBe(1);
		transfers.clear();
		await transferFiles("bob.pdf", async () => {});
		finish();
		await pending;
		expect(transfers.getSnapshot()).toMatchObject({ name: "bob.pdf", state: "done" });
	});
});

it("converts legacy limits to unit-free fields without changing effective limits", () => {
	expect(limitAmount("1s", "time")).toBe("1000");
	expect(limitAmount("0.5s", "time")).toBe("500");
	expect(limitAmount("250ms", "time")).toBe("250");
	expect(limitAmount("1g", "memory")).toBe("1024");
	expect(limitAmount("256m", "memory")).toBe("256");
	expect(limitAmount("32768k", "memory")).toBe("32");
});
