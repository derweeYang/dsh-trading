# CLI 薄壳:argv 选子命令,stdin 读 JSON 请求,stdout 写一行 JSON 响应。
# 业务逻辑在 contracts/chain/daily/underlying_daily/vol_analytics/pricing/strategy
# 模块,这里只做 IO 与分发。

import argparse
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from dsh_options import chain, contracts, daily, pricing, strategy, underlying_daily, vol_analytics
from dsh_options.protocol import OptionsError, run_cli


def _require_dir(request: dict[str, Any], key: str) -> Path:
    """取必填目录字段;TS 侧 resolve 步骤负责绝对化与默认值。"""
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return Path(value)


def _handle_underlyings(request: dict[str, Any]) -> dict[str, Any]:
    return contracts.handle_underlyings(request)


def _handle_contracts(request: dict[str, Any]) -> dict[str, Any]:
    return contracts.handle_contracts(request, _require_dir(request, "cacheDir"))


def _handle_chain(request: dict[str, Any]) -> dict[str, Any]:
    return chain.handle_chain(request)


def _handle_fetch_daily(request: dict[str, Any]) -> dict[str, Any]:
    return daily.handle_fetch_daily(request, _require_dir(request, "cacheDir"))


def _handle_fetch_underlying_daily(request: dict[str, Any]) -> dict[str, Any]:
    return underlying_daily.handle_fetch_underlying_daily(
        request, _require_dir(request, "cacheDir")
    )


def _handle_price(request: dict[str, Any]) -> dict[str, Any]:
    return pricing.handle_price(request)


def _handle_implied_vol(request: dict[str, Any]) -> dict[str, Any]:
    return pricing.handle_implied_vol(request)


def _handle_parity_check(request: dict[str, Any]) -> dict[str, Any]:
    return pricing.handle_parity_check(request)


def _handle_fetch_underlying_daily(request: dict[str, Any]) -> dict[str, Any]:
    return underlying_daily.handle_fetch_underlying_daily(
        request, _require_dir(request, "cacheDir")
    )


def _handle_vol_analytics(request: dict[str, Any]) -> dict[str, Any]:
    return vol_analytics.handle_vol_analytics(request, _require_dir(request, "cacheDir"))


def _handle_strategy(request: dict[str, Any]) -> dict[str, Any]:
    return strategy.handle_strategy(request, _require_dir(request, "cacheDir"))


HANDLERS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "underlyings": _handle_underlyings,
    "contracts": _handle_contracts,
    "chain": _handle_chain,
    "fetch_daily": _handle_fetch_daily,
    "fetch_underlying_daily": _handle_fetch_underlying_daily,
    "vol_analytics": _handle_vol_analytics,
    "price": _handle_price,
    "implied_vol": _handle_implied_vol,
    "parity_check": _handle_parity_check,
    "strategy": _handle_strategy,
}


def main(argv: list[str] | None = None) -> int:
    """入口:解析 argv 上的子命令并交给协议分发框架。"""
    parser = argparse.ArgumentParser(prog="dsh-options")
    parser.add_argument("subcommand", choices=sorted(HANDLERS))
    args = parser.parse_args(argv)
    return run_cli(args.subcommand, HANDLERS)


if __name__ == "__main__":
    sys.exit(main())
