# Dawn — Production Deploy (Fly.io)

Managed-hosting runbook for the Dawn backend (M6). For local/single-host runs use
[`docker-compose.yml`](../docker-compose.yml) + [`services/DEPLOY.md`](../services/DEPLOY.md)
instead — this doc is the **production** path: managed Postgres, secrets, TLS/`wss`, paid RPC.

The same Dockerfiles run anywhere Docker does, so [Railway](#railway-alternative) (or any
container host) works too; only the config wrappers differ.

## Topology

```
                         Internet
                            │
        ┌───────────────────┼────────────────────┐
        │ (https)           │ (wss)              │ (https, Vercel)
   ┌────▼─────┐      ┌───────▼────────┐      ┌────▼─────────────┐
   │ dawn-api │      │ dawn-job-queue │      │ frontend (Vercel)│
   │  :8080   │      │   :8090 /agent │      │   axion site     │
   └────┬─────┘      └───────┬────────┘      └──────────────────┘
        │                    │ http://dawn-proof-service.internal:8081
        │            ┌───────▼────────┐
        │            │ dawn-proof-svc │──── settle() ──▶ Base (Settlement)
        │            │     :8081      │
        │            └────────────────┘
        │   ┌────────────────┐   ┌──────────────┐
        └───│  dawn-indexer  │   │ dawn-pricing │   (internal)
            │  :8083 (RPC)   │   │    :8082     │
            └───────┬────────┘   └──────┬───────┘
                    └──── managed Postgres (Supabase) ◀──── all services
```

| App | Public? | Port | Notes |
|---|---|---|---|
| `dawn-api` | ✅ https | 8080 | Buyer + SDK API; x402 endpoint. |
| `dawn-job-queue` | ✅ wss | 8090 | Agent WebSocket at `/agent`; runs DB migrations on deploy. |
| `dawn-proof-service` | internal | 8081 | Verify/record proofs + on-chain settler (hot key). |
| `dawn-indexer` | internal | 8083 | Polls Base RPC → DB job state. |
| `dawn-pricing` | internal | 8082 | Quotes. |
| frontend | ✅ (Vercel) | — | Already deploys to Vercel; point it at `dawn-api`. |
| agent | — | — | Desktop client, not hosted; connects to `wss://…/agent`. |

Inter-service calls use Fly's private network (`<app>.internal`), so only `dawn-api` and
`dawn-job-queue` need public IPs.

## Prerequisites

- [`flyctl`](https://fly.io/docs/flyctl/install/) + `fly auth login`
- A managed Postgres — **Supabase** (recommended) or `fly postgres create`. Get its DSN.
- A **paid Base RPC** URL (Alchemy / QuickNode) — the public RPC will rate-limit the indexer.
- A funded **settler key** for the proof-service (gas only; rotatable).
- The deployed `Settlement` address (Base Sepolia: `0xc27C…651E`, see
  [`packages/shared/src/web3/addresses.ts`](../packages/shared/src/web3/addresses.ts)).

## Deploy (first time)

```bash
# 1. Create the five apps (no deploy yet).
for s in api job-queue proof-service indexer pricing; do fly apps create "dawn-$s"; done

# 2. Provision Postgres (Supabase dashboard, or `fly postgres create`) and grab the DSN.

# 3. Set secrets. Copy the template, fill in REAL values, run it.
cp deploy/fly/secrets.example.sh deploy/fly/secrets.sh   # secrets.sh is gitignored
$EDITOR deploy/fly/secrets.sh
bash deploy/fly/secrets.sh

# 4. Deploy everything (job-queue first → applies DB migrations via release_command).
bash deploy/fly/deploy-all.sh
```

`deploy-all.sh` runs `fly deploy -c deploy/fly/<svc>.toml --remote-only` from the repo root for
each service, so the Docker build context resolves `@dawn/shared`. Re-run it any time to ship
updates; migrations re-apply idempotently on each `dawn-job-queue` release.

## TLS / WebSocket (`wss`)

Fly terminates TLS at its edge and forwards to the container, transparently upgrading
WebSockets. With `force_https = true`:

- Buyers/SDK → `https://dawn-api.fly.dev`
- **Agents** → set `DAWN_BACKEND_WS=wss://dawn-job-queue.fly.dev/agent` (and
  `DAWN_RPC_URL=<paid Base RPC>`). No app code changes — the Go server speaks plain
  HTTP/WS behind Fly's TLS.

Add custom domains with `fly certs add api.dawn.xyz -a dawn-api` (and `ws.dawn.xyz` for the
queue); then agents use `wss://ws.dawn.xyz/agent`.

## Frontend (Vercel)

The site already deploys to Vercel. Point its API base at the deployed api app
(`https://dawn-api.fly.dev` or your custom domain) via the Vercel project env. The
[`@dawn/sdk`](../packages/sdk) `DawnClient({ baseUrl })` takes the same URL.

## Observability

- Logs: `fly logs -a dawn-<svc>`
- Health: `fly checks list -a dawn-<svc>` (every service answers `GET /healthz`)
- Status/scale: `fly status -a dawn-<svc>`, `fly scale show -a dawn-<svc>`

## Mainnet cutover (deltas)

Single-node `escrow → settle` is mainnet-ready (the redundant flow stays gated off — see
[`the redundant-execution design`](../the redundant-execution design)). The full runbook is
[`LAUNCH.md`](../LAUNCH.md). Cutover state:

1. ✅ `Settlement` deployed to Base mainnet at `0xc27C681cE93a63C0987226CDaC7b66232018651E`
   (block 48037231); address + deploy block recorded in `packages/shared/src/web3/addresses.ts`.
2. ✅ Chain config is committed to the `*.toml [env]` blocks (mainnet): `dawn-api` has
   `NETWORK=base`, `CHAIN_ID=8453`, `USDC_ADDRESS=0x8335…2913`; proof-service + indexer have
   `CHAIN_ID=8453`. The Settlement address is resolved from `addresses.ts` (no `SETTLEMENT_ADDRESS`
   env needed). Putting chain config in the committed toml — not fly secrets — keeps it
   precedence-independent and auditable.
3. ✅ No settler key: single-node self-settles (M0 D3), so proof-service is verify/record-only.
4. Fill the two real secrets in `deploy/fly/secrets.sh` (DB password + Alchemy URL) and run it,
   then `bash deploy/fly/deploy-all.sh`.

## Security

- **Secrets only via `fly secrets`** — never in `*.toml` or git. `deploy/fly/secrets.sh` is gitignored.
- **`AUTH_ALLOW_ALL` must stay unset** in production (real EIP-191 node auth). It is a dev-only escape hatch.
- The settler key is a **hot key**: minimum balance, dedicated account, rotate on suspicion.
  Treasury rotation is independent (`setTreasury`, two-step `Ownable`).
- Restrict the Postgres to the Fly org / Supabase network; require `sslmode=require`.

## Railway alternative

Each service has a standalone Dockerfile (build context = repo root). On Railway: one service
per Dockerfile, set the [env table](../services/DEPLOY.md#environment) per service, point
`PROOF_SERVICE_URL` at the proof-service's private URL, expose `dawn-api` + `dawn-job-queue`,
and add a managed Postgres plugin for `DATABASE_URL`. Run the `migrate` binary once
(`railway run /usr/local/bin/migrate` in the job-queue service) before first serve.
