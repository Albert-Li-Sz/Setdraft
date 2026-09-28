export function chatPolicy(environment: NodeJS.ProcessEnv = process.env) {
	const integer = (key: string, fallback: number, max: number): number => {
		const raw = environment[key];
		if (!raw) return fallback;
		const value = Number(raw);
		if (!/^\d+$/u.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max)
			throw new Error(`${key} must be an integer between 1 and ${max}.`);
		return value;
	};
	return {
		concurrency: integer("SETDRAFT_AI_CONCURRENCY", 4, 64),
		concurrencyPerUser: 1,
		maxOutstanding: integer("SETDRAFT_AI_MAX_OUTSTANDING", 64, 1024),
		maxOutstandingPerUser: integer("SETDRAFT_AI_MAX_OUTSTANDING_PER_USER", 8, 128),
		queueTimeoutMs: integer("SETDRAFT_AI_QUEUE_TIMEOUT_MS", 30 * 60_000, 86_400_000),
		runTimeoutMs: integer("SETDRAFT_AI_RUN_TIMEOUT_MS", 15 * 60_000, 86_400_000),
		retentionMs: 7 * 86_400_000,
		maxRetainedRequests: 200,
	};
}
export type ChatPolicy = ReturnType<typeof chatPolicy>;
