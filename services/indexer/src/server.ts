// Entrypoint for the indexer : runs the poll loop and exposes
// a health endpoint reporting the current cursor.

import Fastify from "fastify";
import type { Address } from "@dawn/shared";
import { CHAIN_IDS, type DawnChainId } from "@dawn/shared/web3";
import { EventProcessor } from "./processor.ts";
import { Indexer, type CursorStore } from "./indexer.ts";
import { ArrayLogSource, type LogSource } from "./source.ts";
import { RpcLogSource } from "./rpcsource.ts";
import { RpcStakeLogSource } from "./rpcstakesource.ts";
import { InMemoryStakeStateWriter, StakeIndexer, StakeProcessor } from "./stake.ts";
import { InMemoryJobStateWriter, type JobStateWriter } from "./state.ts";
import { PostgresIndexerStore } from "./pgstate.ts";

const port = Number(process.env.PORT ?? 8083);

async function main(): Promise<void> {
  // Live Base-RPC source when a chain is configured (INDEXER_RPC=1); otherwise an
  // empty source so the service still boots for health checks in dev.
  let source: LogSource;
  if (process.env.INDEXER_RPC === "1") {
    const chainId = Number(process.env.CHAIN_ID ?? CHAIN_IDS.baseSepolia) as DawnChainId;
    source = new RpcLogSource({ chainId, rpcUrl: process.env.RPC_URL });
    console.log(`indexer: polling Settlement logs on chain ${chainId}`);
  } else {
    source = new ArrayLogSource([]);
    console.warn("indexer: INDEXER_RPC!=1 — no live source (DEV ONLY, nothing indexed)");
  }

  // Persist reconciled state + cursor to Postgres when configured; resume from
  // the saved cursor so a restart doesn't re-scan from the deploy block.
  const dsn = process.env.DATABASE_URL;
  let writer: JobStateWriter;
  let cursorStore: CursorStore | undefined;
  let pgStore: PostgresIndexerStore | undefined;
  let startCursor = null;
  if (dsn) {
    pgStore = new PostgresIndexerStore(dsn);
    writer = pgStore;
    cursorStore = pgStore;
    startCursor = await pgStore.load();
    console.log(`indexer: using Postgres state store (resume cursor: ${JSON.stringify(startCursor)})`);
  } else {
    writer = new InMemoryJobStateWriter();
    console.warn("indexer: DATABASE_URL not set — in-memory state, no cursor persistence (DEV ONLY)");
  }

  // Poll cadence is env-tunable so RPC pressure can be dialed down without a
  // redeploy if the provider's free-tier budget gets tight (default 5s).
  const pollMs = Number(process.env.INDEXER_POLL_MS ?? 5000);
  const processor = new EventProcessor(writer, startCursor);
  const indexer = new Indexer(source, processor, pollMs, cursorStore);

  // M9 stake reconciliation feeding the matcher's StakeOracle. Runs only when the OperatorStaking
  // vault address is configured (the redundant-flow contract — not yet deployed), so it stays
  // dormant for the single-node deployment.
  let stakeIndexer: StakeIndexer | undefined;
  const stakeAddr = process.env.OPERATOR_STAKING_ADDRESS as Address | undefined;
  if (process.env.INDEXER_RPC === "1" && stakeAddr) {
    const chainId = Number(process.env.CHAIN_ID ?? CHAIN_IDS.baseSepolia) as DawnChainId;
    const stakeWriter = pgStore ?? new InMemoryStakeStateWriter();
    const stakeStart = pgStore ? await pgStore.loadStake() : null;
    const stakeSource = new RpcStakeLogSource({
      chainId,
      address: stakeAddr,
      rpcUrl: process.env.RPC_URL,
      deployBlock: process.env.OPERATOR_STAKING_DEPLOY_BLOCK
        ? BigInt(process.env.OPERATOR_STAKING_DEPLOY_BLOCK)
        : undefined,
    });
    const stakeProcessor = new StakeProcessor(stakeWriter, stakeStart);
    stakeIndexer = new StakeIndexer(stakeSource, stakeProcessor, pollMs, pgStore);
    console.log(`indexer: polling OperatorStaking logs at ${stakeAddr} on chain ${chainId}`);
  }

  const app = Fastify({ logger: false });
  app.get("/healthz", async () => ({ status: "ok", cursor: processor.position() }));

  // M9 watchtower (S2): the candidate set of redundant jobs awaiting re-execution. A buyer's-keeper
  // watchtower passes ?buyer=0x… to scope to its own jobs; the watchtower reads the authoritative
  // consensus window/winningHash from chain before challenging. Needs the Postgres store.
  app.get<{ Querystring: { buyer?: string } }>("/v1/pending-consensus", async (req, reply) => {
    if (!pgStore) return reply.code(503).send({ error: "no state store (set DATABASE_URL)" });
    const buyer = req.query.buyer as Address | undefined;
    return { jobs: await pgStore.pendingConsensusJobs(buyer) };
  });

  const addr = await app.listen({ port, host: "0.0.0.0" });
  console.log(`indexer: health on ${addr}`);
  void indexer.run();
  if (stakeIndexer) void stakeIndexer.run();
}

main().catch((err) => {
  console.error("indexer: failed to start", err);
  process.exit(1);
});
