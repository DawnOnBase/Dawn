// Live MarketSource : derives demand/supply signals from the
// shared `jobs` table so spot pricing tracks the real market.
//
//   openJobs       = jobs awaiting an operator (submitted/escrowed)
//   availableNodes = distinct operators active within a recent window
//
// CachedMarketSource fronts it with a short TTL so a burst of quotes doesn't
// hammer Postgres.

import postgres from "postgres";
import type { MarketSource } from "./app.ts";
import type { MarketState } from "./pricing.ts";

export interface PostgresMarketSourceOptions {
  /** Operators that touched a job within this many seconds count as available. */
  activeWindowSec?: number;
}

export class PostgresMarketSource implements MarketSource {
  private readonly sql: postgres.Sql;
  private readonly activeWindowSec: number;

  constructor(dsn: string, opts: PostgresMarketSourceOptions = {}) {
    this.sql = postgres(dsn);
    this.activeWindowSec = opts.activeWindowSec ?? 900;
  }

  async state(): Promise<MarketState> {
    const [open] = await this.sql<{ n: number }[]>`
      SELECT COUNT(*)::int AS n FROM jobs WHERE status IN ('submitted', 'escrowed')`;
    const [nodes] = await this.sql<{ n: number }[]>`
      SELECT COUNT(DISTINCT operator)::int AS n FROM jobs
      WHERE operator IS NOT NULL
        AND updated_at > now() - make_interval(secs => ${this.activeWindowSec})`;
    return { openJobs: open?.n ?? 0, availableNodes: nodes?.n ?? 0 };
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

/** Wraps a MarketSource with a TTL cache to bound DB load under quote bursts. */
export class CachedMarketSource implements MarketSource {
  private cached?: { at: number; state: MarketState };

  constructor(
    private readonly inner: MarketSource,
    private readonly ttlMs = 5000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async state(): Promise<MarketState> {
    const t = this.now();
    if (this.cached && t - this.cached.at < this.ttlMs) return this.cached.state;
    const state = await this.inner.state();
    this.cached = { at: t, state };
    return state;
  }
}
