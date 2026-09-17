# -*- coding: utf-8 -*-
"""抓取东方财富可转债列表真网证据（spikes/impl-akshare-cov/）。

复刻 akshare bond_zh_cov() 的底层 HTTP（datacenter-web RPT_BOND_CB_LIST，
quoteColumns 携带实时正股价/转股价/转股价值/债现价/转股溢价率）。
用法：python -X utf8 fetch_cov.py  （本目录内运行，产物写入本目录）
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

URL = "https://datacenter-web.eastmoney.com/api/data/v1/get"
QUOTE_COLUMNS = (
    "f2~01~CONVERT_STOCK_CODE~CONVERT_STOCK_PRICE,"
    "f235~10~SECURITY_CODE~TRANSFER_PRICE,"
    "f236~10~SECURITY_CODE~TRANSFER_VALUE,"
    "f2~10~SECURITY_CODE~CURRENT_BOND_PRICE,"
    "f237~10~SECURITY_CODE~TRANSFER_PREMIUM_RATIO,"
    "f239~10~SECURITY_CODE~RESALE_TRIG_PRICE,"
    "f240~10~SECURITY_CODE~REDEEM_TRIG_PRICE,"
    "f23~01~CONVERT_STOCK_CODE~PBV_RATIO"
)


def fetch_page(page: int) -> dict:
    params = {
        "sortColumns": "PUBLIC_START_DATE",
        "sortTypes": "-1",
        "pageSize": "500",
        "pageNumber": str(page),
        "reportName": "RPT_BOND_CB_LIST",
        "columns": "ALL",
        "quoteColumns": QUOTE_COLUMNS,
        "source": "WEB",
        "client": "WEB",
    }
    full = URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        full, headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.load(resp)


def main() -> int:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open("fetch-timestamp.txt", "w", encoding="utf-8") as fh:
        fh.write(f"utc={stamp} endpoint={URL} reportName=RPT_BOND_CB_LIST pageSize=500\n")

    first = fetch_page(1)
    pages = int(first["result"]["pages"])
    count = int(first["result"]["count"])
    with open("bond-cov-raw-p1.json", "w", encoding="utf-8") as fh:
        json.dump(first, fh, ensure_ascii=False, indent=1)
    print(f"pages={pages} count={count} p1_rows={len(first['result']['data'])}")

    rows = list(first["result"]["data"])
    if pages > 1:
        p2 = fetch_page(2)
        with open("bond-cov-raw-p2.json", "w", encoding="utf-8") as fh:
            json.dump(p2, fh, ensure_ascii=False, indent=1)
        rows.extend(p2["result"]["data"])
        print(f"p2_rows={len(p2['result']['data'])}")
        time.sleep(0.5)

    # 结构性断言（不锚定行情数值）：关键列存在、可解析为有限数的行占多数。
    key_fields = [
        "SECURITY_CODE", "SECURITY_NAME_ABBR", "CONVERT_STOCK_CODE",
        "CONVERT_STOCK_PRICE", "TRANSFER_PRICE", "TRANSFER_VALUE",
        "CURRENT_BOND_PRICE", "TRANSFER_PREMIUM_RATIO",
    ]
    sample = rows[0]
    missing = [k for k in key_fields if k not in sample]
    print("missing_key_fields:", missing or "none")

    def numeric(v):
        try:
            return v is not None and float(v) == float(v)
        except (TypeError, ValueError):
            return False

    priced = [r for r in rows if numeric(r.get("CURRENT_BOND_PRICE")) and numeric(r.get("TRANSFER_PRICE"))]
    with_premium = [r for r in priced if numeric(r.get("TRANSFER_PREMIUM_RATIO"))]
    print(f"rows_total={len(rows)} priced={len(priced)} with_premium_ratio={len(with_premium)}")

    negative = [r for r in with_premium if float(r["TRANSFER_PREMIUM_RATIO"]) < 0]
    print(f"negative_premium_rows={len(negative)}")
    for r in negative[:3]:
        print(
            "  sample:",
            r["SECURITY_CODE"], r["SECURITY_NAME_ABBR"],
            "bond=", r.get("CURRENT_BOND_PRICE"),
            "value=", r.get("TRANSFER_VALUE"),
            "premium%=", r.get("TRANSFER_PREMIUM_RATIO"),
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
