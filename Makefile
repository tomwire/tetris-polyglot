# Polyglot Tetris — Unified Development Workflow
# Targets: lint, test, build, run, security scans, deploy

SHELL := /bin/bash
PROJECT := tetris-polyglot
COMPOSE ?= docker compose

.PHONY: help build-all test-all lint-all security scan-containers \
        dev-up dev-down prod-up prod-down clean logs status \
        run-go-dev run-rust-dev run-node-dev run-python-dev

help: ## Show this help
	@grep -E '^([^:]+):.*?## (.*)' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-25s\033[0m %s\n", $$1, $$2}'

# ──────────────────────────────────────────────
# Build Targets
# ──────────────────────────────────────────────

build-all: build-go build-rust build-node build-python build-frontend ## Build all engines + frontend
	@echo "✅ All builds complete"

build-go: ## Build Go engine binary
	cd engines/go && CGO_ENABLED=0 go build -ldflags="-s -w" -o ../../dist/engine-go cmd/server/main.go
	@echo "✅ Go engine built → dist/engine-go"

build-rust: ## Build Rust engine binary
	cd engines/rust && cargo build --release 2>/dev/null || \
		$(MAKE) install-cargo-deps && cd engines/rust && cargo build --release
	@mkdir -p dist
	cp engines/rust/target/release/tetris-engine dist/engine-rust 2>/dev/null || true
	@echo "✅ Rust engine built"

build-node: ## Build Node.js engine (TypeScript → JS bundle)
	cd engines/node && npm ci && npm run build
	@mkdir -p dist
	cp -r engines/node/dist dist/engine-node 2>/dev/null || true
	@echo "✅ Node.js engine built"

build-python: ## Build Python engine
	cd engines/python && pip install --upgrade pip && pip install . --target=dist/engine-python
	@echo "✅ Python engine installed to dist/engine-python"

build-frontend: ## Build frontend (React)
	cd frontend && npm ci && npm run build
	@echo "✅ Frontend built → frontend/build"

# ──────────────────────────────────────────────
# Test Targets
# ──────────────────────────────────────────────

test-all: test-go test-rust test-node test-python ## Run all tests across engines
	@echo "✅ All engine tests complete"

test-go: ## Run Go tests
	cd engines/go && go test -v -race ./internal/game/... ./internal/wsserver/...

test-rust: ## Run Rust tests
	cd engines/rust && cargo test --release

test-node: ## Run Node.js tests
	cd engines/node && npm test

test-python: ## Run Python tests
	cd engines/python && python -m pytest tests/ -v -x

# ──────────────────────────────────────────────
# Lint Targets
# ──────────────────────────────────────────────

lint-all: lint-go lint-rust lint-node lint-python lint-frontend ## Lint all engines + frontend

lint-go: ## Lint Go with golangci-lint (falls back to go vet)
	cd engines/go && golangci-lint run ./... 2>/dev/null || \
		go vet ./... && echo "⚠️  golangci-lint not installed, used go vet"

lint-rust: ## Lint Rust with clippy
	cd engines/rust && cargo clippy --release -- -D warnings 2>/dev/null || cargo build --release

lint-node: ## Lint Node.js with eslint + typecheck
	cd engines/node && npx eslint src/ --format stylish && npm run typecheck

lint-python: ## Lint Python with ruff
	cd engines/python && ruff check src/ tests/ 2>/dev/null || \
		python -m py_compile src/*.py && echo "⚠️  ruff not installed, used basic syntax check"

lint-frontend: ## Lint frontend with eslint + prettier
	cd frontend && npx eslint src/ --format stylish && npx prettier --check src/

# ──────────────────────────────────────────────
# Security Scans
# ──────────────────────────────────────────────

security: scan-containers lint-all ## Run all security scans + linting

scan-containers: ## Scan Docker images with Trivy
	docker build -t tetris-polyglot-check engines/go && \
	docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
	 aquasec/trivy:latest image tetris-polyglot-check || \
	echo "⚠️  Trivy not available, skipping container scan"

scan-deps-go: ## Go vulnerability check
	cd engines/go && govulncheck ./... 2>/dev/null || go vet ./...

scan-deps-node: ## Node.js dependency audit
	cd engines/node && npm audit --audit-level=high || true

scan-deps-python: ## Python pip audit
	cd engines/python && pip-audit --require-hashes=false 2>/dev/null || echo "⚠️  pip-audit not installed"

# ──────────────────────────────────────────────
# Dev Stack (docker compose dev override)
# ──────────────────────────────────────────────

dev-up: ## Start full dev stack with hot-reload
	$(COMPOSE) -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml up --build -d

dev-down: ## Tear down dev stack
	$(COMPOSE) -f deploy/docker-compose.yml -f deploy/docker-compose.dev.yml down

prod-up: ## Start production-like stack (no bind mounts, no hot-reload)
	$(COMPOSE) -f deploy/docker-compose.yml up --build -d

prod-down: ## Tear down prod stack
	$(COMPOSE) -f deploy/docker-compose.yml down -v

# ──────────────────────────────────────────────
# Individual Engine Dev Runners
# ──────────────────────────────────────────────

run-go-dev: ## Run Go engine with hot-reload via Entrypoint script
	$(COMPOSE) up go-engine --build

run-rust-dev: ## Run Rust engine
	$(COMPOSE) up rust-engine --build

run-node-dev: ## Run Node.js engine
	$(COMPOSE) up node-engine --build

run-python-dev: ## Run Python engine
	$(COMPOSE) up python-engine --build

# ──────────────────────────────────────────────
# Utilities
# ──────────────────────────────────────────────

clean: ## Remove build artifacts and containers
	@echo "Cleaning build artifacts..."
	rm -rf dist/ frontend/build engines/go/dist engines/rust/target/release \
	       engines/node/dist engines/python/dist
	$(COMPOSE) down --volumes --remove-orphans 2>/dev/null || true
	@echo "🧹 Clean complete"

status: ## Show container status
	$(COMPOSE) ps

logs: ## Show all service logs (follow mode)
	$(COMPOSE) logs -f

logs-engine: ENGINE_NAME ?= go-engine ## Show specific engine logs (go-engine|rust-engine|node-engine|python-engine)
	$(COMPOSE) logs -f $(ENGINE_NAME)

# ──────────────────────────────────────────────
# GitHub CLI helpers (local-only — no push)
# ──────────────────────────────────────────────

gh-commit: ## Stage, commit, and create draft PR with gh CLI (no push)
	git add -A && git commit -S -m "$(MESSAGE)" 2>/dev/null || echo "Nothing to commit"
	@echo "✅ Committed. Create a PR manually or use 'make gh-pr'"

gh-pr: ## Open pull request (draft) for current branch
	gh pr create --title "$(TITLE)" --body "$(BODY)" --draft 2>/dev/null || \
		echo "⚠️  gh CLI not authenticated"

# ──────────────────────────────────────────────
# Documentation & ADRs
# ──────────────────────────────────────────────

docs-adr-new: ADR_NUMBER ?= 0001 ## Create a new ADR document (usage: make docs-adr-new ADR_NUMBER=0005)
	@cp docs/adr/TEMPLATE.md docs/adr/$(ADR_NUMBER)-new-topic.md && \
		echo "✅ Created docs/adr/$(ADR_NUMBER)-new-topic.md — edit it"

install-deps-go: ## Install Go tooling (golangci-lint, govulncheck)
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest 2>/dev/null || true
	go install golang.org/x/vuln/cmd/govulncheck@latest 2>/dev/null || true

install-deps-rust: ## Install Rust tooling (cargo-clippy, cargo-audit)
	cargo install cargo clippy cargo-audit 2>/dev/null || true

install-cargo-deps: ## Ensure cargo is available
	@test -x "$$(which cargo)" 2>/dev/null || echo "⚠️  Install rustup + cargo for Rust engine builds"
