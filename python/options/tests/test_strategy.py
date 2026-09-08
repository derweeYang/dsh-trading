from pathlib import Path

import pytest

from dsh_options import chain, margin, pricing, strategy
from dsh_options.protocol import OptionsError


def test_expand_covered_call_adds_stock_and_short_call():
    legs = strategy.expand_template(
        "covered_call",
        {"expiryMonth": "2612", "strike": 3.0, "qty": 1},
        multiplier=10000,
    )
    assert legs == [
        {"kind": "underlying", "side": "buy", "qty": 10000, "fromTemplate": True},
        {
            "kind": "option",
            "side": "sell",
            "qty": 1,
            "optionType": "C",
            "strike": 3.0,
            "expiryMonth": "2612",
            "fromTemplate": True,
        },
    ]


def test_expand_collar():
    legs = strategy.expand_template(
        "collar",
        {
            "expiryMonth": "2612",
            "callStrike": 3.2,
            "putStrike": 2.8,
            "qty": 2,
        },
        multiplier=10000,
    )
    assert legs == [
        {"kind": "underlying", "side": "buy", "qty": 20000, "fromTemplate": True},
        {
            "kind": "option",
            "side": "sell",
            "qty": 2,
            "optionType": "C",
            "strike": 3.2,
            "expiryMonth": "2612",
            "fromTemplate": True,
        },
        {
            "kind": "option",
            "side": "buy",
            "qty": 2,
            "optionType": "P",
            "strike": 2.8,
            "expiryMonth": "2612",
            "fromTemplate": True,
        },
    ]


def test_expand_vertical():
    legs = strategy.expand_template(
        "vertical",
        {
            "expiryMonth": "2612",
            "optionType": "P",
            "longStrike": 3.2,
            "shortStrike": 2.8,
            "qty": 2,
        },
        multiplier=10000,
    )
    assert legs == [
        {
            "kind": "option",
            "side": "buy",
            "qty": 2,
            "optionType": "P",
            "strike": 3.2,
            "expiryMonth": "2612",
            "fromTemplate": True,
        },
        {
            "kind": "option",
            "side": "sell",
            "qty": 2,
            "optionType": "P",
            "strike": 2.8,
            "expiryMonth": "2612",
            "fromTemplate": True,
        },
    ]


def test_expand_template_rejects_invalid_qty():
    with pytest.raises(OptionsError) as err:
        strategy.expand_template(
            "covered_call",
            {"expiryMonth": "2612", "strike": 3.0, "qty": None},
            10000,
        )
    assert err.value.code == "BAD_REQUEST"


def test_unknown_template_is_bad_request():
    with pytest.raises(OptionsError) as err:
        strategy.expand_template("iron_condor", {}, multiplier=10000)
    assert err.value.code == "BAD_REQUEST"


def test_expand_butterfly_rejects_unequal_spacing():
    with pytest.raises(OptionsError) as err:
        strategy.expand_template(
            "butterfly",
            {
                "expiryMonth": "2612",
                "optionType": "C",
                "lowStrike": 2.8,
                "midStrike": 3.0,
                "highStrike": 3.3,
            },
            multiplier=10000,
        )
    assert err.value.code == "BAD_REQUEST"


def test_expand_straddle_defaults_to_long():
    legs = strategy.expand_template(
        "straddle", {"expiryMonth": "2612", "strike": 3.0}, multiplier=10000
    )
    assert [leg["optionType"] for leg in legs] == ["C", "P"]
    assert {leg["side"] for leg in legs} == {"buy"}


def test_expiry_pnl_covered_call_at_strike_keeps_premium():
    stock = strategy.leg_expiry_pnl(
        kind="underlying",
        side="buy",
        qty=10000,
        multiplier=10000,
        strike=None,
        option_type=None,
        premium=3.05,
        spot0=3.05,
        spot_t=3.0,
    )
    call = strategy.leg_expiry_pnl(
        kind="option",
        side="sell",
        qty=1,
        multiplier=10000,
        strike=3.0,
        option_type="C",
        premium=0.12,
        spot0=3.05,
        spot_t=3.0,
    )
    assert stock == pytest.approx((3.0 - 3.05) * 10000)
    assert call == pytest.approx(0.12 * 10000)
    assert stock + call == pytest.approx((3.0 - 3.05 + 0.12) * 10000)


