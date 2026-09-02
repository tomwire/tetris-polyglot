# Polyglot Tetris — Multi-Runtime Benchmark & Showcase Platform

A production-grade showcase demonstrating **polyglot backend engineering** with four independent Tetris implementations (Go, Rust, Node.js/TypeScript, Python) unified under a strict WebSocket protocol contract. Demonstrates engine hot-swapping, real-time cross-runtime telemetry, and full DevOps tooling.


## Play it here:

[https://tetris.thomaswire.com](https://tetris.thomaswire.com)


## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Caddy Reverse Proxy                   │
│           tetris.thomaswire.com / TLS / WSS             │
└────┬──────────┬──────────┬──────────┬──────────────────┘
     │          │          │          │
  ┌──▼──┐   ┌───▼──┐   ┌───▼──┐   ┌───▼──┐
  │Go    │  │Rust  │   │Node  │  │Python│
  │Engine│  │Engine│   │Engine│  │Engine│
  └──┬──┘   └──┬───┘   └──┬───┘   └──┬───┘
     │          │          │          │
     └──────────┴────┬─────┴──────────┘
                    │ WSS (state handoff)
              ┌─────▼─────┐
              │  Frontend  │
              │ React +    │
              │ Canvas     │
              └───────────┘
                    │
              ┌─────▼─────┐
              │ Prometheus│
              └─────┬─────┘
                ┌───▼────┐
                │ Grafana│
                └────────┘
```

### Key Features

- **4 Independent Engine Implementations** — Each runtime implements the full Tetris game loop, SRS wall kicks, 7-bag generation, and WebSocket protocol from scratch. No shared libraries between runtimes.
- **Mid-Game State Handoff** — Export state from any engine, connect to another, import seamlessly. Game continues uninterrupted during the switch.
- **Live Telemetry Dashboard** — Real-time CPU, RSS memory, tick latency, and GC pauses plotted across all four backends.
- **Production Infrastructure** — Multi-stage Docker builds, Caddy reverse proxy with TLS, CI/CD pipelines with security scanning (Trivy, CodeQL, gitleaks).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Go Engine | `net/http`, `gorilla/websocket`, standard library profiling |
| Rust Engine | `axum`, `tokio-tungstenite`, `sysinfo` crate |
| Node.js Engine | `@fastify/websocket`, `node:perf_hooks`, `process.memoryUsage` |
| Python Engine | `FastAPI`, `websockets`, `tracemalloc`/`psutil` |
| Frontend | React 18, Canvas 2D, Tailwind CSS, Recharts for graphs |
| Observability | Prometheus + Grafana (pre-provisioned dashboards) |
| Reverse Proxy | Caddy (auto-TLS, WebSocket upgrades) |
| CI/CD | GitHub Actions (matrix test, SAST, container scanning) |

## Quick Start

### Development

```bash
# Clone and enter the monorepo
git clone git@github.com:tomwire/tetris-polyglot.git
cd tetris-polyglot

# Build all engines
make build-all

# Run dev stack with hot-reload on frontend + all engines
make dev-up

# Individual engine development (e.g., Go only)
make run-go-dev
```

### Production-like Stack

```bash
# Start full stack (frontend, 4 engines, prometheus, grafana, caddy)
make prod-up

# Shut down everything
make clean
```

## Protocol Contract

All engines implement a unified WebSocket protocol defined in `docs/architecture/protocol-contract.md`. Key messages:

- **INPUT** — Player actions (`MOVE_LEFT`, `ROTATE_CW`, `HARD_DROP`, etc.)
- **STATE_UPDATE** — Full game state broadcast on each tick
- **ENGINE_METRICS** — Runtime telemetry frame (CPU %, RSS, GC pauses)
- **EXPORT_STATE / IMPORT_STATE** — State serialization for hot-swapping between engines

## Engine Switching

The frontend supports mid-game runtime switching:

1. Click the engine selector in the HUD
2. Client sends `EXPORT_STATE` to current engine
3. Receives full serialized game state JSON
4. Closes connection, opens new WebSocket to target engine
5. Sends `IMPORT_STATE` — game resumes seamlessly

## Observability

Each engine exposes `/metrics` in Prometheus exposition format:

- **Application metrics:** `tetris_tick_duration_seconds`, `tetris_lines_cleared_total`, `tetris_active_sessions`
- **Process metrics:** RSS memory, CPU usage, GC cycle counts (where applicable)

Grafana is pre-provisioned with a cross-runtime comparison dashboard at `http://localhost:3001`.

## Project Structure

```
tetris-polyglot/
├── engines/                 # Independent backend implementations
│   ├── go/                  # Gorilla WebSocket reference engine
│   ├── rust/                # Axum + tokio-tungstenite
│   ├── node/                # Fastify WebSockets
│   └── python/              # FastAPI websockets
├── frontend/                # React 18 + Canvas renderer
├── observability/           # Prometheus + Grafana configs
├── deploy/                  # docker-compose, Caddyfile
├── docs/                    # Architecture, ADRs, benchmark results
├── .github/workflows/       # CI, security, CD pipelines
└── Makefile                 # Unified dev workflow
```

## Security & Compliance

CI runs automated security scans:
- **Trivy** — Container image vulnerability scanning
- **CodeQL** — SAST for all languages
- **gitleaks** — Secret detection in source history
- **Dependency audit** — `cargo audit`, `npm audit`, `pip-audit`, `govulncheck`

## License

MIT
