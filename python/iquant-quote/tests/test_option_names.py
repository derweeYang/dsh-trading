"""国信合约简称 → 长代码 / 到期月。live 样例：50ETF购9月2650、深证100ETF购9月3100。"""

from datetime import date

import pytest

from dsh_iquant_quote.option_names import parse_option_name


def test_parse_sse_50etf_call():
    parsed = parse_option_name("50ETF购9月2650", market="SHO", as_of=date(2026, 9, 8))
    assert parsed is not None
    assert parsed.underlying == "510050"
    assert parsed.option_type == "C"
    assert parsed.expiry_month == "2609"
    assert parsed.strike == pytest.approx(2.65)
    assert parsed.long_code == "510050C2609M02650"
    assert parsed.expiry_date == "2026-09-23"


def test_parse_szse_chinext_put():
    parsed = parse_option_name(
        "创业板ETF沽9月3000", market="SZO", as_of=date(2026, 9, 8)
    )
    assert parsed is not None
    assert parsed.underlying == "159915"
    assert parsed.option_type == "P"
    assert parsed.expiry_month == "2609"
    assert parsed.strike == pytest.approx(3.0)
    assert parsed.long_code == "159915P2609M03000"


def test_parse_szse_100etf_call():
    parsed = parse_option_name(
        "深证100ETF购9月3100", market="SZO", as_of=date(2026, 9, 8)
    )
    assert parsed is not None
    assert parsed.underlying == "159901"
    assert parsed.long_code == "159901C2609M03100"


def test_month_without_year_rolls_to_next_year_after_expiry():
    parsed = parse_option_name("50ETF购9月2650", market="SHO", as_of=date(2026, 9, 24))
    assert parsed is not None
    assert parsed.expiry_month == "2709"


def test_explicit_year_in_name():
    parsed = parse_option_name(
        "50ETF购27年3月2800", market="SHO", as_of=date(2026, 9, 8)
    )
    assert parsed is not None
    assert parsed.expiry_month == "2703"
    assert parsed.long_code == "510050C2703M02800"


def test_reject_unknown_alias():
    assert (
        parse_option_name("沪深300股指购9月4000", market="SHO", as_of=date(2026, 9, 8))
        is None
    )


def test_50etf_does_not_steal_500etf():
    parsed = parse_option_name("500ETF购9月7000", market="SHO", as_of=date(2026, 9, 8))
    assert parsed is not None
    assert parsed.underlying == "510500"


def test_parse_star50_588080_by_guosen_alias():
    # 国信 SHO 全表里 588080（易方达）的简称是「科创板50」，不是「易方达科创50ETF」。
    parsed = parse_option_name(
        "科创板50购9月1600", market="SHO", as_of=date(2026, 9, 11)
    )
    assert parsed is not None
    assert parsed.underlying == "588080"
    assert parsed.option_type == "C"
    assert parsed.expiry_month == "2609"
    assert parsed.strike == pytest.approx(1.6)
    assert parsed.long_code == "588080C2609M01600"

    put = parse_option_name("科创板50沽9月1600", market="SHO", as_of=date(2026, 9, 11))
    assert put is not None
    assert put.underlying == "588080"
    assert put.option_type == "P"


def test_star50_alias_does_not_steal_588000():
    # 「科创50」仍是华夏 588000；两条科创别名不得互换。
    parsed = parse_option_name("科创50购9月1300", market="SHO", as_of=date(2026, 9, 11))
    assert parsed is not None
    assert parsed.underlying == "588000"


def test_delisted_four_digit_year_name_is_rejected():
    # 已摘牌合约带四位年份，NAME_RE 有意不解析，挡在活跃链外。
    assert (
        parse_option_name(
            "科创50购2026年4月1100", market="SHO", as_of=date(2026, 9, 11)
        )
        is None
    )
