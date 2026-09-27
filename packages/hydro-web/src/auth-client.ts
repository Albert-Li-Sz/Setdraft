import type { AuthSession, AuthUser, UserPreferences } from "@hydro-problem-make/contracts";

export interface AuthState {
	status: "loading" | "ready" | "anonymous" | "locked" | "error";
	user: AuthUser | null;
	setupRequired: boolean;
	csrfToken?: string;
	message?: string;
}
export class AuthenticationRequired extends Error {
	constructor() {
		super("登录已过期，请重新登录。");
		this.name = "AuthenticationRequired";
	}
}

export class AuthClient {
	private state: AuthState = { status: "loading", user: null, setupRequired: false };
	private readonly listeners = new Set<() => void>();
	private controller = new AbortController();
	private generation = 0;
	private refreshVersion = 0;
	private channel?: BroadcastChannel;
	private started = false;
	getSnapshot = (): AuthState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};
	private publish(state: AuthState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	private abort(): void {
		this.generation++;
		this.controller.abort();
		this.controller = new AbortController();
	}
	start(): void {
		if (this.started) return;
		this.started = true;
		if (typeof window !== "undefined" && typeof BroadcastChannel !== "undefined") {
			this.channel = new BroadcastChannel("setdraft-auth");
			this.channel.onmessage = (event: MessageEvent<unknown>) => {
				if (event.data === "logout") {
					this.refreshVersion++;
					this.abort();
					this.publish({ status: "anonymous", user: null, setupRequired: false });
				} else if (event.data === "profile") {
					void this.refresh();
				} else if (event.data === "changed") {
					this.lock();
					void this.refresh();
				}
			};
		}
		void this.refresh();
	}
	private accept(session: AuthSession): void {
		if (session.user?.id !== this.state.user?.id || session.csrfToken !== this.state.csrfToken) this.abort();
		this.publish({ ...session, status: session.user ? "ready" : "anonymous" });
	}
	lock(): void {
		this.refreshVersion++;
		if (this.state.status === "locked" || this.state.status === "anonymous") return;
		this.abort();
		this.publish({ ...this.state, status: this.state.user ? "locked" : "anonymous", csrfToken: undefined });
	}
	async refresh(): Promise<void> {
		const version = ++this.refreshVersion;
		try {
			const response = await fetch("/api/auth/session", { credentials: "same-origin", cache: "no-store" });
			if (!response.ok) throw new Error("无法连接登录服务，请重试。");
			const session = (await response.json()) as AuthSession;
			if (version !== this.refreshVersion) return;
			if (!session.user && this.state.user) this.lock();
			else this.accept(session);
		} catch (error) {
			if (version !== this.refreshVersion) return;
			if (this.state.user) this.lock();
			else
				this.publish({
					...this.state,
					status: "error",
					message: error instanceof Error ? error.message : "无法连接登录服务，请重试。",
				});
		}
	}
	private async authRequest(path: string, method: string, body?: unknown): Promise<AuthSession> {
		this.refreshVersion++;
		const response = await fetch(`/api/auth/${path}`, {
			method,
			credentials: "same-origin",
			headers: {
				"content-type": "application/json",
				...(this.state.csrfToken ? { "x-csrf-token": this.state.csrfToken } : {}),
			},
			body: JSON.stringify(body ?? {}),
		});
		const value = (await response.json()) as AuthSession & { message?: string };
		if (!response.ok) {
			if (path !== "login" && path !== "setup" && (response.status === 401 || response.status === 403)) this.lock();
			throw new Error(value.message ?? "请求失败，请重试。");
		}
		return value;
	}
	async authenticate(
		mode: "login" | "setup",
		input: { username: string; password: string; setupToken?: string },
	): Promise<void> {
		this.accept(await this.authRequest(mode, "POST", input));
		this.channel?.postMessage("changed");
	}
	async changePassword(currentPassword: string, password: string): Promise<void> {
		this.accept(await this.authRequest("password", "PUT", { currentPassword, password }));
		this.channel?.postMessage("changed");
	}
	async updateProfile(input: Omit<UserPreferences, "avatar"> & { avatar?: string | null }): Promise<void> {
		const generation = this.generation;
		const response = await this.fetch("/api/auth/profile", {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		const value = (await response.json()) as AuthSession & { message?: string };
		if (generation !== this.generation) throw new DOMException("Session changed", "AbortError");
		if (!response.ok) throw new Error(value.message ?? "设置保存失败。");
		this.refreshVersion++;
		this.accept(value);
		this.channel?.postMessage("profile");
	}
	async logout(): Promise<void> {
		const snapshot = await this.authRequest("logout", "POST");
		this.accept(snapshot);
		this.channel?.postMessage("logout");
	}
	async fetch(url: string, init: RequestInit = {}): Promise<Response> {
		if (this.started && (this.state.status !== "ready" || this.state.user?.mustChangePassword))
			throw new AuthenticationRequired();
		const generation = this.generation;
		const headers = new Headers(init.headers);
		if (!["GET", "HEAD", "OPTIONS"].includes(init.method?.toUpperCase() ?? "GET") && this.state.csrfToken)
			headers.set("x-csrf-token", this.state.csrfToken);
		const signal = init.signal ? AbortSignal.any([init.signal, this.controller.signal]) : this.controller.signal;
		const response = await fetch(url, { ...init, headers, signal, credentials: "same-origin" });
		if (generation !== this.generation) throw new DOMException("Session changed", "AbortError");
		const responseUser = response.headers.get("x-setdraft-user");
		if (responseUser && this.state.user && responseUser !== this.state.user.id) {
			this.lock();
			void this.refresh();
			throw new AuthenticationRequired();
		}
		if (response.status === 401) {
			this.lock();
			throw new AuthenticationRequired();
		}
		if (response.status === 403) {
			const value = (await response
				.clone()
				.json()
				.catch(() => undefined)) as { error?: string } | undefined;
			if (value?.error === "PASSWORD_CHANGE_REQUIRED" || value?.error === "CSRF_INVALID") {
				this.lock();
				void this.refresh();
				throw new AuthenticationRequired();
			}
		}
		return response;
	}
}
export const authClient = new AuthClient();
export const authFetch = (url: string, init?: RequestInit): Promise<Response> => authClient.fetch(url, init);
