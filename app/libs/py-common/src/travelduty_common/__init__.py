"""Shared platform conventions for TravelDuty Python services. See docs/contract.md."""

from .cache import CacheResult, TtlCache
from .chaos import ChaosState
from .client import USER_AGENT, ServiceClient
from .errors import AppError, UpstreamError, error_body
from .logs import request_id_var
from .metrics import ServiceMetrics
from .reference import find_airport, load_airports, reference_dir
from .service import create_service

__all__ = [
    "USER_AGENT",
    "AppError",
    "CacheResult",
    "ChaosState",
    "ServiceClient",
    "ServiceMetrics",
    "TtlCache",
    "UpstreamError",
    "create_service",
    "error_body",
    "find_airport",
    "load_airports",
    "reference_dir",
    "request_id_var",
]
