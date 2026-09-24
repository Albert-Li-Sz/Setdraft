import type { HydroJudgeLimits } from "./types.ts";

export const DEFAULT_HYDRO_JUDGE_LIMITS: HydroJudgeLimits = {
	maxTestCases: 100,
	totalTimeLimitMs: 60_000,
};

export function assertHydroJudgeLimits(limits: HydroJudgeLimits): void {
	if (!Number.isSafeInteger(limits.maxTestCases) || limits.maxTestCases < 1)
		throw new Error("Hydro maximum test case count must be a positive integer.");
	if (!Number.isSafeInteger(limits.totalTimeLimitMs) || limits.totalTimeLimitMs < 1)
		throw new Error("Hydro total time limit must be a positive integer in milliseconds.");
}

export function parseHydroTimeLimitMs(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const match = /^(?:[1-9][0-9]*|0\.[0-9]+|[1-9][0-9]*\.[0-9]+)(ms|s)$/.exec(value);
	if (!match) return undefined;
	const parsed = Number.parseFloat(value) * (match[1] === "s" ? 1000 : 1);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
