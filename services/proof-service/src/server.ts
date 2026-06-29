// Entrypoint for the proof-service .

import { makeSettlementClient } from "@dawn/shared/web3";
import { buildApp } from "./app.ts";
import { LoggingSettlementSink } from "./adapters.ts";
import { configFromEnv } from "./config.ts";
import { Eip712SignatureVerifier, OnchainSettlementSink } from "./onchain.ts";
import { InMemoryProofStore, ProofService, type ProofStore, type SettlementSink } from "./service.ts";
import { PostgresProofStore } from "./store.ts";

const port = Number(process.env.PORT ?? 8081);
const cfg = configFromEnv();

// EIP-712 recovery is always real (pure crypto). On-chain settlement is opt-in.
const verifier = new Eip712SignatureVerifier(cfg.chainId, cfg.settlement);

let settlement: SettlementSink;
if (cfg.settlementKey) {
  const client = makeSettlementClient({
    chainId: cfg.chainId,
    rpcUrl: cfg.rpcUrl,
    address: cfg.settlement,
    privateKey: cfg.settlementKey,
  });
  settlement = new OnchainSettlementSink(client);
  console.log(`proof-service: on-chain settlement ON (chain ${cfg.chainId}, settlement ${cfg.settlement})`);
} else {
  settlement = new LoggingSettlementSink();
  console.log("proof-service: SETTLEMENT_PRIVATE_KEY not set — settlements logged, not submitted (DEV ONLY)");
}

const dsn = process.env.DATABASE_URL;
let store: ProofStore;
if (dsn) {
  store = new PostgresProofStore(dsn);
  console.log("proof-service: using Postgres proof store");
} else {
  store = new InMemoryProofStore();
  console.warn("proof-service: DATABASE_URL not set — in-memory proof store (DEV ONLY)");
}

const service = new ProofService(verifier, store, settlement);

const app = buildApp({ service });
app
  .listen({ port, host: "0.0.0.0" })
  .then((addr) => console.log(`proof-service: listening on ${addr}`))
  .catch((err) => {
    console.error("proof-service: failed to start", err);
    process.exit(1);
  });
