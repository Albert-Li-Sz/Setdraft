/** Serializes callbacks from streaming clients without losing errors or terminal event ordering. */
export class EventWriter {
	private pending: Promise<void> = Promise.resolve();
	private error?: unknown;
	private readonly abort: () => void;
	constructor(abort: () => void) {
		this.abort = abort;
	}
	append(write: () => Promise<void>): void {
		this.pending = this.pending
			.then(async () => {
				if (!this.error) await write();
			})
			.catch((error: unknown) => {
				this.error = error;
				this.abort();
			});
	}
	async flush(): Promise<void> {
		await this.pending;
		if (this.error) throw this.error;
	}
}
