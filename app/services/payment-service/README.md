# payment-service (Rust · axum)

TravelDuty's simulated card processor. It authorises and captures payments, replays idempotent
requests and issues refunds. It follows the platform contract in [`docs/contract.md`](../../docs/contract.md)
(`/health`, `/ready`, `/metrics`, `/admin/chaos`, `x-request-id`, error envelope).

Full card numbers are never stored or logged. Records keep only the brand and last 4 digits.

## Run & test

```bash
cargo run                                   # listens on :8086
cargo test                                  # unit + HTTP tests (in-process, no sockets)
cargo clippy --all-targets -- -D warnings

# from the repo root
docker build -f services/payment-service/Dockerfile -t travelduty/payment-service .
```

| Env                  | Default | |
|----------------------|---------|---|
| `PORT`               | `8086`  | |
| `PAYMENT_LATENCY_MS` | `150`   | simulated processor round trip |
| `LOG_LEVEL`, `APP_VERSION`, `ADMIN_TOKEN`, `CHAOS_*` | | see contract |

## API

| Method | Path | |
|--------|------|---|
| `POST` | `/payments` | capture; honours `Idempotency-Key` (replays the original status and body) |
| `GET`  | `/payments/{id}` | |
| `POST` | `/payments/{id}/refunds` | `{"amount": 10}`, or no body for a full refund |

```bash
curl -s localhost:8086/payments -H 'content-type: application/json' -H 'idempotency-key: TD-7KQ2MX' -d '{
  "amount": 789.2, "currency": "GBP", "reference": "TD-7KQ2MX",
  "card": {"number": "4242424242424242", "expMonth": 12, "expYear": 2030, "cvc": "123", "holderName": "Ada Lovelace"}}'
```

### Test cards

| Number             | Result |
|--------------------|--------|
| `4242424242424242` | captured (visa) |
| `5555555555554444` | captured (mastercard) |
| `4000000000000002` | `402 CARD_DECLINED` · `generic_decline` |
| `4000000000009995` | `402 CARD_DECLINED` · `insufficient_funds` |
| `4000000000000069` | `402 CARD_DECLINED` · `expired_card` |
| `4000000000000119` | `502 PROCESSOR_UNAVAILABLE` (acquirer outage, not cached against the idempotency key) |
| any other Luhn-valid number | captured |

## Layout

```
src/main.rs            config, JSON logging, graceful shutdown
src/lib.rs             build_app(Config) -> Router  (used by tests)
src/payments.rs        validation, test-card outcomes, idempotency, refunds
src/platform/          error envelope, request ids + access log, metrics, chaos
tests/api.rs           HTTP-level tests via tower::ServiceExt::oneshot
```
