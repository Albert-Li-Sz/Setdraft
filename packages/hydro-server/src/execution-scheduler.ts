interface Ticket {
	userId: string;
	key: string;
	exclusive: boolean;
	resolve(release: () => void): void;
	reject(error: unknown): void;
	signal: AbortSignal;
	abort(): void;
}

/** One process-wide queue; an execution slot is acquired before marking durable work running. */
export class ExecutionScheduler {
	private readonly limit: number;
	private readonly active = new Map<string, { userId: string; exclusive: boolean }>();
	private readonly waiting: Ticket[] = [];
	constructor(limit: number) {
		this.limit = limit;
	}
	acquire(userId: string, key: string, signal: AbortSignal, exclusive = false): Promise<() => void> {
		return new Promise((resolve, reject) => {
			const ticket: Ticket = {
				userId,
				key: `${userId}:${key}`,
				signal,
				exclusive,
				resolve,
				reject,
				abort: () => {
					const index = this.waiting.indexOf(ticket);
					if (index >= 0) this.waiting.splice(index, 1);
					reject(signal.reason ?? new Error("已取消"));
					this.pump();
				},
			};
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			signal.addEventListener("abort", ticket.abort, { once: true });
			this.waiting.push(ticket);
			this.pump();
		});
	}
	private pump(): void {
		for (let index = 0; index < this.waiting.length && this.active.size < this.limit; ) {
			const ticket = this.waiting[index];
			const active = [...this.active.values()];
			if (active.some((item) => item.exclusive) || (ticket.exclusive && active.length > 0)) return;
			if (active.some((item) => item.userId === ticket.userId)) {
				index++;
				continue;
			}
			this.waiting.splice(index, 1);
			ticket.signal.removeEventListener("abort", ticket.abort);
			this.active.set(ticket.key, { userId: ticket.userId, exclusive: ticket.exclusive });
			let released = false;
			ticket.resolve(() => {
				if (released) return;
				released = true;
				this.active.delete(ticket.key);
				this.pump();
			});
			if (ticket.exclusive) return;
		}
	}
}
