import type { AuthSession } from "@setdraft/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthClient, AuthenticationRequired } from "../src/auth-client.ts";

const snapshot = (id = "alice", csrfToken = "csrf-a"): AuthSession => ({
	user: {
		id,
		username: id,
		role: "user",
		enabled: true,
		mustChangePassword: false,
		createdAt: new Date(0).toISOString(),
	},
	setupRequired: false,
	csrfToken,
});
afterEach(() => vi.unstubAllGlobals());

describe("authentication request boundary", () => {
	it("updates preferences without interrupting business requests and rejects a late result after logout", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(snapshot()));
		vi.stubGlobal("fetch", fetcher);
		const client = new AuthClient();
		await client.refresh();
		let finishBusiness!: (response: Response) => void;
		fetcher.mockImplementationOnce((_url, options) => {
			expect(options?.signal?.aborted).toBe(false);
			return new Promise<Response>((resolve) => {
				finishBusiness = resolve;
			});
		});
		const business = client.fetch("/api/projects");
		const profile = snapshot();
		if (profile.user) profile.user.locale = "en";
		fetcher.mockResolvedValueOnce(Response.json(profile));
		await client.updateProfile({ locale: "en" });
		expect(client.getSnapshot()).toMatchObject({ status: "ready", user: { locale: "en" } });
		finishBusiness(Response.json({ projects: [] }));
		await expect(business).resolves.toBeInstanceOf(Response);
		let finishProfile!: (response: Response) => void;
		fetcher.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					finishProfile = resolve;
				}),
		);
		const pending = client.updateProfile({ locale: "zh-CN" });
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		fetcher.mockResolvedValueOnce(Response.json({ user: null, setupRequired: false }));
		await client.logout();
		finishProfile(Response.json(profile));
		await rejected;
		expect(client.getSnapshot().user).toBeNull();
	});
	it("attaches CSRF, stops work on 401, retains identity, and resumes after same-account login", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(snapshot()));
		vi.stubGlobal("fetch", fetcher);
		const client = new AuthClient();
		client.start();
		await vi.waitFor(() => expect(client.getSnapshot().status).toBe("ready"));
		fetcher.mockResolvedValueOnce(Response.json({ error: "AUTH_REQUIRED" }, { status: 401 }));
		await expect(client.fetch("/api/projects/p", { method: "PUT", body: "draft" })).rejects.toBeInstanceOf(
			AuthenticationRequired,
		);
		const options = fetcher.mock.calls[1][1];
		expect(new Headers(options?.headers).get("x-csrf-token")).toBe("csrf-a");
		expect(options?.credentials).toBe("same-origin");
		expect(client.getSnapshot()).toMatchObject({ status: "locked", user: { id: "alice" } });
		await expect(client.fetch("/api/tasks")).rejects.toBeInstanceOf(AuthenticationRequired);
		expect(fetcher).toHaveBeenCalledTimes(2);
		fetcher.mockResolvedValueOnce(Response.json(snapshot("alice", "csrf-b")));
		await client.authenticate("login", { username: "alice", password: "fake-test-password" });
		expect(client.getSnapshot()).toMatchObject({ status: "ready", csrfToken: "csrf-b" });
	});
	it("rejects stale responses after switching identity and drops identity on explicit logout", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json(snapshot()));
		vi.stubGlobal("fetch", fetcher);
		const client = new AuthClient();
		await client.refresh();
		let finish!: (response: Response) => void;
		fetcher.mockImplementationOnce(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		const pending = client.fetch("/api/projects");
		const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
		fetcher.mockResolvedValueOnce(Response.json(snapshot("bob")));
		await client.authenticate("login", { username: "bob", password: "fake-test-password" });
		finish(Response.json({ privateAliceData: true }));
		await rejected;
		fetcher.mockResolvedValueOnce(Response.json({ user: null, setupRequired: false }));
		await client.logout();
		expect(client.getSnapshot()).toMatchObject({ status: "anonymous", user: null });
	});
	it("locks when a password change encounters a revoked session", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json(snapshot()))
			.mockResolvedValueOnce(Response.json({ message: "expired" }, { status: 401 }));
		vi.stubGlobal("fetch", fetcher);
		const client = new AuthClient();
		await client.refresh();
		await expect(client.changePassword("temporary", "new-test-password")).rejects.toThrow("expired");
		expect(client.getSnapshot().status).toBe("locked");
	});
	it("synchronizes logout and account switches between tabs", async () => {
		const channels: FakeChannel[] = [];
		class FakeChannel {
			onmessage?: (event: { data: unknown }) => void;
			constructor() {
				channels.push(this);
			}
			postMessage(data: unknown) {
				for (const channel of channels) if (channel !== this) channel.onmessage?.({ data });
			}
		}
		let current: AuthSession = snapshot();
		vi.stubGlobal("window", {});
		vi.stubGlobal("BroadcastChannel", FakeChannel);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json(current)),
		);
		const first = new AuthClient(),
			second = new AuthClient();
		first.start();
		second.start();
		await vi.waitFor(() => expect(second.getSnapshot().status).toBe("ready"));
		current = snapshot("bob");
		await first.authenticate("login", { username: "bob", password: "fake-test-password" });
		await vi.waitFor(() => expect(second.getSnapshot().user?.id).toBe("bob"));
		current = { user: null, setupRequired: false };
		await first.logout();
		expect(second.getSnapshot()).toMatchObject({ status: "anonymous", user: null });
	});
	it("discards responses served under another tab's changed cookie identity", async () => {
		const fetcher = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json(snapshot()))
			.mockResolvedValueOnce(Response.json({ privateData: "bob" }, { headers: { "x-setdraft-user": "bob" } }))
			.mockResolvedValueOnce(Response.json(snapshot("bob")));
		vi.stubGlobal("fetch", fetcher);
		const client = new AuthClient();
		await client.refresh();
		await expect(client.fetch("/api/projects")).rejects.toBeInstanceOf(AuthenticationRequired);
		await vi.waitFor(() => expect(client.getSnapshot().user?.id).toBe("bob"));
	});
});
