// Entrypoint for the pricing service .

import { buildApp, StaticMarketSource, type MarketSource } from "./app.ts";
import { CachedMarketSource, PostgresMarketSource } from "./marketsource.ts";

const port = Number(process.env.PORT ?? 8082);
const dsn = process.env.DATABASE_URL;

// Live market counts from the shared jobs table when a DB is configured,
// fronted by a short TTL cache; otherwise a neutral static source (dev only).
let market: MarketSource;
if (dsn) {
  market = new CachedMarketSource(new PostgresMarketSource(dsn));
  console.log("pricing: using live Postgres market source");
} else {
  market = new StaticMarketSource({ openJobs: 0, availableNodes: 1 });
  console.warn("pricing: DATABASE_URL not set — static market source (DEV ONLY)");
}

const app = buildApp({ market });
app
  .listen({ port, host: "0.0.0.0" })
  .then((addr) => console.log(`pricing: listening on ${addr}`))
  .catch((err) => {
    console.error("pricing: failed to start", err);
    process.exit(1);
  });
