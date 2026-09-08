# 品种注册表:标的代码 → 交易所/接口参数/乘数/tick。
#
# DO4:合约参数不写死在代码——品种清单是随包分发的数据文件,加品种改 JSON 不改代码;
# akshare 的 board 接口以中文品种名为参数,这层映射必须有单一出处。
# 数值来源:2026-09-05 探测实测(合约单位 10000 见深交所静态表;tickSize 来自交易所
# 规则快照,akshare 不提供,故显式给 source 字段)。

import json
from importlib.resources import files
from typing import Any

# 注册表字段:
#   underlying    标的 ETF 代码(6 位,synth 品种以 9 开头示假)
#   exchange      SSE | SZSE | SYNTH
#   boardName     akshare option_finance_board 的品种参数(SSE 行情入口 / SZSE 静态表入口)
#   name          标的名称
#   multiplier    合约单位(合约乘数)
#   tickSize      最小变动价位
#   quotesSource  sse_board(可取 T 型行情) | szse_static_only(仅静态表,无行情)
#                 | synth | iquant_board(经 dsh-iquant-quote;live 合约 SHO/SZO)
_REGISTRY_PATH = "data/underlyings.json"


def load_registry(source: str) -> list[dict[str, Any]]:
    """读注册表中指定 source 的品种清单。

    Parameters
    ----------
    source : str
        ``synth`` | ``akshare`` | ``iquant``;akshare 返回全部真实品种,
        synth 返回合成品种,iquant 返回与 akshare 相同的九只 ETF 期权标的。

    Returns
    -------
    list[dict[str, Any]]
        品种记录列表(字段见模块头注);未知 source 按 BAD_REQUEST 由调用方处理。
    """
    raw = json.loads(files("dsh_options").joinpath(_REGISTRY_PATH).read_text("utf-8"))
    if source not in raw:
        return []
    return raw[source]


def find_underlying(source: str, underlying: str) -> dict[str, Any] | None:
    """在注册表中找标的记录;找不到返回 None(调用方决定报错形状)。"""
    for row in load_registry(source):
        if row["underlying"] == underlying:
            return row
    return None
