# 合约静态表:underlyings(注册表)与 contracts(长代码/行权价/到期日/乘数/tick)。
#
# SSE:按到期月逐月调 board,行权价与代码取自行情面,到期日=第四个周三(算法生成)。
# SZSE:board 返回交易所静态表(合约单位/行权日/交收日),无行情——quotesSource=
# szse_static_only,本模块只取静态字段,行情缺口由 chain 显式 NO_DATA。
# synth:make_chain 的合约结构,含已摘牌月(幸存者偏差的样本形态)。

from datetime import date
from pathlib import Path
from typing import Any

import pandas as pd

from dsh_options import synth
from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying, load_registry

# SSE ETF 期权的标准月份序列:当月、次月、季月、隔季月
_SEASONAL_STEPS = (0, 1, 3, 6)
SNAPSHOT_COLUMNS = ["code", "optionType", "strike", "expiryMonth", "expiryDate", "multiplier"]


def handle_underlyings(request: dict[str, Any]) -> dict[str, Any]:
    """`underlyings` 子命令:返回注册表品种清单。

    Parameters
    ----------
    request : dict
        ``{source}``;source 为 ``synth | akshare | iquant``。

    Returns
    -------
    dict[str, Any]
        ``{source, rows, underlyings}``;underlyings 元素含
        underlying/exchange/boardName/name/multiplier/tickSize/quotesSource。
    """
    source = _require(request, "source")
    rows = load_registry(source)
    if not rows:
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")
    return {"source": source, "rows": len(rows), "underlyings": rows}


def handle_contracts(request: dict[str, Any], cache_dir: Path) -> dict[str, Any]:
    """`contracts` 子命令:合约静态表并落 parquet 快照。

    Parameters
    ----------
    request : dict
        ``{source, underlying?, expiryMonths?, asOfMonth?, forceRefresh?, cacheDir}``。
        akshare 缺省月份序列:asOfMonth(YYMM,缺省取本机当前月)起的标准四季月。
    cache_dir : Path
        缓存根目录。

    Returns
    -------
    dict[str, Any]
        ``{source, underlying|exchange, rows, contracts, cachePath}``。
    """
    source = _require(request, "source")
    force = bool(request.get("forceRefresh", False))
    if source == "synth":
        underlying = request.get("underlying", synth.SYNTH_UNDERLYING)
        if underlying != synth.SYNTH_UNDERLYING:
            raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
        chain = synth.make_chain()
        contracts = [
            {
                "code": c["code"],
                "optionType": c["optionType"],
                "strike": c["strike"],
                "expiryMonth": c["expiryMonth"],
                "expiryDate": c["expiryDate"],
                "multiplier": chain["multiplier"],
            }
            for c in chain["contracts"]
        ]
        path = _snapshot_path(cache_dir, "synth", underlying)
        _write_snapshot(path, contracts)
        return {
            "source": "synth",
            "underlying": underlying,
            "rows": len(contracts),
            "contracts": contracts,
            "cachePath": str(path),
        }

    if source == "iquant":
        underlying = _require(request, "underlying")
        row = find_underlying("iquant", underlying)
        if row is None:
            raise OptionsError(
                "BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings"
            )
        path = _snapshot_path(cache_dir, "iquant", underlying)
        if path.exists() and not force:
            return _contracts_response("iquant", underlying, _read_snapshot(path), path)
        from dsh_options import iquant

        raw = iquant.run_quote(
            "option_instruments",
            {"market": iquant.option_market_of(row), "underlying": underlying},
            request,
        )
        contracts = [
            {key: rec[key] for key in SNAPSHOT_COLUMNS} for rec in raw["instruments"]
        ]
        months = request.get("expiryMonths")
        if isinstance(months, list) and months:
            wanted = {str(month) for month in months}
            contracts = [item for item in contracts if item["expiryMonth"] in wanted]
        if not contracts:
            raise OptionsError("NO_DATA", f"no iquant contracts for {underlying}")
        _write_snapshot(path, contracts)
        return _contracts_response("iquant", underlying, contracts, path)

    if source != "akshare":
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")
    underlying = _require(request, "underlying")
    row = find_underlying("akshare", underlying)
    if row is None:
        raise OptionsError("BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings")
    path = _snapshot_path(cache_dir, "akshare", underlying)
    if path.exists() and not force:
        cached = _read_snapshot(path)
        return _contracts_response("akshare", underlying, cached, path)

    if row["quotesSource"] == "szse_static_only":
        contracts = _contracts_szse(row, request)
    else:
        contracts = _contracts_sse(row, request)
    _write_snapshot(path, contracts)
    return _contracts_response("akshare", underlying, contracts, path)


