import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthSession, AuthUser } from "@setdraft/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatService } from "../src/chat.ts";
import { IdentityStore } from "../src/identity.ts";
import { ManualProjectStore } from "../src/manual-projects.ts";
import { createHydroServer } from "../src/server.ts";
import { WorkspaceDatabase } from "../src/workspace-db.ts";

let root: string;
let origin: string;
let identity: IdentityStore;
let projects: ManualProjectStore;
let server: Awaited<ReturnType<typeof createHydroServer>>;
let setupCode: string;
const password = "correct horse battery staple";
class BrowserClient {
	cookie = "";
	csrf = "";
	async request(path: string, method = "GET", data?: unknown): Promise<Response> {
		const response = await fetch(`${origin}/api${path}`, {
			method,
			headers: {
				origin,
				cookie: this.cookie,
				"x-csrf-token": this.csrf,
				...(data === undefined ? {} : { "content-type": "application/json" }),
			},
			body: data === undefined ? undefined : JSON.stringify(data),
		});
		const cookie = response.headers.get("set-cookie");
		if (cookie) this.cookie = cookie.split(";", 1)[0];
		return response;
	}
	async authenticate(mode = "login", username = "administrator", pass = password): Promise<AuthSession> {
		const response = await this.request(`/auth/${mode}`, "POST", { username, password: pass, setupToken: setupCode });
		expect(response.status).toBe(200);
		const session = (await response.json()) as AuthSession;
		this.csrf = session.csrfToken ?? "";
		return session;
	}
	async createMember(name: string): Promise<{ client: BrowserClient; user: AuthUser }> {
		const response = await this.request("/admin/users", "POST", { username: name });
		expect(response.status).toBe(201);
		const result = (await response.json()) as { user: AuthUser; temporaryPassword: string };
		const client = new BrowserClient();
		await client.authenticate("login", name, result.temporaryPassword);
		expect((await client.request("/projects")).status).toBe(403);
		const changed = await client.request("/auth/password", "PUT", {
			currentPassword: result.temporaryPassword,
			password,
		});
		expect(changed.status).toBe(200);
		client.csrf = ((await changed.json()) as AuthSession).csrfToken ?? "";
		return { client, user: result.user };
	}
}
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "setdraft-auth-api-"));
	identity = new IdentityStore(root);
	setupCode = await identity.rotateSetupToken();
	projects = new ManualProjectStore({ root });
	const chat = new ChatService({
		root,
		database: projects.database,
		configPath: join(root, "ai-config.json"),
		client: async ({ onDelta, signal, context }) => {
			if (JSON.stringify(context).includes("hold-stream"))
				await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			onDelta("private answer");
			return "private answer";
		},
	});
	server = await createHydroServer({ projects, chat, identity });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await server.closeWorkspaces();
	identity.close();
	projects.database.sql.close();
	await rm(root, { recursive: true, force: true });
});

