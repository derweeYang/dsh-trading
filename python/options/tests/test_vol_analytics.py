# vol_analytics:ATM 期限结构、25Δ skew、HV、离散蝶形;synth 离线。

import math
from pathlib import Path

import pytest

from dsh_options import vol_analytics
from dsh_options.protocol import OptionsError


def test_atm_iv_averages_call_and_put_on_closest_strike():
    rows = [
        {"optionType": "C", "strike": 2.9, "iv": 0.21, "converged": True, "price": 0.2},
        {"optionType": "P", "strike": 2.9, "iv": 0.19, "converged": True, "price": 0.1},
        {"optionType": "C", "strike": 3.1, "iv": 0.30, "converged": True, "price": 0.05},
    ]
    atm = vol_analytics.atm_from_rows(rows, spot=3.0)
    assert atm["atmStrike"] == pytest.approx(2.9)
    assert atm["atmIv"] == pytest.approx(0.20)


def test_skew_uses_nearest_25_delta_rows_without_interpolating():
    rows = [
        {"optionType": "C", "strike": 3.2, "iv": 0.18, "converged": True, "delta": 0.28},
        {"optionType": "C", "strike": 3.4, "iv": 0.16, "converged": True, "delta": 0.10},
        {"optionType": "P", "strike": 2.8, "iv": 0.24, "converged": True, "delta": -0.22},
        {"optionType": "P", "strike": 2.6, "iv": 0.30, "converged": True, "delta": -0.40},
    ]
    skew = vol_analytics.skew_25d_from_rows(rows)
    assert skew["status"] == "ok"
    assert skew["call25Strike"] == pytest.approx(3.2)
    assert skew["put25Strike"] == pytest.approx(2.8)
    assert skew["skew"] == pytest.approx(0.06)


def test_skew_insufficient_when_delta_too_far():
    rows = [
        {"optionType": "C", "strike": 3.5, "iv": 0.15, "converged": True, "delta": 0.05},
        {"optionType": "P", "strike": 2.4, "iv": 0.35, "converged": True, "delta": -0.55},
    ]
    assert vol_analytics.skew_25d_from_rows(rows)["status"] == "insufficient"


def test_butterfly_flags_negative_convexity_only():
    # equally spaced: residual = C1 + C3 - 2 C2
    calls = {2.8: 0.30, 2.9: 0.10, 3.0: 0.20}  # middle too cheap → residual > 0, ok
    assert vol_analytics.butterfly_violations(calls, tick=0.0001) == []
    cheap_wings = {2.8: 0.10, 2.9: 0.40, 3.0: 0.10}  # middle expensive
    hits = vol_analytics.butterfly_violations(cheap_wings, tick=0.0001)
    assert len(hits) == 1
    assert hits[0]["k2"] == pytest.approx(2.9)
    assert hits[0]["residual"] < 0


def test_realized_vol_needs_window_plus_one_closes():
    # 20 个 ±1% 对数收益,均值 0,样本标准差 0.01
    closes = [1.0]
    for ret in [0.01, -0.01] * 10:
        closes.append(closes[-1] * math.exp(ret))
    hv = vol_analytics.realized_vol(closes, window=20)
    assert hv["status"] == "ok"
    assert hv["sampleSize"] == 20
    # ddof=1: std = 0.01 * sqrt(n/(n-1))
    assert hv["hv"] == pytest.approx(0.01 * math.sqrt(20 / 19) * math.sqrt(252), rel=1e-9)
    short = vol_analytics.realized_vol(closes, window=40)
    assert short["status"] == "insufficient"


def _svi_total_variance(k: float, a: float, b: float, rho: float, m: float, sigma: float) -> float:
    diff = k - m
    return a + b * (rho * diff + math.sqrt(diff * diff + sigma * sigma))


def test_raw_svi_recovers_planted_skew_and_needs_five_strikes():
    from dsh_options.svi import raw_svi_smile

    a, b, rho, m, sigma = 0.04, 0.15, -0.4, 0.05, 0.2
    years, spot, rate, div = 0.25, 3.10, 0.02, 0.0
    forward = spot * math.exp((rate - div) * years)
    mids = {}
    for step in range(9):
        strike = round(2.70 + 0.10 * step, 2)
        log_m = math.log(strike / forward)
        mids[strike] = math.sqrt(_svi_total_variance(log_m, a, b, rho, m, sigma) / years)
    fit = raw_svi_smile(mids, spot=spot, years=years, rate=rate, dividend_yield=div)
    assert fit["status"] == "ok"
    assert fit["method"] == "raw-svi"
    assert fit["nKnots"] == 9
    assert fit["maxAbsResidual"] < 1e-3
    assert fit["arbViolations"] == []
    params = fit["params"]
    assert params["a"] == pytest.approx(a, abs=2e-2)
    assert params["b"] == pytest.approx(b, abs=5e-2)
    assert params["rho"] == pytest.approx(rho, abs=0.15)
    assert params["m"] == pytest.approx(m, abs=5e-2)
    assert params["sigma"] == pytest.approx(sigma, abs=5e-2)
    short = raw_svi_smile(
        {3.0: 0.20, 3.1: 0.21, 3.2: 0.22, 3.3: 0.23},
        spot=3.1,
        years=0.25,
        rate=0.02,
        dividend_yield=0.0,
    )
    assert short["status"] == "insufficient"
    assert short["nKnots"] == 4


