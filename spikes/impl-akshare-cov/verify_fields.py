# -*- coding: utf-8 -*-
"""核对 bond-cov-raw-*.json 字段量纲：转股价值/溢价率可由 正股价+转股价+债现价 重算。"""
import json


def load_rows():
    rows = []
    for page in (1, 2):
        try:
            rows.extend(json.load(open(f"bond-cov-raw-p{page}.json", encoding="utf-8"))["result"]["data"])
        except FileNotFoundError:
            pass
    return rows


def num(v):
    return isinstance(v, (int, float)) and v == v


def main():
    rows = load_rows()
    priced = [r for r in rows if num(r.get("CURRENT_BOND_PRICE"))]
    print(f"rows={len(rows)} priced={len(priced)}")
    print("sample priced rows (fields: code name stock conv value recomputed bond premium recomputed%):")
    worst = 0.0
    for r in priced[:8]:
        cp, tp = r.get("CONVERT_STOCK_PRICE"), r.get("TRANSFER_PRICE")
        tv, bp, pr = r.get("TRANSFER_VALUE"), r.get("CURRENT_BOND_PRICE"), r.get("TRANSFER_PREMIUM_RATIO")
        recomputed_value = 100.0 / tp * cp if num(tp) and tp > 0 and num(cp) else None
        recomputed_premium = (bp - tv) / tv * 100 if num(tv) and tv > 0 and num(bp) else None
        if recomputed_value is not None and num(tv):
            worst = max(worst, abs(recomputed_value - tv))
        if recomputed_premium is not None and num(pr):
            worst_prem_gap = abs(recomputed_premium - pr)
        print(
            f"  {r['SECURITY_CODE']} {r['SECURITY_NAME_ABBR']}: "
            f"stock={cp} conv={tp} value={tv}(rc={recomputed_value and round(recomputed_value, 4)}) "
            f"bond={bp} premium={pr}(rc={recomputed_premium and round(recomputed_premium, 4)})"
        )
    premiums = [r["TRANSFER_PREMIUM_RATIO"] for r in priced if num(r.get("TRANSFER_PREMIUM_RATIO"))]
    print(f"premium min={min(premiums)} max={max(premiums)} n={len(premiums)}")
    r0 = rows[0]
    keys = [
        "SECURITY_CODE", "SECURITY_NAME_ABBR", "CONVERT_STOCK_CODE", "CONVERT_STOCK_NAME",
        "LISTING_DATE", "BOND_EXPIRE_DATE", "PUBLIC_START_DATE", "TRADE_MARKET", "BOND_VALUE",
    ]
    print("row0 meta:", {k: r0.get(k) for k in keys})
    unpriced = [r for r in rows if not num(r.get("CURRENT_BOND_PRICE"))]
    print(f"unpriced={len(unpriced)}; unpriced CURRENT_BOND_PRICE sample={[r.get('CURRENT_BOND_PRICE') for r in unpriced[:3]]}")
    listed_unpriced = [r for r in unpriced if r.get("LISTING_DATE") not in (None, "-", "")]
    print(f"unpriced but has LISTING_DATE={len(listed_unpriced)} sample={[(r['SECURITY_CODE'], r.get('LISTING_DATE'), r.get('BOND_EXPIRE_DATE')) for r in listed_unpriced[:3]]}")


if __name__ == "__main__":
    main()
