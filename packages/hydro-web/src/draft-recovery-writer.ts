import type { ProjectSnapshot } from "@setdraft/contracts";
import type { DraftRecoveryStore } from "./draft-recovery.ts";

/** Keep the first edit immediately, then coalesce rapid edits without delaying departure recovery. */
export class DraftRecoveryWriter {
	private readonly store: Pick<DraftRecoveryStore, "write" | "saved">;
	private readonly onResult: (error?: unknown) => void;
	private pending?: { base: ProjectSnapshot; project: ProjectSnapshot };
	private timer?: ReturnType<typeof setTimeout>;
	private lastWrite = Number.NEGATIVE_INFINITY;
	constructor(store: Pick<DraftRecoveryStore, "write" | "saved">, onResult: (error?: unknown) => void) {
		this.store = store;
		this.onResult = onResult;
	}
	update(base: ProjectSnapshot, project: ProjectSnapshot, saved: boolean): void {
		if (this.pending && this.pending.project.id !== project.id) {
			this.flush();
			this.lastWrite = Number.NEGATIVE_INFINITY;
		}
		if (saved) {
			this.clear();
			this.lastWrite = Number.NEGATIVE_INFINITY;
			try {
				this.store.saved(project.id);
				this.onResult();
			} catch (error) {
				this.onResult(error);
			}
			return;
		}
		this.pending = { base, project };
		if (Date.now() - this.lastWrite >= 250) this.flush();
		else if (!this.timer) this.timer = setTimeout(() => this.flush(), 250 - (Date.now() - this.lastWrite));
	}
	private clear(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending = undefined;
	}
	flush = (): void => {
		const pending = this.pending;
		this.clear();
		if (!pending) return;
		this.lastWrite = Date.now();
		try {
			this.store.write(pending.base, pending.project);
			this.onResult();
		} catch (error) {
			this.onResult(error);
		}
	};
}
