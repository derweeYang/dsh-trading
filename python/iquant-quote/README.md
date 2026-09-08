# dsh-iquant-quote

国信 iQuant 只行情网关。SDK 接触只在这一层。

双击仓库根目录 `start-iquant-quote.bat`（或 `start-iquant-quote.bat 5811` 换端口）。脚本会核对 DLL / 配置路径、释放占用端口，再起 `127.0.0.1:5810`。

```powershell
# 等价手工启动
$env:IQUANT_SDK_ROOT = "D:\workspace\myquant\iquant_market_clean_fresh"
uv run python -m dsh_iquant_quote.gateway
```

- 现货市场：`SH` / `SZ` / `BJ` / `HK`
- 期权合约：`SHO` / `SZO`（不要订到 `SH`）
- 长代码 `510050C2609M02850` 本层拒绝