def test_long_straddle_expiry_is_abs_move_minus_debit():
    call = strategy.leg_expiry_pnl(
        kind="option",
        side="buy",
        qty=1,
        multiplier=10000,
        strike=3.0,
        option_type="C",
        premium=0.10,
        spot0=3.0,
        spot_t=3.4,
    )
    put = strategy.leg_expiry_pnl(
        kind="option",
        side="buy",
        qty=1,
        multiplier=10000,
        strike=3.0,
        option_type="P",
        premium=0.08,
        spot0=3.0,
        spot_t=3.4,
    )
    assert call + put == pytest.approx((0.4 - 0.18) * 10000)


def test_payoff_grid_includes_spot_and_strikes():
    legs = [
        {
            "kind": "option",
            "side": "buy",
            "qty": 1,
            "optionType": "C",
            "strike": 3.0,
            "premium": 0.12,
            "multiplier": 10000,
        }
    ]
    grid = strategy.build_payoff(legs, spot=3.0, tick=0.1)
    xs = [row["spot"] for row in grid]
    assert 3.0 in xs
    assert min(xs) <= 3.0 * 0.70 + 1e-12
    assert max(xs) >= 3.0 * 1.30 - 1e-12
    at_k = next(row for row in grid if row["spot"] == 3.0)
    assert at_k["pnl"] == pytest.approx(-0.12 * 10000)


def test_signed_greeks_flips_and_scales():
    raw = {
        "delta": 0.5,
        "gamma": 1.0,
        "vega": 2.0,
        "vegaPerVolPoint": 0.02,
        "theta": -3.0,
        "thetaPerDay": -3.0 / 365.0,
        "rho": 4.0,
        "rhoPerBp": 0.0004,
    }
    sold = strategy.signed_greeks(raw, side="sell", qty=2, multiplier=10000)
    assert sold["delta"] == pytest.approx(-0.5 * 2 * 10000)


def _strategy(tmp_path, **extra):
    req = {
        "source": "synth",
        "underlying": "910050",
        "asOf": "2026-09-01",
        "cacheDir": str(tmp_path),
        **extra,
    }
    return strategy.handle_strategy(req, tmp_path)


def test_covered_call_payoff_at_strike_and_zero_cash_margin(tmp_path):
    out = _strategy(
        tmp_path,
        template="covered_call",
        templateParams={"expiryMonth": "2612", "strike": 3.0, "qty": 1},
    )
    call = next(leg for leg in out["legs"] if leg["kind"] == "option")
    assert call["covered"] is True
    k = 3.0
    prem = call["premium"]
    s0 = out["spot"]
    at_k = next(row for row in out["payoff"] if abs(row["spot"] - k) < 1e-12)
    assert at_k["pnl"] == pytest.approx((k - s0 + prem) * 10000, rel=0, abs=1e-8)
    assert out["margin"]["totalInitial"] == 0.0
    assert out["margin"]["totalMaintenance"] == 0.0
    short = next(row for row in out["margin"]["perLeg"] if row.get("covered"))
    assert short["initial"] == 0.0


def test_collar_covers_the_short_call(tmp_path):
    out = _strategy(
        tmp_path,
        template="collar",
        templateParams={
            "expiryMonth": "2612",
            "callStrike": 3.2,
            "putStrike": 2.8,
            "qty": 1,
        },
    )
    kinds = [(leg["kind"], leg["side"], leg.get("optionType")) for leg in out["legs"]]
    assert ("underlying", "buy", None) in kinds
    assert any(leg.get("covered") for leg in out["legs"] if leg.get("optionType") == "C")


