// Spot pricing engine . Quotes a job price in USDC base units
// (6 dp) from a base per-second rate scaled by hardware premium and live
// supply/demand. Used by the API (submission quotes) and matching/x402.

import type { JobType } from "@dawn/shared";

// Base rate per second, in USDC base units (1_000_000 = 1 USDC). Illustrative
// Phase 1 defaults; tune from real market data later.
const BASE_RATE_PER_SEC: Record<JobType, number> = {
  inference: 200,
  data_processing: 80,
  rendering: 150,
  fine_tune_shard: 300,
  general_compute: 60,
};

export interface QuoteInput {
  jobType: JobType;
  estimatedDurationSec: number;
  minGpuTier?: number;
}

export interface MarketState {
  openJobs: number;
  availableNodes: number;
}

export interface Quote {
  amountUsdc: string; // total, USDC base units
  ratePerSec: number;
  demandMultiplier: number;
}

const DEMAND_MIN = 0.5;
const DEMAND_MAX = 3.0;

/** Demand multiplier from the open-jobs : available-nodes ratio, clamped. */
export function demandMultiplier(market: MarketState): number {
  if (market.availableNodes <= 0) return DEMAND_MAX; // scarce supply -> max price
  const ratio = market.openJobs / market.availableNodes;
  return clamp(1 + 0.5 * (ratio - 1), DEMAND_MIN, DEMAND_MAX);
}

export function spotQuote(input: QuoteInput, market: MarketState): Quote {
  const base = BASE_RATE_PER_SEC[input.jobType];
  const gpuPremium = 1 + 0.5 * nonNeg(input.minGpuTier ?? 0);
  const demand = demandMultiplier(market);
  const ratePerSec = base * gpuPremium * demand;
  const duration = Math.max(1, Math.floor(input.estimatedDurationSec));
  const amount = Math.ceil(ratePerSec * duration);
  return { amountUsdc: String(amount), ratePerSec, demandMultiplier: demand };
}

function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}
