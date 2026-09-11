# T 型报价:单标的单到期月的 calls/puts 按行权价对齐,交易所快照时间戳透传。
#
# SSE:akshare option_finance_board(上交所官方接口),快照时间按 Asia/Shanghai 解析。
# SZSE:akshare 无行情面(quotesSource=szse_static_only)→ 显式 NO_DATA,不编造。
# iquant:经 dsh-iquant-quote option_chain。默认 source=synth;live 时合约市场是
# SHO/SZO(不是 SH/SZ)。2026-09-08:SH 订 100xxxxx 空;SHO 名单 12416、日 K 通。
# synth:合成链的末行截面,snapshotAt 为合成窗口末日(证明管线,不证明市场事实)。

from datetime import datetime
from pathlib import Path
from typing import Any

from dsh_options import synth
from dsh_options.protocol import OptionsError
from dsh_options.registry import find_underlying


def handle_chain(request: dict[str, Any], cache_dir: Path | None = None) -> dict[str, Any]:
    """`chain` 子命令:T 型报价快照。

    Parameters
    ----------
    request : dict
        ``{source, underlying, expiryMonth}``;source 为 ``synth | akshare | iquant``。
    cache_dir : Path, optional
        预留(cache-first 快照在 O1 不落盘,行情以交易所快照为准)。

    Returns
    -------
    dict[str, Any]
        ``{source, underlying, expiryMonth, expiryDate, snapshotAt,
        calls, puts}``;calls/puts 按行权价升序,元素含
        code/strike/last/changePct/prevSettle(akshare)或 code/strike/last/prevSettle/volume(synth)。
    """
    source = _require(request, "source")
    underlying = _require(request, "underlying")
    month = _require(request, "expiryMonth")
    if source == "synth":
        return _chain_synth(underlying, month)
    if source == "iquant":
        return _chain_iquant(request, underlying, month)
    if source != "akshare":
        raise OptionsError("BAD_REQUEST", f"unknown source: {source!r}")
    row = find_underlying("akshare", underlying)
    if row is None:
        raise OptionsError("BAD_REQUEST", f"unknown underlying {underlying!r}; see underlyings")
    if row["quotesSource"] != "sse_board":
        raise OptionsError(
            "NO_DATA",
            f"{underlying} is szse_static_only: statics via contracts, quotes not available in akshare",
        )
    records = fetch_board(row["boardName"], month)
    calls = [_quote_fields(r) for r in records if r["optionType"] == "C"]
    puts = [_quote_fields(r) for r in records if r["optionType"] == "P"]
    snapshot_at = records[0]["snapshotAt"]
    return {
        "source": "akshare",
        "underlying": underlying,
        "expiryMonth": month,
        "expiryDate": synth.expiry_date_of(month).isoformat(),
        "snapshotAt": snapshot_at,
        "calls": sorted(calls, key=lambda q: q["strike"]),
        "puts": sorted(puts, key=lambda q: q["strike"]),
    }


def fetch_board(board_name: str, expiry_month: str) -> list[dict[str, Any]]:
    """调 akshare board 并标准化;失败统一收口为领域错误。

    Returns
    -------
    list[dict[str, Any]]
        ``[{code, optionType, strike, last, changePct, prevSettle, snapshotAt}]``。
    """
    import akshare as ak

    try:
        raw = ak.option_finance_board(symbol=board_name, end_month=expiry_month)
    except KeyError as err:
        # akshare 对未知品种名抛 KeyError(symbol_map 查不到)
        raise OptionsError(
            "BAD_REQUEST", f"akshare does not serve board name {board_name!r}: {err}"
        ) from err
    except Exception as err:  # noqa: BLE001 - 第三方接口异常形态不稳定,统一收口
        raise OptionsError("NETWORK", f"board fetch failed: {err}") from err
    if raw is None or raw.empty:
        raise OptionsError("NO_DATA", f"empty board for {board_name!r} month {expiry_month}")
    records = []
    for _, r in raw.iterrows():
        code = str(r["合约交易代码"])
        records.append(
            {
                "code": code,
                "optionType": code[6],
                "strike": float(r["行权价"]),
                "last": float(r["当前价"]),
                "changePct": float(r["涨跌幅"]),
                "prevSettle": float(r["前结价"]),
                "snapshotAt": _parse_snapshot(str(r["日期"])),
            }
        )
    return records


