"""FastAPI app factory implementing the TravelDuty platform contract (docs/contract.md §1)."""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.exceptions import HTTPException as StarletteHTTPException

from .chaos import ChaosState, ChaosUpdate, chaos_from_env
from .errors import AppError, UpstreamError, error_body
from .logs import configure_logging
from .metrics import ServiceMetrics
from .middleware import PlatformMiddleware

Readiness = dict[str, Callable[[], Awaitable[bool]]]
log = logging.getLogger("travelduty.service")

_HTTP_CODES = {401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 405: "METHOD_NOT_ALLOWED"}


def create_service(
    name: str,
    *,
    version: str | None = None,
    readiness: Readiness | None = None,
    chaos: ChaosState | None = None,
    admin_token: str | None = None,
    rand: Callable[[], float] = random.random,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> FastAPI:
    """Builds a FastAPI app with request ids, JSON logs, /health, /ready, /metrics, chaos and error envelopes.

    Register async cleanup callbacks (e.g. `client.aclose`) on `app.state.closers`; they run at shutdown.
    """
    configure_logging(name, os.environ.get("LOG_LEVEL", "info"))
    closers: list[Callable[[], Awaitable[None]]] = []

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        log.info("service started")
        yield
        for close in closers:
            await close()

    resolved_version = version or os.environ.get("APP_VERSION", "dev")
    app = FastAPI(title=name, version=resolved_version, lifespan=lifespan)
    metrics = ServiceMetrics()
    chaos_state = chaos or chaos_from_env()
    token = admin_token if admin_token is not None else (os.environ.get("ADMIN_TOKEN") or None)
    checks = readiness or {}
    started = time.monotonic()

    app.state.service_name = name
    app.state.metrics = metrics
    app.state.chaos = chaos_state
    app.state.closers = closers

    @app.get("/health", include_in_schema=False)
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": name,
            "version": resolved_version,
            "uptimeSeconds": round(time.monotonic() - started),
        }

    @app.get("/ready", include_in_schema=False)
    async def ready() -> JSONResponse:
        async def run(check: Callable[[], Awaitable[bool]]) -> bool:
            try:
                return bool(await check())
            except Exception:
                return False

        results = dict(zip(checks, await asyncio.gather(*(run(c) for c in checks.values())), strict=True))
        ok = all(results.values())
        return JSONResponse(
            {"status": "ready" if ok else "not_ready", "checks": results}, status_code=200 if ok else 503
        )

    @app.get("/metrics", include_in_schema=False)
    async def prometheus_metrics() -> Response:
        return Response(generate_latest(metrics.registry), media_type=CONTENT_TYPE_LATEST)

    async def require_admin(x_admin_token: str | None = Header(default=None)) -> None:
        if token and x_admin_token != token:
            raise AppError(401, "UNAUTHORIZED", "A valid x-admin-token header is required")

    @app.get("/admin/chaos", dependencies=[Depends(require_admin)], include_in_schema=False)
    async def get_chaos() -> dict[str, Any]:
        return chaos_state.to_dict()

    @app.put("/admin/chaos", dependencies=[Depends(require_admin)], include_in_schema=False)
    async def put_chaos(update: ChaosUpdate) -> dict[str, Any]:
        for key, value in update.model_dump(exclude_unset=True, exclude_none=True).items():
            setattr(chaos_state, key, value)
        log.warning("chaos: configuration changed", extra={"chaos": chaos_state.to_dict()})
        return chaos_state.to_dict()

    @app.delete("/admin/chaos", dependencies=[Depends(require_admin)], include_in_schema=False)
    async def reset_chaos() -> dict[str, Any]:
        chaos_state.reset()
        log.info("chaos: reset")
        return chaos_state.to_dict()

    @app.exception_handler(AppError)
    async def on_app_error(_req: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(error_body(exc.code, exc.message, exc.details), status_code=exc.status_code)

    @app.exception_handler(UpstreamError)
    async def on_upstream_error(_req: Request, exc: UpstreamError) -> JSONResponse:
        if exc.is_client_error:  # pass client errors (validation, not found, ...) straight through
            body = (
                exc.body
                if isinstance(exc.body, dict) and "error" in exc.body
                else error_body("UPSTREAM_REJECTED", exc.message, service=exc.service)
            )
            return JSONResponse(body, status_code=exc.status_code or 502)
        log.error("upstream failure", extra={"upstream": exc.service, "kind": exc.kind, "status": exc.status_code})
        timeout = exc.kind == "timeout"
        return JSONResponse(
            error_body("UPSTREAM_TIMEOUT" if timeout else "UPSTREAM_UNAVAILABLE", exc.message, service=exc.service),
            status_code=504 if timeout else 502,
        )

    @app.exception_handler(RequestValidationError)
    async def on_validation_error(_req: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {"location": ".".join(str(p) for p in e.get("loc", ())), "message": e.get("msg", "invalid")}
            for e in exc.errors()
        ]
        message = "; ".join(f"{e['location']}: {e['message']}" for e in errors) or "Invalid request"
        return JSONResponse(error_body("VALIDATION_ERROR", message, errors), status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def on_http_exception(req: Request, exc: StarletteHTTPException) -> JSONResponse:
        if exc.status_code == 404 and exc.detail == "Not Found":
            message = f"Route {req.method} {req.url.path} not found"
        else:
            message = str(exc.detail)
        return JSONResponse(
            error_body(_HTTP_CODES.get(exc.status_code, "HTTP_ERROR"), message),
            status_code=exc.status_code,
            headers=getattr(exc, "headers", None),
        )

    app.add_middleware(
        PlatformMiddleware,
        service_name=name,
        metrics=metrics,
        chaos=chaos_state,
        routes=lambda: app.router.routes,
        rand=rand,
        sleep=sleep,
    )
    return app
