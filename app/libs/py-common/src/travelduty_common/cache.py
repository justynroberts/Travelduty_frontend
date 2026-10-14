"""In-memory TTL cache with stale-if-error and single-flight loading.

Placed in front of external APIs so a brief third-party outage degrades freshness, not availability.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class CacheResult[V]:
    value: V
    stale: bool  # True when the refresh failed and an expired value was served


class TtlCache[V]:
    def __init__(self, max_entries: int = 1000, now: Callable[[], float] = time.monotonic) -> None:
        self._entries: OrderedDict[str, tuple[V, float]] = OrderedDict()
        self._inflight: dict[str, asyncio.Future[V]] = {}
        self._max = max_entries
        self._now = now

    async def get_or_load(
        self, key: str, loader: Callable[[], Awaitable[V]], *, ttl: float, stale_if_error: float = 0.0
    ) -> CacheResult[V]:
        entry = self._entries.get(key)
        age = self._now() - entry[1] if entry else float("inf")
        if entry and age < ttl:
            return CacheResult(entry[0], False)
        try:
            return CacheResult(await self._load(key, loader), False)
        except Exception:
            if entry and age < ttl + stale_if_error:
                return CacheResult(entry[0], True)
            raise

    def set(self, key: str, value: V) -> None:
        self._entries.pop(key, None)
        if len(self._entries) >= self._max:
            self._entries.popitem(last=False)
        self._entries[key] = (value, self._now())

    def clear(self) -> None:
        self._entries.clear()

    async def _load(self, key: str, loader: Callable[[], Awaitable[V]]) -> V:
        # Concurrent misses for the same key share one upstream call.
        fut = self._inflight.get(key)
        if fut is None:
            fut = asyncio.ensure_future(loader())
            self._inflight[key] = fut
            fut.add_done_callback(lambda f, k=key: self._inflight.pop(k, None) if self._inflight.get(k) is f else None)
        value = await fut
        self.set(key, value)
        return value
