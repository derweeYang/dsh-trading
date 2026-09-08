# 单合约日线:synth 取数、缓存幂等、区间过滤;akshare 短码映射与新浪日线(mock 网络)。

from pathlib import Path

import pandas as pd
import pytest

from dsh_options import daily
from dsh_options.protocol import OptionsError

SYNTH_CONTRACT = "910050C2609M02850"


def test_fetch_daily_synth_and_cache(tmp_path):
    request = {"contract": SYNTH_CONTRACT, "source": "synth", "cacheDir": str(tmp_path)}
    result = daily.handle_fetch_daily(request, tmp_path)
    assert result["cached"] is False
    assert result["rows"] > 0
    assert result["firstDate"] <= result["lastDate"]
    assert 1 <= len(result["preview"]) <= daily.PREVIEW_ROWS
    assert Path(result["cachePath"]).exists()
    # 二次调用命中缓存:cached=True 且不再重算(行数/边界不变)
    again = daily.handle_fetch_daily(request, tmp_path)
    assert again["cached"] is True
    assert again["rows"] == result["rows"]
    assert again["firstDate"] == result["firstDate"]
    assert again["lastDate"] == result["lastDate"]
    # forceRefresh 强制重拉
    forced = daily.handle_fetch_daily({**request, "forceRefresh": True}, tmp_path)
    assert forced["cached"] is False and forced["rows"] == result["rows"]


def test_fetch_daily_range_filter(tmp_path):
    request = {"contract": SYNTH_CONTRACT, "source": "synth", "cacheDir": str(tmp_path)}
    windowed = daily.handle_fetch_daily(
        {**request, "start": "2026-06-01", "end": "2026-06-30"}, tmp_path
    )
    assert windowed["firstDate"] >= "2026-06-01" and windowed["lastDate"] <= "2026-06-30"
    with pytest.raises(OptionsError) as err:
        daily.handle_fetch_daily({**request, "start": "2030-01-01"}, tmp_path)
    assert err.value.code == "NO_DATA"


def test_fetch_daily_synth_rejects_bad_codes(tmp_path):
    for bad, code in (
        ("garbage", "BAD_REQUEST"),  # 非长码格式
        ("910050C2613M02850", "NO_DATA"),  # 合成链没有的月份
        ("910050C2609M09999", "NO_DATA"),  # 不在行权价网格
        ("510050C2609M02850", "BAD_REQUEST"),  # synth 只服务 910050
    ):
        with pytest.raises(OptionsError) as err:
            daily.handle_fetch_daily(
                {"contract": bad, "source": "synth", "cacheDir": str(tmp_path)}, tmp_path
            )
        assert err.value.code == code


def _sina_daily_fixture() -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": pd.to_datetime(["2026-09-02", "2026-09-03", "2026-09-04"]),
            "open": [0.181, 0.183, 0.182],
            "high": [0.185, 0.186, 0.187],
            "low": [0.179, 0.180, 0.181],
            "close": [0.182, 0.181, 0.1861],
            "volume": [12000, 9800, 15400],
        }
    )


def test_fetch_daily_akshare_via_sina_mock(tmp_path, monkeypatch):
    fetch_calls: list[str] = []

    def fake_fetch(sina_code: str) -> pd.DataFrame:
        fetch_calls.append(sina_code)
        return _sina_daily_fixture()

    monkeypatch.setattr(daily, "_fetch_sina_daily", fake_fetch)
    monkeypatch.setattr(daily, "_resolve_sina_code", lambda *a: "10011255")
    request = {"contract": "510050C2609M02850", "source": "akshare", "cacheDir": str(tmp_path)}
    result = daily.handle_fetch_daily(request, tmp_path)
    assert result["cached"] is False and result["rows"] == 3
    assert result["firstDate"] == "2026-09-02" and result["lastDate"] == "2026-09-04"
    assert fetch_calls == ["10011255"]
    # 二次命中本地 parquet,不再触网
    again = daily.handle_fetch_daily(request, tmp_path)
    assert again["cached"] is True
    assert fetch_calls == ["10011255"]


def test_ensure_mapping_builds_and_caches(tmp_path, monkeypatch):
    import akshare as ak

    greeks_calls: list[str] = []

    def fake_codes(symbol: str, trade_date: str, underlying: str) -> pd.DataFrame:
        return pd.DataFrame({"期权代码": ["10011255", "10011256"]})

    def fake_greeks(symbol: str) -> pd.DataFrame:
        greeks_calls.append(symbol)
        return pd.DataFrame(
            {
                "字段": ["期权代码", "交易代码", "行权价"],
                "值": [symbol, f"510050C2609M0{greeks_calls.index(symbol) + 285}0", "2.85"],
            }
        )

    sleeps: list[float] = []
    monkeypatch.setattr(ak, "option_sse_codes_sina", fake_codes)
    monkeypatch.setattr(ak, "option_sse_greeks_sina", fake_greeks)
    monkeypatch.setattr(daily.time, "sleep", lambda s: sleeps.append(s))
    # codes 返回 2 个 → greeks 2 次、节流 1 次(首个请求前不睡)
    mapping = daily._ensure_mapping("510050", "2609", "C", tmp_path)
    assert mapping == {"510050C2609M02850": "10011255", "510050C2609M02860": "10011256"}
    assert len(greeks_calls) == 2 and sleeps == [daily.REQUEST_PAUSE_SECONDS]
    assert daily._mapping_path(tmp_path, "510050", "2609").exists()
    # 二次调用读映射缓存,不再触网
    greeks_calls.clear()
    again = daily._ensure_mapping("510050", "2609", "C", tmp_path)
    assert again == mapping and greeks_calls == []


def test_resolve_sina_code_missing_strike_is_no_data(tmp_path, monkeypatch):
    import akshare as ak

    monkeypatch.setattr(
        ak,
        "option_sse_codes_sina",
        lambda symbol, trade_date, underlying: pd.DataFrame({"期权代码": ["10011255"]}),
    )
    monkeypatch.setattr(
        ak,
        "option_sse_greeks_sina",
        lambda symbol: pd.DataFrame(
            {"字段": ["期权代码", "交易代码"], "值": [symbol, "510050C2609M02850"]}
        ),
    )
    monkeypatch.setattr(daily.time, "sleep", lambda s: None)
    # 网格中存在的是 02850;请求 02999 → 映射里没有,显式 NO_DATA
    with pytest.raises(OptionsError) as err:
        daily.handle_fetch_daily(
            {"contract": "510050C2609M02999", "source": "akshare", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "NO_DATA"


def test_fetch_daily_akshare_gaps_and_rejects(tmp_path):
    with pytest.raises(OptionsError) as err:
        daily.handle_fetch_daily(
            {"contract": "159915C2609M00300", "source": "akshare", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "NO_DATA"
    assert "szse_static_only" in err.value.message
    with pytest.raises(OptionsError) as err:
        daily.handle_fetch_daily(
            {"contract": "000000C2609M02850", "source": "akshare", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"