def test_raw_svi_degrades_when_volsurface_missing(monkeypatch):
    # 网关环境可能没装 volsurface：SVI 应降级为 insufficient 行，
    # 不抛 INTERNAL 炸掉整份 vol_analytics 报告。
    import builtins

    from dsh_options.svi import raw_svi_smile

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name.startswith("volsurface"):
            raise ImportError(f"No module named {name!r}")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    fit = raw_svi_smile(
        {2.8: 0.20, 2.9: 0.21, 3.0: 0.215, 3.1: 0.22, 3.3: 0.23},
        spot=3.0,
        years=0.25,
        rate=0.02,
        dividend_yield=0.0,
    )
    assert fit["status"] == "insufficient"
    assert fit["method"] == "raw-svi"
    assert "volsurface package not installed" in fit["reason"]
    assert fit["params"] is None
    assert fit["knots"] == []


def test_quadratic_smile_fits_flat_and_needs_three_strikes():
    flat = {2.8: 0.20, 3.0: 0.20, 3.2: 0.20}
    smile = vol_analytics.quadratic_smile(flat)
    assert smile["status"] == "ok"
    assert smile["method"] == "quadratic"
    assert smile["nKnots"] == 3
    assert smile["maxAbsResidual"] == pytest.approx(0.0, abs=1e-12)
    assert smile["coeffs"][0] == pytest.approx(0.20, abs=1e-9)
    short = vol_analytics.quadratic_smile({3.0: 0.20, 3.1: 0.21})
    assert short["status"] == "insufficient"


def test_iv_percentile_average_rank_and_insufficient():
    flat = vol_analytics.iv_percentile([0.20] * 60, window=60)
    assert flat["status"] == "ok"
    assert flat["percentile"] == pytest.approx(50.0)
    assert flat["currentIv"] == pytest.approx(0.20)
    assert flat["sampleSize"] == 60
    rising = vol_analytics.iv_percentile([0.10, 0.12, 0.14, 0.16, 0.20], window=5)
    # 4 个更小 + 0.5 个相等 → 90
    assert rising["percentile"] == pytest.approx(90.0)
    short = vol_analytics.iv_percentile([0.20] * 10, window=60)
    assert short["status"] == "insufficient"


