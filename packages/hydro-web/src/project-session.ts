import { type ProjectSnapshot, readProjectSnapshot } from "@setdraft/contracts";
import { RevisionConflict } from "./api-client.ts";
import { editableProject } from "./problem.ts";

export interface ProjectSessionState {
	project?: ProjectSnapshot;
	status: "saved" | "dirty" | "saving" | "conflict" | "error";
	conflict?: ProjectSnapshot;
	error?: string;
}

/** Owns revision ordering, edits made during saves, conflict blocking, and session replacement. */
export class ProjectSession {
	private state: ProjectSessionState = { status: "saved" };
	private readonly listeners = new Set<() => void>();
	private readonly save: (project: ProjectSnapshot, signal: AbortSignal) => Promise<ProjectSnapshot>;
	private readonly onError: (error: unknown) => void;
	private generation = 0;
	private version = 0;
	private savedVersion = 0;
	private blocked = false;
	private paused = false;
	private remote?: ProjectSnapshot;
	private controller = new AbortController();
	private timer?: ReturnType<typeof setTimeout>;
	private flight?: Promise<void>;

	constructor(
		save: (project: ProjectSnapshot, signal: AbortSignal) => Promise<ProjectSnapshot>,
		onError: (error: unknown) => void = () => {},
	) {
		this.save = save;
		this.onError = onError;
	}

	getSnapshot = (): ProjectSessionState => this.state;
	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	get signal(): AbortSignal {
		return this.controller.signal;
	}

	private publish(state: ProjectSessionState): void {
		this.state = state;
		for (const listener of this.listeners) listener();
	}
	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	open(project?: ProjectSnapshot): void {
		if (project) readProjectSnapshot(project);
		this.clearTimer();
		this.controller.abort();
		this.controller = new AbortController();
		this.generation++;
		this.version = this.savedVersion = 0;
		this.flight = undefined;
		this.blocked = false;
		this.remote = undefined;
		this.publish({ project, status: "saved" });
	}

	accept(project: ProjectSnapshot): void {
		if (this.state.project?.id !== project.id || this.blocked) return;
		readProjectSnapshot(project);
		if (project.revision < this.state.project.revision) return;
		const dirty = this.version > this.savedVersion;
		this.publish({
			project: dirty
				? { ...project, ...editableProject(this.state.project), oracle: this.state.project.oracle }
				: project,
			status: dirty ? "dirty" : "saved",
		});
	}

	conflict(project: ProjectSnapshot): void {
		if (this.state.project?.id !== project.id) return;
		this.clearTimer();
		this.blocked = true;
		this.remote = project;
		this.publish({
			...this.state,
			status: "conflict",
			conflict: project,
			error: "题目版本已变化，请加载服务器版本后继续。",
		});
	}
	dismissConflict(): void {
		this.publish({ ...this.state, conflict: undefined });
	}

	edit(change: (project: ProjectSnapshot) => ProjectSnapshot): void {
		if (!this.state.project) return;
		this.version++;
		this.publish({ ...this.state, project: change(this.state.project), status: this.blocked ? "conflict" : "dirty" });
		this.clearTimer();
		if (!this.blocked && !this.paused) this.timer = setTimeout(() => void this.flush().catch(this.onError), 650);
	}

	pause(): void {
		this.paused = true;
		this.clearTimer();
		this.controller.abort();
		this.controller = new AbortController();
		this.generation++;
		this.flight = undefined;
		if (this.version > this.savedVersion && !this.blocked) this.publish({ ...this.state, status: "dirty" });
	}
	resume(): void {
		const wasPaused = this.paused;
		this.paused = false;
		if (wasPaused && this.version > this.savedVersion && !this.blocked) void this.flush().catch(this.onError);
	}

	flush(): Promise<void> {
		this.clearTimer();
		if (this.paused) return Promise.reject(new DOMException("Authentication required", "AbortError"));
		if (this.blocked) {
			this.publish({ ...this.state, conflict: this.remote });
			return Promise.reject(new Error(this.state.error));
		}
		if (this.flight) return this.flight;
		const generation = this.generation;
		const signal = this.controller.signal;
		const flight = Promise.resolve()
			.then(async () => {
				while (generation === this.generation && this.state.project && this.version > this.savedVersion) {
					const project = this.state.project;
					const sentVersion = this.version;
					this.publish({ ...this.state, status: "saving", error: undefined });
					try {
						const saved = readProjectSnapshot(await this.save(project, signal));
						if (generation !== this.generation) return;
						if (saved.id !== project.id || saved.revision <= project.revision)
							throw new Error("服务端返回的题目版本无效。");
						if (this.blocked) throw new Error(this.state.error);
						this.savedVersion = sentVersion;
						this.accept(saved);
					} catch (error) {
						if (generation !== this.generation) return;
						if (error instanceof RevisionConflict) this.conflict(error.current);
						else if (!this.blocked)
							this.publish({
								...this.state,
								status: "error",
								error: error instanceof Error ? error.message : "题目保存失败。",
							});
						throw error;
					}
				}
			})
			.finally(() => {
				if (this.flight === flight) this.flight = undefined;
			});
		this.flight = flight;
		return flight;
	}

	dispose(): void {
		this.clearTimer();
		this.controller.abort();
		this.generation++;
		this.flight = undefined;
	}
}
