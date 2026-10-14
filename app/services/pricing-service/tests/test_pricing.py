from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest
from fastapi.testclient import TestClient

from pricing_service.app import create_app
from pricing_service.quotes import price_quote

LATEST = {
    "amount": 1.0,
    "base": "EUR",
    "date": "2026-10-13",
    "rates": {"GBP": 0.8446, "USD": 1.1188, "JPY": 176.91, "SEK": 11.1698},
}
CONTRACT_ITEMS = [
    {"kind": "flight", "description": "LHR→LIS NX482", "amountEur": 256.8},
    {"kind": "hotel", "description": "4 nights, Casa Alfama", "amountEur": 612.76},
]


class Frankfurter:
    def __init__(self) -> None:
        self.down = False
        self.calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if self.down:
            return httpx.Response(503)
        assert request.url.path == "/v1/latest" and request.url.params["base"] == "EUR"
        return httpx.Response(200, json=LATEST)


@pytest.fixture
def frankfurter() -> Frankfurter:
    return Frankfurter()


@pytest.fixture
def clock() -> list[float]:
    return [0.0]


@pytest.fixture
def client(frankfurter, clock):
    app = create_app(
        transport=httpx.MockTransport(frankfurter),
        clock=lambda: clock[0],
        now=lambda: datetime(2026, 10, 14, 9, 0, tzinfo=UTC),
        retry_base_delay=0,
    )
    with TestClient(app) as c:
        yield c


def test_quote_matches_contract_example(client):
    res = client.post("/quotes", json={"currency": "gbp", "items": CONTRACT_ITEMS})
    assert res.status_code == 201
    q = res.json()
    assert q["id"].startswith("q_")
    assert (q["currency"], q["rate"], q["rateDate"], q["rateStale"]) == ("GBP", 0.8446, "2026-10-13", False)
    assert q["lines"][0] == {"kind": "flight", "description": "LHR→LIS NX482", "amountEur": 256.8, "amount": 216.89}
    assert q["taxes"] == [
        {"description": "Air passenger duty & airport charges", "amountEur": 23.11, "amount": 19.52},
        {"description": "City & tourist tax", "amountEur": 36.77, "amount": 31.05},
    ]
    assert q["fees"] == [{"description": "TravelDuty service fee", "amountEur": 4.99, "amount": 4.21}]
    # docs/contract.md's example shows 734.42 / 789.2; 869.56 × 0.8446 = 734.43 exactly, so these are correct.
    assert (q["subtotal"], q["taxTotal"], q["feeTotal"], q["total"], q["totalEur"]) == (
        734.43,
        50.57,
        4.21,
        789.21,
        934.43,
    )
    assert q["createdAt"] == "2026-10-14T09:00:00.000Z"
    assert q["expiresAt"] == "2026-10-14T09:30:00.000Z"


def test_eur_quote_works_without_frankfurter(client, frankfurter):
    frankfurter.down = True
    q = client.post("/quotes", json={"currency": "EUR", "items": CONTRACT_ITEMS}).json()
    assert q["rate"] == 1.0 and q["rateDate"] == "2026-10-14"
    assert q["subtotal"] == 869.56 and q["total"] == q["totalEur"] == 934.43
    assert frankfurter.calls == 0


def test_taxes_only_listed_when_non_zero():
    q = price_quote([{"kind": "other", "description": "Insurance", "amountEur": 20}], Decimal(1))
    assert q["taxes"] == [] and q["taxTotal"] == 0 and q["total"] == 24.99


def test_get_quote_and_404(client):
    created = client.post("/quotes", json={"currency": "USD", "items": CONTRACT_ITEMS}).json()
    assert client.get(f"/quotes/{created['id']}").json() == created
    res = client.get("/quotes/q_missing")
    assert res.status_code == 404 and res.json()["error"]["code"] == "NOT_FOUND"


