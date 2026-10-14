"""HTTP API for pricing-service (docs/contract.md §2, pricing-service)."""

from __future__ import annotations

import os
import time
import uuid
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any, Literal

import httpx
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from travelduty_common import AppError, ServiceClient, TtlCache, UpstreamError, create_service

from .quotes import dec, money, price_quote

RATES_TTL = {"ttl": 3600, "stale_if_error": 24 * 3600}
QUOTE_TTL = timedelta(minutes=30)
MAX_QUOTES = 5000
CURRENCY_PATTERN = r"^[A-Za-z]{3}$"


@dataclass(frozen=True)
class EurRates:
    date: str
    rates: dict[str, float]  # per 1 EUR, including EUR itself


@dataclass(frozen=True)
class Rate:
    value: Decimal
    date: str
    stale: bool


class QuoteItem(BaseModel):
    kind: Literal["flight", "hotel", "other"]
    description: str = Field(min_length=1, max_length=200)
    amountEur: float = Field(ge=0)  # noqa: N815


class QuoteRequest(BaseModel):
    currency: str = Field(pattern=CURRENCY_PATTERN)
    items: list[QuoteItem] = Field(min_length=1, max_length=50)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _round6(value: Decimal) -> float:
    return float(round(value, 6))


def create_app(
    *,
    transport: httpx.AsyncBaseTransport | None = None,
    clock: Callable[[], float] = time.monotonic,
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    retry_base_delay: float = 0.1,
) -> FastAPI:
    app = create_service("pricing-service")
    frankfurter = ServiceClient(
        "frankfurter",
        os.environ.get("FRANKFURTER_URL") or "https://api.frankfurter.dev",
        timeout=float(os.environ.get("EXTERNAL_TIMEOUT_MS", "4000")) / 1000,
        transport=transport,
        metrics=app.state.metrics,
        retry_base_delay=retry_base_delay,
    )
    app.state.closers.append(frankfurter.aclose)
    cache: TtlCache[EurRates] = TtlCache(now=clock)
    quotes: OrderedDict[str, dict[str, Any]] = OrderedDict()

    async def load_rates() -> EurRates:
        body = await frankfurter.get("/v1/latest", query={"base": "EUR"})
        if not isinstance(body, dict) or not isinstance(body.get("rates"), dict):
            raise UpstreamError("frankfurter", "http", "frankfurter returned an unexpected payload", 502, body)
        rates = {k.upper(): float(v) for k, v in body["rates"].items()}
        rates["EUR"] = 1.0
        return EurRates(date=str(body.get("date", "")), rates=rates)

    async def eur_rates() -> tuple[EurRates, bool]:
        r = await cache.get_or_load("EUR", load_rates, **RATES_TTL)
        return r.value, r.stale

    def require(table: dict[str, float], *codes: str) -> None:
        for code in codes:
            if code not in table:
                raise AppError(
                    400, "UNSUPPORTED_CURRENCY", f"Currency {code} is not supported", {"supported": sorted(table)}
                )

    async def rate_between(src: str, dst: str) -> Rate:
        if src == dst == "EUR":  # EUR pricing never depends on Frankfurter being up
            return Rate(Decimal(1), now().date().isoformat(), False)
        rates, stale = await eur_rates()
        require(rates.rates, src, dst)
        return Rate(dec(rates.rates[dst]) / dec(rates.rates[src]), rates.date, stale)

    @app.get("/fx/currencies")
    async def currencies() -> dict[str, Any]:
        rates, _ = await eur_rates()
        return {"base": "EUR", "currencies": sorted(rates.rates)}

    @app.get("/fx/rates")
    async def fx_rates(base: str = Query(default="EUR", pattern=CURRENCY_PATTERN)) -> dict[str, Any]:
        base = base.upper()
        rates, stale = await eur_rates()
        require(rates.rates, base)
        per_base = dec(rates.rates[base])
        cross = {c: _round6(dec(v) / per_base) for c, v in sorted(rates.rates.items()) if c != base}
        return {"base": base, "date": rates.date, "rates": cross, "stale": stale, "source": "frankfurter.dev"}

    @app.get("/fx/convert")
    async def convert(
        amount: float = Query(ge=0),
        from_: str = Query(alias="from", pattern=CURRENCY_PATTERN),
        to: str = Query(pattern=CURRENCY_PATTERN),
    ) -> dict[str, Any]:
        src, dst = from_.upper(), to.upper()
        rate = await rate_between(src, dst)
        return {
            "amount": amount,
            "from": src,
            "to": dst,
            "rate": _round6(rate.value),
            "result": money(dec(amount) * rate.value),
            "date": rate.date,
            "stale": rate.stale,
        }

    @app.post("/quotes", status_code=201)
    async def create_quote(req: QuoteRequest) -> JSONResponse:
        currency = req.currency.upper()
        rate = await rate_between("EUR", currency)
        created = now()
        quote = {
            "id": f"q_{uuid.uuid4().hex[:16]}",
            "currency": currency,
            "rate": _round6(rate.value),
            "rateDate": rate.date,
            "rateStale": rate.stale,
            **price_quote([i.model_dump() for i in req.items], rate.value),
            "createdAt": _iso(created),
            "expiresAt": _iso(created + QUOTE_TTL),
        }
        quotes[quote["id"]] = quote
        while len(quotes) > MAX_QUOTES:
            quotes.popitem(last=False)
        return JSONResponse(quote, status_code=201)

    @app.get("/quotes/{quote_id}")
    async def get_quote(quote_id: str) -> dict[str, Any]:
        quote = quotes.get(quote_id)
        if quote is None:
            raise AppError(404, "NOT_FOUND", f"Quote {quote_id} not found")
        return quote

    return app
