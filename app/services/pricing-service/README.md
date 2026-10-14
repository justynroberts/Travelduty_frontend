# pricing-service (Python / FastAPI, port 8084)

FX conversion and booking quotes. Exchange rates come from the real **Frankfurter API**
(`api.frankfurter.dev`, European Central Bank reference rates, no key). Rates are cached for 1 h and
served stale for up to 24 h if Frankfurter is unavailable; EUR quotes never depend on it.

Quotes: flights carry 9% air passenger duty & airport charges, hotels 6% city & tourist tax, plus a
€4.99 service fee per quote. Money math is `Decimal`, rounded half-up to cents. API: `docs/contract.md`.

```bash
uv sync                                              # from the repo root
uv run pricing-service                               # or: uv run uvicorn pricing_service.main:app --port 8084
uv run pytest services/pricing-service
LIVE=1 uv run pytest services/pricing-service -m live
curl 'localhost:8084/fx/convert?amount=100&from=EUR&to=GBP'
```

| Env | Default |
|-----|---------|
| `FRANKFURTER_URL` | `https://api.frankfurter.dev` |
| `EXTERNAL_TIMEOUT_MS` | `4000` |

Docker (build context is the repo root): `docker build -f services/pricing-service/Dockerfile -t travelduty/pricing-service .`
