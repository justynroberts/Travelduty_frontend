# TravelDuty service contract

Every TravelDuty service — whatever its language — implements the same operational contract, so
the platform can be run, observed and broken (chaos) uniformly. This document is the source of truth;
service-specific APIs are listed at the end.

## 1. Platform conventions (all services)

### Ports and configuration

| Service              | Language            | Port |
|----------------------|---------------------|------|
| gateway              | TypeScript (Fastify)| 8080 |
| destination-service  | Python (FastAPI)    | 8081 |
| flight-service       | Go (net/http)       | 8082 |
| hotel-service        | Java (Spring Boot)  | 8083 |
| pricing-service      | Python (FastAPI)    | 8084 |
| booking-service      | TypeScript (Fastify)| 8085 |
| payment-service      | Rust (axum)         | 8086 |
| notification-service | Go (net/http)       | 8087 |

Common environment variables:

| Variable              | Meaning                                                      | Default |
|-----------------------|--------------------------------------------------------------|---------|
| `PORT`                | Listen port                                                  | table above |
| `LOG_LEVEL`           | `debug` / `info` / `warn` / `error`                          | `info` |
| `APP_VERSION`         | Reported by `/health`                                        | `dev` |
| `ADMIN_TOKEN`         | If set, `/admin/*` requires header `x-admin-token`           | unset |
| `CHAOS_LATENCY_MS`    | Initial injected latency                                     | `0` |
| `CHAOS_JITTER_MS`     | Initial random extra latency `[0, jitter)`                   | `0` |
| `CHAOS_ERROR_RATE`    | Initial probability (0–1) of an injected failure             | `0` |
| `CHAOS_ERROR_STATUS`  | Status code of injected failures                             | `503` |
| `REFERENCE_DATA_DIR`  | Directory containing `airports.json` (services that need it) | `../../data` relative to the service dir |
| `<NAME>_SERVICE_URL`  | Base URL of another service, e.g. `FLIGHT_SERVICE_URL`       | `http://localhost:<port>` |

### Request ids

- Read `x-request-id` from the incoming request (accept ≤128 chars); otherwise generate a UUID.
- Echo it back as the `x-request-id` response header.
- Include it as `requestId` in every log line for that request.
- Forward it on every outbound call to another TravelDuty service or external API.

### Logging

Structured JSON to stdout, one object per line, including at least `level`, `time`/`timestamp`,
`service`, `msg`/`message`, and `requestId` when in a request.

### Error envelope

All non-2xx responses have the body:

```json
{ "error": { "code": "SCREAMING_SNAKE_CODE", "message": "Human readable", "details": {} } }
```

`details` is optional. Standard codes:

| Status | Code                   | When |
|--------|------------------------|------|
| 400    | `VALIDATION_ERROR`     | Bad query/body (missing field, wrong type, bad date) |
| 400    | `BAD_REQUEST`          | Semantically invalid request |
| 401    | `UNAUTHORIZED`         | Missing/invalid `x-admin-token` |
| 404    | `NOT_FOUND`            | Unknown route or resource |
| 409    | `SOLD_OUT`, `HOLD_EXPIRED`, `HOLD_CANCELLED`, … | State conflicts |
| 502    | `UPSTREAM_UNAVAILABLE` | A dependency failed (5xx/network) |
| 504    | `UPSTREAM_TIMEOUT`     | A dependency timed out |
| 5xx    | `CHAOS_INJECTED`       | Failure injected by chaos |
| 500    | `INTERNAL_ERROR`       | Anything else |

### Operational endpoints

These are never subject to chaos injection.

- `GET /health` → `200 {"status":"ok","service":"<name>","version":"<APP_VERSION>","uptimeSeconds":12}`
- `GET /ready` → `200 {"status":"ready","checks":{"postgres":true}}`, or `503` with `"status":"not_ready"`
  if any dependency check fails. Services without hard dependencies return `{"status":"ready","checks":{}}`.
- `GET /metrics` → Prometheus text format. Must include:
  - `http_requests_total{method,route,status}` — counter; `route` is the route template (e.g. `/holds/{id}`), not the raw path
  - `http_request_duration_seconds{method,route}` — histogram
  - `upstream_calls_total{target,outcome}` — counter, for services that call others (`outcome` = `success`|`error`)

### Chaos injection

State: `{"latencyMs":0,"jitterMs":0,"errorRate":0,"errorStatus":503}` (initialised from `CHAOS_*`).

