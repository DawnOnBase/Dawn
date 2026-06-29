// Entrypoint for the API service .

import type { Address } from "@dawn/shared";
import { CHAIN_IDS, makePublicClient, type DawnChainId } from "@dawn/shared/web3";
import { buildApp } from "./app.ts";
import { InMemoryJobsRepo, type JobsRepo } from "./repo/jobs.ts";
import { PostgresJobsRepo } from "./repo/postgres.ts";
import { OnchainPaymentVerifier, StubPaymentVerifier, type PaymentVerifier } from "./x402.ts";

const port = Number(process.env.PORT ?? 8080);
const dsn = process.env.DATABASE_URL;

// USDC addresses are the design (the agent-owned, treasury TBD).
// Base Sepolia USDC default; override via env for mainnet.
const usdcAsset = (process.env.USDC_ADDRESS ?? "0x036CbD53842c5426634e7929541eC2318f3dCF7e") as Address;
const treasury = (process.env.TREASURY_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;
const network = (process.env.NETWORK as "base" | "base-sepolia") ?? "base-sepolia";

const repo: JobsRepo = dsn ? new PostgresJobsRepo(dsn) : new InMemoryJobsRepo();
if (!dsn) console.warn("api: DATABASE_URL not set — using in-memory repo (DEV ONLY)");

// On-chain x402 verification is enabled when a chain is configured; otherwise
// the stub sentinel verifier runs (DEV ONLY — payments are NOT confirmed).
let verifier: PaymentVerifier;
if (process.env.X402_ONCHAIN === "1") {
  const chainId = Number(process.env.CHAIN_ID ?? CHAIN_IDS.baseSepolia) as DawnChainId;
  verifier = new OnchainPaymentVerifier(makePublicClient(chainId, process.env.RPC_URL));
  console.log(`api: x402 on-chain verification ON (chain ${chainId})`);
} else {
  verifier = new StubPaymentVerifier();
  console.warn("api: X402_ONCHAIN!=1 — using stub payment verifier (DEV ONLY, payments NOT confirmed)");
}

const app = buildApp({
  repo,
  verifier,
  usdcAsset,
  treasury,
  network,
});

app
  .listen({ port, host: "0.0.0.0" })
  .then((addr) => console.log(`api: listening on ${addr}`))
  .catch((err) => {
    console.error("api: failed to start", err);
    process.exit(1);
  });
