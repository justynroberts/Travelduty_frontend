"""Async JSON HTTP client with timeouts, bounded retries, request-id propagation and metrics."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx

from .errors import UpstreamError
from .logs import request_id_var
from .metrics import ServiceMetrics

USER_AGENT = "TravelDuty/0.1 (sample microservices app)"


class ServiceClient:
    def __init__(
        self,
        name: str,
        base_url: str,
        *,
        timeout: float = 5.0,
        retries: int = 2,
        retry_base_delay: float = 0.1,
        headers: dict[str, str] | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
        metrics: ServiceMetrics | None = None,
    ) -> None:
        self.name = name
        self.retries = retries
        self.retry_base_delay = retry_base_delay
        self.metrics = metrics
        self._client = httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            timeout=timeout,
            transport=transport,
            headers={"user-agent": USER_AGENT, "accept": "application/json", **(headers or {})},
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def get(self, path: str, **kwargs: Any) -> Any:
        return await self.request("GET", path, **kwargs)

    async def post(self, path: str, **kwargs: Any) -> Any:
        return await self.request("POST", path, **kwargs)

    async def request(self, method: str, path: str, **kwargs: Any) -> Any:
        return (await self.exchange(method, path, **kwargs))[1]

    async def exchange(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        json_body: Any = None,
        idempotency_key: str | None = None,
        headers: dict[str, str] | None = None,
        timeout: float | None = None,
    ) -> tuple[int, Any]:
        """Returns `(status, parsed_body)`; raises `UpstreamError` on any non-2xx or transport failure."""
        params = {
            k: (str(v).lower() if isinstance(v, bool) else v) for k, v in (query or {}).items() if v not in (None, "")
        }
        hdrs = dict(headers or {})
        request_id = request_id_var.get()
        if request_id:
            hdrs["x-request-id"] = request_id
        if idempotency_key:
            hdrs["idempotency-key"] = idempotency_key

        retryable = method == "GET" or bool(idempotency_key)
        attempts = self.retries + 1 if retryable else 1
        last: UpstreamError | None = None

        for attempt in range(attempts):
            if attempt:
                await asyncio.sleep(self.retry_base_delay * 2 ** (attempt - 1))
            started = time.perf_counter()
            try:
                res = await self._client.request(
                    method,
                    path,
                    params=params,
                    json=json_body,
                    headers=hdrs,
                    timeout=timeout if timeout is not None else httpx.USE_CLIENT_DEFAULT,
                )
            except httpx.TimeoutException as exc:
                self._record("error", started)
                last = UpstreamError(self.name, "timeout", f"{self.name} timed out ({type(exc).__name__})")
                continue
            except httpx.TransportError as exc:
                self._record("error", started)
                reason = str(exc) or type(exc).__name__
                last = UpstreamError(self.name, "network", f"{self.name} unreachable: {reason}")
                continue

            body = _parse(res)
            if res.is_success:
                self._record("success", started)
                return res.status_code, body
            self._record("error", started)
            last = UpstreamError(
                self.name,
                "http",
                f"{self.name} responded {res.status_code} to {method} {res.request.url.path}",
                res.status_code,
                body,
            )
            if res.status_code < 500:  # deterministic; retrying will not help
                raise last
        assert last is not None
        raise last

    def _record(self, outcome: str, started: float) -> None:
        if self.metrics:
            self.metrics.record_call(self.name, outcome, time.perf_counter() - started)


def _parse(res: httpx.Response) -> Any:
    if not res.content:
        return None
    try:
        return res.json()
    except (json.JSONDecodeError, UnicodeDecodeError):
        return res.text
