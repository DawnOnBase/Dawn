# services/api  ·  [the backend]

Public entrypoint for compute buyers and AI agents .
**Stack:** TypeScript + Fastify · **Store:** Postgres (shared `jobs`
table with `job-queue`).

## Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/jobs` | Submit a job (`JobRequirements`, `amountUsdc`, `deadline`, `inputRef`) → `{ jobId, status }` |
| `GET` | `/v1/jobs/:id` | Job status |
| `GET` | `/v1/jobs/:id/result` | Result ref + attestation (when proven/settled) |
| `POST` | `/v1/jobs/x402` | x402 agent payment: `402` with requirements, then submit on a valid `X-PAYMENT` header |
| `GET` | `/healthz` | Liveness |

`jobId` is `keccak256` of the canonical job params , reused as the
Settlement contract jobId. Jobs land as `submitted`; the indexer flips them to
`escrowed` on the on-chain `JobEscrowed` event, after which `job-queue` matches them.

## Layout
- `src/app.ts` — Fastify factory + validation (testable via `inject()`).
- `src/repo/` — `JobsRepo` interface, in-memory impl (tested), Postgres impl (CI).
- `src/x402.ts` — `PaymentVerifier` seam; on-chain settle is **[shared]** with the agent.
- `src/sdk.ts` — `DawnClient` SDK.
- `src/jobid.ts`, `src/server.ts`.

## Run / test
```
bun install
bun test            # 7 tests, in-memory repo
bunx tsc --noEmit   # typecheck
DATABASE_URL=postgres://… bun run src/server.ts
```

### Follow-ups (tracked)
- Real x402 on-chain verification + Settlement escrow (shared,).
- USDC/treasury addresses — currently env, Base Sepolia default.
- Postgres repo integration tests in CI.

Depends on: `packages/shared`, `job-queue` (shared DB), `proof-service`. Status: **/ implemented.**
