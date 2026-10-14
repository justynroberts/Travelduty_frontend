"""Pure-ASGI middleware: request ids, access logs, metrics, chaos injection and last-resort 500s."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from starlette.datastructures import MutableHeaders
from starlette.routing import Match
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .chaos import ChaosState
from .errors import error_body
from .logs import request_id_var
from .metrics import ServiceMetrics

EXEMPT = re.compile(r"^/(health|ready|metrics|admin)(/|$)")
log = logging.getLogger("travelduty.http")


class PlatformMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        service_name: str,
        metrics: ServiceMetrics,
        chaos: ChaosState,
        routes: Callable[[], list[Any]],
        rand: Callable[[], float],
        sleep: Callable[[float], Awaitable[None]],
    ) -> None:
        self.app = app
        self.service_name = service_name
        self.metrics = metrics
        self.chaos = chaos
        self.routes = routes
        self.rand = rand
        self.sleep = sleep

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        incoming = next((v.decode("latin-1") for k, v in scope["headers"] if k == b"x-request-id"), None)
        request_id = incoming if incoming and len(incoming) <= 128 else str(uuid.uuid4())
        token = request_id_var.set(request_id)
        state = {"status": 500, "started": False}

        async def send_wrapper(message: Message) -> None:
            if message["type"] == "http.response.start":
                state["status"] = message["status"]
                state["started"] = True
                MutableHeaders(scope=message)["x-request-id"] = request_id
            await send(message)

        started = time.perf_counter()
        path: str = scope["path"]
        try:
            if not EXEMPT.match(path) and await self._inject_failure():
                log.warning("chaos: injecting failure", extra={"chaos": self.chaos.to_dict()})
                await _send_json(
                    send_wrapper,
                    self.chaos.errorStatus,
                    error_body("CHAOS_INJECTED", f"Injected failure in {self.service_name}"),
                )
            else:
                await self.app(scope, receive, send_wrapper)
        except Exception:
            log.exception("unhandled error")
            if not state["started"]:
                await _send_json(send_wrapper, 500, error_body("INTERNAL_ERROR", "Internal server error"))
        finally:
            elapsed = time.perf_counter() - started
            route = self._route(scope)
            if route != "/metrics":
                self.metrics.observe_http(scope["method"], route, int(state["status"]), elapsed)
            log.info(
                "request completed",
                extra={
                    "method": scope["method"],
                    "path": path,
                    "route": route,
                    "status": state["status"],
                    "durationMs": round(elapsed * 1000, 1),
                },
            )
            request_id_var.reset(token)

    async def _inject_failure(self) -> bool:
        c = self.chaos
        delay_ms = c.latencyMs + (self.rand() * c.jitterMs if c.jitterMs > 0 else 0)
        if delay_ms > 0:
            await self.sleep(delay_ms / 1000)
        return c.errorRate > 0 and self.rand() < c.errorRate

    def _route(self, scope: Scope) -> str:
        """The matched route template (e.g. `/destinations/{code}`), never the raw path."""
        matched = scope.get("route")
        if matched is not None and getattr(matched, "path", None):
            return matched.path
        for route in self.routes():
            match, _ = route.matches(scope)
            if match != Match.NONE:
                return route.path
        return "unmatched"


async def _send_json(send: Send, status: int, body: dict[str, Any]) -> None:
    payload = json.dumps(body).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(payload)).encode())],
        }
    )
    await send({"type": "http.response.body", "body": payload})
