from __future__ import annotations

from dataclasses import dataclass
import re

from dsh_iquant_quote.errors import QuoteGatewayError

LONG_OPTION = re.compile(r"^\d{6}[CP]\d{4}M\d{5}$", re.IGNORECASE)
DOTTED = re.compile(r"^(\d{6,8})\.(SH|SZ|BJ|HK|SHO|SZO)$", re.IGNORECASE)
PREFIXED = re.compile(r"^(SH|SZ|BJ|HK|SHO|SZO)(\d{6,8})$", re.IGNORECASE)


@dataclass(frozen=True)
class ParsedSymbol:
    market: str
    code: str

    @property
    def symbol(self) -> str:
        return f"{self.code}.{self.market}"


def parse_symbol(raw: str) -> ParsedSymbol:
    text = (raw or "").strip().upper()
    if not text:
        raise QuoteGatewayError("BAD_REQUEST", "symbol is required")
    if LONG_OPTION.match(text):
        raise QuoteGatewayError(
            "BAD_REQUEST",
            f"long option code {raw!r} is not a quote primary key; map to 100xxxxx.SHO / 900xxxxx.SZO first",
        )
    dotted = DOTTED.match(text)
    if dotted:
        return ParsedSymbol(dotted.group(2).upper(), dotted.group(1))
    prefixed = PREFIXED.match(text)
    if prefixed:
        return ParsedSymbol(prefixed.group(1).upper(), prefixed.group(2))
    if text.isdigit() and len(text) == 8:
        if text.startswith("100"):
            return ParsedSymbol("SHO", text)
        if text.startswith("900"):
            return ParsedSymbol("SZO", text)
        raise QuoteGatewayError("BAD_REQUEST", f"unknown 8-digit symbol {raw!r}")
    if text.isdigit() and len(text) == 6:
        return ParsedSymbol(_infer_cash_market(text), text)
    raise QuoteGatewayError("BAD_REQUEST", f"unsupported symbol {raw!r}")


def _infer_cash_market(code: str) -> str:
    if code.startswith(("6", "5", "9")):
        return "SH"
    if code.startswith(("0", "1", "3")):
        return "SZ"
    if code.startswith(("4", "8")):
        return "BJ"
    raise QuoteGatewayError("BAD_REQUEST", f"cannot infer market for {code}")
