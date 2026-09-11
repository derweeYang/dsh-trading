from __future__ import annotations

from typing import Any, Protocol

from dsh_iquant_quote.errors import QuoteGatewayError
from dsh_iquant_quote.symbols import parse_symbol


class QuoteBackend(Protocol):
    def ticker(self, market: str, code: str) -> dict[str, Any]: ...
    def klines(
        self, market: str, code: str, interval: str, limit: int
    ) -> list[dict[str, Any]]: ...
    def instruments(self, market: str) -> list[dict[str, Any]]: ...
    def snapshot(self, market: str, symbols: list[str]) -> list[dict[str, Any]]: ...
    def history_bars(
        self,
        market: str,
        symbol: str,
        start_ms: int,
        end_ms: int,
        limit: int,
        period_ms: int = 86_400_000,
    ) -> list[dict[str, Any]]: ...
    def option_chain(
        self,
        market: str,
        underlying: str,
        expiry_month: str,
        atm_focus: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...
    def option_instruments(
        self, market: str, underlying: str
    ) -> list[dict[str, Any]]: ...


class QuoteService:
    def __init__(self, backend: QuoteBackend) -> None:
        self.backend = backend

    def ticker(self, symbol: str) -> dict[str, Any]:
        parsed = parse_symbol(symbol)
        row = self.backend.ticker(parsed.market, parsed.code)
        return {**row, "symbol": parsed.symbol}

    def klines(
        self, symbol: str, interval: str = "1d", limit: int = 100
    ) -> dict[str, Any]:
        parsed = parse_symbol(symbol)
        bars = self.backend.klines(parsed.market, parsed.code, interval, limit)
        return {"symbol": parsed.symbol, "bars": bars}

    def instruments(self, market: str) -> dict[str, Any]:
        token = (market or "").strip().upper()
        if token not in {"SH", "SZ", "BJ", "HK", "SHO", "SZO"}:
            raise QuoteGatewayError("BAD_REQUEST", f"unknown market {market!r}")
        return {"market": token, "instruments": self.backend.instruments(token)}

    def handle_command(self, command: str, body: dict[str, Any]) -> dict[str, Any]:
        if command == "snapshot":
            market = str(body.get("market") or "")
            symbols = list(body.get("symbols") or [])
            return {"snapshots": self.backend.snapshot(market, symbols)}
        if command == "history_bars":
            market = str(body.get("market") or "")
            symbol = str(body.get("symbol") or "")
            return {
                "bars": self.backend.history_bars(
                    market,
                    symbol,
                    int(body.get("startMs") or 0),
                    int(body.get("endMs") or 0),
                    int(body.get("limit") or 100),
                )
            }
        if command == "option_chain":
            focus = _parse_atm_focus(body.get("atmFocus"))
            # 缺省不传 atm_focus 关键字：不带收窄参数的旧 backend 实现仍可全链服务。
            return self.backend.option_chain(
                str(body.get("market") or ""),
                str(body.get("underlying") or ""),
                str(body.get("expiryMonth") or ""),
                **({} if focus is None else {"atm_focus": focus}),
            )
        if command == "option_instruments":
            return {
                "instruments": self.backend.option_instruments(
                    str(body.get("market") or ""),
                    str(body.get("underlying") or ""),
                )
            }
        raise QuoteGatewayError("BAD_REQUEST", f"unknown subcommand {command!r}")


def _parse_atm_focus(raw: Any) -> dict[str, Any] | None:
    """``atmFocus`` 请求体 → ``{"spot": float, "strikes": int}``；缺省 None（全链）。"""
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise QuoteGatewayError("BAD_REQUEST", f"atmFocus must be an object: {raw!r}")
    spot = raw.get("spot")
    strikes = raw.get("strikes")
    if not isinstance(spot, (int, float)) or isinstance(spot, bool) or spot <= 0:
        raise QuoteGatewayError(
            "BAD_REQUEST", f"atmFocus.spot must be a positive number: {spot!r}"
        )
    if (
        not isinstance(strikes, int)
        or isinstance(strikes, bool)
        or not 1 <= strikes <= 10
    ):
        raise QuoteGatewayError(
            "BAD_REQUEST", f"atmFocus.strikes must be an integer in 1..10: {strikes!r}"
        )
    return {"spot": float(spot), "strikes": strikes}
