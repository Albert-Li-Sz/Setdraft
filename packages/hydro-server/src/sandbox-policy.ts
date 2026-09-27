export interface SandboxPolicy {
	concurrency: number;
	maxOutstanding: number;
	maxOutstandingPerUser: number;
	queueTimeoutMs: number;
	runTimeoutMs: number;
	buildTimeoutMs: number;
}

export function sandboxPolicy(environment: NodeJS.ProcessEnv = process.env): SandboxPolicy {
	const integer = (key: string, fallback: number, max: number): number => {
		const raw = environment[key];
		if (!raw) return fallback;
		const value = Number(raw);
		if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max)
			throw new Error(`${key} must be an integer between 1 and ${max}.`);
		return value;
	};
	return {
		concurrency: integer("SETDRAFT_SANDBOX_CONCURRENCY", 2, 16),
		maxOutstanding: integer("SETDRAFT_SANDBOX_MAX_OUTSTANDING", 64, 1024),
		maxOutstandingPerUser: integer("SETDRAFT_SANDBOX_MAX_OUTSTANDING_PER_USER", 8, 128),
		queueTimeoutMs: integer("SETDRAFT_SANDBOX_QUEUE_TIMEOUT_MS", 30 * 60_000, 86_400_000),
		runTimeoutMs: integer("SETDRAFT_SANDBOX_RUN_TIMEOUT_MS", 15 * 60_000, 86_400_000),
		buildTimeoutMs: integer("SETDRAFT_SANDBOX_BUILD_TIMEOUT_MS", 30 * 60_000, 86_400_000),
	};
}
