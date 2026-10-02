import type { ModelCost } from "../src/types.ts";

/** Dynamic routers and negative catalog sentinels have unknown pricing. */
export function normalizeModelCost(cost: ModelCost, model?: { provider: string; id: string }): ModelCost {
	const result = { ...cost };
	if (
		model?.provider === "openrouter" &&
		["auto", "openrouter/auto", "openrouter/auto-beta", "openrouter/fusion"].includes(model.id)
	) result.unknown = true;
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		if (!Number.isFinite(cost[field]) || cost[field] < 0) {
			result[field] = 0;
			result.unknown = true;
		}
	}
	if (cost.tiers) result.tiers = cost.tiers.map(tier => ({ ...normalizeModelCost(tier), inputTokensAbove: tier.inputTokensAbove }));
	return result;
}