def test_holding_qty_prefills_covered_call_legs_from_real_position(tmp_path):
    """阶段 4 互联:holdingQty=25000 份 → 2 张备兑,现货/期权两腿自动匹配。"""
    out = _strategy(
        tmp_path,
        template="covered_call",
        templateParams={"expiryMonth": "2612", "strike": 3.0},
        holdingQty=25000,
    )
    stock = next(leg for leg in out["legs"] if leg["kind"] == "underlying")
    call = next(leg for leg in out["legs"] if leg["kind"] == "option")
    assert stock["qty"] == 20000
    assert call["qty"] == 2


def test_holding_qty_below_one_contract_is_bad_request(tmp_path):
    with pytest.raises(OptionsError, match="less than one contract"):
        _strategy(
            tmp_path,
            template="covered_call",
            templateParams={"expiryMonth": "2612", "strike": 3.0},
            holdingQty=9999,
        )


def test_holding_qty_rejected_for_non_holding_template(tmp_path):
    with pytest.raises(OptionsError, match="only applies to"):
        _strategy(
            tmp_path,
            template="vertical",
            templateParams={
                "expiryMonth": "2612",
                "optionType": "C",
                "longStrike": 2.9,
                "shortStrike": 3.1,
            },
            holdingQty=25000,
        )


def test_bull_call_vertical_max_profit_and_short_leg_margin(tmp_path):
    out = _strategy(
        tmp_path,
        template="vertical",
        templateParams={
            "expiryMonth": "2612",
            "optionType": "C",
            "longStrike": 2.9,
            "shortStrike": 3.1,
            "qty": 1,
        },
    )
    long = next(leg for leg in out["legs"] if leg["strike"] == 2.9)
    short = next(leg for leg in out["legs"] if leg["strike"] == 3.1)
    debit = long["premium"] - short["premium"]
    hi = 3.1
    at_hi = next(row for row in out["payoff"] if abs(row["spot"] - hi) < 1e-12)
    assert at_hi["pnl"] == pytest.approx((0.2 - debit) * 10000, rel=0, abs=1e-8)
    assert out["margin"]["totalInitial"] > 0.0


def test_long_straddle_margin_is_zero(tmp_path):
    out = _strategy(
        tmp_path,
        template="straddle",
        templateParams={"expiryMonth": "2612", "strike": 3.0, "qty": 1},
    )
    assert out["margin"]["totalInitial"] == 0.0
    debit = sum(leg["premium"] for leg in out["legs"] if leg["kind"] == "option")
    at = next(row for row in out["payoff"] if abs(row["spot"] - 3.4) < 1e-12)
    assert at["pnl"] == pytest.approx((0.4 - debit) * 10000, rel=0, abs=1e-8)


def test_call_butterfly_charges_margin_on_two_short_mids(tmp_path):
    out = _strategy(
        tmp_path,
        template="butterfly",
        templateParams={
            "expiryMonth": "2612",
            "optionType": "C",
            "lowStrike": 2.8,
            "midStrike": 3.0,
            "highStrike": 3.2,
            "qty": 1,
        },
    )
    shorts = [
        row for row in out["margin"]["perLeg"] if row.get("qty") == 2 or row.get("side") == "sell"
    ]
    assert out["margin"]["totalInitial"] > 0.0
    assert all(not row.get("covered") for row in shorts)


