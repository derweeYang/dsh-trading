# 波动率分析图:ATM 期限与当日二次微笑 PNG。matplotlib 懒加载,无显示后端。

from __future__ import annotations

from pathlib import Path
from typing import Any

from dsh_options.protocol import OptionsError

CHART_KINDS = ("term", "smile")


def resolve_chart_kinds(raw: Any) -> tuple[str, ...]:
    """校验 ``chartKinds``:缺省两类;显式值必须是非空子集。"""
    if raw is None:
        return CHART_KINDS
    if not isinstance(raw, list) or not raw or not all(isinstance(item, str) for item in raw):
        raise OptionsError("BAD_REQUEST", f"chartKinds must be a non-empty subset of {list(CHART_KINDS)}")
    if not set(raw) <= set(CHART_KINDS):
        raise OptionsError("BAD_REQUEST", f"chartKinds must be a non-empty subset of {list(CHART_KINDS)}")
    return tuple(dict.fromkeys(raw))


def write_vol_charts(
    *,
    viz_dir: Path,
    underlying: str,
    stamp: str,
    term: list[dict[str, Any]],
    smile: list[dict[str, Any]],
    kinds: tuple[str, ...],
) -> list[dict[str, Any]]:
    """按种类写 PNG,返回 ``charts[]`` 行(含到期/不足打标)。"""
    try:
        dest = viz_dir / underlying / stamp
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as err:
        raise OptionsError("BAD_REQUEST", f"vizDir is not a writable directory: {err}") from err
    rows: list[dict[str, Any]] = []
    if "term" in kinds:
        rows.append(_write_term(dest, underlying, stamp, term))
    if "smile" in kinds:
        for row in smile:
            rows.append(_write_smile(dest, underlying, stamp, row))
    return rows


def _write_term(
    dest: Path, underlying: str, stamp: str, term: list[dict[str, Any]]
) -> dict[str, Any]:
    live = [row for row in term if row.get("status") == "ok" and row.get("atmIv") is not None]
    title = f"{underlying} ATM term {stamp}"
    if not live:
        status = "expired" if term and all(row.get("status") == "expired" for row in term) else "insufficient"
        return {"kind": "term", "status": status, "title": title}
    path = dest / "term.png"
    xs = [str(row["expiryMonth"]) for row in live]
    ys = [float(row["atmIv"]) for row in live]
    _plot_xy(path, xs, ys, title=title, xlabel="expiry month", ylabel="ATM IV", series="ATM IV")
    return {"kind": "term", "status": "ok", "title": title, "path": str(path)}


def _write_smile(
    dest: Path, underlying: str, stamp: str, row: dict[str, Any]
) -> dict[str, Any]:
    month = str(row["expiryMonth"])
    title = f"{underlying} {month} mid-IV smile {stamp}"
    status = str(row.get("status") or "insufficient")
    base = {"kind": "smile", "expiryMonth": month, "status": status, "title": title}
    if status != "ok" or not row.get("knots"):
        return base
    path = dest / f"smile-{month}.png"
    knots = row["knots"]
    strikes = [float(item["strike"]) for item in knots]
    ivs = [float(item["iv"]) for item in knots]
    fitted = [float(item["fittedIv"]) for item in knots]
    _plot_smile(path, strikes, ivs, fitted, title)
    return {**base, "path": str(path)}


def _plot_xy(
    path: Path,
    xs: list[str],
    ys: list[float],
    *,
    title: str,
    xlabel: str,
    ylabel: str,
    series: str,
) -> None:
    plt = _pyplot()
    fig, ax = plt.subplots(figsize=(7.0, 4.0))
    ax.plot(xs, ys, marker="o", label=series)
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def _plot_smile(
    path: Path, strikes: list[float], ivs: list[float], fitted: list[float], title: str
) -> None:
    plt = _pyplot()
    fig, ax = plt.subplots(figsize=(7.0, 4.0))
    ax.scatter(strikes, ivs, label="mid IV")
    ax.plot(strikes, fitted, label="quadratic fit")
    ax.set_title(title)
    ax.set_xlabel("strike")
    ax.set_ylabel("IV")
    ax.legend()
    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def _pyplot():
    """导入 pyplot 前锁定 Agg;缺库按 INTERNAL 失败。"""
    try:
        import matplotlib

        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except ImportError as err:
        raise OptionsError("INTERNAL", "matplotlib is required to write vol charts") from err
    return plt
