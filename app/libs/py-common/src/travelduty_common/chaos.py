"""Fault injection state for incident-response demos (see docs/contract.md, "Chaos injection")."""

from __future__ import annotations

import os
from dataclasses import asdict, dataclass

from pydantic import BaseModel, ConfigDict, Field


@dataclass
class ChaosState:
    latencyMs: int = 0  # noqa: N815 - wire format is camelCase
    jitterMs: int = 0  # noqa: N815
    errorRate: float = 0.0  # noqa: N815
    errorStatus: int = 503  # noqa: N815

    def to_dict(self) -> dict[str, float | int]:
        return asdict(self)

    def reset(self) -> None:
        self.latencyMs, self.jitterMs, self.errorRate, self.errorStatus = 0, 0, 0.0, 503


class ChaosUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    latencyMs: int | None = Field(default=None, ge=0, le=60_000)  # noqa: N815
    jitterMs: int | None = Field(default=None, ge=0, le=60_000)  # noqa: N815
    errorRate: float | None = Field(default=None, ge=0, le=1)  # noqa: N815
    errorStatus: int | None = Field(default=None, ge=400, le=599)  # noqa: N815


def chaos_from_env() -> ChaosState:
    def num(name: str, default: float) -> float:
        raw = os.environ.get(name)
        return float(raw) if raw not in (None, "") else default

    return ChaosState(
        latencyMs=int(num("CHAOS_LATENCY_MS", 0)),
        jitterMs=int(num("CHAOS_JITTER_MS", 0)),
        errorRate=num("CHAOS_ERROR_RATE", 0.0),
        errorStatus=int(num("CHAOS_ERROR_STATUS", 503)),
    )
