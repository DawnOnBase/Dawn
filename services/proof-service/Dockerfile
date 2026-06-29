# proof-service (Bun/Fastify) — the architecture  Build context = repo root:
#   docker build -f services/proof-service/Dockerfile -t dawn-proof-service .
# Resolves @dawn/shared via tsconfig paths, so packages/shared (incl. its viem
# install for @dawn/shared/web3) ships in the image.

FROM oven/bun:1.3-slim
WORKDIR /app

COPY packages/shared/package.json packages/shared/bun.lock ./packages/shared/
RUN cd packages/shared && bun install --frozen-lockfile
COPY packages/shared/ ./packages/shared/

COPY services/proof-service/package.json services/proof-service/bun.lock ./services/proof-service/
RUN cd services/proof-service && bun install --frozen-lockfile
COPY services/proof-service/ ./services/proof-service/

WORKDIR /app/services/proof-service
ENV PORT=8081
EXPOSE 8081
USER bun
CMD ["bun", "run", "src/server.ts"]
