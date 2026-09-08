# 固定种子合成期权链:离线测试与无网络冒烟的数据底座。
#
# 合成链不模拟真实市场事实,但刻意保留三类结构特征供下游测试:
# 1) 已摘牌合约(序列止于到期日)——O6 幸存者偏差的样本形态;
# 2) 平价违反合约(call 价格加 5% 偏移)——O2 parity_check 的靶子;
# 3) 价格基本性质(Call 随行权价非增、内在价值下界、C-P 平价)。

import calendar
import functools
import math
import re
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

SYNTH_UNDERLYING = "910050"
SYNTH_MULTIPLIER = 10000
SYNTH_START_PRICE = 3.0
# 权利金 tick 下限:深度虚值到期时 BSM 数值价可为 0,真实市场最低报价为一个 tick
TICK_FLOOR = 0.0001
LONG_CODE_RE = re.compile(r"^(\d{6})([CP])(\d{4})M(\d{5})$")


def fourth_wednesday(year: int, month: int) -> date:
    """A股 ETF 期权到期日:到期月份的第四个星期三(上交所/深交所同规则)。

    2026-09 → 2026-09-23,与深交所静态表实测一致。
    """
    wednesdays = [
        d
        for d in calendar.Calendar(firstweekday=0).itermonthdates(year, month)
        if d.month == month and d.weekday() == 2
    ]
    if len(wednesdays) < 4:
        raise ValueError(f"month {year}-{month:02d} has no fourth Wednesday")
    return wednesdays[3]


