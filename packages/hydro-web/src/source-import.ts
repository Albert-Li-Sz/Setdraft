export interface SourceImportScope {
	projectId: string;
	signal: AbortSignal;
}

/** A source import belongs to its original editing scope and latest import for that field. */
export class SourceImports {
	private readonly pending = new Map<string, AbortController>();
	private readonly read: (file: File, signal: AbortSignal) => Promise<string>;
	private readonly current: () => SourceImportScope;
	constructor(read: (file: File, signal: AbortSignal) => Promise<string>, current: () => SourceImportScope) {
		this.read = read;
		this.current = current;
	}
	async import(field: string, file: File, apply: (text: string) => void): Promise<void> {
		this.pending.get(field)?.abort();
		const controller = new AbortController();
		this.pending.set(field, controller);
		const scope = this.current();
		const abort = () => controller.abort();
		scope.signal.addEventListener("abort", abort, { once: true });
		try {
			scope.signal.throwIfAborted();
			const text = await this.read(file, controller.signal);
			const latest = this.current();
			if (
				latest.projectId !== scope.projectId ||
				latest.signal !== scope.signal ||
				this.pending.get(field) !== controller
			)
				throw new DOMException("题目会话已变化", "AbortError");
			controller.signal.throwIfAborted();
			scope.signal.throwIfAborted();
			apply(text);
		} finally {
			scope.signal.removeEventListener("abort", abort);
			if (this.pending.get(field) === controller) this.pending.delete(field);
		}
	}
	cancel(): void {
		for (const controller of this.pending.values()) controller.abort();
		this.pending.clear();
	}
}
