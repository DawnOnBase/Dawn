# job-queue (Go) — the architecture  Build context = repo root:
#   docker build -f services/job-queue/Dockerfile -t dawn-job-queue .
# Ships both the server and the migrate tool; run migrate once before serving.

FROM golang:1.26 AS build
WORKDIR /src
COPY services/job-queue/go.mod services/job-queue/go.sum ./
RUN go mod download
COPY services/job-queue/ ./
# Static, stripped binaries (CGO off → runs on distroless/static).
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/job-queue ./cmd/job-queue \
 && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/job-queue /usr/local/bin/job-queue
COPY --from=build /out/migrate /usr/local/bin/migrate
# Migrations travel with the image so `migrate` can apply them in-cluster.
COPY --from=build /src/migrations /migrations
ENV MIGRATIONS_DIR=/migrations
EXPOSE 8090
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/job-queue"]