def expiry_date_of(expiry_month: str) -> date:
    """到期月 ``YYMM``/``YYYYMM`` → 第四个周三日期。"""
    month = _normalize_month(expiry_month)
    return fourth_wednesday(month // 100, month % 100)


def make_long_code(underlying: str, option_type: str, expiry_month: str, strike: float) -> str:
    """组装标准长代码:``910050C2609M02850``(strike × 1000 取整为 5 位)。"""
    month = _normalize_month(expiry_month)
    scaled = round(strike * 1000)
    if abs(scaled - strike * 1000) > 1e-9:
        raise ValueError(f"strike {strike!r} is not on a 0.001 grid")
    if option_type not in ("C", "P"):
        raise ValueError(f"option_type must be 'C' or 'P', got {option_type!r}")
    return f"{underlying}{option_type}{month % 10000:04d}M{scaled:05d}"


def parse_long_code(code: str) -> dict[str, Any]:
    """解析长代码 → ``{underlying, optionType, expiryMonth(YYMM), strike}``。"""
    match = LONG_CODE_RE.match(code)
    if match is None:
        raise ValueError(f"not a long option code: {code!r}")
    underlying, option_type, month, scaled = match.groups()
    return {
        "underlying": underlying,
        "optionType": option_type,
        "expiryMonth": month,
        "strike": int(scaled) / 1000.0,
    }


def norm_cdf(x):
    """标准正态 CDF(math.erf 实现,synth 内联定价用)。"""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def bs_price(spot, strike, years, rate, sigma, is_call):
    """欧式 BSM 定价(现货无股息);向量化 or 标量皆可输入。

    synth 数据生成专用;O2 的正式定价内核(容差/错误处理/契约)另行实现。
    years <= 0 时退化为内在价值。
    """
    spot = np.asarray(spot, dtype="float64")
    strike = float(strike)
    years = np.asarray(years, dtype="float64")
    sigma = float(sigma)
    intrinsic = np.maximum(spot - strike, 0.0) if is_call else np.maximum(strike - spot, 0.0)
    live = years > 0.0
    if not np.any(live):
        return intrinsic
    t_live = np.where(live, years, 1.0)  # 防 log/除零,死值随后覆盖
    sqrt_t = np.sqrt(t_live)
    d1 = (np.log(spot / strike) + (rate + 0.5 * sigma * sigma) * t_live) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    disc = np.exp(-rate * t_live)
    if is_call:
        price = spot * _ncdf(d1) - strike * disc * _ncdf(d2)
    else:
        price = strike * disc * _ncdf(-d2) - spot * _ncdf(-d1)
    return np.where(live, price, intrinsic)


# np.vectorize 包装的标量正态 CDF:bs_price 内部逐元素调用
_ncdf = np.vectorize(norm_cdf, otypes=["float64"])


def _normalize_month(expiry_month: str) -> int:
    """``'2609'``/``'202609'`` → 202609;非法输入 ValueError。"""
    text = str(expiry_month).strip()
    if len(text) == 4:
        text = f"20{text}"
    if not text.isdigit() or len(text) != 6:
        raise ValueError(f"invalid expiry month: {expiry_month!r}")
    return int(text)


@functools.lru_cache(maxsize=1)
def make_chain_cached() -> dict[str, Any]:
    """默认参数链的进程级只读缓存(O2 起 pricing/分析层高频复用)。

    契约:**返回对象共享,调用方只读不得修改**(DataFrame 一旦被改动会污染
    全进程后续读者)。需要可变副本或非默认参数时用 :func:`make_chain`。
    """
    return make_chain()


def make_chain(
    n_days: int = 120,
    seed: int = 42,
    start_price: float = SYNTH_START_PRICE,
    start_date: str = "2026-05-06",
    strike_step: float = 0.05,
    n_strikes: int = 9,
    expiry_months: tuple[str, ...] = ("2609", "2612"),
    delisted_month: str | None = "2606",
    parity_violation: bool = True,
    parity_strike: float | None = None,
    rate: float = 0.02,
    vol: float = 0.20,
) -> dict[str, Any]:
    """生成合成 ETF 期权链(标的日线 + 全部合约的逐日价格)。

    Parameters
    ----------
    n_days : int
        合成交易日数量(自然日历按工作日推进)。
    seed : int
        随机种子;同参数同种子输出逐字节稳定。
    start_price : float
        标的起始价(元)。
    start_date : str
        首个合成交易日。
    strike_step, n_strikes : float, int
        行权价网格:围绕 start_price 取整档居中,``n_stikes`` 档(奇数居中对称)。
    expiry_months : tuple[str, ...]
        活跃合约到期月(YYMM)。
    delisted_month : str | None
        已摘牌合约的到期月;其价格序列止于到期日,用于覆盖到期摘牌形态。
    parity_violation : bool
        是否制造平价违反合约(近月指定行权价的 call +5% 偏移)。
    parity_strike : float | None
        制造违反的行权价;None 表示用居中档。仅在 parity_violation 为真时生效。
    rate, vol : float
        定价用的无风险利率与波动率(合成值,非市场事实)。

    Returns
    -------
    dict[str, Any]
        ``{underlying, multiplier, spot: DataFrame[date,close],
        contracts: [{code, optionType, strike, expiryMonth, expiryDate,
        delisted, parityViolation, daily: DataFrame[date,open,high,low,close,volume]}]}``。
    """
    if n_days < 10:
        raise ValueError(f"n_days must be >= 10, got {n_days}")
    if n_strikes < 3 or n_strikes % 2 == 0:
        raise ValueError(f"n_strikes must be odd and >= 3, got {n_strikes}")
    if start_price <= 0 or strike_step <= 0:
        raise ValueError("start_price and strike_step must be positive")
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range(start=start_date, periods=n_days)

    # 标的日线:几何随机游走(同 dsh_quant.synth 思路)
    log_returns = rng.normal(0.0002, 0.012, size=n_days)
    spot_close = start_price * np.exp(np.cumsum(log_returns))
    spot = pd.DataFrame({"date": dates, "close": spot_close})

    center = round(start_price / strike_step) * strike_step
    half = (n_strikes - 1) // 2
    strikes = [round(center + (i - half) * strike_step, 4) for i in range(n_strikes)]
    if parity_strike is None:
        parity_strike = round(center, 4)
    elif not any(abs(s - parity_strike) < 1e-9 for s in strikes):
        raise ValueError(f"parity_strike {parity_strike!r} is not on the strike grid")

    months = [("活跃", m) for m in expiry_months]
    if delisted_month is not None:
        months.insert(0, ("摘牌", delisted_month))

    contracts: list[dict[str, Any]] = []
    for kind, month in months:
        expiry = expiry_date_of(month)
        for option_type in ("C", "P"):
            for strike in strikes:
                daily = _contract_daily(
                    dates,
                    spot_close,
                    strike,
                    expiry,
                    rate,
                    vol,
                    is_call=(option_type == "C"),
                    rng=rng,
                )
                code = make_long_code(SYNTH_UNDERLYING, option_type, month, strike)
                violates = (
                    parity_violation
                    and kind == "活跃"
                    and month == expiry_months[0]
                    and option_type == "C"
                    and strike == parity_strike
                )
                if violates:
                    # 偏移同步作用于全部价格列,保持 high >= close >= low 的内部一致
                    for column in ("open", "high", "low", "close"):
                        daily[column] = (daily[column] * 1.05).round(4)
                contracts.append(
                    {
                        "code": code,
                        "optionType": option_type,
                        "strike": strike,
                        "expiryMonth": month,
                        "expiryDate": expiry.isoformat(),
                        "delisted": kind == "摘牌",
                        "parityViolation": violates,
                        "daily": daily,
                    }
                )
    return {
        "underlying": SYNTH_UNDERLYING,
        "multiplier": SYNTH_MULTIPLIER,
        "spot": spot,
        "contracts": contracts,
    }


def _contract_daily(
    dates: pd.DatetimeIndex,
    spot_close: np.ndarray,
    strike: float,
    expiry: date,
    rate: float,
    vol: float,
    is_call: bool,
    rng: np.random.Generator,
) -> pd.DataFrame:
    """单合约逐日 OHLCV:close 为 BSM 价(T 随自然日衰减),到期日后不再有行。"""
    as_dates = dates.date
    kept = [i for i, d in enumerate(as_dates) if d <= expiry]
    idx = np.array(kept, dtype="int64")
    remaining = np.array([(expiry - as_dates[i]).days for i in kept], dtype="float64")
    years = np.maximum(remaining / 365.0, 0.0)
    close = np.maximum(bs_price(spot_close[idx], strike, years, rate, vol, is_call), TICK_FLOOR)
    prev_close = np.concatenate(([close[0]], close[:-1]))
    wick = np.abs(rng.normal(0.0, 0.0004, size=len(idx))) * close
    # 钳制保证 OHLC 内部一致:深度虚值到期时 BSM 价可数值归零,统一托到 tick 下限
    high = np.maximum(prev_close, close) + wick
    low = np.clip(np.minimum(prev_close, close) - wick, TICK_FLOOR, np.minimum(prev_close, close))
    volume = rng.integers(1_000, 200_000, size=len(idx))
    return pd.DataFrame(
        {
            "date": dates[idx],
            "open": prev_close,
            "high": high,
            "low": low,
            "close": close,
            "volume": volume.astype("int64"),
        }
    )
