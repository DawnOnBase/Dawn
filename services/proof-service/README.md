# services/proof-service  ·  [the backend]

Off-chain proof validation + redundant-execution consensus .
**Stack:** TypeScript + Fastify.

`job-queue`'s coordinator `POST`s submitted proofs here. Each is validated
(signature recover via the `SignatureVerifier` seam), accumulated per job, and
once a **strict-majority quorum** of matching `outputHash`es is reached the
decision is handed to on-chain settlement — paying the agreeing nodes and
flagging dissenters for bond loss / slashing.

## Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/proofs` | `{ proof: ProofBundle, redundancy }` → validate + consensus |
| `GET` | `/healthz` | Liveness |

## Layout
- `src/consensus.ts` — pure quorum/consensus logic (fully unit-tested).
- `src/service.ts` — orchestration + `SignatureVerifier`, `SettlementSink`, `ProofStore` seams.
- `src/adapters.ts` — dev/test stubs for those seams.
- `src/app.ts`, `src/server.ts`.

## Run / test
```
bun install && bun test    # 11 tests
bunx tsc --noEmit
```

### Follow-ups (tracked, shared with the agent)
- Real EIP-712 signature recover, asserting signer == assigned operator.
- `SettlementSink` → Settlement contract: release USDC to agreeing nodes, slash
  dissenter bonds (/).
- Durable `ProofStore` (Postgres) for multi-instance + restart safety.

Depends on: `packages/shared`. Status: ** implemented (seams stubbed).**
