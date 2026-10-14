"""Prometheus metrics required by the contract, on a per-app registry."""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, GCCollector, Histogram, PlatformCollector, ProcessCollector


class ServiceMetrics:
    def __init__(self) -> None:
        self.registry = CollectorRegistry()
        ProcessCollector(registry=self.registry)
        PlatformCollector(registry=self.registry)
        GCCollector(registry=self.registry)
        self.http_requests = Counter(
            "http_requests", "HTTP requests handled", ["method", "route", "status"], registry=self.registry
        )
        self.http_duration = Histogram(
            "http_request_duration_seconds",
            "HTTP request latency",
            ["method", "route"],
            buckets=(0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
            registry=self.registry,
        )
        self.upstream_calls = Counter(
            "upstream_calls",
            "Outbound calls to other services and external APIs",
            ["target", "outcome"],
            registry=self.registry,
        )
        self.upstream_duration = Histogram(
            "upstream_call_duration_seconds",
            "Outbound call latency",
            ["target"],
            buckets=(0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10),
            registry=self.registry,
        )

    def observe_http(self, method: str, route: str, status: int, seconds: float) -> None:
        self.http_requests.labels(method, route, str(status)).inc()
        self.http_duration.labels(method, route).observe(seconds)

    def record_call(self, target: str, outcome: str, seconds: float) -> None:
        self.upstream_calls.labels(target, outcome).inc()
        self.upstream_duration.labels(target).observe(seconds)
