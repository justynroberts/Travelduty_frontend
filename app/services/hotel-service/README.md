# hotel-service (Java 17 / Spring Boot)

Hotel inventory, deterministic room offers and holds for TravelDuty. API and platform conventions
(health, metrics, chaos, error envelope) are defined in [`docs/contract.md`](../../docs/contract.md).

## Run

```bash
./mvnw spring-boot:run          # http://localhost:8083, reads ../../data/airports.json
PORT=9083 HOLD_TTL_SECONDS=60 ./mvnw spring-boot:run
```

The Maven wrapper downloads Maven on first use; only a JDK 17 is required.

## Test

```bash
./mvnw test                                   # all tests
./mvnw test -Dtest=HotelServiceTest           # one class
./mvnw test -Dtest=HotelServiceTest#holdConfirmFlow   # one test
```

## Docker

The build context is the repository root (the image bundles `data/airports.json`):

```bash
docker build -f services/hotel-service/Dockerfile -t travelduty/hotel-service .
docker run --rm -p 8083:8083 travelduty/hotel-service
```

## Try it

```bash
curl 'localhost:8083/hotels/search?city=LIS&checkIn=2026-11-02&checkOut=2026-11-06&guests=2'
curl -XPOST localhost:8083/holds -H 'content-type: application/json' \
     -d '{"offerId":"HT.LIS.3.2026-11-02.2026-11-06.2","rooms":1}'
curl -XPUT localhost:8083/admin/chaos -H 'content-type: application/json' -d '{"errorRate":0.5}'
```

## Layout

- `domain/` — `Rng` (FNV-1a + mulberry32, matches the other services), `HotelCatalog` (8 hotels per city),
  `OfferService` (pricing, availability, offer ids), `HoldStore` (thread-safe holds with capacity accounting)
- `platform/` — request-id filter, HTTP metrics filter, chaos interceptor, error envelope
- `web/` — hotel/hold API and ops endpoints (`/health`, `/ready`, `/metrics`, `/admin/chaos`)
