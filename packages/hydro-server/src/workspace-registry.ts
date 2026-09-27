import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthUser } from "@hydro-problem-make/contracts";
import { AiConfigurationStore } from "./ai-configuration.ts";
import type { ChatService } from "./chat.ts";
import { ChatRequestQueue } from "./chat-requests.ts";
import { ContestStore } from "./contests.ts";
import { ExecutionScheduler } from "./execution-scheduler.ts";
import { AuthError, type IdentityStore } from "./identity.ts";
import { ManualProjectStore } from "./manual-projects.ts";
import { TaskQueue } from "./tasks.ts";
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
	private readonly identity: IdentityStore;
	private readonly legacyProjects: ManualProjectStore;
	private readonly legacyChat: ChatService;
	private readonly workspaces = new Map<string, UserWorkspace>();
	private readonly sandbox = new ExecutionScheduler(2);
	private readonly ai = new ExecutionScheduler(4);
	private readonly probes = new Map<AbortController, { userId: string; done: Promise<unknown> }>();
	constructor(identity: IdentityStore, projects: ManualProjectStore, chat: ChatService) {
		this.identity = identity;
		this.legacyProjects = projects;
		this.legacyChat = chat;
		this.configuration = new AiConfigurationStore(
			{
				read: () => identity.getSetting("ai-config") ?? projects.database.get("ai-config", "default"),
				write: (catalog) => identity.setSetting("ai-config", catalog),
			},
			join(projects.root, "ai-config.json"),
		);
	}
	async start(): Promise<void> {
		await this.configuration.load();
		// Persist the catalog once, including an empty catalog, so old config files never resurrect it.
		if (!this.configuration.getConfiguration().error && this.identity.getSetting("ai-config") === undefined)
			this.identity.setSetting("ai-config", this.configuration.catalog);
		for (const user of this.identity.listUsers()) {
			const workspace = this.open(user);
			if (!user.enabled) await Promise.all([workspace.tasks.cancelAll(), workspace.chatRequests.cancelAll()]);
		}
	}
	get(user: AuthUser): UserWorkspace {
		if (!this.identity.getUser(user.id).enabled) throw new AuthError("请重新登录。", 401, "AUTH_REQUIRED");
		return this.open(user);
	}
	private open(user: AuthUser): UserWorkspace {
		const cached = this.workspaces.get(user.id);
		if (cached) return cached;
		const legacy = user.id === this.identity.legacyOwnerId;
		const root = legacy ? this.legacyProjects.root : join(this.legacyProjects.root, "users", user.id);
		const database = legacy ? this.legacyProjects.database : new WorkspaceDatabase(root);
		const projects = legacy
			? this.legacyProjects
			: new ManualProjectStore({
					root,
					database,
					image: this.legacyProjects.image,
					judgeLimits: this.legacyProjects.judgeLimits,
					maxFileBytes: this.legacyProjects.maxFileBytes,
					maxProjectBytes: this.legacyProjects.maxProjectBytes,
				});
		const chat = this.legacyChat.forWorkspace(root, database, this.configuration);
		const contests = new ContestStore(projects);
		const enabled = () => this.identity.getUser(user.id).enabled;
		const workspace: UserWorkspace = {
			projects,
			chat,
			contests,
			tasks: new TaskQueue(projects, contests, { scheduler: this.sandbox, userId: user.id, enabled }),
			chatRequests: new ChatRequestQueue(database, chat, { scheduler: this.ai, userId: user.id, enabled }),
		};
		this.workspaces.set(user.id, workspace);
		return workspace;
	}
	async testProfile(user: AuthUser, profileId: string): ReturnType<ChatService["testProfile"]> {
		const controller = new AbortController();
		const done = (async () => {
			const release = await this.ai.acquire(user.id, randomUUID(), controller.signal);
			try {
				controller.signal.throwIfAborted();
				this.identity.requireAdmin(user.id);
				return await this.get(user).chat.testProfile(profileId, controller.signal);
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
		const workspace = this.open(user);
		await Promise.all([workspace.tasks.cancelAll(), workspace.chatRequests.cancelAll()]);
	}
	async close(): Promise<void> {
		for (const controller of this.probes.keys()) controller.abort();
		await Promise.allSettled([...this.probes.values()].map((probe) => probe.done));
		await Promise.all(
			[...this.workspaces.values()].map(async (workspace) => {
				workspace.tasks.close();
				await Promise.all([workspace.tasks.idle(), workspace.chatRequests.close()]);
				if (workspace.projects !== this.legacyProjects) workspace.projects.database.db.close();
			}),
		);
	}
}
