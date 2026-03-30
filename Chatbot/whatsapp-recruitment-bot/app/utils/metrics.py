"""Metrics utilities for latency and error-rate reporting."""

from __future__ import annotations

from typing import Iterable, List


def parse_duration_to_ms(value: str) -> float:
    """Parse duration strings like '0.123s', '250ms', '1.5m'."""
    text = (value or "").strip().lower()
    if not text:
        return 0.0
    if text.endswith("ms"):
        return float(text[:-2])
    if text.endswith("s"):
        return float(text[:-1]) * 1000.0
    if text.endswith("m"):
        return float(text[:-1]) * 60000.0
    return float(text)


def percentile(values: List[float], p: float) -> float:
    if not values:
        return 0.0
    sorted_vals = sorted(values)
    k = (len(sorted_vals) - 1) * p
    f = int(k)
    c = min(f + 1, len(sorted_vals) - 1)
    if f == c:
        return sorted_vals[f]
    return sorted_vals[f] + (k - f) * (sorted_vals[c] - sorted_vals[f])


def error_rate(status_codes: Iterable[int]) -> float:
    codes = list(status_codes)
    if not codes:
        return 0.0
    errors = sum(1 for c in codes if c >= 500)
    return (errors / len(codes)) * 100.0
