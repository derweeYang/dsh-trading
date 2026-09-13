"""国信期权合约简称 → 标的 / 涨跌 / 到期月 / 行权价 / 长代码。

live 样例（2026-09-08）：`50ETF购9月2650`、`深证100ETF购9月3100`。
行情主键仍是短码 + SHO/SZO；长代码只给期权内核当规范 code。
"""

from __future__ import annotations

import calendar
import re
from dataclasses import dataclass
from datetime import date


NAME_RE = re.compile(
    r"^(?P<alias>.+?)(?P<cp>购|沽)(?:(?P<yy>\d{2})年)?(?P<month>\d{1,2})月(?P<strike>\d+)$"
)

# 长别名在前，避免「科创50ETF」抢「易方达科创50ETF」。
# 国信 SHO 实际简称（2026-09-11 全表抓取）：50ETF/300ETF/500ETF/科创50(588000)/
# 科创板50(588080，易方达)。带四位年份（如「科创50购2026年4月1100」）的是已摘牌
# 合约，NAME_RE 有意不解析，作为活跃链的天然过滤器。
# 2026-09-13 起 510300/510500 移出标的名册，其别名（沪深300ETF/300ETF/中证500ETF/
# 500ETF 等）一并下架：解析不到 underlying 即不入活跃链。深市 159919/159922 不受影响。
SHO_ALIASES: tuple[tuple[str, str], ...] = (
    ("华夏上证50ETF", "510050"),
    ("华夏科创50ETF", "588000"),
    ("易方达科创50ETF", "588080"),
    ("上证50ETF", "510050"),
    ("科创50ETF", "588000"),
    ("科创50", "588000"),
    ("科创板50", "588080"),
    ("50ETF", "510050"),
)

SZO_ALIASES: tuple[tuple[str, str], ...] = (
    ("创业板ETF易方达", "159915"),
    ("深证100ETF易方达", "159901"),
    ("嘉实沪深300ETF", "159919"),
    ("嘉实中证500ETF", "159922"),
    ("创业板ETF", "159915"),
    ("深证100ETF", "159901"),
    ("沪深300ETF", "159919"),
    ("中证500ETF", "159922"),
)

ALIASES = {"SHO": SHO_ALIASES, "SZ": SHO_ALIASES, "SZO": SZO_ALIASES}


@dataclass(frozen=True)
class ParsedOptionName:
    underlying: str
    option_type: str
    expiry_month: str
    expiry_date: str
    strike: float
    long_code: str


def fourth_wednesday(year: int, month: int) -> date:
    wednesdays = [
        day
        for day in calendar.Calendar(firstweekday=0).itermonthdates(year, month)
        if day.month == month and day.weekday() == 2
    ]
    if len(wednesdays) < 4:
        raise ValueError(f"month {year}-{month:02d} has no fourth Wednesday")
    return wednesdays[3]


def infer_expiry_month(month: int, as_of: date, year_yy: int | None) -> str:
    if year_yy is not None:
        year = 2000 + year_yy
    else:
        year = as_of.year
        if as_of > fourth_wednesday(year, month):
            year += 1
    return f"{year % 100:02d}{month:02d}"


def _alias_underlying(alias: str, market: str) -> str | None:
    for prefix, underlying in ALIASES.get(market.upper(), ()):
        if alias == prefix:
            return underlying
    return None


def parse_option_name(
    name: str, *, market: str, as_of: date | None = None
) -> ParsedOptionName | None:
    text = (name or "").strip()
    match = NAME_RE.match(text)
    if match is None:
        return None
    underlying = _alias_underlying(match.group("alias"), market)
    if underlying is None:
        return None
    option_type = "C" if match.group("cp") == "购" else "P"
    month = int(match.group("month"))
    if month < 1 or month > 12:
        return None
    year_raw = match.group("yy")
    year_yy = int(year_raw) if year_raw else None
    as_of = as_of or date.today()
    expiry_month = infer_expiry_month(month, as_of, year_yy)
    century = as_of.year - (as_of.year % 100)
    year = century + int(expiry_month[:2])
    expiry = fourth_wednesday(year, int(expiry_month[2:]))
    strike = int(match.group("strike")) / 1000.0
    scaled = round(strike * 1000)
    long_code = f"{underlying}{option_type}{expiry_month}M{scaled:05d}"
    return ParsedOptionName(
        underlying=underlying,
        option_type=option_type,
        expiry_month=expiry_month,
        expiry_date=expiry.isoformat(),
        strike=strike,
        long_code=long_code,
    )
