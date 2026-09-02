# Tetris Engine — Go Reference Implementation
# Multi-stage build: compile binary, copy to scratch image.

# ──────────────────────────────────────────────
# Stage 1: Build
# ──────────────────────────────────────────────
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates tzdata

WORKDIR /build

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w -extldflags '-static'" \
    -o /build/tetris-engine \
    cmd/server/main.go

# ──────────────────────────────────────────────
# Stage 2: Runtime (minimal)
# ──────────────────────────────────────────────
FROM scratch

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /build/tetris-engine /tetris-engine

EXPOSE 8000 9000

ENV HTTP_PORT=8000
ENV ENGINE_NAME=go-engine

ENTRYPOINT ["/tetris-engine"]
