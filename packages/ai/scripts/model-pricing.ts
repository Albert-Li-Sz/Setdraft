import type { ModelCost } from "../src/types.ts";

/** Negative catalog rates are routing sentinels, not credit paid to the caller. */
export function normalizeModelCost(cost: ModelCost): ModelCost {
 const result = { ...cost };
 for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
  if (!Number.isFinite(cost[field]) || cost[field] < 0) { result[field] = 0; result.unknown = true; }
 }
 if (cost.tiers) result.tiers = cost.tiers.map(tier => ({ ...normalizeModelCost(tier), inputTokensAbove: tier.inputTokensAbove }));
 return result;
}
