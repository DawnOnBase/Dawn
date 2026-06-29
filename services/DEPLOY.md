# Dawn Services — Deploy Runbook

Backend services . Each ships a Dockerfile; `docker-compose.yml`
(repo root) wires them together. All images build from the **repo root** context
so the TS services can resolve `@dawn/shared` (and its bundled `viem`).

> **This doc is the local/single-host (docker-compose) path.** For **production
> managed hosting** — Fly.io configs, managed Postgres, secrets, TLS/`wss`, paid
> RPC, and the mainnet cutover — see [`deploy/README.md`](../deploy/README.md).

| Service | Lang | Port | Image build |
|---|---|---|---|
| job-queue | Go | 8090 | `docker build -f services/job-queue/Dockerfile .` |
| api | Bun | 8080 | `docker build -f services/api/Dockerfile .` |
| proof-service | Bun | 8081 | `docker build -f services/proof-service/Dockerfile .` |
| pricing | Bun | 8082 | `docker build -f services/pricing/Dockerfile .` |
| indexer | Bun | 8083 | `docker build -f services/indexer/Dockerfile .` |
| agent | Rust | — | `docker build -f apps/agent/Dockerfile .` (headless) |

## First run (compose)

Config is read from the gitignored `.env` (DATABASE_URL, chain/RPC, keys).

```bash
# 1. Apply DB migrations (creates jobs, proof_submissions, job_settlements, indexer_cursor).
docker compose run --rm --entrypoint /usr/local/bin/migrate job-queue

# 2. Build + start all services.
docker compose up --build
```

Health: every service answers `GET /healthz`.

## Environment

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | all | Supabase/Postgres DSN. Without it, services fall back to in-memory (DEV ONLY). |
| `PROOF_SERVICE_URL` | job-queue | Where the coordinator POSTs proofs (`http://proof-service:8081`). |
| `AUTH_ALLOW_ALL=1` | job-queue | Disables EIP-191 node-auth (DEV ONLY). Default = real verification. |
| `CHAIN_ID` | api, proof, indexer | `84532` Base Sepolia (default) / `8453` Base mainnet. |
| `RPC_URL` | api, proof, indexer | Base RPC; falls back to the chain's public RPC. |
| `SETTLEMENT_PRIVATE_KEY` | proof-service | Set → settle on-chain; unset → log only. |
| `X402_ONCHAIN=1` | api | Enables on-chain x402 payment verification. |
| `INDEXER_RPC=1` | indexer | Enables live Base-RPC log polling. |
| `TREASURY_ADDRESS` / `USDC_ADDRESS` / `NETWORK` | api | x402 payment requirements. |

On-chain features are **opt-in** so dev/test runs never touch a chain. Production
turns them on by supplying the keys/flags above.

## Notes

- The deployed Base Sepolia Settlement (`0xc27C681…`) and USDC address are recorded
  in `packages/shared/src/web3/addresses.ts`; services default to them.
- `SETTLEMENT_PRIVATE_KEY` for the proof-service must be funded for gas and is the
  on-chain settler — treat as a hot key; use a dedicated, rotatable account.
