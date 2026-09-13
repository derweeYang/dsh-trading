"""LiveBackend 用 SHO/SZO 名单 + tick（盘后回落日 K）组 T 板，不再空抛 NO_DATA。"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone

import pytest

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.live import LiveBackend, seasonal_focus_months
from dsh_iquant_quote.service import QuoteService, _parse_atm_focus

_CST = timezone(timedelta(hours=8))
_LIVE_NOW = datetime(2026, 9, 8, 10, 0, tzinfo=_CST)
_CLOSED_NOW = datetime(2026, 9, 10, 23, 0, tzinfo=_CST)


class _FakeRequest:
    def __init__(self, callback, bars):
        self._callback = callback
        self._bars = bars
        self.closed = False

    def wait(self, timeout_ms=-1):
        if self._callback is not None:
            self._callback(0, 0, self._bars)
        return 0

    def close(self):
        self.closed = True


class _FakeQuoteClient:
    def __init__(self, names, ticks=None, bars_by_code=None):
        self.names = names
        self.ticks = ticks or {}
        self.bars_by_code = bars_by_code or {}
        self.subscribed = None
        self.unsubscribed = []
        self.history_calls = []

    def get_instrument_names(self, market):
        return [row for row in self.names if row["market"] == market]

    def subscribe_symbols(self, market, codes):
        self.subscribed = (market, list(codes))
        return 7

    def unsubscribe(self, sub_id):
        self.unsubscribed.append(sub_id)

    def drain(self, on_tick, max_count=64, timeout_ms=200):
        if self.subscribed is None:
            return 0
        market, _codes = self.subscribed
        emitted = 0
        for code, snap in self.ticks.items():
            on_tick(code, snap)
            emitted += 1
        return emitted

    def request_history(
        self,
        symbol,
        period,
        start_ms,
        end_ms,
        period_ms,
        kline_type,
        limit,
        callback=None,
    ):
        self.history_calls.append((symbol, period))
        bars = self.bars_by_code.get(period, [])
        return _FakeRequest(callback, bars)


def _backend(client, as_of=date(2026, 9, 8), now=None):
    backend = LiveBackend()
    backend._client = client
    backend._as_of = as_of
    # 默认钉在连续竞价，避免本机盘后跑单测时跳过 subscribe。
    backend._now = lambda: now or _LIVE_NOW
    return backend


def test_option_instruments_parses_names_into_long_codes():
    client = _FakeQuoteClient(
        [
            {"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"},
            {"market": "SHO", "code": "10011256", "name": "50ETF沽9月2650"},
            {"market": "SHO", "code": "10019999", "name": "300ETF购9月4000"},
        ]
    )
    rows = _backend(client).option_instruments("SHO", "510050")
    assert {row["code"] for row in rows} == {"510050C2609M02650", "510050P2609M02650"}
    assert rows[0]["shortCode"] == "10011255" or rows[1]["shortCode"] == "10011255"
    assert all(row["expiryMonth"] == "2609" for row in rows)
    assert all(row["multiplier"] == 10000 for row in rows)


def test_option_chain_uses_ticks_when_drain_has_prints():
    client = _FakeQuoteClient(
        [
            {"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"},
            {"market": "SHO", "code": "10011256", "name": "50ETF沽9月2650"},
        ],
        ticks={
            "10011255": {
                "last": 0.3658,
                "pre_close": 0.35,
                "volume": 1200,
                "timestamp_ms": 1_757_000_000_000,
                "ask": [0.366, 0.367, 0.0, 0.0, 0.0],
                "bid": [0.3648, 0.3646, 0.0, 0.0, 0.0],
            },
            "10011256": {
                "last": 0.012,
                "pre_close": 0.014,
                "volume": 800,
                "timestamp_ms": 1_757_000_000_000,
            },
        },
    )
    chain = _backend(client).option_chain("SHO", "510050", "2609")
    assert chain["expiryDate"] == "2026-09-23"
    assert chain["calls"][0]["code"] == "510050C2609M02650"
    assert chain["calls"][0]["last"] == pytest.approx(0.3658)
    assert chain["calls"][0]["preClose"] == pytest.approx(0.35)
    assert chain["calls"][0]["volume"] == 1200
    # 全推快照五档第一档 → 买一/卖一透传（套利扫描可执行边界）。
    assert chain["calls"][0]["ask"] == pytest.approx(0.366)
    assert chain["calls"][0]["bid"] == pytest.approx(0.3648)
    assert chain["puts"][0]["code"] == "510050P2609M02650"
    assert chain["puts"][0]["last"] == pytest.approx(0.012)
    # 无盘口字段的 tick（快照缺 ask/bid）不落键，不造 0 价。
    assert "bid" not in chain["puts"][0]
    assert "ask" not in chain["puts"][0]
    assert client.subscribed == ("SHO", ["10011255", "10011256"])
    assert client.unsubscribed == [7]


def test_option_chain_first_level_zero_omits_bid_ask():
    """五档第一档为 0（无盘/极端档）→ 不落 bid/ask 键，下游退回 last 近似。"""
    client = _FakeQuoteClient(
        [
            {"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"},
        ],
        ticks={
            "10011255": {
                "last": 0.3658,
                "pre_close": 0.35,
                "volume": 1200,
                "timestamp_ms": 1_757_000_000_000,
                "ask": [0.0, 0.0, 0.0, 0.0, 0.0],
                "bid": [0.0, 0.0, 0.0, 0.0, 0.0],
            },
        },
    )
    chain = _backend(client).option_chain("SHO", "510050", "2609")
    assert chain["calls"][0]["last"] == pytest.approx(0.3658)
    assert "bid" not in chain["calls"][0]
    assert "ask" not in chain["calls"][0]


def test_option_chain_falls_back_to_daily_when_drain_empty():
    client = _FakeQuoteClient(
        [
            {"market": "SZO", "code": "90007061", "name": "创业板ETF购9月3000"},
        ],
        ticks={},
        bars_by_code={
            "90007061": [
                {
                    "timestamp_ms": 1_756_800_000_000,
                    "open": 0.18,
                    "high": 0.19,
                    "low": 0.17,
                    "close": 0.185,
                    "volume": 100,
                },
                {
                    "timestamp_ms": 1_756_886_400_000,
                    "open": 0.185,
                    "high": 0.20,
                    "low": 0.18,
                    "close": 0.19,
                    "volume": 110,
                },
            ]
        },
    )
    chain = _backend(client).option_chain("SZO", "159915", "2609")
    assert chain["calls"][0]["code"] == "159915C2609M03000"
    assert chain["calls"][0]["last"] == pytest.approx(0.19)
    assert chain["calls"][0]["preClose"] == pytest.approx(0.185)
    assert chain["calls"][0]["volume"] == 110
    assert client.history_calls == [("SZO", "90007061")]


def test_option_chain_no_matching_names_is_no_data():
    client = _FakeQuoteClient(
        [{"market": "SHO", "code": "10019999", "name": "300ETF购9月4000"}]
    )
    with pytest.raises(QuoteGatewayError) as err:
        _backend(client).option_chain("SHO", "510050", "2609")
    assert err.value.code == "NO_DATA"


def test_option_chain_closed_window_skips_tick_subscription():
    client = _FakeQuoteClient(
        [{"market": "SHO", "code": "10011255", "name": "50ETF购9月2650"}],
        ticks={
            "10011255": {
                "last": 0.3658,
                "pre_close": 0.35,
                "volume": 1200,
                "timestamp_ms": 1,
            }
        },
        bars_by_code={
            "10011255": [
                {
                    "timestamp_ms": 1_756_886_400_000,
                    "open": 0.2,
                    "high": 0.21,
                    "low": 0.19,
                    "close": 0.205,
                    "volume": 50,
                }
            ]
        },
    )
    chain = _backend(client, now=_CLOSED_NOW).option_chain("SHO", "510050", "2609")
    assert client.subscribed is None  # 窗口外不订阅
    assert chain["calls"][0]["last"] == pytest.approx(0.205)  # 走日 K 回落


def _strike_grid_names(strikes: list[str]):
    """510050 九月链 C/P 双边名单（行权价 2600→'2.60' 拆两档小数）。"""
    names = []
    for index, raw in enumerate(strikes):
        names.append(
            {
                "market": "SHO",
                "code": f"10011{index * 2:02d}",
                "name": f"50ETF购9月{raw}",
            }
        )
        names.append(
            {
                "market": "SHO",
                "code": f"10011{index * 2 + 1:02d}",
                "name": f"50ETF沽9月{raw}",
            }
        )
    return names


def _bars(close: float):
    return [
        {
            "timestamp_ms": 1_756_800_000_000,
            "open": close,
            "high": close,
            "low": close,
            "close": close,
            "volume": 10,
        },
        {
            "timestamp_ms": 1_756_886_400_000,
            "open": close,
            "high": close,
            "low": close,
            "close": close,
            "volume": 20,
        },
    ]


def test_option_chain_atm_focus_trims_strikes_and_daily_fallback():
    """atm_focus 只回落 ATM±N 档：5 档链 spot=2.68 → 2.65/2.70/2.75，日 K 只打 6 合约。"""
    strikes = ["2600", "2650", "2700", "2750", "2800"]
    bars_by_code = {
        f"10011{i:02d}": _bars(0.1 + i * 0.01) for i in range(len(strikes) * 2)
    }
    client = _FakeQuoteClient(
        _strike_grid_names(strikes), ticks={}, bars_by_code=bars_by_code
    )
    chain = _backend(client, now=_CLOSED_NOW).option_chain(
        "SHO", "510050", "2609", atm_focus={"spot": 2.68, "strikes": 3}
    )
    assert [c["strike"] for c in chain["calls"]] == pytest.approx([2.65, 2.70, 2.75])
    assert [p["strike"] for p in chain["puts"]] == pytest.approx([2.65, 2.70, 2.75])
    # 日 K 回落只发生在保留的 6 个合约上；2.60/2.80 档不打 SDK。
    assert sorted(code for _m, code in client.history_calls) == [
        f"10011{i:02d}" for i in (2, 3, 4, 5, 6, 7)
    ]


def test_option_chain_atm_focus_tie_prefers_lower_strike():
    """spot 落在两档正中时取低档（稳定序，不抖动）。"""
    client = _FakeQuoteClient(
        _strike_grid_names(["2600", "2650", "2700"]),
        ticks={},
        bars_by_code={f"10011{i:02d}": _bars(0.1) for i in range(6)},
    )
    chain = _backend(client, now=_CLOSED_NOW).option_chain(
        "SHO", "510050", "2609", atm_focus={"spot": 2.675, "strikes": 1}
    )
    assert [c["strike"] for c in chain["calls"]] == pytest.approx([2.65])


def test_seasonal_focus_months_covers_current_and_next():
    assert seasonal_focus_months(datetime(2026, 9, 11, 12, 0, tzinfo=_CST)) == [
        "2609",
        "2610",
    ]


def test_seasonal_focus_months_skips_expired_current_month():
    # 2026-09 的第四个周三是 09-23；24 日起当月链已摘牌。
    assert seasonal_focus_months(datetime(2026, 9, 24, 9, 30, tzinfo=_CST)) == ["2610"]


def test_seasonal_focus_months_keeps_expiry_day_and_wraps_year():
    assert seasonal_focus_months(datetime(2026, 9, 23, 15, 0, tzinfo=_CST)) == [
        "2609",
        "2610",
    ]
    assert seasonal_focus_months(datetime(2026, 12, 5, 10, 0, tzinfo=_CST)) == [
        "2612",
        "2701",
    ]


def test_parse_atm_focus_valid_and_default():
    assert _parse_atm_focus(None) is None
    assert _parse_atm_focus({"spot": 3.1, "strikes": 3}) == {
        "spot": 3.1,
        "strikes": 3,
    }


@pytest.mark.parametrize(
    "raw",
    [
        "full",
        {"spot": 0, "strikes": 3},
        {"spot": -2.5, "strikes": 3},
        {"spot": 3.1},
        {"spot": 3.1, "strikes": 0},
        {"spot": 3.1, "strikes": 11},
        {"spot": 3.1, "strikes": True},
    ],
)
def test_parse_atm_focus_rejects_invalid(raw):
    with pytest.raises(QuoteGatewayError) as err:
        _parse_atm_focus(raw)
    assert err.value.code == "BAD_REQUEST"


def test_service_option_chain_routes_focus_and_full_chain():
    """handle_command 带 atmFocus → 收窄透传到 backend；缺省 → 不带关键字（全链）。"""
    calls = []

    class _RecordingBackend:
        def option_instruments(self, market, underlying):
            return [
                {
                    "code": "510050C2609M02600",
                    "shortCode": "1001",
                    "optionType": "C",
                    "strike": 2.6,
                    "expiryMonth": "2609",
                    "expiryDate": "2026-09-23",
                },
                {
                    "code": "510050C2609M02650",
                    "shortCode": "1002",
                    "optionType": "C",
                    "strike": 2.65,
                    "expiryMonth": "2609",
                    "expiryDate": "2026-09-23",
                },
                {
                    "code": "510050C2609M02700",
                    "shortCode": "1003",
                    "optionType": "C",
                    "strike": 2.7,
                    "expiryMonth": "2609",
                    "expiryDate": "2026-09-23",
                },
            ]

        def option_chain(self, market, underlying, expiry_month, atm_focus=None):
            calls.append(atm_focus)
            return {"calls": [], "puts": []}

    service = QuoteService(_RecordingBackend())
    service.handle_command(
        "option_chain",
        {
            "market": "SH",
            "underlying": "510050",
            "expiryMonth": "2609",
            "atmFocus": {"spot": 2.68, "strikes": 2},
        },
    )
    service.handle_command(
        "option_chain", {"market": "SH", "underlying": "510050", "expiryMonth": "2609"}
    )
    assert calls == [{"spot": 2.68, "strikes": 2}, None]
