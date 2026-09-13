# 标的 ETF 现货日线:akshare 东财 hist,沪深通用;无 synth;单标的抛原错误码。

from pathlib import Path

import pandas as pd
import pytest

from dsh_options import underlying_daily
from dsh_options.protocol import OptionsError


def _hist_frame(
    dates: list[str] | None = None,
    closes: list[float] | None = None,
    volumes: list[int] | None = None,
) -> pd.DataFrame:
    dates = dates or ["2026-08-03", "2026-08-04", "2026-08-05"]
    closes = closes or [3.10, 3.12, 3.15]
    volumes = volumes or [1000, 1100, 1200]
    n = len(dates)
    return pd.DataFrame(
        {
            "date": dates,
            "open": [3.09] * n,
            "high": [3.16] * n,
            "low": [3.08] * n,
            "close": closes,
            "volume": volumes,
        }
    )


def _cache_name(path: str, name: str) -> None:
    assert Path(path).name == name
    assert Path(path).parent.name == "underlyings"


def _patch_fetch(monkeypatch, frames: dict[str, pd.DataFrame] | pd.DataFrame):
    """按标的返回预置帧;传入单帧时所有标的共用。"""

    def fake_fetch(underlying: str, adjust: str) -> pd.DataFrame:
        if isinstance(frames, pd.DataFrame):
            return frames.copy()
        if underlying not in frames:
            raise OptionsError("NO_DATA", f"no fixture for {underlying}")
        return frames[underlying].copy()

    monkeypatch.setattr(underlying_daily, "_fetch_em_daily", fake_fetch)


def test_single_fetch_cache_and_force(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, _hist_frame())
    request = {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)}
    result = underlying_daily.handle_fetch_underlying_daily(request, tmp_path)
    assert result["source"] == "akshare"
    assert result["adjust"] == "none"
    assert result["rows"] == 1
    assert result["failures"] == []
    item = result["underlyings"][0]
    assert item["underlying"] == "510050"
    assert item["exchange"] == "SSE"
    assert item["cached"] is False
    assert item["rows"] == 3
    assert item["firstDate"] == "2026-08-03"
    assert item["lastDate"] == "2026-08-05"
    _cache_name(item["cachePath"], "510050_raw.parquet")
    assert Path(item["cachePath"]).exists()
    assert len(item["preview"]) == 3
    again = underlying_daily.handle_fetch_underlying_daily(request, tmp_path)
    assert again["underlyings"][0]["cached"] is True
    forced = underlying_daily.handle_fetch_underlying_daily(
        {**request, "forceRefresh": True}, tmp_path
    )
    assert forced["underlyings"][0]["cached"] is False
    assert forced["underlyings"][0]["rows"] == 3


def test_range_filter(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, _hist_frame())
    request = {
        "source": "akshare",
        "underlying": "510050",
        "start": "2026-08-04",
        "end": "2026-08-04",
        "cacheDir": str(tmp_path),
    }
    result = underlying_daily.handle_fetch_underlying_daily(request, tmp_path)
    item = result["underlyings"][0]
    assert item["firstDate"] == item["lastDate"] == "2026-08-04"
    with pytest.raises(OptionsError) as err:
        underlying_daily.handle_fetch_underlying_daily(
            {**request, "start": "2030-01-01", "end": "2030-01-31"}, tmp_path
        )
    assert err.value.code == "NO_DATA"


def test_drops_invalid_rows(tmp_path, monkeypatch):
    dirty = _hist_frame(
        dates=["2026-08-03", "not-a-date", "2026-08-05", "2026-08-06"],
        closes=[3.10, 3.11, 0.0, 3.15],
        volumes=[1000, 1100, 1200, -1],
    )
    _patch_fetch(monkeypatch, dirty)
    result = underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    item = result["underlyings"][0]
    assert item["rows"] == 1
    assert item["firstDate"] == item["lastDate"] == "2026-08-03"