def test_short_put_margin_uses_asof_prev_settle_not_chain_last_row(tmp_path):
    iv = pricing.handle_implied_vol(
        {
            "source": "synth",
            "underlying": "910050",
            "expiryMonth": "2612",
            "priceField": "prevSettle",
            "asOf": "2026-09-01",
        }
    )
    asof_row = next(
        row for row in iv["results"] if row["optionType"] == "P" and row["strike"] == 3.0
    )
    snap = chain.handle_chain(
        {"source": "synth", "underlying": "910050", "expiryMonth": "2612"},
        tmp_path,
    )
    last_row = next(quote for quote in snap["puts"] if quote["strike"] == 3.0)
    assert asof_row["price"] is not None
    assert asof_row["price"] != pytest.approx(last_row["prevSettle"])

    out = _strategy(
        tmp_path,
        legs=[
            {
                "kind": "option",
                "side": "sell",
                "qty": 1,
                "optionType": "P",
                "strike": 3.0,
                "expiryMonth": "2612",
            }
        ],
    )
    short = next(row for row in out["margin"]["perLeg"] if row["side"] == "sell")
    expected = margin.initial_short_put(
        prev_settle=float(asof_row["price"]),
        spot_prev=out["spot"],
        strike=3.0,
        multiplier=10000,
        qty=1,
    )
    last_row_margin = margin.initial_short_put(
        prev_settle=float(last_row["prevSettle"]),
        spot_prev=out["spot"],
        strike=3.0,
        multiplier=10000,
        qty=1,
    )
    assert short["initial"] == pytest.approx(expected, rel=0, abs=1e-8)
    assert short["initial"] != pytest.approx(last_row_margin, rel=0, abs=1e-8)
    assert "marginSettleFallback" not in out["meta"]


def test_expired_synth_month_derives_asof_spot(tmp_path):
    snap = pricing._snapshot_synth("910050", "2606", "last", "2026-09-01")
    out = _strategy(
        tmp_path,
        template="covered_call",
        templateParams={"expiryMonth": "2606", "strike": 3.0, "qty": 1},
    )
    assert out["spot"] == pytest.approx(snap["spot"])
    call = next(leg for leg in out["legs"] if leg["kind"] == "option")
    assert call["ivStatus"] == "expired"
    assert out["payoff"]
    assert out["margin"]["totalInitial"] == 0.0
    assert out["greeks"]["status"] == "insufficient"


def test_expired_uncovered_short_uses_asof_snapshot_settle_not_chain(tmp_path):
    as_of = "2026-09-01"
    month = "2606"
    strike = 3.0
    snap = pricing._snapshot_synth("910050", month, "prevSettle", as_of)
    snap_row = next(
        row
        for row in (*snap["calls"], *snap["puts"])
        if row["optionType"] == "P" and row["strike"] == strike
    )
    last = chain.handle_chain(
        {"source": "synth", "underlying": "910050", "expiryMonth": month},
        tmp_path,
    )
    last_row = next(quote for quote in last["puts"] if quote["strike"] == strike)
    assert last_row["prevSettle"] is not None
    legs = [
        {
            "kind": "option",
            "side": "sell",
            "qty": 1,
            "optionType": "P",
            "strike": strike,
            "expiryMonth": month,
        }
    ]
    if snap_row["price"] is None:
        with pytest.raises(OptionsError) as err:
            _strategy(tmp_path, legs=legs)
        assert err.value.code == "NO_DATA"
        return
    assert snap_row["price"] != pytest.approx(last_row["prevSettle"])
    out = _strategy(tmp_path, legs=legs)
    short = next(row for row in out["margin"]["perLeg"] if row["side"] == "sell")
    expected = margin.initial_short_put(
        prev_settle=float(snap_row["price"]),
        spot_prev=out["spot"],
        strike=strike,
        multiplier=10000,
        qty=1,
    )
    last_row_margin = margin.initial_short_put(
        prev_settle=float(last_row["prevSettle"]),
        spot_prev=out["spot"],
        strike=strike,
        multiplier=10000,
        qty=1,
    )
    assert short["initial"] == pytest.approx(expected, rel=0, abs=1e-8)
    assert short["initial"] != pytest.approx(last_row_margin, rel=0, abs=1e-8)
    assert short["initial"] != 0.0


