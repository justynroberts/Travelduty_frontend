"""HTTP API for destination-service (docs/contract.md §2, destination-service)."""

from __future__ import annotations

import asyncio
import logging
import os
import re
import time
from collections.abc import Callable
from datetime import date, timedelta
from typing import Any

import httpx
from fastapi import FastAPI, Query

from travelduty_common import AppError, ServiceClient, TtlCache, create_service, find_airport, load_airports

from .clients import NagerDateClient, OpenMeteoClient

log = logging.getLogger("destination_service")

WEATHER_TTL = {"ttl": 15 * 60, "stale_if_error": 6 * 3600}
HOLIDAY_TTL = {"ttl": 24 * 3600, "stale_if_error": 7 * 24 * 3600}
GEOCODE_TTL = {"ttl": 3600, "stale_if_error": 24 * 3600}
ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def summary(a: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in a.items() if k != "costIndex"}


def require_destination(code: str) -> dict[str, Any]:
    a = find_airport(code)
    if a is None:
        raise AppError(404, "NOT_FOUND", f"Unknown destination {code}")
    return a


def _parse_date(value: str, field: str) -> date:
    if not ISO_DATE.match(value):
        raise AppError(400, "VALIDATION_ERROR", f"{field} must be a YYYY-MM-DD date")
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise AppError(400, "VALIDATION_ERROR", f"{field} must be a valid YYYY-MM-DD date") from None


def create_app(
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    today: Callable[[], date] = date.today,
    clock: Callable[[], float] = time.monotonic,
    retry_base_delay: float = 0.1,
) -> FastAPI:
    app = create_service("destination-service")
    timeout = float(os.environ.get("EXTERNAL_TIMEOUT_MS", "4000")) / 1000

    def client(name: str, env_key: str, default: str) -> ServiceClient:
        c = ServiceClient(
            name,
            os.environ.get(env_key) or default,
            timeout=timeout,
            transport=transport,
            metrics=app.state.metrics,
            retry_base_delay=retry_base_delay,
        )
        app.state.closers.append(c.aclose)
        return c

    open_meteo = OpenMeteoClient(
        client("open-meteo", "OPEN_METEO_URL", "https://api.open-meteo.com"),
        client("open-meteo-geocoding", "OPEN_METEO_GEOCODING_URL", "https://geocoding-api.open-meteo.com"),
    )
    nager = NagerDateClient(client("nager-date", "NAGER_DATE_URL", "https://date.nager.at"))
    weather_cache: TtlCache[list[dict[str, Any]]] = TtlCache(now=clock)
    holiday_cache: TtlCache[list[dict[str, Any]]] = TtlCache(now=clock)
    geocode_cache: TtlCache[list[dict[str, Any]]] = TtlCache(now=clock)

    def holiday_range(from_: str | None, to: str | None) -> tuple[str, str]:
        start = _parse_date(from_, "from") if from_ else today()
        end = _parse_date(to, "to") if to else start + timedelta(days=90)
        span = (end - start).days
        if span < 0:
            raise AppError(400, "BAD_REQUEST", "to must not be before from")
        if span > 400:
            raise AppError(400, "BAD_REQUEST", "Holiday range is limited to 400 days")
        return start.isoformat(), end.isoformat()

    async def weather(a: dict[str, Any], days: int):
        return await weather_cache.get_or_load(
            f"{a['code']}:{days}", lambda: open_meteo.forecast(a["lat"], a["lon"], days), **WEATHER_TTL
        )

    async def holidays(a: dict[str, Any], start: str, end: str) -> tuple[list[dict[str, Any]], bool]:
        stale = False
        found: list[dict[str, Any]] = []
        for year in sorted({int(start[:4]), int(end[:4])}):
            r = await holiday_cache.get_or_load(
                f"{a['countryCode']}:{year}",
                lambda year=year: nager.public_holidays(year, a["countryCode"]),
                **HOLIDAY_TTL,
            )
            stale = stale or r.stale
            found.extend(r.value)
        return [h for h in found if start <= h["date"] <= end], stale

    @app.get("/destinations")
    async def list_destinations(tag: str | None = None) -> dict[str, Any]:
        items = [summary(a) for a in load_airports() if not tag or tag in a["tags"]]
        return {"count": len(items), "items": items}

    @app.get("/destinations/{code}")
    async def get_destination(
        code: str,
        include: str = "",
        from_: str | None = Query(default=None, alias="from"),
        to: str | None = None,
    ) -> dict[str, Any]:
        a = require_destination(code)
        wanted = {part.strip() for part in include.split(",") if part.strip()}
        result: dict[str, Any] = summary(a)
        degraded: list[dict[str, str]] = []

        # Enrichment is best-effort: an external outage degrades the response rather than failing it.
        async def add_weather() -> None:
            try:
                r = await weather(a, 7)
                result["weather"] = {"days": r.value, "stale": r.stale, "source": "open-meteo.com"}
            except Exception as exc:
                result["weather"] = None
                degraded.append({"feature": "weather", "reason": str(exc)})
                log.warning("enrichment unavailable, serving degraded response", extra={"feature": "weather"})

        async def add_holidays(start: str, end: str) -> None:
            try:
                items, stale = await holidays(a, start, end)
                result["holidays"] = {
                    "from": start,
                    "to": end,
                    "items": items,
                    "stale": stale,
                    "source": "date.nager.at",
                }
            except Exception as exc:
                result["holidays"] = None
                degraded.append({"feature": "holidays", "reason": str(exc)})
                log.warning("enrichment unavailable, serving degraded response", extra={"feature": "holidays"})

        tasks = []
        if "weather" in wanted:
            tasks.append(add_weather())
        if "holidays" in wanted:
            tasks.append(add_holidays(*holiday_range(from_, to)))
        await asyncio.gather(*tasks)
        if degraded:
            result["degraded"] = degraded
        return result

    @app.get("/destinations/{code}/weather")
    async def get_weather(code: str, days: int = Query(default=7, ge=1, le=16)) -> dict[str, Any]:
        a = require_destination(code)
        r = await weather(a, days)
        return {"code": a["code"], "city": a["city"], "days": r.value, "stale": r.stale, "source": "open-meteo.com"}

    @app.get("/destinations/{code}/holidays")
    async def get_holidays(
        code: str, from_: str | None = Query(default=None, alias="from"), to: str | None = None
    ) -> dict[str, Any]:
        a = require_destination(code)
        start, end = holiday_range(from_, to)
        items, stale = await holidays(a, start, end)
        return {
            "code": a["code"],
            "countryCode": a["countryCode"],
            "from": start,
            "to": end,
            "items": items,
            "stale": stale,
            "source": "date.nager.at",
        }

    @app.get("/geocode")
    async def geocode(
        q: str = Query(min_length=2, max_length=100), count: int = Query(default=5, ge=1, le=10)
    ) -> dict[str, Any]:
        r = await geocode_cache.get_or_load(f"{q.lower()}:{count}", lambda: open_meteo.geocode(q, count), **GEOCODE_TTL)
        return {"query": q, "results": r.value, "stale": r.stale, "source": "open-meteo.com"}

    return app