def test_handle_synth_2609_term_structure_skew_and_hv(tmp_path):
    # asOf 选在近月仍存活、行权价网格能落到 25Δ 的交易日
    result = vol_analytics.handle_vol_analytics(
        {
            "source": "synth",
            "underlying": "910050",
            "expiryMonths": ["2609"],
            "asOf": "2026-09-01",
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    assert result["source"] == "synth"
    assert result["underlying"] == "910050"
    assert result["failures"] == []
    term = result["termStructure"]
    assert len(term) == 1
    assert term[0]["expiryMonth"] == "2609"
    assert term[0]["status"] == "ok"
    assert term[0]["atmIv"] == pytest.approx(0.20, abs=1e-3)
    skew = result["skew"][0]
    assert skew["status"] == "ok"
    assert skew["skew"] == pytest.approx(0.0, abs=1e-6)
    windows = {row["window"]: row for row in result["realizedVol"]}
    assert windows[20]["status"] == "ok"
    assert windows[60]["status"] == "ok"
    assert windows[120]["status"] == "insufficient"
    assert result["butterflies"][0]["nChecked"] >= 1
    pct = {row["window"]: row for row in result["ivPercentile"]}
    assert pct[60]["status"] == "ok"
    assert pct[60]["expiryMonth"] == "2609"
    assert pct[60]["sampleSize"] == 60
    # 日线 close 四位取整 + 2609 植入平价违约,ATM 路径不是常数 0.20
    assert 0.0 <= pct[60]["percentile"] <= 100.0
    assert pct[60]["currentIv"] == pytest.approx(0.20, abs=2e-2)
    assert pct[252]["status"] == "insufficient"
    smile = result["smile"][0]
    assert smile["status"] == "ok"
    assert smile["method"] == "quadratic"
    assert smile["nKnots"] >= 3
    assert smile["atmIvFitted"] == pytest.approx(0.20, abs=2e-2)
    assert smile["butterflyViolations"] == []
    svi = result["svi"][0]
    assert svi["status"] == "ok"
    assert svi["method"] == "raw-svi"
    assert svi["nKnots"] >= 5
    assert svi["atmIvFitted"] == pytest.approx(0.20, abs=2e-2)
    assert svi["maxAbsResidual"] < 5e-2
    assert svi["butterflyViolations"] == []
    assert set(svi["params"]) == {"a", "b", "rho", "m", "sigma"}
    assert result["charts"] == []


def test_handle_expired_month_iv_percentile_is_expired(tmp_path):
    result = vol_analytics.handle_vol_analytics(
        {
            "source": "synth",
            "underlying": "910050",
            "expiryMonths": ["2606"],
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    assert result["termStructure"][0]["status"] == "expired"
    assert all(row["status"] == "expired" for row in result["ivPercentile"])
    assert result["smile"][0]["status"] == "expired"
    assert result["svi"][0]["status"] == "expired"
    assert result["charts"] == []


def test_handle_expired_month_is_marked_not_fatal(tmp_path):
    result = vol_analytics.handle_vol_analytics(
        {
            "source": "synth",
            "underlying": "910050",
            "expiryMonths": ["2606", "2612"],
            "cacheDir": str(tmp_path),
        },
        tmp_path,
    )
    by_month = {row["expiryMonth"]: row for row in result["termStructure"]}
    assert by_month["2606"]["status"] == "expired"
    assert by_month["2612"]["status"] == "ok"


def test_rejects_non_synth_unknown_and_missing_cachedir(tmp_path):
    with pytest.raises(OptionsError) as err:
        vol_analytics.handle_vol_analytics(
            {"source": "bogus", "underlying": "910050", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"
    with pytest.raises(OptionsError) as err:
        vol_analytics.handle_vol_analytics(
            {"source": "synth", "underlying": "510050", "cacheDir": str(tmp_path)},
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"


def test_charts_require_vizdir_and_valid_kinds(tmp_path):
    with pytest.raises(OptionsError) as err:
        vol_analytics.handle_vol_analytics(
            {
                "source": "synth",
                "underlying": "910050",
                "expiryMonths": ["2609"],
                "asOf": "2026-09-01",
                "cacheDir": str(tmp_path),
                "chartKinds": ["term"],
            },
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"
    assert "vizDir" in err.value.message
    with pytest.raises(OptionsError) as err:
        vol_analytics.handle_vol_analytics(
            {
                "source": "synth",
                "underlying": "910050",
                "expiryMonths": ["2609"],
                "asOf": "2026-09-01",
                "cacheDir": str(tmp_path),
                "vizDir": str(tmp_path / "viz"),
                "chartKinds": ["svi"],
            },
            tmp_path,
        )
    assert err.value.code == "BAD_REQUEST"


def test_handle_writes_term_and_smile_pngs(tmp_path):
    viz = tmp_path / "viz"
    result = vol_analytics.handle_vol_analytics(
        {
            "source": "synth",
            "underlying": "910050",
            "expiryMonths": ["2609"],
            "asOf": "2026-09-01",
            "cacheDir": str(tmp_path),
            "vizDir": str(viz),
        },
        tmp_path,
    )
    by_kind = {(row["kind"], row.get("expiryMonth")): row for row in result["charts"]}
    term = by_kind[("term", None)]
    smile = by_kind[("smile", "2609")]
    assert term["status"] == "ok"
    assert smile["status"] == "ok"
    for row in (term, smile):
        path = Path(row["path"])
        assert path.is_file()
        assert path.read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_expired_smile_chart_is_marked_not_written(tmp_path):
    viz = tmp_path / "viz"
    result = vol_analytics.handle_vol_analytics(
        {
            "source": "synth",
            "underlying": "910050",
            "expiryMonths": ["2606"],
            "cacheDir": str(tmp_path),
            "vizDir": str(viz),
        },
        tmp_path,
    )
    smile = next(row for row in result["charts"] if row["kind"] == "smile")
    assert smile["status"] == "expired"
    assert "path" not in smile
    term = next(row for row in result["charts"] if row["kind"] == "term")
    assert term["status"] == "expired"
    assert not list(viz.rglob("*.png"))