def test_missing_settle_raises_instead_of_using_premium(tmp_path, monkeypatch):
    real_iv = pricing.handle_implied_vol
    real_snap = pricing._snapshot_synth

    def fake_iv(req):
        if req.get("priceField") == "prevSettle":
            raise OptionsError("NO_DATA", "no prevSettle rows")
        return real_iv(req)

    def fake_snap(underlying, month, price_field, as_of):
        if price_field == "prevSettle":
            raise OptionsError("NO_DATA", "no asOf prevSettle")
        return real_snap(underlying, month, price_field, as_of)

    def fake_chain(req, cache_dir=None):
        raise AssertionError("synth settle must not use handle_chain")

    monkeypatch.setattr(pricing, "handle_implied_vol", fake_iv)
    monkeypatch.setattr(pricing, "_snapshot_synth", fake_snap)
    monkeypatch.setattr(strategy.chain, "handle_chain", fake_chain)
    with pytest.raises(OptionsError) as err:
        _strategy(
            tmp_path,
            legs=[
                {
                    "kind": "option",
                    "side": "sell",
                    "qty": 1,
                    "optionType": "P",
                    "strike": 3.0,
                    "expiryMonth": "2612",
                }
            ],
            premiumOverrides={"0": 0.15},
        )
    assert err.value.code == "NO_DATA"


def test_prev_settle_network_propagates(tmp_path, monkeypatch):
    real_iv = pricing.handle_implied_vol

    def fake_iv(req):
        if req.get("priceField") == "prevSettle":
            raise OptionsError("NETWORK", "board fetch failed")
        return real_iv(req)

    monkeypatch.setattr(pricing, "handle_implied_vol", fake_iv)
    with pytest.raises(OptionsError) as err:
        _strategy(
            tmp_path,
            legs=[
                {
                    "kind": "option",
                    "side": "sell",
                    "qty": 1,
                    "optionType": "P",
                    "strike": 3.0,
                    "expiryMonth": "2612",
                }
            ],
        )
    assert err.value.code == "NETWORK"


def test_short_underlying_margin_is_unsupported(tmp_path):
    out = _strategy(
        tmp_path,
        legs=[{"kind": "underlying", "side": "sell", "qty": 10000}],
        spot=3.0,
    )
    short = next(row for row in out["margin"]["perLeg"] if row.get("kind") == "underlying")
    assert short["status"] == "unsupported"
    assert "initial" not in short
    assert "maintenance" not in short
    assert out["margin"]["totalInitial"] == 0.0
    assert out["margin"]["totalMaintenance"] == 0.0


def test_no_vizdir_means_empty_charts(tmp_path):
    out = _strategy(
        tmp_path,
        template="straddle",
        templateParams={"expiryMonth": "2612", "strike": 3.0},
    )
    assert out["charts"] == []


def test_vizdir_writes_payoff_and_greeks_png(tmp_path):
    viz = tmp_path / "viz"
    out = _strategy(
        tmp_path,
        template="straddle",
        templateParams={"expiryMonth": "2612", "strike": 3.0},
        vizDir=str(viz),
    )
    kinds = {row["kind"]: row for row in out["charts"]}
    assert kinds["payoff"]["status"] == "ok"
    assert Path(kinds["payoff"]["path"]).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"
    assert kinds["greeks"]["status"] == "ok"
    assert Path(kinds["greeks"]["path"]).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n"


def test_chart_kinds_without_vizdir_is_bad_request(tmp_path):
    with pytest.raises(OptionsError) as err:
        _strategy(
            tmp_path,
            template="straddle",
            templateParams={"expiryMonth": "2612", "strike": 3.0},
            chartKinds=["payoff"],
        )
    assert err.value.code == "BAD_REQUEST"


def test_illegal_chart_kinds_is_bad_request(tmp_path):
    with pytest.raises(OptionsError) as err:
        _strategy(
            tmp_path,
            template="straddle",
            templateParams={"expiryMonth": "2612", "strike": 3.0},
            vizDir=str(tmp_path / "viz"),
            chartKinds=["svi"],
        )
    assert err.value.code == "BAD_REQUEST"
