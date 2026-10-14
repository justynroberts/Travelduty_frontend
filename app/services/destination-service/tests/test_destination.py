from datetime import date

import httpx
import pytest
from fastapi.testclient import TestClient

from destination_service.app import create_app
from destination_service.clients import describe_weather

FORECAST = {
    "daily": {
        "time": ["2026-10-14", "2026-10-15"],
        "weather_code": [2, 61],
        "temperature_2m_max": [31.2, 24.0],
        "temperature_2m_min": [15.8, 17.1],
        "precipitation_sum": [0.0, 4.2],
        "precipitation_probability_max": [0, 80],
    }
}
PT_2026 = [
    {"date": "2026-10-05", "localName": "Implantação da República", "name": "Republic Day", "global": True},
    {"date": "2026-11-01", "localName": "Dia de Todos-os-Santos", "name": "All Saints Day", "global": True},
    {"date": "2026-12-25", "localName": "Natal", "name": "Christmas Day", "global": True},
]
PT_2027 = [{"date": "2027-01-01", "localName": "Ano Novo", "name": "New Year's Day", "global": True}]
GEOCODE = {
    "results": [
        {
            "name": "Lisbon",
            "country": "Portugal",
            "country_code": "PT",
            "admin1": "Lisbon",
            "latitude": 38.72,
            "longitude": -9.14,
            "timezone": "Europe/Lisbon",
            "population": 517802,
        }
    ]
}


class Upstreams:
    """Programmable stand-ins for Open-Meteo and Nager.Date, routed by host."""

    def __init__(self) -> None:
        self.down: set[str] = set()
        self.calls: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.calls.append(request)
        host, path = request.url.host, request.url.path
        if host in self.down:
            return httpx.Response(503, json={"reason": "maintenance"})
        if host == "api.open-meteo.com" and path == "/v1/forecast":
            return httpx.Response(200, json=FORECAST)
        if host == "geocoding-api.open-meteo.com" and path == "/v1/search":
            return httpx.Response(200, json=GEOCODE if request.url.params["name"] != "zzzz" else {})
        if host == "date.nager.at":
            if path.endswith("/TH"):
                return httpx.Response(204)
            if path.endswith("/XX"):
                return httpx.Response(404)
            return httpx.Response(200, json=PT_2027 if "/2027/" in path else PT_2026)
        return httpx.Response(404)


@pytest.fixture
def upstreams() -> Upstreams:
    return Upstreams()


@pytest.fixture
def clock() -> list[float]:
    return [0.0]


@pytest.fixture
def client(upstreams, clock):
    app = create_app(
        transport=httpx.MockTransport(upstreams),
        today=lambda: date(2026, 10, 14),
        clock=lambda: clock[0],
        retry_base_delay=0,
    )
    with TestClient(app) as c:
        yield c


def test_lists_destinations_with_tag_filter(client):
    body = client.get("/destinations").json()
    assert body["count"] == 14
    assert "costIndex" not in body["items"][0]
    beach = client.get("/destinations?tag=beach").json()
    assert {d["code"] for d in beach["items"]} >= {"LIS", "BCN", "SYD"}
    assert all("beach" in d["tags"] for d in beach["items"])


def test_detail_with_weather_and_holidays(client, upstreams):
    res = client.get("/destinations/lis?include=weather,holidays&from=2026-10-20&to=2027-01-10")
    assert res.status_code == 200
    body = res.json()
    assert body["code"] == "LIS" and body["city"] == "Lisbon"
    assert body["weather"]["source"] == "open-meteo.com" and body["weather"]["stale"] is False
    assert body["weather"]["days"][1] == {
        "date": "2026-10-15",
        "summary": "Rain",
        "weatherCode": 61,
        "tempMaxC": 24.0,
        "tempMinC": 17.1,
        "precipitationMm": 4.2,
        "precipitationChance": 80,
    }
    assert [h["date"] for h in body["holidays"]["items"]] == ["2026-11-01", "2026-12-25", "2027-01-01"]
    assert body["holidays"]["items"][0] == {
        "date": "2026-11-01",
        "name": "All Saints Day",
        "localName": "Dia de Todos-os-Santos",
        "nationwide": True,
    }
    assert "degraded" not in body
    forecast_call = next(r for r in upstreams.calls if r.url.host == "api.open-meteo.com")
    assert forecast_call.url.params["latitude"] == "38.7223"
    assert forecast_call.url.params["timezone"] == "auto"