- `GET /admin/chaos` → current state
- `PUT /admin/chaos` with any subset of the fields → merged state (validate: latency/jitter 0–60000 ints,
  errorRate 0–1, errorStatus 400–599; otherwise `400 VALIDATION_ERROR`)
- `DELETE /admin/chaos` → reset to zeros / 503, returns state

For every request **except** `/health`, `/ready`, `/metrics` and `/admin/*`: sleep
`latencyMs + random()*jitterMs`, then with probability `errorRate` respond `errorStatus` with
`{"error":{"code":"CHAOS_INJECTED","message":"Injected failure in <service>"}}`.

### Outbound calls

Timeouts on every call (default 5 s internal, 4 s external). GETs may be retried up to 2 times on
network errors/5xx with exponential backoff (100 ms, 200 ms). Non-idempotent calls are not retried
unless they carry an `Idempotency-Key`.

### Holds (flight-service, hotel-service)

Inventory is reserved with a **hold**, then confirmed or cancelled — the booking saga relies on it.

```json
{
  "id": "fh_3f9a1c2b7d4e5f60",
  "status": "held | confirmed | cancelled | expired",
  "offer": { "...": "the full offer object" },
  "quantity": 2,
  "createdAt": "2026-10-14T09:00:00.000Z",
  "expiresAt": "2026-10-14T09:15:00.000Z",
  "confirmedAt": "…optional…",
  "cancelledAt": "…optional…",
  "confirmation": { "…service specific, present once confirmed…": "" }
}
```

- Holds expire after `HOLD_TTL_SECONDS` (default 900). An expired hold reports `status: "expired"`.
- `POST /holds/{id}/confirm` on a held hold → confirmed (idempotent if already confirmed);
  on expired → `409 HOLD_EXPIRED`; on cancelled → `409 HOLD_CANCELLED`.
- `DELETE /holds/{id}` → `200` with the hold, status `cancelled` (idempotent; works on confirmed holds too,
  which models a ticket/reservation cancellation). Unknown id → `404`.
- Held and confirmed quantities count against capacity. Requesting more than is available →
  `409 SOLD_OUT` with `details: {"available": n}`.

### Reference data

`data/airports.json` lists the 14 destinations (code, city, country, countryCode, currency, timezone,
lat, lon, costIndex, tags, blurb). Services that need it load it at startup from `REFERENCE_DATA_DIR`.

Simulated inventory is **deterministic**: the same search inputs always produce the same offers, seeded
from a hash of the inputs. Offer ids encode their inputs, so a service can re-derive an offer from its id
without storing searches.

Use this exact seeding scheme everywhere so behaviour is reproducible across languages:

- Hash: 32-bit FNV-1a over the UTF-8 string (offset `0x811c9dc5`, prime `0x01000193`).
- PRNG: mulberry32 seeded with the hash, returning floats in `[0,1)`.

## 2. Service APIs

All amounts are numbers rounded to 2 decimals. Dates are `YYYY-MM-DD`.

### flight-service (Go, 8082)

Airlines (fictional): `NX` Nimbus Air, `AU` Aurora Airways, `MR` Meridian Airlines, `CS` Coastline, `BV` Boreal.

- `GET /flights/search?from=LHR&to=LIS&date=2026-11-02&adults=1&cabin=economy`
  - `from`/`to` must be known codes and differ; `date` must be a valid date not in the past; `adults` 1–9;
    `cabin` ∈ `economy|premium|business` (default economy).
  - → `{"from","to","date","adults","cabin","count","items":[Offer]}` sorted by price ascending.
- `GET /flights/offers/{offerId}?adults=1` → Offer, or 404.
- `POST /holds` `{"offerId":"…","passengers":2}` → `201` Hold (prefix `fh_`). Validates seat availability.
- `GET /holds/{id}`, `POST /holds/{id}/confirm`, `DELETE /holds/{id}`.
  Confirmation: `{"tickets":["<3-digit airline number>-<10 digits>", …one per passenger]}`, `"pnr":"6 chars"`.

Offer:

```json
{
  "id": "FL.LHR.LIS.2026-11-02.economy.3",
  "airline": { "code": "NX", "name": "Nimbus Air" },
  "flightNumber": "NX482",
  "from": "LHR", "to": "LIS",
  "departureTime": "2026-11-02T07:35", "arrivalTime": "2026-11-02T10:20",
  "durationMinutes": 165, "stops": 0, "cabin": "economy",
  "seatsLeft": 7, "pricePerAdultEur": 128.4, "totalEur": 128.4, "adults": 1
}
```

