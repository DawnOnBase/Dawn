# api (Bun/Fastify) — the architecture / Build context = repo root:
#   docker build -f services/api/Dockerfile -t dawn-api .
# Resolves @dawn/shared via tsconfig paths, so packages/shared (incl. its viem
# install for @dawn/shared/web3) ships in the image.

FROM oven/bun:1.3-slim
WORKDIR /app

# Shared package first (its deps: viem), so layer caching survives service edits.
COPY packages/shared/package.json packages/shared/bun.lock ./packages/shared/
RUN cd packages/shared && bun install --frozen-lockfile
COPY packages/shared/ ./packages/shared/

# Service deps + source.
COPY services/api/package.json services/api/bun.lock ./services/api/
RUN cd services/api && bun install --frozen-lockfile
COPY services/api/ ./services/api/

WORKDIR /app/services/api
ENV PORT=8080
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/server.ts"]