describe("authenticated personal workspaces", () => {
	it("fails closed before setup, validates exact origins and CSRF, and uses HttpOnly sessions", async () => {
		const client = new BrowserClient();
		expect(await (await client.request("/health")).json()).toEqual({ status: "ok" });
		for (const path of ["/projects", "/chats", "/ai/config", "/tasks", "/system/status", "/releases/unknown/hydro"])
			expect((await client.request(path)).status).toBe(401);
		const untrusted = await fetch(`${origin}/api/auth/setup`, {
			method: "POST",
			headers: { origin: "http://127.0.0.1:9999", "content-type": "application/json" },
			body: JSON.stringify({ setupToken: setupCode, username: "attacker", password }),
		});
		expect(untrusted.status).toBe(403);
		const response = await client.request("/auth/setup", "POST", {
			setupToken: setupCode,
			username: "administrator",
			password,
		});
		expect(response.headers.get("set-cookie")).toMatch(/HttpOnly; SameSite=Lax/u);
		const session = (await response.json()) as AuthSession;
		expect((await client.request("/projects", "POST", { scoringMode: "acm" })).status).toBe(403);
		client.csrf = session.csrfToken ?? "";
		expect((await client.request("/projects", "POST", { scoringMode: "acm" })).status).toBe(201);
		expect(
			(await client.request("/auth/setup", "POST", { setupToken: setupCode, username: "other", password })).status,
		).toBe(409);
		const oldCookie = client.cookie;
		await client.request("/auth/logout", "POST");
		client.cookie = oldCookie;
		expect((await client.request("/projects")).status).toBe(401);
	});
	it("isolates IDs, files, downloads, and task actions in fresh personal workspaces", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const legacy = (await (await admin.request("/projects", "POST", { scoringMode: "acm" })).json()) as {
			id: string;
		};
		const { client: a } = await admin.createMember("alice");
		const { client: b, user: bob } = await admin.createMember("bob");
		expect(((await (await admin.request("/projects")).json()) as { projects: { id: string }[] }).projects[0].id).toBe(
			legacy.id,
		);
		expect(await (await a.request("/projects")).json()).toEqual({ projects: [] });
		const project = (await (await b.request("/projects", "POST", { scoringMode: "acm" })).json()) as { id: string };
		const chat = (await (await b.request("/chats", "POST")).json()) as { id: string };
		const contest = (await (
			await b.request("/contests", "POST", { title: "Private contest", slug: "private-contest" })
		).json()) as { id: string };
		expect(
			(
				await b.request(`/projects/${project.id}/cases`, "POST", {
					name: "secret.in",
					input: "private test",
					output: "private output",
				})
			).status,
		).toBe(201);
		const privateDatabase = new WorkspaceDatabase(join(root, "users", bob.id));
		const releaseId = randomUUID(),
			bundleId = randomUUID();
		try {
			await privateDatabase.commitFiles(
				[
					{
						ownerKind: "release-file",
						ownerId: releaseId,
						name: "hydro.zip",
						source: { bytes: Buffer.from("private release") },
					},
					{
						ownerKind: "contest-bundle",
						ownerId: bundleId,
						name: "bundle.zip",
						source: { bytes: Buffer.from("private contest") },
					},
				],
				async () => {
					await privateDatabase.put("release", releaseId, {
						id: releaseId,
						projectId: project.id,
						slug: "private",
						createdAt: new Date().toISOString(),
					});
					await privateDatabase.put("contest-release", bundleId, {
						id: bundleId,
						slug: "private",
						format: "hydro",
						createdAt: new Date().toISOString(),
					});
				},
			);
		} finally {
			privateDatabase.sql.close();
		}
		expect(await (await b.request(`/releases/${releaseId}/hydro`)).text()).toBe("private release");
		expect(await (await b.request(`/contest-releases/${bundleId}/download`)).text()).toBe("private contest");
		const task = (await (await b.request(`/projects/${project.id}/generate`, "POST")).json()) as {
			task: { id: string };
		};
		for (const client of [a, admin]) {
			for (const path of [
				`/projects/${project.id}`,
				`/projects/${project.id}/files/secret.in`,
				`/chats/${chat.id}`,
				`/chats/${chat.id}/requests`,
				`/contests/${contest.id}`,
				`/tasks/${task.task.id}`,
				`/tasks/${task.task.id}/events`,
				`/releases/${releaseId}/hydro`,
				`/contest-releases/${bundleId}/download`,
			])
				expect((await client.request(path)).status, path).toBe(404);
			for (const path of [`/tasks/${task.task.id}/cancel`, `/tasks/${task.task.id}/retry`])
				expect((await client.request(path, "POST")).status).toBe(404);
			expect((await client.request(`/projects/${project.id}`, "DELETE")).status).toBe(404);
		}
		expect(await (await b.request(`/projects/${project.id}/files/secret.in`)).text()).toBe("private test");
		expect((await b.request(`/projects/${project.id}`)).status).toBe(200);
	});
	it("isolates draft history, insight reports, and revision-checked restores", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const { client: owner } = await admin.createMember("author");
		const { client: other } = await admin.createMember("other");
		const project = (await (await owner.request("/projects", "POST", { scoringMode: "acm" })).json()) as {
			id: string;
		};
		expect(
			(await owner.request(`/projects/${project.id}`, "PUT", { title: "Saved title", expectedRevision: 0 })).status,
		).toBe(200);
		for (const client of [admin, other]) {
			for (const path of ["authoring-insights", "drafts", "drafts/0"])
				expect((await client.request(`/projects/${project.id}/${path}`)).status).toBe(404);
			expect(
				(await client.request(`/projects/${project.id}/drafts/0/restore`, "POST", { expectedRevision: 1 })).status,
			).toBe(404);
		}
		expect((await owner.request(`/projects/${project.id}/authoring-insights`)).status).toBe(200);
		expect((await owner.request(`/projects/${project.id}/drafts/0`)).status).toBe(200);
		const drafts = (await (await owner.request(`/projects/${project.id}/drafts`)).json()) as {
			drafts: { revision: number }[];
		};
		expect(drafts.drafts.map((draft) => draft.revision)).toEqual([1, 0]);
		const csrf = owner.csrf;
		owner.csrf = "wrong";
		expect(
			(await owner.request(`/projects/${project.id}/drafts/0/restore`, "POST", { expectedRevision: 1 })).status,
		).toBe(403);
		owner.csrf = csrf;
		expect(
			(await owner.request(`/projects/${project.id}/drafts/0/restore`, "POST", { expectedRevision: 0 })).status,
		).toBe(409);
		const restored = await owner.request(`/projects/${project.id}/drafts/0/restore`, "POST", {
			expectedRevision: 1,
		});
		expect(restored.status).toBe(200);
		expect(await restored.json()).toMatchObject({ id: project.id, revision: 2, title: "" });
	});
	it("shares administrator models, hides keys, and denies member management and sandbox access", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const { client } = await admin.createMember("alice");
		const config = {
			name: "Team",
			provider: "openai-completions",
			modelId: "faux",
			apiKey: "secret-team-credential",
		};
		expect((await admin.request("/ai/config", "PUT", config)).status).toBe(200);
		const response = await client.request("/ai/config");
		const text = await response.text();
		expect(text).toContain("Team");
		expect(text).not.toContain(config.apiKey);
		for (const [path, method, data] of [
			["/ai/config", "PUT", config],
			["/ai/config", "DELETE", undefined],
			["/sandbox/build", "POST", undefined],
			["/admin/users", "GET", undefined],
			["/admin/users", "POST", { username: "intruder" }],
		] as const)
			expect((await client.request(path, method, data)).status).toBe(403);
		const chat = (await (await client.request("/chats", "POST")).json()) as { id: string };
		const requestId = randomUUID();
		expect(
			(
				await client.request(`/chats/${chat.id}/messages`, "POST", {
					requestId,
					message: "hello",
					images: [
						{
							name: "pixel.png",
							mimeType: "image/png",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
						},
					],
				})
			).status,
		).toBe(202);
		const stream = await client.request(`/chats/${chat.id}/requests/${requestId}/events`);
		expect(await stream.text()).toContain("private answer");
		const conversation = (await (await client.request(`/chats/${chat.id}`)).json()) as {
			messages: Array<{ images?: Array<{ id: string }> }>;
		};
		const imageId = conversation.messages[0].images?.[0].id;
		expect(imageId).toBeTruthy();
		expect((await client.request(`/chats/${chat.id}/images/${imageId}`)).status).toBe(200);
		expect((await admin.request(`/chats/${chat.id}/images/${imageId}`)).status).toBe(404);
		for (const action of ["cancel", "retry"])
			expect((await admin.request(`/chats/${chat.id}/requests/${requestId}/${action}`, "POST")).status).toBe(404);

		expect((await admin.request(`/chats/${chat.id}/requests/${requestId}/events`)).status).toBe(404);
	});
	it("closes existing SSE and cancels work when a member is disabled", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const { client, user } = await admin.createMember("alice");
		await admin.request("/ai/config", "PUT", {
			name: "Team",
			provider: "openai-completions",
			modelId: "faux",
			apiKey: "fake-key",
		});
		const chat = (await (await client.request("/chats", "POST")).json()) as { id: string };
		const requestId = randomUUID();
		await client.request(`/chats/${chat.id}/messages`, "POST", { requestId, message: "hold-stream" });
		const stream = await client.request(`/chats/${chat.id}/requests/${requestId}/events`);
		const reader = stream.body?.getReader();
		expect(reader).toBeDefined();
		await reader?.read();
		if (!reader) throw new Error("SSE reader missing");
		const closed = (async () => {
			try {
				while (!(await reader.read()).done) {}
			} catch (error) {
				if (!(error instanceof TypeError)) throw error;
			}
			return true;
		})();
		expect((await admin.request(`/admin/users/${user.id}`, "PATCH", { enabled: false })).status).toBe(200);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await expect(
				Promise.race([
					closed,
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error("SSE did not close after revocation")), 3000);
					}),
				]),
			).resolves.toBe(true);
		} finally {
			clearTimeout(timer);
			await reader.cancel().catch(() => {});
		}
		expect((await client.request("/projects")).status).toBe(401);
		expect((await admin.request(`/admin/users/${user.id}`, "PATCH", { enabled: true })).status).toBe(200);
		await client.authenticate("login", "alice");
		const request = (await (await client.request(`/chats/${chat.id}/requests/${requestId}`)).json()) as {
			state: string;
		};
		expect(request.state).toBe("failed");
	});
	it("restores account ownership, cookies and shared configuration on restart", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const { client } = await admin.createMember("alice");
		const project = (await (await client.request("/projects", "POST", { scoringMode: "acm" })).json()) as {
			id: string;
		};
		await admin.request("/ai/config", "PUT", {
			name: "Team",
			provider: "openai-completions",
			modelId: "faux",
			apiKey: "fake",
		});
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await server.closeWorkspaces();
		identity.close();
		projects.database.sql.close();
		identity = new IdentityStore(root);
		projects = new ManualProjectStore({ root });
		server = await createHydroServer({
			identity,
			projects,
			chat: new ChatService({
				root,
				database: projects.database,
				configPath: join(root, "ai-config.json"),
				client: async () => "faux",
			}),
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		expect((await client.request(`/projects/${project.id}`)).status).toBe(200);
		expect((await admin.request(`/projects/${project.id}`)).status).toBe(404);
		expect(await (await client.request("/ai/config")).text()).toContain("Team");
	});
	it("persists personal preferences without changing another user or revoking the current session", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const { client, user } = await admin.createMember("alice");
		const avatar =
			"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==";
		const saved = await client.request("/auth/profile", "PUT", { locale: "en", avatar });
		expect(saved.status).toBe(200);
		expect(await saved.json()).toMatchObject({ user: { id: user.id, locale: "en", avatar }, csrfToken: client.csrf });
		expect((await client.request("/projects")).status).toBe(200);
		const reopened = new IdentityStore(root);
		try {
			expect(await reopened.getUser(user.id)).toMatchObject({ locale: "en", avatar });
		} finally {
			reopened.close();
		}
		expect(((await (await admin.request("/auth/session")).json()) as AuthSession).user?.avatar).toBeUndefined();
		for (const input of [
			{ locale: "fr" },
			{ avatar: "data:image/svg+xml;base64,PHN2Zz4=" },
			{ avatar: "data:image/png;base64,bm90LXBuZw==" },
		])
			expect((await client.request("/auth/profile", "PUT", input)).status).toBe(422);
		client.csrf = "wrong";
		expect((await client.request("/auth/profile", "PUT", { locale: "zh-CN" })).status).toBe(403);
		await client.authenticate("login", "alice");
		expect(
			((await (await client.request("/auth/profile", "PUT", { avatar: null })).json()) as AuthSession).user?.avatar,
		).toBeUndefined();
	});
	it("copies only an owned problem into another enabled user's independent workspace", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		const { client: a, user: alice } = await admin.createMember("alice");
		const { client: b, user: bob } = await admin.createMember("bob");
		const project = (await (await a.request("/projects", "POST", { scoringMode: "acm" })).json()) as {
			id: string;
			revision: number;
		};
		await a.request(`/projects/${project.id}`, "PUT", {
			title: "Copy me",
			reference: { language: "cpp17", code: "private source" },
			expectedRevision: 0,
		});
		await a.request(`/projects/${project.id}/cases`, "POST", { input: "private data", output: "answer" });
		const current = (await (await a.request(`/projects/${project.id}`)).json()) as { revision: number };
		for (const intruder of [admin, b]) {
			expect(
				(
					await intruder.request(`/projects/${project.id}/copy`, "POST", {
						recipientId: alice.id,
						expectedRevision: current.revision,
					})
				).status,
			).toBe(404);
			expect((await intruder.request(`/projects/${project.id}/releases`)).status).toBe(404);
			expect(
				(
					await intruder.request(`/projects/${project.id}/releases/${randomUUID()}/restore`, "POST", {
						expectedRevision: current.revision,
					})
				).status,
			).toBe(404);
		}
		const people = (await (await a.request("/people")).json()) as { users: Array<{ id: string; username: string }> };
		expect(people.users).toContainEqual({ id: bob.id, username: "bob" });
		expect(people.users.some((user) => user.id === alice.id)).toBe(false);
		const result = await a.request(`/projects/${project.id}/copy`, "POST", {
			recipientId: bob.id,
			expectedRevision: current.revision,
		});
		expect(result.status).toBe(201);
		const copied = (await result.json()) as { id: string };
		expect(copied.id).not.toBe(project.id);
		expect(await (await b.request(`/projects/${copied.id}`)).json()).toMatchObject({
			title: "Copy me",
			reference: { code: "private source" },
			revision: 0,
		});
		expect(await (await b.request(`/projects/${copied.id}/files/1.in`)).text()).toBe("private data");
		expect((await a.request(`/projects/${copied.id}`)).status).toBe(404);
		await b.request(`/projects/${copied.id}`, "PUT", { title: "Bob's copy", expectedRevision: 0 });
		expect(await (await a.request(`/projects/${project.id}`)).json()).toMatchObject({ title: "Copy me" });
		await admin.request(`/admin/users/${bob.id}`, "PATCH", { enabled: false });
		expect(
			(
				await a.request(`/projects/${project.id}/copy`, "POST", {
					recipientId: bob.id,
					expectedRevision: current.revision,
				})
			).status,
		).toBe(404);
	}, 15000);

	it.each([
		["https://team.example", "team.example"],
		["http://team.example", "team.example"],
		["http://192.168.1.20", "192.168.1.20"],
		["http://[2001:db8::20]", "[2001:db8::20]"],
		[undefined, "192.168.1.20"],
		[undefined, "[2001:db8::20]"],
	] as const)(
		"authenticates with configured origin %s and host %s while enforcing Host, Origin and CSRF",
		async (publicOrigin, host) => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await server.closeWorkspaces();
			server = await createHydroServer({
				identity,
				projects,
				publicOrigin,
				chat: new ChatService({ root, database: projects.database, configPath: join(root, "ai-config.json") }),
			});
			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
			origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
			const browserOrigin = publicOrigin ?? `http://${host}:${new URL(origin).port}`;
			const request = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) =>
				new Promise<{ status: number | undefined; cookie: string; text: string }>((resolve, reject) => {
					const connection = httpRequest(
						`${origin}/api${path}`,
						{
							method,
							headers: {
								origin: browserOrigin,
								host: new URL(browserOrigin).host,
								"content-type": "application/json",
								...headers,
							},
						},
						(response) => {
							let text = "";
							response.setEncoding("utf8");
							response.on("data", (chunk: string) => {
								text += chunk;
							});
							response.on("error", reject);
							response.on("end", () =>
								resolve({
									status: response.statusCode,
									cookie: response.headers["set-cookie"]?.[0] ?? "",
									text,
								}),
							);
						},
					);
					connection.on("error", reject);
					connection.end(body === undefined ? undefined : JSON.stringify(body));
				});
			const setup = vi.spyOn(identity, "setup");
			const credentials = { username: "administrator", password, setupToken: setupCode };
			const response = await request("/auth/setup", "POST", credentials, { "x-forwarded-for": "192.0.2.20" });
			expect(response.status).toBe(200);
			expect(setup).toHaveBeenCalledWith(credentials, publicOrigin ? "192.0.2.20" : "127.0.0.1");
			if (browserOrigin.startsWith("https:"))
				expect(response.cookie).toMatch(/^__Host-setdraft-session=.*; Secure$/u);
			else {
				expect(response.cookie).toMatch(/^setdraft-session=.*; Path=\/; HttpOnly; SameSite=Lax;/u);
				expect(response.cookie).not.toContain("Secure");
			}
			const cookie = response.cookie.split(";", 1)[0];
			const session = JSON.parse(response.text) as AuthSession;
			expect((await request("/projects", "GET", undefined, { cookie })).status).toBe(200);
			expect((await request("/projects", "POST", { scoringMode: "acm" }, { cookie })).status).toBe(403);
			expect(
				(
					await request(
						"/projects",
						"POST",
						{ scoringMode: "acm" },
						{ cookie, "x-csrf-token": session.csrfToken ?? "" },
					)
				).status,
			).toBe(201);
			expect((await request("/auth/login", "POST", credentials, { origin })).status).toBe(403);
			expect(
				(await request("/auth/login", "POST", credentials, { origin: "http://untrusted.example" })).status,
			).toBe(403);
			expect((await request("/auth/session", "GET", undefined, { host: "untrusted.example" })).status).toBe(403);
			if (!publicOrigin) {
				const wrongPort = `http://${host}:${Number(new URL(origin).port) + 1}`;
				expect((await request("/auth/login", "POST", credentials, { origin: wrongPort })).status).toBe(403);
				expect(
					(await request("/auth/session", "GET", undefined, { host: new URL(wrongPort).host, origin: wrongPort }))
						.status,
				).toBe(403);
			}
			expect(
				(await request("/auth/logout", "POST", undefined, { cookie, "x-csrf-token": session.csrfToken ?? "" }))
					.status,
			).toBe(200);
			expect((await request("/projects", "GET", undefined, { cookie })).status).toBe(401);
			expect((await request("/auth/login", "POST", credentials)).status).toBe(200);
		},
	);
	it("shares four AI slots across users, limits each user to one and keeps jobs on logout", async () => {
		const admin = new BrowserClient();
		await admin.authenticate("setup");
		await admin.request("/ai/config", "PUT", {
			name: "Team",
			provider: "openai-completions",
			modelId: "faux",
			apiKey: "fake",
		});
		const clients = [admin];
		for (let index = 0; index < 4; index++) clients.push((await admin.createMember(`member${index}`)).client);
		const jobs: Array<{ client: BrowserClient; chatId: string; requestId: string }> = [];
		for (const client of [admin, admin, ...clients.slice(1)]) {
			const chat = (await (await client.request("/chats", "POST")).json()) as { id: string };
			const requestId = randomUUID();
			expect(
				(await client.request(`/chats/${chat.id}/messages`, "POST", { requestId, message: "hold-stream" })).status,
			).toBe(202);
			jobs.push({ client, chatId: chat.id, requestId });
		}
		const states = async () =>
			Promise.all(
				jobs.map(
					async ({ client, chatId, requestId }) =>
						((await (await client.request(`/chats/${chatId}/requests/${requestId}`)).json()) as { state: string })
							.state,
				),
			);
		await vi.waitFor(async () =>
			expect(await states()).toEqual(["running", "queued", "running", "running", "running", "queued"]),
		);
		await admin.request("/auth/logout", "POST");
		await admin.authenticate("login");
		expect((await states())[0]).toBe("running");
		await admin.request(`/chats/${jobs[0].chatId}/requests/${jobs[0].requestId}/cancel`, "POST");
		await vi.waitFor(async () => expect((await states())[1]).toBe("running"));
		for (const job of jobs) await job.client.request(`/chats/${job.chatId}/requests/${job.requestId}/cancel`, "POST");
	}, 20000);
});
