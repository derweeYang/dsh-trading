/**
 * CN ETF 期权「现货 ⇄ 期权」双透镜端到端验证（page-level CDP，复用 11:40 验证过的直连模式）。
 * 文案匹配中英文双 locale 兼容。验证点：
 *   1) 选上证50ETF 后双透镜胶囊出现（名册命中 6 位码）→ Options 透镜可点
 *   2) 点 Options 透镜 → OptionsStage 挂载，T 表真实数据渲染
 *   3) 联动条：标的 ETF chip / 交易现货 ETF 按钮 / 发给 Agent 下单 按钮 均在
 *   4) 点选一档合约 → 发给 Agent 下单 由禁用转启用
 *   5) 点 查看现货 → 透镜回跳现货（双向互联）
 * 截图：lens-interlink-cn.png / lens-interlink-selected-cn.png / lens-back-to-spot-cn.png
 * 证据：lens-verify-evidence.json
 *
 * 用法：node cdp-verify-lens.mjs <pageWsUrl> <tokenizedURL> <outDir>
 */
const [, , pageWs, pageUrl, outDir] = process.argv
if (!pageWs || !pageUrl || !outDir) { console.error('usage: node cdp-verify-lens.mjs <pageWsUrl> <tokenizedURL> <outDir>'); process.exit(1) }

const { writeFileSync } = await import('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RE_LENS_OPT = /期权|Options/
const RE_LENS_SPOT = /现货|Spot/
const RE_TRADE = /交易现货\s*ETF|Trade spot ETF/
const RE_SEND = /将合约发给 Agent 下单|Send contract to Agent to order/
const RE_LEG = /已选合约|Selected contract/
const RE_VIEW = /查看现货|View spot/
const RE_UNDERLYING = /标的|Underlying/
// 注意：下方在 Runtime.evaluate 字符串里内联正则时，必须用 ${RE_X}（模板字符串会调用
// RegExp.toString() 渲染成 /pattern/），绝不能写 JSON.stringify(RE_X.source)（那会变成字符串再 .test 报错）。

const ws = new WebSocket(pageWs)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) } }
function cdp(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evalJS(expr) { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page ex: ' + JSON.stringify(r.exceptionDetails).slice(0, 500)); return r.result.value }
async function waitFor(expr, label, timeout = 25000, interval = 500) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await evalJS(expr)) return } catch {} await sleep(interval) } throw new Error('timeout waiting for: ' + label) }
async function screenshot(name) { const s = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }); const p = `${outDir}/${name}`; writeFileSync(p, Buffer.from(s.data, 'base64')); return p }

const evidence = { steps: {}, pass: false }
const mark = (k, v) => { evidence.steps[k] = v; console.log(k, JSON.stringify(v)) }

