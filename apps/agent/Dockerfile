# dawn-agent (Rust) — the architecture  Build context = repo root:
#   docker build -f apps/agent/Dockerfile -t dawn-agent .
#
# Primarily a desktop binary; this image targets HEADLESS/triggered runs (servers
# with no desktop session), so it defaults DAWN_FORCE_RUN=1 to bypass idle probing.
# Build with `--build-arg FEATURES=onchain` to compile the on-chain self-settle path.

FROM rust:1-slim AS build
ARG FEATURES=""
WORKDIR /src
COPY apps/agent/ ./
RUN if [ -n "$FEATURES" ]; then \
      cargo build --release --locked --features "$FEATURES"; \
    else \
      cargo build --release --locked; \
    fi

FROM debian:bookworm-slim
# rustls needs the system trust store for https/wss endpoints.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/dawn-agent /usr/local/bin/dawn-agent
# Headless default; override to 0 (and provide a desktop session) for idle-gated runs.
ENV DAWN_FORCE_RUN=1
ENTRYPOINT ["/usr/local/bin/dawn-agent"]
