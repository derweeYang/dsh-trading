"""停更与串位防护（2026-09-11 事故回归）：

- 厂商 1m 历史库盘中停更（510050 钉在 10:30）→ klines 必须报 STALE_DATA 且不回写缓存；
- snapshot 只认本 code 的 tick，drain 队列串进来的 foreign tick 不得跨标的回退（4.575 串位）；
- ticker 日 K 回落缓存盘中 60s 过期（last=3.017 钉死全天），窗口外当日复用。
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta, timezone

import pytest

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.live import expected_latest_open_ms

from test_option_chain import _FakeQuoteClient, _backend

_CST = timezone(timedelta(hours=8))
_TRADING_FRIDAY = date(2026, 9, 11)


def _ms(moment: datetime) -> int:
    return int(moment.timestamp() * 1000)


def _bar(open_ms: int, close: float = 3.0) -> dict:
    return {
        "timestamp_ms": open_ms,
        "open": close,
        "high": close,
        "low": close,
        "close": close,
        "volume": 1,
    }


def _at(hour: int, minute: int, day: int = 11) -> datetime:
    return datetime(2026, 9, day, hour, minute, tzinfo=_CST)


# --- expected_latest_open_ms：交易时段内应有最新 1m bar 的位置 ---


def test_expected_latest_open_ms_boundaries():
    assert expected_latest_open_ms(_at(9, 20)) is None  # 09:31 前无法预期
    assert expected_latest_open_ms(_at(10, 30)) == _ms(_at(10, 30))
    assert expected_latest_open_ms(_at(11, 45)) == _ms(_at(11, 30))  # 午休回指
    assert expected_latest_open_ms(_at(13, 5)) == _ms(_at(13, 5))
    assert expected_latest_open_ms(_at(15, 30)) == _ms(_at(15, 0))  # 收盘后回指
    assert expected_latest_open_ms(_at(10, 0, day=12)) is None  # 周六


# --- klines 停更闸门 ---


def test_klines_1m_stalled_raises_and_skips_cache():
    # 13:35 回源，厂商库停在 10:30（当日事故现场）
    client = _FakeQuoteClient([], bars_by_code={"510050": [_bar(_ms(_at(10, 30)))]})
    backend = _backend(client, now=_at(13, 35))
    with pytest.raises(QuoteGatewayError) as err:
        backend.klines("SH", "510050", "1m", 60)
    assert err.value.code == "STALE_DATA"
    assert "510050" in err.value.message
    assert backend._klines_cache == {}  # 陈旧数组不得回写缓存


def test_klines_1m_fresh_within_tolerance_passes():
    # 最新 bar 是当前分钟（expected 与 latest 同分钟），正常放行并缓存
    client = _FakeQuoteClient([], bars_by_code={"510050": [_bar(_ms(_at(10, 30)))]})
    backend = _backend(
        client,
        now=_at(
            10,
            30,
        ),
    )
    bars = backend.klines("SH", "510050", "1m", 60)
    assert bars[0]["close"] == pytest.approx(3.0)
    assert ("SH", "510050", "1m", 60) in backend._klines_cache


def test_klines_1m_lunch_break_latest_morning_bar_is_fresh():
    # 午休 11:45 回源，最新 bar 停在 11:30 属正常，不得误报停更
    client = _FakeQuoteClient([], bars_by_code={"510050": [_bar(_ms(_at(11, 30)))]})
    backend = _backend(client, now=_at(11, 45))
    bars = backend.klines("SH", "510050", "1m", 60)
    assert bars[0]["close"] == pytest.approx(3.0)


def test_klines_daily_interval_skips_staleness_check():
    # 日 K 的最新一根本来就是上一交易日，不做分钟级新鲜度校验
    client = _FakeQuoteClient(
        [], bars_by_code={"510050": [_bar(_ms(_at(10, 30, day=10)))]}
    )
    backend = _backend(client, now=_at(13, 35))
    bars = backend.klines("SH", "510050", "1d", 8)
    assert bars[0]["close"] == pytest.approx(3.0)


def test_klines_before_open_skips_staleness_check():
    # 盘前回源（昨天数据），expected 为 None 跳过校验（preheat 场景）
    client = _FakeQuoteClient(
        [], bars_by_code={"510050": [_bar(_ms(_at(15, 0, day=10)))]}
    )
    backend = _backend(client, now=_at(9, 20))
    bars = backend.klines("SH", "510050", "1m", 60)
    assert bars[0]["close"] == pytest.approx(3.0)


# --- snapshot 串位 ---


def test_snapshot_never_returns_foreign_symbol_tick():
    # drain 队列是 SDK 进程级共享：只灌进来 510300 的 tick 时，
    # 请求 510050 不得拿别人的价凑数（事故里 4.575 被塞给 510050）
    client = _FakeQuoteClient(
        [],
        ticks={
            "510300": {
                "last": 4.575,
                "pre_close": 4.5,
                "volume": 1,
                "timestamp_ms": 1,
            }
        },
    )
    backend = _backend(client, now=_at(10, 30))
    with pytest.raises(QuoteGatewayError) as err:
        backend.snapshot("SH", ["510050"])
    assert err.value.code == "NO_DATA"


def test_ticker_falls_back_to_daily_when_foreign_tick_only():
    # snapshot 拒了串位 tick 后，ticker 的日 K 回落仍然可用
    client = _FakeQuoteClient(
        [],
        ticks={
            "510300": {
                "last": 4.575,
                "pre_close": 4.5,
                "volume": 1,
                "timestamp_ms": 1,
            }
        },
        bars_by_code={"510050": [_bar(1, close=2.96)]},
    )
    backend = _backend(client, now=_at(10, 30))
    row = backend.ticker("SH", "510050")
    assert row["last"] == pytest.approx(2.96)


# --- ticker 日 K 回落缓存 TTL ---


def test_daily_cache_expires_inside_trading_window():
    client = _FakeQuoteClient([], bars_by_code={"510050": [_bar(1, close=3.017)]})
    backend = _backend(client, now=_at(10, 30))
    # 2 分钟前缓存的旧价，盘中必须过期重拉
    backend._daily_cache[("SH", "510050")] = (
        time.time() - 120,
        {"last": 9.99, "preClose": 9.0, "volume": 1, "timestamp": 1},
    )
    quote = backend._last_daily_quote("SH", "510050")
    assert quote is not None and quote["last"] == pytest.approx(3.017)
    assert client.history_calls == [("SH", "510050")]


def test_daily_cache_reused_outside_trading_window():
    client = _FakeQuoteClient([], bars_by_code={"510050": [_bar(1, close=3.017)]})
    backend = _backend(client, now=_at(23, 0))
    # 窗口外当日日 K 不变，1 小时前的缓存直接复用，不打 SDK
    backend._daily_cache[("SH", "510050")] = (
        time.time() - 3600,
        {"last": 3.0, "preClose": 2.9, "volume": 1, "timestamp": 1},
    )
    quote = backend._last_daily_quote("SH", "510050")
    assert quote is not None and quote["last"] == pytest.approx(3.0)
    assert client.history_calls == []


def test_daily_cache_fresh_inside_ttl_reused():
    client = _FakeQuoteClient([], bars_by_code={"510050": [_bar(1, close=3.017)]})
    backend = _backend(client, now=_at(10, 30))
    backend._daily_cache[("SH", "510050")] = (
        time.time() - 10,
        {"last": 3.0, "preClose": 2.9, "volume": 1, "timestamp": 1},
    )
    quote = backend._last_daily_quote("SH", "510050")
    assert quote is not None and quote["last"] == pytest.approx(3.0)
    assert client.history_calls == []