def test_rejects_non_akshare_and_unknown(tmp_path):
    with pytest.raises(OptionsError) as err:
        underlying_daily.handle_fetch_underlying_daily(
            {"source": "synth", "underlying": "910050", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"
    assert "akshare" in err.value.message
    with pytest.raises(OptionsError) as err:
        underlying_daily.handle_fetch_underlying_daily(
            {"source": "akshare", "underlying": "000000", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"


def test_adjust_qfq_uses_matching_cache_suffix(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, _hist_frame())
    result = underlying_daily.handle_fetch_underlying_daily(
        {
            "source": "akshare",
            "underlying": "510050",
            "adjust": "qfq",
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    assert result["adjust"] == "qfq"
    _cache_name(result["underlyings"][0]["cachePath"], "510050_qfq.parquet")


def test_szse_underlying_is_served(tmp_path, monkeypatch):
    # 期权合约日线对 SZSE 是 szse_static_only;标的 ETF 现货不受此限。
    _patch_fetch(monkeypatch, _hist_frame())
    result = underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "159922", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    item = result["underlyings"][0]
    assert item["underlying"] == "159922"
    assert item["exchange"] == "SZSE"
    assert item["rows"] == 3


def test_batch_all_returns_every_registered_underlying(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, _hist_frame())
    result = underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "all", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    codes = [item["underlying"] for item in result["underlyings"]]
    assert "510050" in codes
    assert "159922" in codes
    # 2026-09-13 起 510300/510500 移出名册：akshare 注册标的 9 → 7
    assert "510300" not in codes
    assert result["rows"] == len(result["underlyings"]) >= 7
    assert result["failures"] == []


def test_batch_partial_failure_keeps_successes(tmp_path, monkeypatch):
    def fake_fetch(underlying: str, adjust: str) -> pd.DataFrame:
        if underlying == "588000":
            raise OptionsError("NETWORK", "eastmoney timed out")
        return _hist_frame()

    monkeypatch.setattr(underlying_daily, "_fetch_em_daily", fake_fetch)
    result = underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "all", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    assert any(item["underlying"] == "510050" for item in result["underlyings"])
    assert any(
        fail["underlying"] == "588000" and fail["code"] == "NETWORK" for fail in result["failures"]
    )
    assert result["rows"] == len(result["underlyings"])


def test_batch_all_fail_propagates_first_error(tmp_path, monkeypatch):
    def fake_fetch(underlying: str, adjust: str) -> pd.DataFrame:
        raise OptionsError("NETWORK", f"down {underlying}")

    monkeypatch.setattr(underlying_daily, "_fetch_em_daily", fake_fetch)
    with pytest.raises(OptionsError) as err:
        underlying_daily.handle_fetch_underlying_daily(
            {"source": "akshare", "underlying": "all", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "NETWORK"
    assert "510050" in err.value.message


def test_single_network_is_not_downgraded_to_no_data(tmp_path, monkeypatch):
    def fake_fetch(underlying: str, adjust: str) -> pd.DataFrame:
        raise OptionsError("NETWORK", "502 from eastmoney")

    monkeypatch.setattr(underlying_daily, "_fetch_em_daily", fake_fetch)
    with pytest.raises(OptionsError) as err:
        underlying_daily.handle_fetch_underlying_daily(
            {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "NETWORK"


def test_atomic_write_leaves_no_tmp_and_appends_manifest(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, _hist_frame())
    underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    cache_dir = tmp_path / "underlyings"
    assert list(cache_dir.glob("*.tmp")) == []
    parquet = cache_dir / "510050_raw.parquet"
    assert parquet.exists()
    manifest = tmp_path / "manifest.jsonl"
    assert manifest.exists()
    lines = manifest.read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 1
    assert "510050" in lines[0]
    assert "fetch_underlying_daily" in lines[0]


def test_retries_retryable_then_succeeds(tmp_path, monkeypatch):
    attempts = {"n": 0}

    def flaky(underlying: str, adjust: str) -> pd.DataFrame:
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise TimeoutError("eastmoney timed out")
        return _hist_frame()

    monkeypatch.setattr(underlying_daily, "_fund_etf_hist_em", flaky)
    monkeypatch.setattr(underlying_daily.time, "sleep", lambda _s: None)
    result = underlying_daily.handle_fetch_underlying_daily(
        {"source": "akshare", "underlying": "510050", "cacheDir": str(tmp_path)},
        tmp_path,
    )
    assert attempts["n"] == 3
    assert result["underlyings"][0]["rows"] == 3
