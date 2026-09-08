# 合成期权链的结构性质:确定性、单调性、内在价值下界、到期摘牌、平价违反。

from datetime import date

import numpy as np
import pytest

from dsh_options import synth


def test_fourth_wednesday_known_dates():
    """2026-09 → 23 日(与深交所静态表实测一致);再钉两个可手查的月份。"""
    assert synth.fourth_wednesday(2026, 9) == date(2026, 9, 23)
    assert synth.fourth_wednesday(2026, 6) == date(2026, 6, 24)
    assert synth.fourth_wednesday(2025, 12) == date(2025, 12, 24)


def test_expiry_month_accepts_short_and_long_forms():
    assert synth.expiry_date_of("2609") == date(2026, 9, 23)
    assert synth.expiry_date_of("202609") == date(2026, 9, 23)
    with pytest.raises(ValueError):
        synth.expiry_date_of("209913")  # 非法月份


def test_long_code_roundtrip():
    code = synth.make_long_code("910050", "C", "2609", 2.85)
    assert code == "910050C2609M02850"
    assert synth.parse_long_code(code) == {
        "underlying": "910050",
        "optionType": "C",
        "expiryMonth": "2609",
        "strike": 2.85,
    }
    with pytest.raises(ValueError):
        synth.make_long_code("910050", "X", "2609", 2.85)  # 非法类型
    with pytest.raises(ValueError):
        synth.make_long_code("910050", "C", "2609", 2.8505)  # 不在 0.001 网格
    with pytest.raises(ValueError):
        synth.parse_long_code("510050C2609X02850")  # 非 M 分隔


def test_make_chain_deterministic():
    """同参数同种子:全部合约的价格帧逐值相等(逐字节稳定的基础)。"""
    first = synth.make_chain()
    second = synth.make_chain()
    assert first["spot"].equals(second["spot"])
    assert len(first["contracts"]) == len(second["contracts"])
    for a, b in zip(first["contracts"], second["contracts"]):
        assert a["code"] == b["code"]
        assert a["daily"].equals(b["daily"])


def test_chain_shape_and_strike_grid():
    chain = synth.make_chain()
    # 2 活跃月 + 1 摘牌月,每月 9 档 × C/P = 54 个合约
    assert len(chain["contracts"]) == (2 + 1) * 9 * 2
    strikes = {c["strike"] for c in chain["contracts"]}
    assert min(strikes) == 2.80 and max(strikes) == 3.20  # 围绕 3.0 居中 9 档
    assert {c["expiryMonth"] for c in chain["contracts"]} == {"2606", "2609", "2612"}


def test_call_monotone_decreasing_in_strike():
    """末行截面:Call 随行权价非增,Put 非减(容差 = 0 tick,严格 BSM 单调)。"""
    chain = synth.make_chain()
    month = "2612"  # 无平价偏移的远月
    last = chain["spot"]["close"].iloc[-1]
    for option_type, expect in (("C", "noninc"), ("P", "nondec")):
        rows = sorted(
            (
                c
                for c in chain["contracts"]
                if c["expiryMonth"] == month and c["optionType"] == option_type
            ),
            key=lambda c: c["strike"],
        )
        prices = [c["daily"]["close"].iloc[-1] for c in rows]
        for prev, cur in zip(prices, prices[1:]):
            if expect == "noninc":
                assert cur <= prev + 1e-12
            else:
                assert cur >= prev - 1e-12
        # 内在价值下界(欧式无股息时 C >= max(S-K,0) 严格成立)
        for contract, price in zip(rows, prices):
            intrinsic = max(last - contract["strike"], 0.0)
            assert price >= intrinsic - 1e-10


def test_delisted_contract_stops_at_expiry():
    """摘牌月(2606)合约序列止于到期日 2026-06-24;活跃月序列延续到窗口末。"""
    chain = synth.make_chain()
    delisted = [c for c in chain["contracts"] if c["delisted"]]
    assert delisted, "chain must contain delisted contracts"
    for contract in delisted:
        assert contract["expiryDate"] == "2026-06-24"
        assert c_last_date(contract) <= np.datetime64("2026-06-24")
        assert c_last_date(contract) < chain["spot"]["date"].iloc[-1]
    active = next(c for c in chain["contracts"] if c["expiryMonth"] == "2612")
    assert c_last_date(active) == chain["spot"]["date"].iloc[-1]


def c_last_date(contract) -> "np.datetime64":
    return contract["daily"]["date"].iloc[-1].to_datetime64()


def test_parity_violation_is_exactly_one():
    """近月(2609)平价行权价 call 被施加 +5% 偏移;违反标记与数值偏移一致。"""
    chain = synth.make_chain()
    clean = synth.make_chain(parity_violation=False)
    assert not any(c["parityViolation"] for c in clean["contracts"])
    violated = [c for c in chain["contracts"] if c["parityViolation"]]
    assert len(violated) == 1
    target = violated[0]
    assert target["expiryMonth"] == "2609" and target["optionType"] == "C"
    assert target["strike"] == 3.0
    clean_match = next(c for c in clean["contracts"] if c["code"] == target["code"])
    # 价格 tick 化(4 位小数)下比值只能近似 1.05;排除低价区(相对量化误差大)
    ratio = target["daily"]["close"] / clean_match["daily"]["close"]
    # 只在价格主体区(>0.05 元)断言:低价区一个 tick 的相对误差即可达 1%
    liquid = clean_match["daily"]["close"] > 0.05
    assert liquid.sum() > 40
    assert np.allclose(ratio[liquid], 1.05, rtol=3e-3)


def test_daily_frame_internal_consistency():
    """high >= max(open, close) 且 low <= min(open, close);价格 > 0。"""
    chain = synth.make_chain()
    for contract in chain["contracts"]:
        df = contract["daily"]
        assert len(df) >= 10
        assert (df["high"] >= df[["open", "close"]].max(axis=1) - 1e-12).all()
        assert (df["low"] <= df[["open", "close"]].min(axis=1) + 1e-12).all()
        assert (df[["open", "high", "low", "close"]] > 0).all().all()
        assert (df["volume"] > 0).all()


def test_bs_price_intrinsic_at_zero_maturity():
    spot = np.array([2.9, 3.0, 3.1])
    call = synth.bs_price(spot, 3.0, 0.0, 0.02, 0.2, True)
    put = synth.bs_price(spot, 3.0, 0.0, 0.02, 0.2, False)
    assert np.allclose(call, [0.0, 0.0, 0.1])
    assert np.allclose(put, [0.1, 0.0, 0.0])
    # 正期限平价:C - P = S - K·e^(-rT)
    years = np.full(3, 0.25)
    call = synth.bs_price(spot, 3.0, years, 0.02, 0.2, True)
    put = synth.bs_price(spot, 3.0, years, 0.02, 0.2, False)
    parity = spot - 3.0 * np.exp(-0.02 * 0.25)
    assert np.allclose(call - put, parity, atol=1e-12)
