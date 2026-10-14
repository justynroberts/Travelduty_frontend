"""Loads shared reference data (data/airports.json)."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any


def reference_dir() -> Path:
    configured = os.environ.get("REFERENCE_DATA_DIR")
    if configured:
        return Path(configured)
    for base in (Path.cwd(), Path(__file__).resolve().parent):
        for candidate in (base, *base.parents):
            if (candidate / "data" / "airports.json").is_file():
                return candidate / "data"
    raise FileNotFoundError("data/airports.json not found; set REFERENCE_DATA_DIR")


@lru_cache(maxsize=1)
def load_airports() -> tuple[dict[str, Any], ...]:
    with open(reference_dir() / "airports.json", encoding="utf-8") as f:
        return tuple(json.load(f))


def find_airport(code: str) -> dict[str, Any] | None:
    code = code.upper()
    return next((a for a in load_airports() if a["code"] == code), None)
