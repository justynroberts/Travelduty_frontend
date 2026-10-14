import asyncio

import httpx
import pytest
from fastapi import Query
from fastapi.testclient import TestClient

from travelduty_common import AppError, ChaosState, ServiceClient, TtlCache, UpstreamError, create_service


async def no_sleep(_seconds: float) -> None:
    return None


def make_app(**kwargs):
    app = create_service("test-service", sleep=no_sleep, **kwargs)

    @app.get("/items/{item_id}")
    async def item(item_id: str, n: int = Query(default=1, ge=1, le=5)):
        if item_id == "missing":
            raise AppError(404, "NOT_FOUND", "no such item")
        if item_id == "boom":
            raise RuntimeError("kaboom")
        return {"id": item_id, "n": n}

    return app


def test_health_and_ready():
    async def ok():
        return True

    async def broken():
        raise RuntimeError("db down")

    with TestClient(make_app(readiness={"db": ok})) as c:
        assert c.get("/health").json()["status"] == "ok"
        assert c.get("/health").json()["service"] == "test-service"
        assert c.get("/ready").json() == {"status": "ready", "checks": {"db": True}}
    with TestClient(make_app(readiness={"db": broken})) as c:
        res = c.get("/ready")
        assert res.status_code == 503
        assert res.json() == {"status": "not_ready", "checks": {"db": False}}


def test_request_id_is_echoed_or_generated():
    with TestClient(make_app()) as c:
        assert c.get("/items/a", headers={"x-request-id": "abc-123"}).headers["x-request-id"] == "abc-123"
        generated = c.get("/items/a").headers["x-request-id"]
        assert len(generated) == 36
        assert c.get("/items/a", headers={"x-request-id": "x" * 200}).headers["x-request-id"] != "x" * 200


def test_error_envelopes():
    with TestClient(make_app()) as c:
        res = c.get("/items/a?n=99")
        assert res.status_code == 400
        assert res.json()["error"]["code"] == "VALIDATION_ERROR"

        res = c.get("/items/missing")
        assert res.status_code == 404 and res.json() == {"error": {"code": "NOT_FOUND", "message": "no such item"}}

        res = c.get("/nope")
        assert res.status_code == 404
        assert res.json()["error"] == {"code": "NOT_FOUND", "message": "Route GET /nope not found"}

        res = c.get("/items/boom")
        assert res.status_code == 500
        assert res.json() == {"error": {"code": "INTERNAL_ERROR", "message": "Internal server error"}}
        assert "x-request-id" in res.headers


def test_chaos_injection_exempts_operational_endpoints():
    with TestClient(make_app(chaos=ChaosState(errorRate=1.0, errorStatus=503))) as c:
        res = c.get("/items/a")
        assert res.status_code == 503
        assert res.json() == {"error": {"code": "CHAOS_INJECTED", "message": "Injected failure in test-service"}}
        assert c.get("/health").status_code == 200
        assert c.get("/metrics").status_code == 200
        assert c.get("/admin/chaos").json()["errorRate"] == 1.0
        assert c.delete("/admin/chaos").json() == {"latencyMs": 0, "jitterMs": 0, "errorRate": 0.0, "errorStatus": 503}
        assert c.get("/items/a").status_code == 200


def test_chaos_admin_validation_and_latency():
    slept: list[float] = []

    async def record(seconds: float) -> None:
        slept.append(seconds)

    app = create_service("test-service", sleep=record, rand=lambda: 0.5)

    @app.get("/ping")
    async def ping():
        return {"pong": True}

    with TestClient(app) as c:
        assert c.put("/admin/chaos", json={"errorRate": 2}).status_code == 400
        assert c.put("/admin/chaos", json={"bogus": 1}).json()["error"]["code"] == "VALIDATION_ERROR"
        state = c.put("/admin/chaos", json={"latencyMs": 100, "jitterMs": 50}).json()
        assert state == {"latencyMs": 100, "jitterMs": 50, "errorRate": 0.0, "errorStatus": 503}
        c.get("/ping")
        assert slept == [0.125]