def _chain_iquant(request: dict[str, Any], underlying: str, month: str) -> dict[str, Any]:
    """经 iquant-quote ``option_chain`` 取 T 型报价;深交所不再是缺口。

    请求带 ``atmFocus``(IV 路径收窄到 ATM 附近档位)时原样下传;T 板不传 → 全链。
    """
    from dsh_options import iquant

    row = iquant.require_row(underlying)
    raw = iquant.run_quote(
        "option_chain",
        {
            "market": iquant.option_market_of(row),
            "underlying": underlying,
            "expiryMonth": month,
            **(
                {"atmFocus": request["atmFocus"]}
                if isinstance(request.get("atmFocus"), dict)
                else {}
            ),
        },
        request,
    )
    calls = [iquant.map_chain_quote(item) for item in raw["calls"]]
    puts = [iquant.map_chain_quote(item) for item in raw["puts"]]
    return {
        "source": "iquant",
        "underlying": underlying,
        "expiryMonth": month,
        "expiryDate": raw["expiryDate"],
        "snapshotAt": raw["snapshotAt"],
        "calls": sorted(calls, key=lambda quote: quote["strike"]),
        "puts": sorted(puts, key=lambda quote: quote["strike"]),
    }


def _chain_synth(underlying: str, month: str) -> dict[str, Any]:
    """synth 链末行截面;未注册的合成标的或月份按 BAD_REQUEST/NO_DATA 报错。"""
    if underlying != synth.SYNTH_UNDERLYING:
        raise OptionsError("BAD_REQUEST", f"synth only serves {synth.SYNTH_UNDERLYING!r}")
    chain = synth.make_chain()
    matched = [c for c in chain["contracts"] if c["expiryMonth"] == month]
    if not matched:
        raise OptionsError("NO_DATA", f"synth chain has no month {month!r}")
    snapshot_at = f"{chain['spot']['date'].iloc[-1].date().isoformat()}T15:00:00+08:00"
    calls, puts = [], []
    for c in matched:
        daily = c["daily"]
        quote = {
            "code": c["code"],
            "strike": c["strike"],
            "last": float(daily["close"].iloc[-1]),
            "prevSettle": float(daily["close"].iloc[-2]),
            "volume": int(daily["volume"].iloc[-1]),
        }
        (calls if c["optionType"] == "C" else puts).append(quote)
    return {
        "source": "synth",
        "underlying": underlying,
        "expiryMonth": month,
        "expiryDate": matched[0]["expiryDate"],
        "snapshotAt": snapshot_at,
        "calls": sorted(calls, key=lambda q: q["strike"]),
        "puts": sorted(puts, key=lambda q: q["strike"]),
    }


def _quote_fields(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "code": record["code"],
        "strike": record["strike"],
        "last": record["last"],
        "changePct": record["changePct"],
        "prevSettle": record["prevSettle"],
    }


def _parse_snapshot(raw: str) -> str:
    """交易所快照 ``YYYYMMDDHHMMSS`` → ISO 8601(Asia/Shanghai,交易所本地时间)。"""
    try:
        moment = datetime.strptime(raw, "%Y%m%d%H%M%S")
    except ValueError as err:
        raise OptionsError("INTERNAL", f"unparseable board snapshot {raw!r}: {err}") from err
    return moment.strftime("%Y-%m-%dT%H:%M:%S+08:00")


def _require(request: dict[str, Any], key: str) -> str:
    value = request.get(key)
    if not isinstance(value, str) or not value:
        raise OptionsError("BAD_REQUEST", f"missing or invalid field: {key}")
    return value
