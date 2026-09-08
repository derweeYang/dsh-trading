# 正式定价内核:含连续股息率的欧式 BSM 定价、全 Greeks 与 Brent 隐波反解。
#
# 与 synth.bs_price 的分工(DO3):synth 版是数据生成专用(无股息、无 Greeks、无错误契约),
# 本模块是面向工具面的正式实现——显式 dividendYield、边界退化、无解三分类
# (below-intrinsic | above-upper-bound | unconverged)。两套实现互不复用代码,
# q=0 时数值对拍作为测试锚点(防止同源实现自证)。
#
# 算法基石:BSM 价对 vol 严格单调递增(r、q、T、S、K 固定)——bracket 外即无解,
# bracket 内根唯一,Brent 必收敛(迭代上限作守卫)。

import math
from typing import Any

import numpy as np

# IV 反解默认参数:区间、精度与迭代上限。显式可配,响应 meta 回显(不藏口径)。
DEFAULT_VOL_LO = 1e-4
DEFAULT_VOL_HI = 5.0
DEFAULT_MAX_ITER = 200
DEFAULT_TOL = 1e-10


def norm_cdf(x):
    """标准正态 CDF(math.erf 实现,标量;与 synth.norm_cdf 同式但独立维护)。"""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def norm_pdf(x):
    """标准正态 PDF(标量,Greeks 用)。"""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def _validate_core(spot: float, strike: float, vol: float) -> None:
    """正性校验;违反即 ValueError(子命令层转 BAD_REQUEST)。"""
    if spot <= 0 or strike <= 0:
        raise ValueError(f"spot and strike must be positive, got spot={spot!r}, strike={strike!r}")
    if vol <= 0:
        raise ValueError(f"vol must be positive, got {vol!r}")


def _d1_d2(spot, strike, years, rate, div_yield, vol):
    """(d1, d2) 向量化;years<=0 的行防除零(填 1 后由调用方覆盖)。"""
    t = np.maximum(np.asarray(years, dtype="float64"), 1e-12)
    sqrt_t = np.sqrt(t)
    d1 = (np.log(spot / strike) + (rate - div_yield + 0.5 * vol * vol) * t) / (vol * sqrt_t)
    return d1, d1 - vol * sqrt_t


def bs_price(spot, strike, years, rate, div_yield, vol, is_call: bool):
    """含股息率的欧式 BSM 定价;标量/数组皆可。

    ``years <= 0`` 时退化为**未折现内在价值**(T=0 时贴现因子为 1,
    远期收敛到现货);与 synth.bs_price(spot 无股息)在 q=0 时对拍为测试锚。
    """
    _validate_core(float(spot), float(strike), float(vol))
    spot = np.asarray(spot, dtype="float64")
    years = np.asarray(years, dtype="float64")
    q = float(div_yield)
    r = float(rate)
    diff = spot - float(strike) if is_call else float(strike) - spot
    intrinsic = np.maximum(np.asarray(diff, dtype="float64"), 0.0)
    live = years > 0.0
    if not np.any(live):
        return intrinsic
    d1, d2 = _d1_d2(spot, float(strike), years, r, q, float(vol))
    n_d1 = _ncdf(d1)
    n_d2 = _ncdf(d2)
    disc_q = np.exp(-q * years)
    disc_r = np.exp(-r * years)
    if is_call:
        price = spot * disc_q * n_d1 - float(strike) * disc_r * n_d2
    else:
        price = float(strike) * disc_r * _ncdf(-d2) - spot * disc_q * _ncdf(-d1)
    return np.where(live, price, intrinsic)


def bs_greeks(spot, strike, years, rate, div_yield, vol, is_call: bool) -> dict[str, Any]:
    """全 Greeks(解析式,含股息率);标量输入,标量输出。

    单位契约(P8):
    - delta: 每 1 元标的价格变动的权利金变动(无量纲)
    - gamma: delta 对标的价格的二阶导(1/元)
    - vega:  每 1.0 波动率(100 个 vol 点)变动的权利金变动;``vegaPerVolPoint`` 为 ×0.01 口径
    - theta: **年化**;``thetaPerDay`` 为 ÷365 口径
    - rho:   每 1.0 利率(100bp)变动;``rhoPerBp`` 为 ×0.0001 口径

    ``years <= 0``(到期退化):price=内在价值,delta 按 ITM/OTM/ATM 三态(1/0/0.5),
    其余 Greeks 取 0——数学边界奇异,显式约定优于静默发散。
    """
    _validate_core(float(spot), float(strike), float(vol))
    t = float(years)
    s = float(spot)
    k = float(strike)
    r = float(rate)
    q = float(div_yield)
    sigma = float(vol)
    if t <= 0.0:
        itm = s > k
        atm = math.isclose(s, k, rel_tol=0.0, abs_tol=1e-12)
        delta = 0.5 if atm else (1.0 if itm == is_call else 0.0)
        intrinsic = max(s - k, 0.0) if is_call else max(k - s, 0.0)
        return {
            "price": intrinsic,
            "delta": delta,
            "gamma": 0.0,
            "vega": 0.0,
            "vegaPerVolPoint": 0.0,
            "theta": 0.0,
            "thetaPerDay": 0.0,
            "rho": 0.0,
            "rhoPerBp": 0.0,
        }
    sqrt_t = math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sigma * sigma) * t) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    disc_q = math.exp(-q * t)
    disc_r = math.exp(-r * t)
    pdf_d1 = norm_pdf(d1)
    gamma = disc_q * pdf_d1 / (s * sigma * sqrt_t)  # C/P 同式
    vega = s * disc_q * pdf_d1 * sqrt_t  # C/P 同式
    if is_call:
        delta = disc_q * norm_cdf(d1)
        theta = (
            -s * disc_q * pdf_d1 * sigma / (2.0 * sqrt_t)
            + q * s * disc_q * norm_cdf(d1)
            - r * k * disc_r * norm_cdf(d2)
        )
        rho = k * t * disc_r * norm_cdf(d2)
    else:
        delta = -disc_q * norm_cdf(-d1)
        theta = (
            -s * disc_q * pdf_d1 * sigma / (2.0 * sqrt_t)
            - q * s * disc_q * norm_cdf(-d1)
            + r * k * disc_r * norm_cdf(-d2)
        )
        rho = -k * t * disc_r * norm_cdf(-d2)
    return {
        "price": float(bs_price(s, k, t, r, q, sigma, is_call)),
        "delta": delta,
        "gamma": gamma,
        "vega": vega,
        "vegaPerVolPoint": vega * 0.01,
        "theta": theta,
        "thetaPerDay": theta / 365.0,
        "rho": rho,
        "rhoPerBp": rho * 0.0001,
    }