def test_detail_without_include_does_not_call_upstreams(client, upstreams):
    assert "weather" not in client.get("/destinations/LIS").json()
    assert upstreams.calls == []


def test_degraded_when_open_meteo_fails(client, upstreams):
    upstreams.down.add("api.open-meteo.com")
    res = client.get("/destinations/LIS?include=weather,holidays")
    assert res.status_code == 200
    body = res.json()
    assert body["weather"] is None
    assert body["holidays"]["items"]  # default range today..+90d
    assert body["holidays"]["from"] == "2026-10-14" and body["holidays"]["to"] == "2027-01-12"
    assert len(body["degraded"]) == 1
    assert body["degraded"][0]["feature"] == "weather"
    assert "open-meteo" in body["degraded"][0]["reason"]
    # GETs are retried twice before giving up.
    assert sum(1 for r in upstreams.calls if r.url.host == "api.open-meteo.com") == 3


def test_stale_weather_served_when_upstream_down(client, upstreams, clock):
    assert client.get("/destinations/LIS/weather").json()["stale"] is False
    clock[0] = 16 * 60  # past the 15 minute TTL
    upstreams.down.add("api.open-meteo.com")
    body = client.get("/destinations/LIS/weather").json()
    assert body["stale"] is True and len(body["days"]) == 2
    clock[0] = 7 * 3600  # past stale-if-error window
    res = client.get("/destinations/LIS/weather")
    assert res.status_code == 502
    assert res.json()["error"]["code"] == "UPSTREAM_UNAVAILABLE"
    assert res.json()["error"]["service"] == "open-meteo"


def test_weather_is_cached(client, upstreams):
    client.get("/destinations/LIS/weather")
    client.get("/destinations/LIS/weather")
    assert sum(1 for r in upstreams.calls if r.url.host == "api.open-meteo.com") == 1


def test_weather_days_validation(client):
    res = client.get("/destinations/LIS/weather?days=30")
    assert res.status_code == 400 and res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_nager_204_means_no_holidays(client):
    body = client.get("/destinations/BKK/holidays").json()
    assert body["items"] == [] and body["countryCode"] == "TH"


def test_holiday_range_validation(client):
    assert client.get("/destinations/LIS/holidays?from=2026-13-01").json()["error"]["code"] == "VALIDATION_ERROR"
    res = client.get("/destinations/LIS/holidays?from=2026-10-10&to=2026-10-01")
    assert res.status_code == 400 and res.json()["error"]["code"] == "BAD_REQUEST"
    assert client.get("/destinations/LIS/holidays?from=2026-01-01&to=2027-12-31").status_code == 400


def test_unknown_destination_is_404(client):
    res = client.get("/destinations/XYZ?include=weather")
    assert res.status_code == 404
    assert res.json() == {"error": {"code": "NOT_FOUND", "message": "Unknown destination XYZ"}}


def test_geocode(client):
    body = client.get("/geocode?q=Lisbon").json()
    assert body["results"][0] == {
        "name": "Lisbon",
        "country": "Portugal",
        "countryCode": "PT",
        "region": "Lisbon",
        "lat": 38.72,
        "lon": -9.14,
        "timezone": "Europe/Lisbon",
        "population": 517802,
    }
    assert client.get("/geocode?q=zzzz").json()["results"] == []


def test_geocode_validation(client):
    for qs in ("", "?q=a", "?q=Lisbon&count=50"):
        res = client.get(f"/geocode{qs}")
        assert res.status_code == 400, qs
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"


def test_describe_weather():
    assert describe_weather(0) == "Clear sky"
    assert describe_weather(95) == "Thunderstorm"
    assert describe_weather(42) == "Unknown"
