# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TravelDuty: a sample polyglot microservice platform (a fictional travel company) for demoing
observability and incident response. Eight services in five languages, plus a React front end:
gateway and booking-service (TypeScript), destination- and pricing-service (Python), flight- and
notification-service (Go), hotel-service (Java), payment-service (Rust). See README.md for the
architecture diagram and port table.

## The contract is the source of truth

`docs/contract.md` defines everything shared across languages: endpoints and payloads, the error
envelope `{"error":{"code","message","details"}}`, `/health` `/ready` `/metrics` `/admin/chaos`,
`x-request-id` propagation, the hold lifecycle (held → confirmed | cancelled | expired), and the
FNV-1a + mulberry32 seeding used for deterministic inventory. **When changing an API or a shared
behaviour, update the contract and every language's implementation together.** Each language has its
own platform library implementing the contract: `libs/ts-common`, `libs/go-platform`, `libs/py-common`.
Java (`services/hotel-service/.../platform/`) and Rust (`services/payment-service/src/platform/`) keep
theirs inside the service.

`data/airports.json` is the single copy of reference data. Services find it via `REFERENCE_DATA_DIR`,
or by walking up from the working directory. Docker images copy it to `/app/data` or `/data`.

## Commands

`make help` lists everything. Common ones:

```bash
make test                    # all suites (TS, Go, Python, Java, Rust)
make up && make e2e          # full stack in Docker + 22 end-to-end checks
npx vitest run services/booking-service          # one TS service
npx vitest run -t "releases every hold"          # one TS test by name
go test ./services/flight-service/... -run TestSoldOutAndExpiry
uv run pytest services/pricing-service -k quote
cd services/hotel-service && ./mvnw test -Dtest=HotelServiceTest
cd services/payment-service && cargo test refund
LIVE=1 uv run pytest -m live  # real external APIs
```

TypeScript: `npx tsc -b` typechecks and builds `libs/ts-common` plus both TS services (project references).
The web app is separate (`npm run typecheck -w @travelduty/web`). In dev and tests, `@travelduty/common`
resolves to `src/` (vitest alias in `vitest.config.ts`, and tsx `--conditions=development`); in builds it
resolves to `dist/`.

Go uses `go.work` at the repo root. Each Go service's `go.mod` also has a `replace` for `libs/go-platform`,
so Docker builds work with `GOWORK=off`. After adding a dependency, run `GOWORK=off go mod tidy` in that service.

Python is a uv workspace rooted at `pyproject.toml` (pytest and ruff config live there too).

## Things that are easy to get wrong

- **Docker build context is always the repo root**, e.g. `docker build -f services/hotel-service/Dockerfile .`,
  because images copy shared libs and `data/`.
- **Inventory is finite and stateful.** Holds count against seats and rooms, so repeated bookings on the
  same offer eventually return `409 SOLD_OUT`. That's by design; tests and scripts should pick offers
  that still have capacity (see `freshOffers()` in `scripts/e2e.mjs`).
- **flight, hotel and payment keep state in memory.** Restarting them loses holds and payments;
  booking-service (Postgres) keeps the booking but its hold ids go stale.
- **The saga must stay compensating.** Any new step in `services/booking-service/src/saga.ts` that reserves
  or charges something must push a compensation, and notification failures must never fail a booking.
- **Gateway pass-through mirrors upstream status codes.** 4xx bodies from services are forwarded as-is;
  5xx, timeouts and network errors become `502 UPSTREAM_UNAVAILABLE` / `504 UPSTREAM_TIMEOUT`
  (`libs/ts-common/src/service.ts` error handler).
- Chaos never applies to `/health`, `/ready`, `/metrics` or `/admin/*`, in any language.
- Never log or store full card numbers. booking-service stores only brand and last 4 digits.

## Front end

`apps/web` is React 18 + Vite 7 + Tailwind v4. All colours are CSS custom properties in `src/styles.css`,
with separately designed light and dark palettes in OKLCH. Theme is set via `data-theme` on `<html>`,
falling back to `prefers-color-scheme`. Fonts are Schibsted Grotesk (UI) and Martian Mono (codes, times,
prices only), self-hosted via @fontsource. Icons come from Phosphor (`@phosphor-icons/react`), light weight.
The `hover-fine:` variant limits hover styles to fine pointers.
