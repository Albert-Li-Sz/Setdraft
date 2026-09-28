export interface SandboxPolicy {
	concurrency: number;
	concurrencyPerUser: number;
	cpus: number;
	memoryMb: number;
	maxOutstanding: number;
	maxOutstandingPerUser: number;
	queueTimeoutMs: number;
	runTimeoutMs: number;
	buildTimeoutMs: number;
}

export function sandboxPolicy(environment: NodeJS.ProcessEnv = process.env): SandboxPolicy {
	const integer = (key: string, fallback: number, max: number, min = 1): number => {
		const raw = environment[key];
		if (!raw) return fallback;
		const value = Number(raw);
		if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < min || value > max)
			throw new Error(`${key} must be an integer between ${min} and ${max}.`);
		return value;
	};
	return {
		concurrency: integer("SETDRAFT_SANDBOX_CONCURRENCY", 2, 64),
		concurrencyPerUser: integer("SETDRAFT_SANDBOX_CONCURRENCY_PER_USER", 1, 64),
		cpus: integer("SETDRAFT_SANDBOX_CPUS", 1, 64),
		memoryMb: integer("SETDRAFT_SANDBOX_MEMORY_MB", 2048, 131072, 512),
		maxOutstanding: integer("SETDRAFT_SANDBOX_MAX_OUTSTANDING", 64, 1024),
		maxOutstandingPerUser: integer("SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER", 8, 128),
		queueTimeoutMs: integer("SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS", 30 * 60_000, 86_400_000),
		runTimeoutMs: integer("SETDRAFT_SANDBOX_RUN_TIMEOUT_MS", 15 * 60_000, 86_400_000),
		buildTimeoutMs: integer("SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS", 30 * 60_000, 86_400_000),
	};
}
