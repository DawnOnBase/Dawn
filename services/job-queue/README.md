# services/job-queue  ·  [the backend]

The heart of the network .

- **Queue** — durable, ordered task distribution (Postgres-backed to start; Redis/NATS later if needed).
- **Matching engine** — route jobs by hardware capability, geo proximity, reliability score, and spot price.
- **Coordinator** — Phase 1 may be centralized; design for decentralization in Phase 4.
- **Job lifecycle state machine** — `submitted → escrowed → matched → running → proven → settled / failed / timed_out` (`JobStatus` in `packages/shared`).

**Stack:** Go (hot path, the design). Domain types are mirrored from
`packages/shared` into `internal/domain` (TS stays the Shared source of truth).

Depends on: `packages/shared`, `pricing`, `indexer`.

### Status
- [x] Job lifecycle **state machine** — `internal/statemachine`.
- [x] **Queue** abstraction — `internal/queue` (in-memory impl, full unit tests).
- [x] **Postgres** backend — `internal/store/postgres` + `migrations/0001_init.sql`
      (`FOR UPDATE SKIP LOCKED` claim). Compiles; live-DB integration tests run in
      CI (`DATABASE_URL`) — no local Postgres in this env.
- [x] **Matching engine** — `internal/matching` (hw-cap eligibility + pay/urgency
      ranking; reliability/spot-price weights plug in from `pricing`).
- [x] **Coordinator + WebSocket server** — `internal/coordinator`, `internal/wsserver`
      implementing the shared agent protocol (`packages/shared`). End-to-end
      round-trip test (hello→pull→submit) over a real WebSocket.
- [x] **Entrypoint** — `cmd/job-queue` (env config, timeout sweeper, graceful shutdown).

**Run:** `PORT=8090 DATABASE_URL=postgres://… go run ./cmd/job-queue` (omit
`DATABASE_URL` for the in-memory dev backend).

### Follow-ups (tracked)
- Real node-wallet signature auth (replace `AllowAllAuth`,).
- Forward proofs to `proof-service` over HTTP (currently logged).
- Reliability/spot-price weighting fed from `pricing`.
