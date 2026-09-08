# bsm 内核对拍测试。防自证纪律:期望值来自测试内独立实现的公式/有限差分,
# 不复用 dsh_options.bsm 的内部函数;synth.bs_price 是另一套独立实现,作 q=0 锚点。

import itertools
import math

import pytest

from dsh_options import bsm, synth

# 交叉参数盘:覆盖 C/P、ITM/ATM/OTM、q=0 与 q>0、长短期限
CASES = [
    # (spot, strike, years, rate, q, vol, is_call)
    (3.00, 3.00, 0.25, 0.02, 0.0, 0.20, True),
    (3.00, 3.00, 0.25, 0.02, 0.0, 0.20, False),
    (3.05, 2.80, 0.10, 0.02, 0.0, 0.35, True),
    (3.05, 3.20, 0.02, 0.015, 0.0, 0.18, False),
    (2.85, 2.90, 1.00, 0.03, 0.02, 0.30, True),
    (2.85, 2.70, 0.50, 0.03, 0.02, 0.30, False),
]


def reference_price(s, k, t, r, q, sigma, is_call):
    """独立参考实现:教科书 Merton 连续股息 BSM(与 bsm.py 无共享代码)。"""
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma**2) * t) / (sigma * math.sqrt(t))
    d2 = d1 - sigma * math.sqrt(t)
    n = lambda x: 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))
    if is_call:
        return s * math.exp(-q * t) * n(d1) - k * math.exp(-r * t) * n(d2)
    return k * math.exp(-r * t) * n(-d2) - s * math.exp(-q * t) * n(-d1)


class TestPrice:
    @pytest.mark.parametrize("s,k,t,r,q,sigma,is_call", CASES)
    def test_matches_independent_formula(self, s, k, t, r, q, sigma, is_call):
        got = float(bsm.bs_price(s, k, t, r, q, sigma, is_call))
        assert got == pytest.approx(reference_price(s, k, t, r, q, sigma, is_call), rel=1e-12)

    def test_q0_matches_synth_generator(self):
        """两套独立实现(synth 生成器 vs 正式内核)在 q=0 时逐案对拍。"""
        for s, k, t, r, _q, sigma, is_call in CASES:
            got = float(bsm.bs_price(s, k, t, r, 0.0, sigma, is_call))
            ref = float(synth.bs_price(s, k, t, r, sigma, is_call))
            assert got == pytest.approx(ref, rel=1e-12, abs=1e-12)

    def test_zero_years_degenerates_to_intrinsic(self):
        assert float(bsm.bs_price(3.1, 3.0, 0.0, 0.02, 0.0, 0.2, True)) == pytest.approx(0.1)
        assert float(bsm.bs_price(3.1, 3.0, -0.5, 0.02, 0.0, 0.2, True)) == pytest.approx(0.1)
        assert float(bsm.bs_price(3.0, 3.1, 0.0, 0.02, 0.0, 0.2, False)) == pytest.approx(0.1)
        assert float(bsm.bs_price(3.0, 3.1, 0.0, 0.02, 0.0, 0.2, True)) == 0.0

    @pytest.mark.parametrize("args", [(0.0, 3.0), (3.0, 0.0), (-1.0, 3.0)])
    def test_nonpositive_inputs_rejected(self, args):
        with pytest.raises(ValueError):
            bsm.bs_price(args[0], args[1], 0.1, 0.02, 0.0, 0.2, True)
        with pytest.raises(ValueError):
            bsm.bs_price(3.0, 3.0, 0.1, 0.02, 0.0, 0.0, True)  # vol<=0


