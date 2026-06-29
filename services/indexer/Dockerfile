# indexer (Bun/Fastify) — the architecture  Build context = repo root:
#   docker build -f services/indexer/Dockerfile -t dawn-indexer .

FROM oven/bun:1.3-slim
WORKDIR /app

COPY packages/shared/package.json packages/shared/bun.lock ./packages/shared/
RUN cd packages/shared && bun install --frozen-lockfile
COPY packages/shared/ ./packages/shared/

COPY services/indexer/package.json services/indexer/bun.lock ./services/indexer/
RUN cd services/indexer && bun install --frozen-lockfile
COPY services/indexer/ ./services/indexer/

WORKDIR /app/services/indexer
ENV PORT=8083
EXPOSE 8083
USER bun
CMD ["bun", "run", "src/server.ts"]
