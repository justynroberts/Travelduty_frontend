"""Error types that map onto the contract's `{"error": {...}}` envelope."""

from __future__ import annotations

from typing import Any, Literal

UpstreamKind = Literal["http", "timeout", "network"]


def error_body(code: str, message: str, details: Any = None, **extra: Any) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message, **extra}
    if details is not None:
        err["details"] = details
    return {"error": err}


class AppError(Exception):
    """An error that maps directly onto an HTTP response."""

    def __init__(self, status_code: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


class UpstreamError(Exception):
    """A call to another service or external API failed."""

    def __init__(
        self,
        service: str,
        kind: UpstreamKind,
        message: str,
        status_code: int | None = None,
        body: Any = None,
    ) -> None:
        super().__init__(message)
        self.service = service
        self.kind = kind
        self.message = message
        self.status_code = status_code
        self.body = body

    @property
    def is_client_error(self) -> bool:
        return self.kind == "http" and self.status_code is not None and self.status_code < 500

    @property
    def upstream_code(self) -> str | None:
        if isinstance(self.body, dict):
            err = self.body.get("error")
            if isinstance(err, dict) and isinstance(err.get("code"), str):
                return err["code"]
        return None