def test_quote_validation(client):
    for body in (
        {"currency": "GBP", "items": []},
        {"currency": "POUNDS", "items": CONTRACT_ITEMS},
        {"currency": "GBP", "items": [{"kind": "boat", "description": "x", "amountEur": 1}]},
        {"currency": "GBP", "items": [{"kind": "flight", "description": "x", "amountEur": -1}]},
    ):
        res = client.post("/quotes", json=body)
        assert res.status_code == 400, body
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_unsupported_currency(client):
    res = client.post("/quotes", json={"currency": "XYZ", "items": CONTRACT_ITEMS})
    assert res.status_code == 400
    assert res.json()["error"]["code"] == "UNSUPPORTED_CURRENCY"
    assert "GBP" in res.json()["error"]["details"]["supported"]
    assert client.get("/fx/convert?amount=1&from=EUR&to=XYZ").json()["error"]["code"] == "UNSUPPORTED_CURRENCY"


def test_rates_eur_base(client):
    body = client.get("/fx/rates").json()
    assert body["base"] == "EUR" and body["date"] == "2026-10-13" and body["source"] == "frankfurter.dev"
    assert body["rates"]["GBP"] == 0.8446 and "EUR" not in body["rates"]
    assert body["stale"] is False


def test_cross_rates_for_non_eur_base(client):
    body = client.get("/fx/rates?base=gbp").json()
    assert body["base"] == "GBP"
    assert body["rates"]["EUR"] == round(1 / 0.8446, 6)
    assert body["rates"]["USD"] == round(1.1188 / 0.8446, 6)
    assert "GBP" not in body["rates"]


def test_currencies(client):
    assert client.get("/fx/currencies").json() == {"base": "EUR", "currencies": ["EUR", "GBP", "JPY", "SEK", "USD"]}


def test_convert(client):
    assert client.get("/fx/convert?amount=100&from=EUR&to=GBP").json() == {
        "amount": 100.0,
        "from": "EUR",
        "to": "GBP",
        "rate": 0.8446,
        "result": 84.46,
        "date": "2026-10-13",
        "stale": False,
    }
    body = client.get("/fx/convert?amount=100&from=GBP&to=USD").json()
    assert body["rate"] == round(1.1188 / 0.8446, 6) and body["result"] == 132.47
    assert client.get("/fx/convert?amount=-5&from=EUR&to=GBP").status_code == 400
    assert client.get("/fx/convert?amount=5&to=GBP").status_code == 400


def test_rates_cached_and_served_stale_if_error(client, frankfurter, clock):
    client.get("/fx/rates")
    client.get("/fx/convert?amount=1&from=EUR&to=USD")
    assert frankfurter.calls == 1
    clock[0] = 3601
    frankfurter.down = True
    body = client.get("/fx/rates").json()
    assert body["stale"] is True and body["rates"]["GBP"] == 0.8446
    q = client.post("/quotes", json={"currency": "GBP", "items": CONTRACT_ITEMS}).json()
    assert q["rateStale"] is True
    clock[0] = 3600 + 24 * 3600 + 1
    res = client.get("/fx/rates")
    assert res.status_code == 502
    assert res.json()["error"] == {
        "code": "UPSTREAM_UNAVAILABLE",
        "message": "frankfurter responded 503 to GET /v1/latest",
        "service": "frankfurter",
    }


def test_frankfurter_down_without_cache_fails_non_eur(client, frankfurter):
    frankfurter.down = True
    res = client.post("/quotes", json={"currency": "GBP", "items": CONTRACT_ITEMS})
    assert res.status_code == 502
    assert frankfurter.calls == 3  # initial + 2 retries


def test_metrics_record_frankfurter_calls(client):
    client.get("/fx/rates")
    text = client.get("/metrics").text
    assert 'upstream_calls_total{outcome="success",target="frankfurter"} 1.0' in text
    assert 'http_requests_total{method="GET",route="/fx/rates",status="200"} 1.0' in text
