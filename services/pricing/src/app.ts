// Fastify app for the pricing service : spot quotes for the API
// + matching, and reliability scores for matching's ranking.
//
// MarketState is provided by a MarketSource (in production: live counts from the
// job-queue/indexer). A static source backs dev/tests.

import Fastify, { type FastifyInstance } from "fastify";
import type { JobType } from "@dawn/shared";
import { spotQuote, type MarketState } from "./pricing.ts";
import { reliabilityScore, type NodeStats } from "./reliability.ts";

export interface MarketSource {
  state(): Promise<MarketState>;
}

export class StaticMarketSource implements MarketSource {
  constructor(private market: MarketState) {}
  set(market: MarketState): void {
    this.market = market;
  }
  async state(): Promise<MarketState> {
    return this.market;
  }
}

export interface AppDeps {
  market: MarketSource;
}

const JOB_TYPES: ReadonlySet<string> = new Set([
  "inference",
  "data_processing",
  "rendering",
  "fine_tune_shard",
  "general_compute",
]);

interface QuoteBody {
  jobType?: string;
  estimatedDurationSec?: number;
  minGpuTier?: number;
}

interface ReliabilityBody {
  completed?: number;
  timedOut?: number;
  mismatched?: number;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.post("/v1/quote", async (req, reply) => {
    const body = (req.body ?? {}) as QuoteBody;
    if (!JOB_TYPES.has(String(body.jobType))) return reply.code(400).send({ error: "invalid jobType" });
    if (typeof body.estimatedDurationSec !== "number" || body.estimatedDurationSec <= 0) {
      return reply.code(400).send({ error: "estimatedDurationSec must be positive" });
    }
    const market = await deps.market.state();
    const quote = spotQuote(
      { jobType: body.jobType as JobType, estimatedDurationSec: body.estimatedDurationSec, minGpuTier: body.minGpuTier },
      market,
    );
    return reply.send(quote);
  });

  app.post("/v1/reliability", async (req, reply) => {
    const body = (req.body ?? {}) as ReliabilityBody;
    const stats: NodeStats = {
      completed: body.completed ?? 0,
      timedOut: body.timedOut ?? 0,
      mismatched: body.mismatched ?? 0,
    };
    return reply.send({ score: reliabilityScore(stats) });
  });

  return app;
}