def implied_vol(
    price: float,
    spot: float,
    strike: float,
    years: float,
    rate: float,
    div_yield: float,
    is_call: bool,
    vol_lo: float = DEFAULT_VOL_LO,
    vol_hi: float = DEFAULT_VOL_HI,
    max_iter: int = DEFAULT_MAX_ITER,
    tol: float = DEFAULT_TOL,
) -> tuple[float | None, str]:
    """Brent 反解隐含波动率;返回 ``(iv, status)``。

    Statuses(P3 无解三分类,永不静默):
    - ``ok``               反解收敛,iv 为根
    - ``below-intrinsic``  市场价 < P(vol_lo)(vol 单调下界,常为深度实/虚值或价格错误)
    - ``above-upper-bound`` 市场价 > P(vol_hi)(超出区间上界理论价)
    - ``unconverged``      Brent 迭代用尽(守卫,正常参数下不触发)

    数学依据:vol→0 极限价 = e^{-rT}·max(±(F−K),0),F = S·e^{(r−q)T}——
    ``below-intrinsic`` 即价格低于折现远期内在价值,由 P7 单调性保证无解。
    """
    _validate_core(float(spot), float(strike), vol_lo)
    if years <= 0.0:
        return None, "unconverged"  # T=0 无信息可反解;显式不猜
    if not math.isfinite(price) or price <= 0.0:
        return None, "below-intrinsic"

    def f(v: float) -> float:
        return float(bs_price(spot, strike, years, rate, div_yield, v, is_call)) - price

    f_lo = f(vol_lo)
    f_hi = f(vol_hi)
    if f_lo > 0.0:
        return None, "below-intrinsic"
    if f_hi < 0.0:
        return None, "above-upper-bound"
    root, converged = _brentq(f, vol_lo, vol_hi, f_lo, f_hi, tol, max_iter)
    if not converged or not math.isfinite(root):
        return None, "unconverged"
    return root, "ok"


def _brentq(f, a, b, fa, fb, tol: float, max_iter: int) -> tuple[float, bool]:
    """Brent 求根(二分+割线+反二次插值组合;f(a)·f(b)<0 前置)。

    自实现而非引 scipy(P2):量小、可钉测试、无重依赖。
    """
    if fa == 0.0:
        return a, True
    if fb == 0.0:
        return b, True
    if abs(fa) < abs(fb):  # 令 b 为当前最优近似
        a, b, fa, fb = b, a, fb, fa
    c, fc = a, fa
    d = c
    mflag = True
    for _ in range(max_iter):
        if fb == 0.0 or abs(b - a) < tol:
            return b, True
        if fa != fc and fb != fc:
            # 反二次插值
            s = (
                a * fb * fc / ((fa - fb) * (fa - fc))
                + b * fa * fc / ((fb - fa) * (fb - fc))
                + c * fa * fb / ((fc - fa) * (fc - fb))
            )
        else:
            s = b - fb * (b - a) / (fb - fa)  # 割线
        cond_interp = (
            s < min((3.0 * a + b) / 4.0, b)
            or s > max((3.0 * a + b) / 4.0, b)
            or (mflag and abs(s - b) >= abs(b - c) / 2.0)
            or (not mflag and abs(s - b) >= abs(c - d) / 2.0)
            or (mflag and abs(b - c) < tol)
            or (not mflag and abs(c - d) < tol)
        )
        if cond_interp:
            s = (a + b) / 2.0
            mflag = True
        else:
            mflag = False
        fs = f(s)
        d = c
        c, fc = b, fb
        if fa * fs < 0.0:
            b, fb = s, fs
        else:
            a, fa = s, fs
        if abs(fa) < abs(fb):
            a, b, fa, fb = b, a, fb, fa
    return b, False


_ncdf = np.vectorize(norm_cdf, otypes=["float64"])
