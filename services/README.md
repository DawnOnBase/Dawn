# Dawn — Backend Services

**Owner:** Dawn · **Stack:** TypeScript + Fastify (`api` + SDK) and Go (`job-queue`/matching hot path), the design · **Store:** Postgres

Off-chain services that route, validate, price, and index Dawn jobs. Each subfolder is one
deployable service; they share types from [`packages/shared`](../packages/shared). All flows are
**USDC-only / token-optional** until the Phase 3 gate .

| Service | Responsibility | the architecture |
|---------|----------------|-----------|
| [`api`](api) | Job submission API + SDK; x402 agent-payment HTTP endpoint |, |
| [`job-queue`](job-queue) | Queue + matching engine + coordinator + job state machine | |
| [`proof-service`](proof-service) | Off-chain proof validation + redundant-execution orchestration | |
| [`indexer`](indexer) | Index Settlement events → reconcile job/operator state | |
| [`pricing`](pricing) | Node reliability scoring + spot pricing | |

> **Status: stubs.** Each folder has a README describing scope; implementation per the architecture
> Phase 1–2. the backend (backend owner) confirms the final stack before service code is written.
