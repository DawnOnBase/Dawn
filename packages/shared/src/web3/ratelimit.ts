// Client-side RPC rate limiting so Dawn's services stay under the RPC provider's
// throughput cap. Alchemy's free tier allows ~330 compute-units/second (CUPS) and
// a monthly CU budget; each JSON-RPC method costs a different number of CUs. viem's
// http transport already RETRIES on HTTP 429, but that's reactive — by the time we
// see a 429 we've already been throttled. This bucket is PROACTIVE: it meters
// outbound calls by their CU weight so we rarely trip the limit in the first place.
//
// The bucket is a per-process singleton shared across every client in the service
// (e.g. the indexer's Settlement + OperatorStaking poll loops draw from one budget),
// so the sum of a service's RPC traffic — not any single client — is what's capped.

/**
 * Approximate Alchemy compute-unit cost per JSON-RPC method (Base / Ethereum
 * pricing). Used to weight the token bucket so heavy calls (getLogs) consume more
 * budget than cheap ones (blockNumber). Unknown methods fall back to
 * {@link DEFAULT_METHOD_CU}. These are the dominant methods Dawn issues.
 */
export const RPC_METHOD_CU: Record<string, number> = {
  eth_blockNumber: 10,
  eth_getLogs: 75,
  eth_call: 26,
  eth_getBalance: 19,
  eth_getCode: 19,
  eth_getStorageAt: 17,
  eth_getBlockByNumber: 16,
  eth_getBlockByHash: 21,
  eth_getTransactionByHash: 17,
  eth_getTransactionReceipt: 15,
  eth_getTransactionCount: 19,
  eth_sendRawTransaction: 250,
  eth_estimateGas: 87,
  eth_gasPrice: 19,
  eth_feeHistory: 19,
  eth_maxPriorityFeePerGas: 19,
  eth_getProof: 79,
  eth_chainId: 0,
  net_version: 0,
};

/** CU charged for any method not in {@link RPC_METHOD_CU}. */
export const DEFAULT_METHOD_CU = 25;

/** CU cost of a JSON-RPC method, clamped to a sane minimum of 1. */
export function cuFor(method: string): number {
  const cu = RPC_METHOD_CU[method] ?? DEFAULT_METHOD_CU;
  return cu < 1 ? 1 : cu;
}

export interface TokenBucketOptions {
  /** Sustained refill rate, in compute-units per second. */
  cuPerSec: number;
  /** Bucket capacity (max burst); defaults to `cuPerSec` (≈1s of burst). */
  burst?: number;
  /** Injectable clock (ms since epoch) for deterministic tests. */
  now?: () => number;
  /** Injectable sleep so `take()` can be tested without real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Hard cap on how long one `take()` will queue before giving up (default 60s). */
  maxWaitMs?: number;
}

/**
 * A refilling token bucket measured in compute-units. `take(cost)` resolves once
 * `cost` CU are available, consuming them; concurrent callers serialize naturally
 * because token accounting (`tryTake`) is synchronous and the runtime is
 * single-threaded. As a backstop against permanent starvation, a call that has
 * waited longer than `maxWaitMs` is let through (the provider's own 429-retry then
 * absorbs any genuine overage).
 */
export class TokenBucket {
  readonly cuPerSec: number;
  readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private tokens: number;
  private last: number;

  constructor(opts: TokenBucketOptions) {
    this.cuPerSec = opts.cuPerSec > 0 ? opts.cuPerSec : 1;
    this.capacity = Math.max(this.cuPerSec, opts.burst ?? this.cuPerSec);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxWaitMs = opts.maxWaitMs ?? 60_000;
    this.tokens = this.capacity;
    this.last = this.now();
  }

  /** Add tokens accrued since the last refill, capped at capacity. */
  private refill(): void {
    const t = this.now();
    const elapsed = (t - this.last) / 1000;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.cuPerSec);
      this.last = t;
    }
  }

  /** Consume `cost` CU if available right now; returns whether it succeeded. */
  tryTake(cost: number): boolean {
    this.refill();
    const c = clampCost(cost, this.capacity);
    if (this.tokens >= c) {
      this.tokens -= c;
      return true;
    }
    return false;
  }

  /** Estimated ms until `cost` CU would be available (0 if available now). */
  waitMsFor(cost: number): number {
    this.refill();
    const c = clampCost(cost, this.capacity);
    if (this.tokens >= c) return 0;
    return Math.ceil(((c - this.tokens) / this.cuPerSec) * 1000);
  }

  /** Resolve once `cost` CU are available, consuming them. */
  async take(cost: number): Promise<void> {
    const c = clampCost(cost, this.capacity);
    const deadline = this.now() + this.maxWaitMs;
    while (!this.tryTake(c)) {
      if (this.now() >= deadline) {
        // Waited too long — let it through rather than stall the service forever;
        // the provider's 429 + viem's retry is the safety net for real overage.
        this.refill();
        this.tokens = this.tokens - c; // may go negative; refill repays the debt
        return;
      }
      await this.sleep(Math.min(this.waitMsFor(c) || 1, 250));
    }
  }
}

function clampCost(cost: number, capacity: number): number {
  if (!(cost > 0)) return 0;
  return cost > capacity ? capacity : cost;
}

/**
 * Process-wide bucket built from env on first use:
 *   RPC_CU_PER_SEC  sustained CU/s (default 200, safely under Alchemy free 330)
 *   RPC_CU_BURST    bucket capacity (default 2× the rate)
 * Lazily created so importing this module has no side effects.
 */
let shared: TokenBucket | undefined;
export function sharedRpcBucket(): TokenBucket {
  if (!shared) {
    const cuPerSec = numEnv("RPC_CU_PER_SEC", 200);
    const burst = numEnv("RPC_CU_BURST", cuPerSec * 2);
    shared = new TokenBucket({ cuPerSec, burst });
  }
  return shared;
}

/** Test-only: reset the process-wide bucket so env changes take effect. */
export function resetSharedRpcBucket(): void {
  shared = undefined;
}

function numEnv(name: string, fallback: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
