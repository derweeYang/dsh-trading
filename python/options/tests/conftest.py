# 默认跳过 network 标记的测试;DSH_OPTIONS_NETWORK_TESTS=1 时启用。

import os

import pandas as pd
import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    if os.environ.get("DSH_OPTIONS_NETWORK_TESTS") == "1":
        return
    skip = pytest.mark.skip(reason="network tests need DSH_OPTIONS_NETWORK_TESTS=1")
    for item in items:
        if "network" in item.keywords:
            item.add_marker(skip)


@pytest.fixture
def sse_board_df() -> pd.DataFrame:
    """board 实测形状(2026-09-05 探测):中文列,日期为快照时间戳。"""
    return pd.DataFrame(
        {
            "日期": ["20260904162901"] * 4,
            "合约交易代码": [
                "510050C2609M02850",
                "510050C2609M02900",
                "510050P2609M02850",
                "510050P2609M02900",
            ],
            "当前价": [0.1861, 0.1391, 0.0103, 0.0132],
            "涨跌幅": [2.82, 5.30, -1.9, -2.1],
            "前结价": [0.1810, 0.1321, 0.0105, 0.0135],
            "行权价": [2.85, 2.90, 2.85, 2.90],
            "数量": [28, 28, 28, 28],
        }
    )


@pytest.fixture
def szse_static_df() -> pd.DataFrame:
    """深交所静态表实测形状;两品种混排,按标的名称过滤。"""
    return pd.DataFrame(
        {
            "合约编码": ["90007051", "90007052", "90007061"],
            "合约简称": ["深证100ETF购9月3100", "深证100ETF沽9月3100", "创业板ETF购9月3000"],
            "标的名称": ["深证100ETF易方达", "深证100ETF易方达", "创业板ETF易方达"],
            "类型": ["认购", "认沽", "认购"],
            "行权价": [3.1, 3.1, 3.0],
            "合约单位": [10000, 10000, 10000],
            "期权行权日": ["2026-09-23", "2026-09-23", "2026-09-23"],
            "行权交收日": ["2026-09-24", "2026-09-24", "2026-09-24"],
        }
    )