def test_admin_token_required_when_configured():
    with TestClient(make_app(admin_token="s3cret")) as c:
        res = c.get("/admin/chaos")
        assert res.status_code == 401 and res.json()["error"]["code"] == "UNAUTHORIZED"
        assert c.get("/admin/chaos", headers={"x-admin-token": "s3cret"}).status_code == 200


def test_metrics_use_route_templates():
    with TestClient(make_app()) as c:
        c.get("/items/abc")
        c.get("/items/def")
        c.get("/nope")
        body = c.get("/metrics").text
    assert 'http_requests_total{method="GET",route="/items/{item_id}",status="200"} 2.0' in body
    assert 'route="unmatched",status="404"' in body
    assert "http_request_duration_seconds_bucket" in body
    assert "upstream_calls_total" in body


def test_upstream_errors_map_to_gateway_statuses():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/bad":
            return httpx.Response(422, json={"error": {"code": "SOLD_OUT", "message": "gone"}})
        if request.url.path == "/slow":
            raise httpx.ReadTimeout("slow", request=request)
        return httpx.Response(503, json={"error": {"code": "DOWN", "message": "down"}})

    app = create_service("test-service", sleep=no_sleep)
    upstream = ServiceClient(
        "upstream",
        "http://upstream",
        transport=httpx.MockTransport(handler),
        metrics=app.state.metrics,
        retry_base_delay=0,
    )

    @app.get("/proxy/{what}")
    async def proxy(what: str):
        return await upstream.get(f"/{what}")

    with TestClient(app) as c:
        res = c.get("/proxy/bad")
        assert res.status_code == 422 and res.json()["error"]["code"] == "SOLD_OUT"
        res = c.get("/proxy/slow")
        assert res.status_code == 504 and res.json()["error"]["code"] == "UPSTREAM_TIMEOUT"
        res = c.get("/proxy/down")
        assert res.status_code == 502
        assert res.json()["error"]["code"] == "UPSTREAM_UNAVAILABLE"
        assert res.json()["error"]["service"] == "upstream"
        metrics = c.get("/metrics").text
    assert 'upstream_calls_total{outcome="error",target="upstream"} 7.0' in metrics


def test_client_retries_gets_and_forwards_request_id():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) < 3:
            return httpx.Response(503)
        return httpx.Response(200, json={"ok": True})

    app = create_service("test-service", sleep=no_sleep)
    upstream = ServiceClient("upstream", "http://upstream", transport=httpx.MockTransport(handler), retry_base_delay=0)

    @app.get("/call")
    async def call():
        return await upstream.get("/thing", query={"a": 1, "skip": None, "flag": True})

    with TestClient(app) as c:
        assert c.get("/call", headers={"x-request-id": "trace-me"}).json() == {"ok": True}
    assert len(seen) == 3
    assert all(r.headers["x-request-id"] == "trace-me" for r in seen)
    assert seen[0].headers["user-agent"].startswith("TravelDuty/")
    assert str(seen[0].url) == "http://upstream/thing?a=1&flag=true"


def test_client_does_not_retry_posts_without_idempotency_key():
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    client = ServiceClient("u", "http://u", transport=httpx.MockTransport(handler), retry_base_delay=0)
    with pytest.raises(UpstreamError) as err:
        asyncio.run(client.post("/x", json_body={"a": 1}))
    assert calls == 1 and err.value.status_code == 500
    with pytest.raises(UpstreamError):
        asyncio.run(client.post("/x", json_body={}, idempotency_key="k1"))
    assert calls == 4


def test_cache_serves_stale_on_error_and_single_flights():
    now = [0.0]
    cache: TtlCache[int] = TtlCache(now=lambda: now[0])
    calls = 0

    async def loader() -> int:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        return calls

    async def failing() -> int:
        raise RuntimeError("upstream down")

    async def scenario():
        first = await asyncio.gather(*(cache.get_or_load("k", loader, ttl=10) for _ in range(5)))
        assert [r.value for r in first] == [1] * 5 and calls == 1
        now[0] = 11
        stale = await cache.get_or_load("k", failing, ttl=10, stale_if_error=60)
        assert stale.value == 1 and stale.stale
        now[0] = 100
        with pytest.raises(RuntimeError):
            await cache.get_or_load("k", failing, ttl=10, stale_if_error=60)

    asyncio.run(scenario())
