"""Hits the real external APIs. Skipped unless LIVE=1."""

import os
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from destination_service.app import create_app

pytestmark = [pytest.mark.live, pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="set LIVE=1")]


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


def test_live_lisbon_weather(client):
    body = client.get("/destinations/LIS/weather?days=3").json()
    assert len(body["days"]) == 3
    assert date.fromisoformat(body["days"][0]["date"])
    assert isinstance(body["days"][0]["tempMaxC"], float)


def test_live_portugal_holidays(client):
    year = date.today().year
    body = client.get(f"/destinations/LIS/holidays?from={year}-01-01&to={year}-12-31").json()
    assert any(h["date"] == f"{year}-12-25" for h in body["items"])


def test_live_detail_not_degraded(client):
    end = (date.today() + timedelta(days=60)).isoformat()
    body = client.get(f"/destinations/LIS?include=weather,holidays&to={end}").json()
    assert "degraded" not in body, body.get("degraded")


def test_live_geocode_lisbon(client):
    body = client.get("/geocode?q=Lisbon&count=1").json()
    assert body["results"][0]["countryCode"] == "PT"
