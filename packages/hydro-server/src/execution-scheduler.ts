interface Ticket {
	userId: string;
	key: string;
	exclusive: boolean;
	resolve(release: () => void): void;
	reject(error: unknown): void;
	signal: AbortSignal;
	abort(): void;
}

export class QueueAdmissionError extends Error {
	readonly statusCode: number;
	constructor(message: string, statusCode = 429) {
		super(message);
		this.statusCode = statusCode;
	}
}

/** One process-wide queue; an execution slot is acquired before marking durable work running. */
export class ExecutionScheduler {
	private readonly limit: number;
	private readonly perUserLimit: number;
	private readonly active = new Map<string, { userId: string; exclusive: boolean }>();
	private readonly waiting: Ticket[] = [];
	private readonly pauses = new Set<string>();
	private readonly turns = new Map<string, number>();
	private turn = 0;
	private readonly reservations = new Map<string, { userId: string; exclusive: boolean }>();
	private readonly capacity?: { maxOutstanding: number; maxOutstandingPerUser: number };
	constructor(
		limit: number,
		capacity?: { maxOutstanding: number; maxOutstandingPerUser: number; concurrencyPerUser?: number },
	) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Execution concurrency must be positive.");
		this.limit = limit;
		this.perUserLimit = capacity?.concurrencyPerUser ?? 1;
		if (!Number.isSafeInteger(this.perUserLimit) || this.perUserLimit < 1)
			throw new Error("Per-user execution concurrency must be positive.");
		this.capacity = capacity;
	}
	/** Reserve admission before the durable insert; recovered work may exceed newly lowered limits. */
	reserve(userId: string, key: string, exclusive = false, recovered = false): () => void {
		const id = `${userId}:${key}`;
		if (this.reservations.has(id)) throw new Error("Task already reserved.");
		if (!recovered) {
			if (exclusive && [...this.reservations.values()].some((item) => item.exclusive))
				throw new QueueAdmissionError("已有沙箱镜像构建任务，请等待其完成。", 409);
			if (this.capacity && this.reservations.size >= this.capacity.maxOutstanding)
				throw new QueueAdmissionError("全站任务队列已满，请稍后重试。");
			if (
				this.capacity &&
				[...this.reservations.values()].filter((item) => item.userId === userId).length >=
					this.capacity.maxOutstandingPerUser
			)
				throw new QueueAdmissionError("你的未完成任务已达上限，请等待完成或取消排队任务。");
		}
		this.reservations.set(id, { userId, exclusive });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.reservations.delete(id);
		};
	}
	status(userId: string) {
		return {
			paused: this.pauses.size > 0,
			concurrency: this.limit,
			running: this.active.size,
			outstanding: this.reservations.size,
			userRunning: [...this.active.values()].some((item) => item.userId === userId),
			userAtCapacity: [...this.active.values()].filter((item) => item.userId === userId).length >= this.perUserLimit,
			maintenance: [...this.active.values(), ...this.waiting].some((item) => item.exclusive),
		};
	}
	/** Fail closed during an unconfirmed container stop, across every workspace sharing this scheduler. */
	pause(key: string): () => void {
		this.pauses.add(key);
		let resumed = false;
		return () => {
			if (resumed) return;
			resumed = true;
			this.pauses.delete(key);
			this.pump();
		};
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
			if (this.active.has(ticket.key) || this.waiting.some((item) => item.key === ticket.key)) {
				reject(new Error("Execution already scheduled."));
				return;
			}
			if (!this.turns.has(userId)) this.turns.set(userId, this.turn++);
			signal.addEventListener("abort", ticket.abort, { once: true });
			this.waiting.push(ticket);
			this.pump();
		});
	}
	private pump(): void {
		if (this.pauses.size) return;
		while (this.waiting.length && this.active.size < this.limit) {
			const active = [...this.active.values()];
			if (active.some((item) => item.exclusive)) return;
			// A build is a barrier: drain earlier work, then run it alone. Later jobs cannot starve it.
			const barrier = this.waiting.findIndex((item) => item.exclusive);
			const candidates = barrier < 0 ? this.waiting : this.waiting.slice(0, barrier || 1);
			let ticket: Ticket | undefined;
			for (const candidate of candidates) {
				if (candidate.exclusive && active.length) continue;
				if (active.filter((item) => item.userId === candidate.userId).length >= this.perUserLimit) continue;
				if (!ticket || (this.turns.get(candidate.userId) ?? 0) < (this.turns.get(ticket.userId) ?? 0))
					ticket = candidate;
			}
			if (!ticket) return;
			const index = this.waiting.indexOf(ticket);
			this.waiting.splice(index, 1);
			this.turns.set(ticket.userId, this.turn++);
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
