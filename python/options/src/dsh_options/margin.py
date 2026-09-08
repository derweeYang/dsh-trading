"""沪深 ETF 期权标准义务仓保证金(12%/7%)。无 IO、无组合净额。"""

from __future__ import annotations


def otm_call(strike: float, spot: float) -> float:
    return max(strike - spot, 0.0)


def otm_put(strike: float, spot: float) -> float:
    return max(spot - strike, 0.0)


def initial_short_call(
    *, prev_settle: float, spot_prev: float, strike: float, multiplier: int, qty: int
) -> float:
    add = max(0.12 * spot_prev - otm_call(strike, spot_prev), 0.07 * spot_prev)
    return (prev_settle + add) * multiplier * qty


def initial_short_put(
    *, prev_settle: float, spot_prev: float, strike: float, multiplier: int, qty: int
) -> float:
    add = max(0.12 * spot_prev - otm_put(strike, spot_prev), 0.07 * strike)
    return min(prev_settle + add, strike) * multiplier * qty


def maintenance_short_call(
    *, settle: float, spot_close: float, strike: float, multiplier: int, qty: int
) -> float:
    return initial_short_call(
        prev_settle=settle, spot_prev=spot_close, strike=strike, multiplier=multiplier, qty=qty
    )


def maintenance_short_put(
    *, settle: float, spot_close: float, strike: float, multiplier: int, qty: int
) -> float:
    return initial_short_put(
        prev_settle=settle, spot_prev=spot_close, strike=strike, multiplier=multiplier, qty=qty
    )


def cover_short_calls(*, long_shares: int, short_call_qty: int, multiplier: int) -> tuple[int, int]:
    if multiplier <= 0 or short_call_qty < 0 or long_shares < 0:
        raise ValueError("cover inputs must be non-negative; multiplier must be positive")
    covered = min(short_call_qty, long_shares // multiplier)
    return covered, short_call_qty - covered
