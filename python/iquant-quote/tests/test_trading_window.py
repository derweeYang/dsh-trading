"""trading_window_open：A 股窗口边界（工作日 9:15–15:05，周末恒关）。"""

from __future__ import annotations

from datetime import datetime

from dsh_iquant_quote.live import trading_window_open


def _at(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def test_weekday_inside_window_is_open():
    # 2026-09-10 是周四
    assert trading_window_open(_at("2026-09-10T09:15:00+08:00"))  # 集合竞价起
    assert trading_window_open(_at("2026-09-10T10:30:00+08:00"))
    assert trading_window_open(_at("2026-09-10T11:30:00+08:00"))  # 午间休市，保守放窗
    assert trading_window_open(_at("2026-09-10T13:00:00+08:00"))
    assert trading_window_open(_at("2026-09-10T15:05:00+08:00"))  # 收盘缓冲


def test_weekday_outside_window_is_closed():
    assert not trading_window_open(_at("2026-09-10T09:14:00+08:00"))
    assert not trading_window_open(_at("2026-09-10T15:06:00+08:00"))
    assert not trading_window_open(_at("2026-09-10T23:29:00+08:00"))


def test_weekend_is_closed():
    assert not trading_window_open(_at("2026-09-12T10:00:00+08:00"))  # 周六
    assert not trading_window_open(_at("2026-09-13T10:00:00+08:00"))  # 周日
