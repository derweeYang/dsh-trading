# -*- coding: utf-8 -*-
"""找存续/退市判别字段：对比 有报价行 vs 有上市日无报价行 的全部键与取值。"""
import json


def num(v):
    return isinstance(v, (int, float)) and v == v


def load_rows():
    rows = []
    for page in (1, 2):
        try:
            rows.extend(json.load(open(f"bond-cov-raw-p{page}.json", encoding="utf-8"))["result"]["data"])
        except FileNotFoundError:
            pass
    return rows


def main():
    rows = load_rows()
    priced = [r for r in rows if num(r.get("CURRENT_BOND_PRICE"))]
    unpriced_listed = [r for r in rows if not num(r.get("CURRENT_BOND_PRICE")) and r.get("LISTING_DATE")]
    print("all keys of a priced row:")
    p0 = priced[0]
    print(sorted(p0.keys()))
    print()
    print("diff-generating keys (priced vs unpriced_listed):")
    u0 = unpriced_listed[0]
    for k in sorted(p0.keys()):
        pv, uv = p0.get(k), u0.get(k)
        if (pv is None) != (uv is None) or (num(pv) != num(uv)):
            pass  # 值不同很正常，只看结构性字段
    # 看候选状态字段
    for k in ["TRADE_STATUS", "REDEEM_STATUS", "LISTING_STATE", "SECURITY_STATUS", "BOND_STATUS",
              "DELISTING_DATE", "REDEEM_DATE", "EXPIRE_DATE", "BOND_EXPIRE_DATE", "YIELD_RATE_TYPE",
              "IS_LIST", "LIST_STATE", "BOND_TYPE"]:
        vals_p = {json.dumps(p0.get(k)) for p0 in priced[:50]}
        vals_u = {json.dumps(u.get(k)) for u in unpriced_listed[:50]}
        if k in p0 or vals_p != {"null"} or vals_u != {"null"}:
            print(f"  {k}: priced_sample={list(vals_p)[:3]} unpriced_sample={list(vals_u)[:3]}")
    print()
    print("unpriced_listed[0] full row:")
    print(json.dumps(unpriced_listed[0], ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
