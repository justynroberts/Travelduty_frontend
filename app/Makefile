# TravelDuty: one entry point for a polyglot repo.
.PHONY: help install test test-ts test-go test-py test-java test-rust test-live lint build up up-obs down logs e2e clean

help: ## Show targets
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies for every language
	npm ci
	uv sync
	cd services/hotel-service && ./mvnw -q -B dependency:go-offline
	cd services/payment-service && cargo fetch
	go work sync

test: test-ts test-go test-py test-java test-rust ## Run every unit/integration test suite

test-ts: ## TypeScript: gateway, booking-service, libs/ts-common
	npx tsc -b
	npx vitest run

test-go: ## Go: flight-service, notification-service, libs/go-platform
	go vet ./libs/go-platform/... ./services/flight-service/... ./services/notification-service/...
	go test ./libs/go-platform/... ./services/flight-service/... ./services/notification-service/...

test-py: ## Python: destination-service, pricing-service, libs/py-common
	uv run ruff check
	uv run pytest

test-java: ## Java: hotel-service
	cd services/hotel-service && ./mvnw -q -B test

test-rust: ## Rust: payment-service
	cd services/payment-service && cargo test --locked && cargo clippy --all-targets --locked -- -D warnings

test-live: ## Tests that call the real external APIs (Open-Meteo, Nager.Date, Frankfurter)
	LIVE=1 uv run pytest -m live

build: ## Build all container images
	docker compose build

up: ## Run the platform (web :3000, API :8080)
	docker compose up --build -d
	@echo "web http://localhost:3000   api http://localhost:8080/api/status"

up-obs: ## Run the platform plus Prometheus (:9090)
	docker compose --profile observability up --build -d

down: ## Stop the platform
	docker compose --profile observability down

logs: ## Follow logs from every service
	docker compose logs -f --tail=50

e2e: ## End-to-end checks against a running platform
	node scripts/e2e.mjs

clean: ## Remove build outputs
	npx tsc -b --clean; rm -rf apps/web/dist services/hotel-service/target services/payment-service/target
