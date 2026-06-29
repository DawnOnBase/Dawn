# services/pricing  ·  [the backend]

Market signals for matching + submission quotes .
**Stack:** TypeScript + Fastify.

- **Reliability scoring** — per-node score in `[0,1]` from completion / timeout /
  mismatch history (Laplace-smoothed; mismatches weigh 2× timeouts; unknown
  nodes start neutral at 0.5). Feeds `job-queue` matching ranking.
- **Spot pricing** — quotes a job price in USDC base units from a per-job-type
  per-second base rate × GPU premium × clamped supply/demand multiplier
  (`0.5×…3×`). Used by `api` submission quotes and the x402 endpoint.

## Endpoints
| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/v1/quote` | `{ jobType, estimatedDurationSec, minGpuTier? }` → `{ amountUsdc, ratePerSec, demandMultiplier }` |
| `POST` | `/v1/reliability` | `{ completed, timedOut, mismatched }` → `{ score }` |
| `GET` | `/healthz` | Liveness |

## Layout
- `src/reliability.ts`, `src/pricing.ts` — pure logic (fully unit-tested).
- `src/app.ts` — Fastify + `MarketSource` seam, `src/server.ts`.

## Run / test
```
bun install && bun test    # 13 tests
bunx tsc --noEmit
```

### Follow-ups (tracked)
- Live `MarketSource` (open escrowed jobs vs. available nodes) from job-queue/indexer.
- Persist node stats; tune base rates from real market data.

Depends on: `packages/shared`, `indexer`. Status: ** implemented.**
