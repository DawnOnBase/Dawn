# services/indexer  ·  [the backend]

Bridges chain → backend . **Stack:** TypeScript.

Polls Base for Settlement events and reconciles on-chain truth into the shared
`jobs` table: `JobEscrowed` → `escrowed`, `JobSettled` → `settled` (+ payout
record), `JobRefunded` → `failed`, `FeeCollected` → treasury accounting. Idempotent
via a `(blockNumber, logIndex)` cursor so replays/restarts never double-apply.

## Layout
- `src/events.ts` — decoded `SettlementEvent` union + cursor helpers (shared spec).
- `src/processor.ts` — event → state reconciliation (fully unit-tested, idempotent).
- `src/state.ts` — `JobStateWriter` seam + in-memory impl.
- `src/source.ts` — `LogSource` seam + `ArrayLogSource` for tests.
- `src/indexer.ts` — poll loop (`tick()` tested), `src/server.ts` — health + cursor.

## Run / test
```
bun install && bun test    # 5 tests
bunx tsc --noEmit
```

### Follow-ups (tracked, shared with the agent)
- Base RPC `LogSource` decoding Settlement logs (needs deployed address + ABI,).
- Postgres `JobStateWriter` (shared jobs table) + persisted cursor.
- Phase 3 (GATED): `$DAWN` token events.

Event shapes are shared (`packages/shared` + `contracts/.../Settlement.sol`).
Status: ** implemented (RPC source + PG writer are follow-ups).**
