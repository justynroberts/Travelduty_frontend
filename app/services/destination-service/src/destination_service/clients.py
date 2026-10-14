"""Clients for the real external APIs: Open-Meteo (forecast + geocoding) and Nager.Date (public holidays)."""

from __future__ import annotations

from typing import Any

from travelduty_common import ServiceClient, UpstreamError

DAILY_FIELDS = ",".join(
    (
        "weather_code",
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "precipitation_probability_max",
    )
)


def describe_weather(code: int) -> str:
    """WMO weather interpretation codes, as used by Open-Meteo."""
    if code == 0:
        return "Clear sky"
    if code == 1:
        return "Mainly clear"
    if code == 2:
        return "Partly cloudy"
    if code == 3:
        return "Overcast"
    if code in (45, 48):
        return "Fog"
    if 51 <= code <= 57:
        return "Drizzle"
    if 61 <= code <= 67:
        return "Rain"
    if 71 <= code <= 77:
        return "Snow"
    if 80 <= code <= 82:
        return "Rain showers"
    if code in (85, 86):
        return "Snow showers"
    if code >= 95:
        return "Thunderstorm"
    return "Unknown"


def _at(values: list[Any] | None, i: int) -> Any:
    return values[i] if values is not None and i < len(values) else None


class OpenMeteoClient:
    """https://open-meteo.com — free forecast and geocoding APIs, no key required."""

    def __init__(self, forecast_api: ServiceClient, geocoding_api: ServiceClient) -> None:
        self.forecast_api = forecast_api
        self.geocoding_api = geocoding_api

    async def forecast(self, lat: float, lon: float, days: int = 7) -> list[dict[str, Any]]:
        res = await self.forecast_api.get(
            "/v1/forecast",
            query={
                "latitude": lat,
                "longitude": lon,
                "daily": DAILY_FIELDS,
                "timezone": "auto",
                "forecast_days": days,
            },
        )
        daily = (res or {}).get("daily") or {}
        out = []
        for i, date in enumerate(daily.get("time") or []):
            code = _at(daily.get("weather_code"), i)
            code = -1 if code is None else int(code)
            out.append(
                {
                    "date": date,
                    "summary": describe_weather(code),
                    "weatherCode": code,
                    "tempMaxC": _at(daily.get("temperature_2m_max"), i),
                    "tempMinC": _at(daily.get("temperature_2m_min"), i),
                    "precipitationMm": _at(daily.get("precipitation_sum"), i) or 0,
                    "precipitationChance": _at(daily.get("precipitation_probability_max"), i),
                }
            )
        return out

    async def geocode(self, query: str, count: int = 5) -> list[dict[str, Any]]:
        res = await self.geocoding_api.get(
            "/v1/search", query={"name": query, "count": count, "language": "en", "format": "json"}
        )
        return [
            {
                "name": r.get("name"),
                "country": r.get("country", ""),
                "countryCode": r.get("country_code", ""),
                "region": r.get("admin1"),
                "lat": r.get("latitude"),
                "lon": r.get("longitude"),
                "timezone": r.get("timezone", "UTC"),
                "population": r.get("population"),
            }
            for r in (res or {}).get("results") or []
        ]


class NagerDateClient:
    """https://date.nager.at — worldwide public holidays, no key required."""

    def __init__(self, api: ServiceClient) -> None:
        self.api = api

    async def public_holidays(self, year: int, country_code: str) -> list[dict[str, Any]]:
        try:
            # Unsupported countries answer 204 (empty body) or 404.
            res = await self.api.get(f"/api/v3/PublicHolidays/{year}/{country_code}")
        except UpstreamError as exc:
            if exc.status_code == 404:
                return []
            raise
        return [
            {"date": h["date"], "name": h["name"], "localName": h["localName"], "nationwide": bool(h.get("global"))}
            for h in res or []
        ]
