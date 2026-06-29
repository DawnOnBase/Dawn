# pricing (Bun/Fastify) — the architecture  Build context = repo root:
#   docker build -f services/pricing/Dockerfile -t dawn-pricing .

FROM oven/bun:1.3-slim
WORKDIR /app

COPY packages/shared/package.json packages/shared/bun.lock ./packages/shared/
RUN cd packages/shared && bun install --frozen-lockfile
COPY packages/shared/ ./packages/shared/

COPY services/pricing/package.json services/pricing/bun.lock ./services/pricing/
RUN cd services/pricing && bun install --frozen-lockfile
COPY services/pricing/ ./services/pricing/

WORKDIR /app/services/pricing
ENV PORT=8082
EXPOSE 8082
USER bun
CMD ["bun", "run", "src/server.ts"]
