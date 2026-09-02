# Tetris Engine — Rust (Axum + Tokio)
# Multi-stage build: compile in release mode, copy to distroless.

# ──────────────────────────────────────────────
# Stage 1: Build
# ──────────────────────────────────────────────
FROM rust:1.75-bookworm AS builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY Cargo.toml Cargo.lock* ./
# Stub out src/ to download deps first (layer caching)
RUN mkdir -p src && echo "fn main(){}" > src/main.rs && cargo build --release
RUN rm -rf src
COPY src/ src/
# Wipe the stub's incremental cache so this compile actually rebuilds every
# changed source file (stale target/ from the earlier fn main(){} stub layer can
# make cargo skip recompiling real code, producing a binary without our strings).
RUN rm -rf /build/target
RUN cargo build --release

# ──────────────────────────────────────────────
# Stage 2: Runtime
# ──────────────────────────────────────────────
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

COPY --from=builder /build/target/release/tetris-engine /tetris-engine

EXPOSE 8000 9000

ENV HTTP_PORT=8000
ENV ENGINE_NAME=rust-engine
ENV RUST_LOG=info

ENTRYPOINT ["/tetris-engine"]
