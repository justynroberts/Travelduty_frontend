"""Hits the real Frankfurter API. Skipped unless LIVE=1."""

import os

import pytest
from fastapi.testclient import TestClient

from pricing_service.app import create_app

pytestmark = [pytest.mark.live, pytest.mark.skipif(os.environ.get("LIVE") != "1", reason="set LIVE=1")]


@pytest.fixture(scope="module")
def client():
    with TestClient(create_app()) as c:
        yield c


def test_live_eur_to_gbp(client):
    body = client.get("/fx/convert?amount=100&from=EUR&to=GBP").json()
    assert 0.5 < body["rate"] < 1.5 and body["stale"] is False
    assert body["result"] == pytest.approx(100 * body["rate"], abs=0.01)


def test_live_quote_in_usd(client):
    res = client.post(
        "/quotes",
        json={"currency": "USD", "items": [{"kind": "flight", "description": "LHR→JFK", "amountEur": 450}]},
    )
    assert res.status_code == 201 and res.json()["total"] > 450
