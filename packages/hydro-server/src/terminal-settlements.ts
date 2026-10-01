/** Own completed work until its conditional terminal transaction commits; never repeat the work. */
export class TerminalSettlements {
	private readonly pending = new Map<string, { commit(): Promise<void>; retryAt: number; failures: number }>();
	private readonly active = new Set<string>();
	private readonly timer = setInterval(() => void this.retry(), 100);
	constructor() {
		this.timer.unref();
	}
	has(id: string): boolean {
		return this.pending.has(id);
	}
	async settle(id: string, commit: () => Promise<void>): Promise<void> {
		this.pending.set(id, { commit, retryAt: 0, failures: 0 });
		await this.tryCommit(id);
	}
	private async tryCommit(id: string): Promise<void> {
		const item = this.pending.get(id);
		if (!item || this.active.has(id) || Date.now() < item.retryAt) return;
		this.active.add(id);
		try {
			await item.commit();
			this.pending.delete(id);
		} catch {
			if (!item.failures) console.warn("Completed execution retained until terminal storage recovers.");
			item.retryAt = Date.now() + Math.min(5000, 100 * 2 ** Math.min(item.failures++, 6));
		} finally {
			this.active.delete(id);
		}
	}
	private async retry(): Promise<void> {
		await Promise.all([...this.pending.keys()].map((id) => this.tryCommit(id)));
	}
	async flush(timeoutMs = 5000): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = Date.now() + timeoutMs;
		try {
			await Promise.race([
				(async () => {
					while (this.pending.size && Date.now() < deadline) {
						await this.retry();
						if (this.pending.size) await new Promise((resolve) => setTimeout(resolve, 50));
					}
				})(),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, timeoutMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}
	stop(): void {
		clearInterval(this.timer);
	}
}