class TestGreeks:
    @pytest.mark.parametrize("s,k,t,r,q,sigma,is_call", CASES)
    def test_finite_difference(self, s, k, t, r, q, sigma, is_call):
        """解析 Greeks vs 中心差分(独立数值验证,容差 1e-4 相对量级)。"""
        g = bsm.bs_greeks(s, k, t, r, q, sigma, is_call)
        f = lambda *a: float(bsm.bs_price(*a, is_call))
        # delta: dP/dS
        h = 1e-4 * s
        assert g["delta"] == pytest.approx(
            (f(s + h, k, t, r, q, sigma) - f(s - h, k, t, r, q, sigma)) / (2 * h), abs=2e-5
        )
        # gamma: d²P/dS²
        assert g["gamma"] == pytest.approx(
            (
                f(s + h, k, t, r, q, sigma)
                - 2 * f(s, k, t, r, q, sigma)
                + f(s - h, k, t, r, q, sigma)
            )
            / h**2,
            abs=2e-3,
        )
        # vega: dP/dσ
        hv = 1e-5
        assert g["vega"] == pytest.approx(
            (f(s, k, t, r, q, sigma + hv) - f(s, k, t, r, q, sigma - hv)) / (2 * hv), abs=2e-6
        )
        # theta: −dP/dT(年化口径)
        ht = min(1e-5, t / 100)
        assert g["theta"] == pytest.approx(
            -(f(s, k, t + ht, r, q, sigma) - f(s, k, t - ht, r, q, sigma)) / (2 * ht), abs=2e-4
        )
        # rho: dP/dr
        hr = 1e-6
        assert g["rho"] == pytest.approx(
            (f(s, k, t, r + hr, q, sigma) - f(s, k, t, r - hr, q, sigma)) / (2 * hr), abs=2e-5
        )

    def test_units_derivation(self):
        g = bsm.bs_greeks(3.0, 3.0, 0.25, 0.02, 0.0, 0.2, True)
        assert g["vegaPerVolPoint"] == pytest.approx(g["vega"] * 0.01)
        assert g["thetaPerDay"] == pytest.approx(g["theta"] / 365.0)
        assert g["rhoPerBp"] == pytest.approx(g["rho"] * 1e-4)

    def test_zero_years_degenerate_greeks(self):
        itm = bsm.bs_greeks(3.1, 3.0, 0.0, 0.02, 0.0, 0.2, True)
        assert itm["price"] == pytest.approx(0.1)
        assert itm["delta"] == 1.0 and itm["gamma"] == 0.0
        atm = bsm.bs_greeks(3.0, 3.0, 0.0, 0.02, 0.0, 0.2, True)
        assert atm["delta"] == 0.5
        otm_put = bsm.bs_greeks(3.1, 3.0, 0.0, 0.02, 0.0, 0.2, False)
        assert otm_put["price"] == 0.0 and otm_put["delta"] == 0.0

    @pytest.mark.parametrize("s,k,t,r,q,sigma,is_call", CASES)
    def test_put_call_parity_identity(self, s, k, t, r, q, sigma, is_call):
        """C−P ≡ S·e^{−qT} − K·e^{−rT}:Greeks 的 price 字段与解析恒等式对拍。"""
        c = bsm.bs_greeks(s, k, t, r, q, sigma, True)["price"]
        p = bsm.bs_greeks(s, k, t, r, q, sigma, False)["price"]
        assert c - p == pytest.approx(s * math.exp(-q * t) - k * math.exp(-r * t), abs=1e-12)


class TestImpliedVol:
    @pytest.mark.parametrize("s,k,t,r,q,sigma,is_call", CASES)
    def test_round_trip(self, s, k, t, r, q, sigma, is_call):
        """定价→反解→回到原 vol(Brent 精度 1e-8 级)。"""
        price = reference_price(s, k, t, r, q, sigma, is_call)
        iv, status = bsm.implied_vol(price, s, k, t, r, q, is_call)
        assert status == "ok"
        assert iv == pytest.approx(sigma, abs=1e-8)

    def test_below_intrinsic(self):
        """市场价低于 vol_lo 理论价(折现远期内在价值)→ 显式分类,非静默。"""
        iv, status = bsm.implied_vol(0.001, 3.05, 2.80, 0.1, 0.02, 0.0, True)
        assert iv is None and status == "below-intrinsic"
        iv, status = bsm.implied_vol(0.0, 3.05, 2.80, 0.1, 0.02, 0.0, True)
        assert status == "below-intrinsic"

    def test_above_upper_bound(self):
        """市场价高于 vol_hi 理论价 → above-upper-bound(调大区间可解)。"""
        huge = reference_price(3.0, 3.0, 0.25, 0.02, 0.0, 5.0, True) * 1.5
        iv, status = bsm.implied_vol(huge, 3.0, 3.0, 0.25, 0.02, 0.0, True)
        assert iv is None and status == "above-upper-bound"
        # 同价放宽到 [1e-4, 8.0] 可解 → 证明是区间问题而非数据问题
        wide = bsm.implied_vol(
            reference_price(3.0, 3.0, 0.25, 0.02, 0.0, 5.0, True),
            3.0,
            3.0,
            0.25,
            0.02,
            0.0,
            True,
            vol_hi=8.0,
        )
        assert wide[1] == "ok" and wide[0] == pytest.approx(5.0, abs=1e-6)

    def test_zero_years_unconverged(self):
        """T=0 无信息可反解:显式 unconverged,不猜。"""
        assert bsm.implied_vol(0.1, 3.0, 3.0, 0.0, 0.02, 0.0, True) == (None, "unconverged")

    def test_vol_monotonicity_bracket(self):
        """P(vol) 单调性(算法基石 P7):抽样验证严格递增。"""
        prices = [
            reference_price(3.0, 3.0, 0.25, 0.02, 0.0, v, True) for v in (0.05, 0.2, 0.5, 1.0, 3.0)
        ]
        assert all(a < b for a, b in itertools.pairwise(prices))


class TestBrent:
    def test_known_roots(self):
        """标准测试函数根(平方根、三角)逐一命中。"""
        assert bsm._brentq(lambda x: x * x - 4.0, 0.0, 5.0, -4.0, 21.0, 1e-12, 200)[
            0
        ] == pytest.approx(2.0, abs=1e-10)
        f = lambda x: math.sin(x)
        root, ok = bsm._brentq(f, 3.0, 4.0, f(3.0), f(4.0), 1e-12, 200)
        assert ok and root == pytest.approx(math.pi, abs=1e-10)

    def test_endpoint_zero(self):
        assert bsm._brentq(lambda x: x - 2.0, 0.0, 2.0, -2.0, 0.0, 1e-12, 200) == (2.0, True)
