import pytest

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.symbols import parse_symbol


def test_parse_cash_and_option_markets():
    assert parse_symbol("510050.SH").market == "SH"
    assert parse_symbol("510050").market == "SH"
    assert parse_symbol("000001.SZ").code == "000001"
    assert parse_symbol("10011255.SHO").market == "SHO"
    assert parse_symbol("10011255").market == "SHO"
    assert parse_symbol("90007051").market == "SZO"


def test_reject_long_option_code():
    with pytest.raises(QuoteGatewayError) as err:
        parse_symbol("510050C2609M02850")
    assert err.value.code == "BAD_REQUEST"