def _contracts_sse(row: dict[str, Any], request: dict[str, Any]) -> list[dict[str, Any]]:
    """上交所:逐月调 board,代码与行权价来自行情面,到期日算法生成。"""
    months = _resolve_months(request)
    from dsh_options.chain import fetch_board  # 延迟导入避免循环依赖

    contracts: list[dict[str, Any]] = []
    seen: set[str] = set()
    for month in months:
        try:
            board = fetch_board(row["boardName"], month)
        except OptionsError as err:
            if err.code == "NO_DATA":
                continue  # 该月无合约(非交易月/未上市):跳过并继续
            raise
        for rec in board:
            code = rec["code"]
            if code in seen:
                continue
            seen.add(code)
            contracts.append(
                {
                    "code": code,
                    "optionType": rec["optionType"],
                    "strike": rec["strike"],
                    "expiryMonth": month,
                    "expiryDate": synth.expiry_date_of(month).isoformat(),
                    "multiplier": row["multiplier"],
                }
            )
    if not contracts:
        raise OptionsError("NO_DATA", f"no SSE contracts for {row['underlying']} in {months}")
    return contracts


def _contracts_szse(row: dict[str, Any], request: dict[str, Any]) -> list[dict[str, Any]]:
    """深交所:board 返回静态表(无行情);按标的名称过滤本品种。"""
    import akshare as ak

    try:
        raw = ak.option_finance_board(
            symbol=row["boardName"], end_month=_resolve_months(request)[0]
        )
    except Exception as err:  # noqa: BLE001 - 第三方接口异常形态不稳定,统一收口
        raise OptionsError("NETWORK", f"szse static table fetch failed: {err}") from err
    if raw is None or raw.empty:
        raise OptionsError("NO_DATA", f"empty SZSE static table for {row['boardName']!r}")
    contracts: list[dict[str, Any]] = []
    for _, r in raw.iterrows():
        if str(r["标的名称"]) != row["name"]:
            continue
        contracts.append(
            {
                "code": str(r["合约编码"]),
                "optionType": "C" if str(r["类型"]) == "认购" else "P",
                "strike": float(r["行权价"]),
                "expiryMonth": str(r["期权行权日"])[:7].replace("-", "")[2:],
                "expiryDate": str(r["期权行权日"]),
                "multiplier": int(r["合约单位"]),
            }
        )
    if not contracts:
        raise OptionsError("NO_DATA", f"no SZSE contracts for {row['name']} in static table")
    return contracts


def _resolve_months(request: dict[str, Any]) -> list[str]:
    """显式 expiryMonths 优先;否则从 asOfMonth(缺省本机当前月)生成标准四季月。"""
    explicit = request.get("expiryMonths")
    if isinstance(explicit, list) and explicit:
        return [str(m) for m in explicit]
    base = str(request.get("asOfMonth") or date.today().strftime("%y%m"))
    year, month = int(base[:2]), int(base[2:])
    months: list[str] = []
    for step in _SEASONAL_STEPS:
        total = year * 12 + (month - 1) + step
        months.append(f"{total // 12:02d}{total % 12 + 1:02d}")
    return months


def _snapshot_path(cache_dir: Path, source: str, underlying: str) -> Path:
    if "/" in underlying:
        raise OptionsError("BAD_REQUEST", f"path separators not allowed: {underlying!r}")
    return cache_dir / "contracts" / source / f"{underlying}.parquet"


def _write_snapshot(path: Path, contracts: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(contracts, columns=SNAPSHOT_COLUMNS).to_parquet(path, index=False)


def _read_snapshot(path: Path) -> list[dict[str, Any]]:
    df = pd.read_parquet(path)
    if list(df.columns) != SNAPSHOT_COLUMNS:
        raise OptionsError("INTERNAL", f"contracts snapshot {path} has unexpected columns")
    return df.to_dict(orient="records")


def _contracts_response(
    source: str, underlying: str, contracts: list[dict[str, Any]], path: Path
) -> dict[str, Any]:
    return {
        "source": source,
        "underlying": underlying,
        "rows": len(contracts),
        "contracts": contracts,
        "cachePath": str(path),
    }


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value