Departure/arrival are local wall-clock times at the origin/destination (timezone-aware).
Generation (seed = `"<from>-<to>-<date>-<cabin>"`): 4–7 offers; distance by haversine; duration ≈
`distance/820 h + 35 min + stops × (70–160 min)`; one stop likely above 7000 km; price per adult ≈
`(35 + 0.085 × km) × (0.75–1.55) × cabinMultiplier` (economy 1, premium 1.7, business 3.2); 1–9 seats,
minus held/confirmed seats.

### hotel-service (Java, 8083)

- `GET /hotels?city=LIS` → `{"city","items":[Hotel]}` (8 hotels per city, deterministic, seed = city code).
- `GET /hotels/search?city=LIS&checkIn=2026-11-02&checkOut=2026-11-06&guests=2`
  - checkOut after checkIn, ≤ 30 nights, checkIn not in the past, guests 1–6.
  - → `{"city","checkIn","checkOut","nights","guests","count","items":[Offer]}` sorted by total ascending,
    excluding hotels with no rooms left.
- `GET /hotels/offers/{offerId}` → Offer, or 404.
- `POST /holds` `{"offerId":"…","rooms":1}` → `201` Hold (prefix `hh_`). `rooms` defaults to 1.
- `GET /holds/{id}`, `POST /holds/{id}/confirm`, `DELETE /holds/{id}`.
  Confirmation: `{"confirmationCode":"HTL-XXXXXX"}`.

Hotel: `{"id":"LIS-3","name":"…","stars":4,"rating":8.7,"neighbourhood":"Old Town","amenities":["wifi","pool"],"baseRateEur":142.5}`

Offer:

```json
{
  "id": "HT.LIS.3.2026-11-02.2026-11-06.2",
  "hotel": { "...": "Hotel" },
  "city": "LIS", "checkIn": "2026-11-02", "checkOut": "2026-11-06", "nights": 4, "guests": 2,
  "roomsLeft": 3, "nightlyRatesEur": [142.5, 142.5, 163.88, 163.88],
  "avgNightlyEur": 153.19, "totalEur": 612.76
}
```

Nightly rate = baseRate × 1.15 on Friday/Saturday nights × 1.4 if guests > 2. Rooms left 0–6, seeded by
`"<hotelId>-<checkIn>"`, minus held/confirmed rooms.

### pricing-service (Python, 8084)

Uses the **Frankfurter API** (ECB reference rates) — `FRANKFURTER_URL`, default `https://api.frankfurter.dev`.
Rates are cached for 1 h and served stale for up to 24 h if Frankfurter is down. EUR→EUR always works.

- `GET /fx/currencies` → `{"base":"EUR","currencies":["AUD","BRL",…,"EUR",…]}`
- `GET /fx/rates?base=EUR` → `{"base","date","rates":{…},"stale":false,"source":"frankfurter.dev"}`
  (cross rates computed locally for non-EUR bases).
- `GET /fx/convert?amount=100&from=EUR&to=GBP` → `{"amount","from","to","rate","result","date","stale"}`
- `POST /quotes`

```json
{ "currency": "GBP",
  "items": [ { "kind": "flight", "description": "LHR→LIS NX482", "amountEur": 256.8 },
             { "kind": "hotel",  "description": "4 nights, Casa …", "amountEur": 612.76 } ] }
```

→ `201`

```json
{
  "id": "q_…", "currency": "GBP", "rate": 0.8446, "rateDate": "2026-10-13", "rateStale": false,
  "lines": [ { "kind": "flight", "description": "…", "amountEur": 256.8, "amount": 216.89 } ],
  "taxes": [ { "description": "Air passenger duty & airport charges", "amountEur": 23.11, "amount": 19.52 },
             { "description": "City & tourist tax", "amountEur": 36.77, "amount": 31.05 } ],
  "fees":  [ { "description": "TravelDuty service fee", "amountEur": 4.99, "amount": 4.21 } ],
  "subtotal": 734.43, "taxTotal": 50.57, "feeTotal": 4.21, "total": 789.21, "totalEur": 934.43,
  "createdAt": "…", "expiresAt": "…(+30 min)"
}
```

Tax rules: flights 9%, hotels 6%, other 0%; one service fee of €4.99 per quote. Taxes are only listed
when non-zero. Unsupported currency → `400 UNSUPPORTED_CURRENCY`. `GET /quotes/{id}` → quote or 404.

