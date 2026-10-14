# destination-service (Python / FastAPI, port 8081)

The destination catalogue (`data/airports.json`), enriched with live data from two real, keyless APIs:

- **Open-Meteo** — 7–16 day forecasts (`api.open-meteo.com`) and place search (`geocoding-api.open-meteo.com`)
- **Nager.Date** — public holidays for the trip window (`date.nager.at`)

Responses are cached (weather 15 min, holidays 24 h, geocoding 1 h) and served stale if the
upstream is down. Enrichment on `/destinations/{code}` is best-effort: a failing upstream nulls that
field and adds a `degraded` entry rather than failing the request. API: `docs/contract.md`.

```bash
uv sync                                                 # from the repo root
uv run destination-service                              # or: uv run uvicorn destination_service.main:app --port 8081
uv run pytest services/destination-service              # mocked upstreams
LIVE=1 uv run pytest services/destination-service -m live   # real APIs
curl 'localhost:8081/destinations/LIS?include=weather,holidays'
```

| Env | Default |
|-----|---------|
| `OPEN_METEO_URL` | `https://api.open-meteo.com` |
| `OPEN_METEO_GEOCODING_URL` | `https://geocoding-api.open-meteo.com` |
| `NAGER_DATE_URL` | `https://date.nager.at` |
| `EXTERNAL_TIMEOUT_MS` | `4000` |
| `REFERENCE_DATA_DIR` | auto-discovers `data/` by walking up from the working directory |

Docker (build context is the repo root): `docker build -f services/destination-service/Dockerfile -t travelduty/destination-service .`
