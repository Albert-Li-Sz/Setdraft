import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthUser, SearchSnapshot } from "@setdraft/contracts";
import { AiConfigurationStore } from "./ai-configuration.ts";
import type { ChatService } from "./chat.ts";
import { ChatRequestQueue } from "./chat-requests.ts";
import { ContestStore } from "./contests.ts";
import { ExecutionScheduler } from "./execution-scheduler.ts";
import { AuthError, type IdentityStore } from "./identity.ts";
import { ManualProjectStore } from "./manual-projects.ts";
import { TaskQueue } from "./tasks.ts";
import { WebSearch } from "./web-search.ts";
import { WorkspaceDatabase } from "./workspace-db.ts";

export interface UserWorkspace {
	projects: ManualProjectStore;
	chat: ChatService;
	contests: ContestStore;
	tasks: TaskQueue;
	chatRequests: ChatRequestQueue;
}

export class WorkspaceRegistry {
	readonly configuration: AiConfigurationStore;
	readonly search: WebSearch;
	private readonly identity: IdentityStore;
	private readonly projectTemplate: ManualProjectStore;
	private readonly chatTemplate: ChatService;
	private readonly workspaces = new Map<string, UserWorkspace>();
	private readonly sandbox = new ExecutionScheduler(2);
	private readonly ai = new ExecutionScheduler(4);
	private readonly probes = new Map<AbortController, { userId: string; done: Promise<unknown> }>();
	constructor(identity: IdentityStore, projects: ManualProjectStore, chat: ChatService) {
		this.identity = identity;
		this.search = new WebSearch(identity);
		this.projectTemplate = projects;
		this.chatTemplate = chat;
		this.configuration = new AiConfigurationStore(
			{
				read: async () => await identity.getSetting("ai-config"),
				write: async (catalog) => await identity.setSetting("ai-config", catalog),
			},
			join(projects.root, "ai-config.json"),
		);
	}
	async start(): Promise<void> {
		await this.configuration.load();
		// Persist the catalog once, including an empty catalog, so old config files never resurrect it.
		if (!this.configuration.getConfiguration().error && (await this.identity.getSetting("ai-config")) === undefined)
			await this.identity.setSetting("ai-config", this.configuration.catalog);
		for (const user of await this.identity.listUsers()) {
			const workspace = await this.open(user);
			if (!user.enabled) await Promise.all([workspace.tasks.cancelAll(), workspace.chatRequests.cancelAll()]);
		}
	}
	async get(user: AuthUser): Promise<UserWorkspace> {
		if (!(await this.identity.getUser(user.id)).enabled) throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
		return await this.open(user);
	}
	private async open(user: AuthUser): Promise<UserWorkspace> {
		const cached = this.workspaces.get(user.id);
		if (cached) {
			await Promise.all([cached.tasks.ready, cached.chatRequests.ready]);
			return cached;
		}
		const root = join(this.identity.root, "users", user.id);
		const database = new WorkspaceDatabase(root, user.id);
		const projects = new ManualProjectStore({
			root,
			database,
			image: this.projectTemplate.image,
			judgeLimits: this.projectTemplate.judgeLimits,
			maxFileBytes: this.projectTemplate.maxFileBytes,
			maxProjectBytes: this.projectTemplate.maxProjectBytes,
		});
		const chat = this.chatTemplate.forWorkspace(root, database, this.configuration, {
			service: this.search,
			userId: user.id,
		});
		const contests = new ContestStore(projects);
		const enabled = async () => (await this.identity.getUser(user.id)).enabled;
		const workspace: UserWorkspace = {
			projects,
			chat,
			contests,
			tasks: new TaskQueue(projects, contests, { scheduler: this.sandbox, userId: user.id, enabled }),
			chatRequests: new ChatRequestQueue(database, chat, { scheduler: this.ai, userId: user.id, enabled }),
		};
		this.workspaces.set(user.id, workspace);
		await Promise.all([workspace.tasks.ready, workspace.chatRequests.ready]);
		return workspace;
	}
	async testProfile(user: AuthUser, profileId: string): ReturnType<ChatService["testProfile"]> {
		return this.probe(user, async (signal) => (await this.get(user)).chat.testProfile(profileId, signal));
	}
	async testSearch(user: AuthUser): Promise<SearchSnapshot> {
		return this.probe(user, async (signal) => {
			const { projects } = await this.get(user);
			const requestId = randomUUID();
			try {
				return await this.search.search(projects.database, user.id, requestId, "SearXNG documentation", signal);
			} finally {
				await projects.database.delete("search-cache", `request:${requestId}`);
			}
		});
	}
	private async probe<T>(user: AuthUser, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		const done = (async () => {
			const release = await this.ai.acquire(user.id, randomUUID(), controller.signal);
			try {
				controller.signal.throwIfAborted();
				await this.identity.requireAdmin(user.id);
				return await run(controller.signal);
			} finally {
				release();
			}
		})();
		this.probes.set(controller, { userId: user.id, done });
		try {
			return await done;
		} finally {
			this.probes.delete(controller);
		}
	}
	async disable(user: AuthUser): Promise<void> {
		for (const [controller, probe] of this.probes) if (probe.userId === user.id) controller.abort();
		const workspace = await this.open(user);
		await Promise.all([workspace.tasks.cancelAll(), workspace.chatRequests.cancelAll()]);
	}
	async close(): Promise<void> {
		for (const controller of this.probes.keys()) controller.abort();
		await Promise.allSettled([...this.probes.values()].map((probe) => probe.done));
		await Promise.all(
			[...this.workspaces.values()].map(async (workspace) => {
				workspace.tasks.close();
				await Promise.all([workspace.tasks.idle(), workspace.chatRequests.close()]);
			}),
		);
	}
}