await cdp('Page.enable'); await cdp('Runtime.enable')
await cdp('Page.navigate', { url: pageUrl })
await sleep(4000)
// 1. A股
await waitFor(`[...document.querySelectorAll('button,[role=tab]')].some(e => e.textContent.trim() === 'A股')`, 'sidebar A股')
await evalJS(`[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='A股').click()`)
// 2. 上证50ETF
await waitFor(`[...document.querySelectorAll('*')].some(e => e.childElementCount===0 && e.textContent.trim()==='上证50ETF')`, '上证50ETF row')
await evalJS(`[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent.trim()==='上证50ETF').click()`)
// 3. 双透镜胶囊（名册命中）→ Options 透镜可点
await waitFor(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');if(!l)return false;return [...l.querySelectorAll('button[role=tab]')].some(b=>${RE_LENS_OPT}.test(b.textContent))})()`, 'Options lens tab')
const lensBefore = await evalJS(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');return [...l.querySelectorAll('button[role=tab]')].map(b=>({t:b.textContent.trim(),active:b.getAttribute('data-active')==='true'}))})()`)
mark('lens_before', lensBefore)
// 4. 点 Options 透镜 → OptionsStage 挂载 + T 表
await evalJS(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');[...l.querySelectorAll('button[role=tab]')].find(b=>${RE_LENS_OPT}.test(b.textContent)).click()})()`)
await waitFor(`!!document.querySelector('[data-dshtrading-options-stage] table tbody tr')`, 'T-board rows', 60000)
const board = await evalJS(`(function(){
  const root=document.querySelector('[data-dshtrading-options-stage]')
  const expList=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='option expiry months')
  const pills=expList?[...expList.querySelectorAll('button[role=tab]')].map(b=>(b.getAttribute('data-active')==='true'?'*':'')+b.textContent.trim()).filter(Boolean):[]
  const head=[...root.querySelectorAll('thead tr')].map(tr=>[...tr.children].map(c=>c.textContent.trim()).join(' | '))
  const rows=[...root.querySelectorAll('tbody tr')].slice(0,3).map(tr=>[...tr.children].map(c=>c.textContent.trim()).join(' | '))
  return {pills,head,rows,rowCount:root.querySelectorAll('tbody tr').length}
})()`)
mark('board', board)
const shot1 = await screenshot('lens-interlink-cn.png'); console.log('shot1 ->', shot1)
// 5. 联动条
const actionBar = await evalJS(`(function(){
  const root=document.querySelector('[data-dshtrading-options-stage]')
  const chip=[...root.querySelectorAll('button')].find(b=>${RE_VIEW}.test(b.getAttribute('aria-label')||'')||${RE_UNDERLYING}.test(b.textContent))
  const trade=[...root.querySelectorAll('button')].find(b=>${RE_TRADE}.test(b.textContent))
  const send=[...root.querySelectorAll('button')].find(b=>${RE_SEND}.test(b.textContent))
  return { underlyingChip: chip?chip.textContent.replace(/\\s+/g,' ').trim():null, tradeSpotBtn: trade?{text:trade.textContent.trim(),disabled:trade.disabled}:null, sendLegBtn: send?{text:send.textContent.trim(),disabled:send.disabled}:null }
})()`)
mark('action_bar', actionBar)
// 6. 点选一档合约 → 发给 Agent 启用
await evalJS(`document.querySelector('[data-dshtrading-options-stage] tbody tr td').click()`)
await waitFor(`(function(){const s=[...document.querySelector('[data-dshtrading-options-stage]').querySelectorAll('button')].find(b=>${RE_SEND}.test(b.textContent));return s&&!s.disabled})()`, 'sendLeg enabled')
const afterSelect = await evalJS(`(function(){
  const root=document.querySelector('[data-dshtrading-options-stage]')
  const send=[...root.querySelectorAll('button')].find(b=>${RE_SEND}.test(b.textContent))
  const legTag=[...root.querySelectorAll('span')].find(s=>${RE_LEG}.test(s.textContent.trim()))
  return { sendLegDisabled: send?send.disabled:null, legTag: legTag?legTag.textContent.replace(/\\s+/g,' ').trim():null }
})()`)
mark('after_select_leg', afterSelect)
const shot2 = await screenshot('lens-interlink-selected-cn.png'); console.log('shot2 ->', shot2)
// 7. 点 查看现货 → 回跳现货透镜
await evalJS(`(function(){const root=document.querySelector('[data-dshtrading-options-stage]');const chip=[...root.querySelectorAll('button')].find(b=>${RE_VIEW}.test(b.getAttribute('aria-label')||'')||${RE_UNDERLYING}.test(b.textContent));if(chip)chip.click()})()`)
await waitFor(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');if(!l)return false;const spot=[...l.querySelectorAll('button[role=tab]')].find(b=>${RE_LENS_SPOT}.test(b.textContent));return spot&&spot.getAttribute('data-active')==='true'})()`, 'lens back to spot', 12000)
const lensAfter = await evalJS(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');return [...l.querySelectorAll('button[role=tab]')].map(b=>({t:b.textContent.trim(),active:b.getAttribute('data-active')==='true'}))})()`)
mark('lens_after', lensAfter)
const shot3 = await screenshot('lens-back-to-spot-cn.png'); console.log('shot3 ->', shot3)

const pass = lensBefore.some(x => RE_LENS_OPT.test(x.t)) && board.rowCount > 0 && !!actionBar.tradeSpotBtn && actionBar.sendLegBtn && actionBar.sendLegBtn.disabled === true && afterSelect.sendLegDisabled === false && !!afterSelect.legTag && lensAfter.some(x => RE_LENS_SPOT.test(x.t) && x.active)
evidence.pass = pass
writeFileSync(`${outDir}/lens-verify-evidence.json`, Buffer.from(JSON.stringify(evidence, null, 1)))
console.log('VERIFY_PASS', pass)
process.exit(pass ? 0 : 2)
