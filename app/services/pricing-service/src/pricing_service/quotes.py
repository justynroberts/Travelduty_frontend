"""Quote arithmetic. All money math is done in Decimal and rounded half-up to 2 places."""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal
from typing import Any

TAX_RULES: tuple[tuple[str, Decimal, str], ...] = (
    ("flight", Decimal("0.09"), "Air passenger duty & airport charges"),
    ("hotel", Decimal("0.06"), "City & tourist tax"),
)
SERVICE_FEE_EUR = Decimal("4.99")
SERVICE_FEE_DESCRIPTION = "TravelDuty service fee"

_CENT = Decimal("0.01")


def dec(value: float | int | str | Decimal) -> Decimal:
    return value if isinstance(value, Decimal) else Decimal(str(value))


def money(value: Decimal) -> float:
    return float(value.quantize(_CENT, rounding=ROUND_HALF_UP))


def price_quote(items: list[dict[str, Any]], rate: Decimal) -> dict[str, Any]:
    """Prices EUR line items into the target currency at `rate`.

    Taxes are a percentage of each kind's EUR subtotal; one service fee applies per quote.
    Converted amounts are computed from unrounded EUR values, then rounded once.
    """
    lines = [
        {
            "kind": i["kind"],
            "description": i["description"],
            "amountEur": money(dec(i["amountEur"])),
            "amount": money(dec(i["amountEur"]) * rate),
        }
        for i in items
    ]
    subtotal_eur = sum((dec(i["amountEur"]) for i in items), Decimal(0))

    taxes = []
    tax_eur_total = Decimal(0)
    for kind, pct, description in TAX_RULES:
        base = sum((dec(i["amountEur"]) for i in items if i["kind"] == kind), Decimal(0))
        tax = base * pct
        if money(tax) > 0:
            taxes.append({"description": description, "amountEur": money(tax), "amount": money(tax * rate)})
            tax_eur_total += dec(money(tax))

    fees = [
        {
            "description": SERVICE_FEE_DESCRIPTION,
            "amountEur": money(SERVICE_FEE_EUR),
            "amount": money(SERVICE_FEE_EUR * rate),
        }
    ]

    subtotal = money(subtotal_eur * rate)
    tax_total = money(sum((dec(t["amount"]) for t in taxes), Decimal(0)))
    fee_total = money(sum((dec(f["amount"]) for f in fees), Decimal(0)))
    return {
        "lines": lines,
        "taxes": taxes,
        "fees": fees,
        "subtotal": subtotal,
        "taxTotal": tax_total,
        "feeTotal": fee_total,
        "total": money(dec(subtotal) + dec(tax_total) + dec(fee_total)),
        "totalEur": money(subtotal_eur + tax_eur_total + SERVICE_FEE_EUR),
    }
