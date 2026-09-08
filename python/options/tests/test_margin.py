import pytest

from dsh_options import margin


def test_otm_is_max_with_zero_floor():
    assert margin.otm_call(3.4, 3.0) == pytest.approx(0.4)
    assert margin.otm_call(2.8, 3.0) == 0.0
    assert margin.otm_put(2.8, 3.0) == pytest.approx(0.2)
    assert margin.otm_put(3.4, 3.0) == 0.0


def test_atm_short_call_initial_uses_12pct_when_larger_than_7pct():
    # [0.15 + max(0.12*3 - 0, 0.07*3)] * 10000 = 5100
    assert margin.initial_short_call(
        prev_settle=0.15, spot_prev=3.0, strike=3.0, multiplier=10000, qty=1
    ) == pytest.approx(5100.0)


def test_otm_short_call_falls_to_7pct_floor():
    # OTM=0.4 → max(0.36-0.4, 0.21)=0.21 → (0.15+0.21)*10000 = 3600
    assert margin.initial_short_call(
        prev_settle=0.15, spot_prev=3.0, strike=3.4, multiplier=10000, qty=1
    ) == pytest.approx(3600.0)


def test_short_put_is_capped_at_strike_times_multiplier():
    # min(2.8 + max(0.12*2 - 0, 0.21), 3.0) * 10000 = 30000
    assert margin.initial_short_put(
        prev_settle=2.8, spot_prev=2.0, strike=3.0, multiplier=10000, qty=1
    ) == pytest.approx(30000.0)


def test_maintenance_matches_initial_when_prices_coincide():
    kwargs = dict(strike=3.0, multiplier=10000, qty=2)
    init = margin.initial_short_call(prev_settle=0.15, spot_prev=3.0, **kwargs)
    maint = margin.maintenance_short_call(settle=0.15, spot_close=3.0, **kwargs)
    assert maint == pytest.approx(init)


def test_cover_short_calls_splits_covered_and_uncovered():
    covered, uncovered = margin.cover_short_calls(
        long_shares=10000, short_call_qty=2, multiplier=10000
    )
    assert (covered, uncovered) == (1, 1)
    assert margin.cover_short_calls(long_shares=0, short_call_qty=1, multiplier=10000) == (0, 1)