### payment-service (Rust, 8086)

Simulated card processor. Never stores or logs full card numbers.

- `POST /payments` (optional `Idempotency-Key` header — replaying a key returns the original status + body)

```json
{ "amount": 789.2, "currency": "GBP", "reference": "TD-7KQ2MX",
  "card": { "number": "4242424242424242", "expMonth": 12, "expYear": 2030, "cvc": "123", "holderName": "Ada Lovelace" } }
```

  Validation (`400 VALIDATION_ERROR`): amount > 0, 3-letter currency, Luhn-valid 12–19 digit number,
  expiry not in the past, cvc 3–4 digits.

  Test cards:

  | Number             | Result |
  |--------------------|--------|
  | `4242424242424242` | captured (visa) |
  | `5555555555554444` | captured (mastercard) |
  | `4000000000000002` | `402 CARD_DECLINED`, `details.declineCode = "generic_decline"` |
  | `4000000000009995` | `402 CARD_DECLINED`, `declineCode = "insufficient_funds"` |
  | `4000000000000069` | `402 CARD_DECLINED`, `declineCode = "expired_card"` |
  | `4000000000000119` | `502 PROCESSOR_UNAVAILABLE` (simulates the acquirer being down) |
  | any other valid    | captured |

  → `201 {"id":"pay_…","status":"captured","amount","currency","reference","card":{"brand":"visa","last4":"4242"},"refundedAmount":0,"createdAt"}`
  Simulated processing delay `PAYMENT_LATENCY_MS` (default 150).
- `GET /payments/{id}`
- `POST /payments/{id}/refunds` `{"amount": 10}` (omit for full) → Payment with `refundedAmount` updated and
  status `refunded` or `partially_refunded`. Refunding more than remains → `409 REFUND_EXCEEDS_CAPTURE`.

### notification-service (Go, 8087)

- `POST /notifications` `{"template":"booking_confirmed|booking_cancelled|booking_failed","to":"a@b.com","bookingRef":"TD-…","data":{…}}`
  → `202` Notification. Renders a subject + plain text body from the template and `data`
  (`data` may include `customerName`, `total`, `currency`, `itinerary`, `reason`).
  Deliveries: `email` is simulated (recorded, logged). If `WEBHOOK_URL` is set, also POSTs
  `{"text": "<subject>\n<body>"}` (Slack-compatible) — a real outbound call — recording success/failure.
- `GET /notifications?bookingRef=&to=&limit=50` → `{"items":[Notification]}` newest first (kept in memory, max 1000).
- `GET /notifications/{id}`

Notification: `{"id":"ntf_…","template","to","bookingRef","subject","body","createdAt","deliveries":[{"channel":"email","status":"sent"},{"channel":"webhook","status":"failed","error":"…"}]}`

### destination-service (Python, 8081)

Uses **Open-Meteo** forecast + geocoding and **Nager.Date** public holidays (no API keys).
Weather cached 15 min (stale-if-error 6 h), holidays 24 h (stale 7 d), geocoding 1 h.

- `GET /destinations?tag=beach` → `{"count","items":[Destination]}`
- `GET /destinations/{code}?include=weather,holidays&from=&to=` → Destination plus optional
  `weather: {"days":[DailyForecast],"stale","source"}` and `holidays: {"from","to","items":[Holiday],"stale","source"}`.
  Enrichment is best-effort: if an upstream fails the field is `null` and
  `degraded: [{"feature":"weather","reason":"…"}]` is added. Unknown code → 404.
- `GET /destinations/{code}/weather?days=7` (1–16)
- `GET /destinations/{code}/holidays?from=&to=` (default today..+90 d, max 400 d range)
- `GET /geocode?q=lisbon&count=5`

Destination: the airports.json entry minus `costIndex`.
DailyForecast: `{"date","summary","weatherCode","tempMaxC","tempMinC","precipitationMm","precipitationChance"}`.
Holiday: `{"date","name","localName","nationwide"}`.

### booking-service (TypeScript, 8085)

Orchestrates a booking as a saga: hold flight(s) → hold hotel → quote → charge → confirm holds → notify.
Any failure compensates (cancel holds, refund) and records the booking as `FAILED`.
Postgres when `DATABASE_URL` is set, in-memory otherwise.

### gateway (TypeScript, 8080)

The public API (`/api/*`) used by the web app; proxies to services and aggregates trip searches.
