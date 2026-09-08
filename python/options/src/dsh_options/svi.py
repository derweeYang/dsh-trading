# 到期月 Raw SVI:`volsurface` 校准同日中点 IV。残差与套利条件只打标,
# 不改写 implied_vol 行。SSVI / 日历套利不在本模块。

from __future__ import annotations

import math
from typing import Any

import numpy as np

from dsh_options.protocol import OptionsError

MIN_SVI_KNOTS = 5
SVI_METHOD = "raw-svi"


def raw_svi_smile(
    mids: dict[float, float],
    *,
    spot: float,
    years: float,
    rate: float,
    dividend_yield: float,
) -> dict[str, Any]:
    """对 (K, mid-IV) 做 Raw SVI;`w(k)=a+b[ρ(k−m)+√((k−m)²+σ²)]`,k=ln(K/F)。

    Parameters
    ----------
    mids : dict[float, float]
        已收敛 C/P 平均后的行权价 → 中点 IV。
    spot, years, rate, dividend_yield : float
        与 BSM 同一组输入;`F = S·e^{(r−q)T}`。

    Returns
    -------
    dict[str, Any]
        ``status/method/nKnots`` 及成功时的 params、残差、ATM 拟合 IV。
        少于 5 档、清洗后不足或优化器未收敛时 ``insufficient``。
    """
    empty: dict[str, Any] = {
        "status": "insufficient",
        "method": SVI_METHOD,
        "nKnots": len(mids),
        "maxAbsResidual": None,
        "rmse": None,
        "atmIvFitted": None,
        "forward": None,
        "params": None,
        "knots": [],
        "arbViolations": [],
    }
    if years <= 0.0 or spot <= 0.0:
        empty["reason"] = "need positive spot and years"
        return empty
    if len(mids) < MIN_SVI_KNOTS:
        empty["reason"] = "need at least 5 distinct mid-IV strikes"
        return empty

    forward = float(spot * math.exp((rate - dividend_yield) * years))
    if forward <= 0.0:
        empty["reason"] = "non-positive forward"
        return empty

    strikes_list = sorted(mids)
    strikes = np.asarray(strikes_list, dtype=np.float64)
    ivs = np.asarray([mids[key] for key in strikes_list], dtype=np.float64)
    try:
        from volsurface.market_data.cleaning import clean_chain
        from volsurface.models import RawSVI
    except ImportError as err:
        raise OptionsError("INTERNAL", "volsurface is required for Raw SVI") from err

    try:
        slice_ = clean_chain(
            strikes, ivs, expiry_years=years, forward=forward, spot=spot, rate=rate
        )
    except ValueError as err:
        empty["forward"] = forward
        empty["reason"] = str(err)
        return empty

    if slice_.n_strikes < MIN_SVI_KNOTS:
        empty["nKnots"] = int(slice_.n_strikes)
        empty["forward"] = forward
        empty["reason"] = "need at least 5 distinct mid-IV strikes after cleaning"
        return empty

    model = RawSVI()
    result = model.fit(slice_)
    if not result.success:
        empty["nKnots"] = int(slice_.n_strikes)
        empty["forward"] = forward
        empty["reason"] = result.message or "Raw SVI optimiser did not converge"
        return empty

    fitted = np.asarray(model.iv(slice_.log_moneyness), dtype=np.float64)
    resid = np.abs(fitted - slice_.ivs)
    atm_k = math.log(spot / forward)
    atm = float(np.asarray(model.iv(atm_k)).reshape(-1)[0])
    params = {
        name: float(result.params[name]) for name in ("a", "b", "rho", "m", "sigma")
    }
    knots = [
        {"strike": float(strike), "iv": float(iv), "fittedIv": float(fit)}
        for strike, iv, fit in zip(slice_.strikes, slice_.ivs, fitted, strict=True)
    ]
    return {
        "status": "ok",
        "method": SVI_METHOD,
        "nKnots": int(slice_.n_strikes),
        "maxAbsResidual": float(resid.max()),
        "rmse": float(result.rmse),
        "atmIvFitted": atm,
        "forward": forward,
        "params": params,
        "knots": knots,
        "arbViolations": list(model.params.check_no_arbitrage()),
    }
