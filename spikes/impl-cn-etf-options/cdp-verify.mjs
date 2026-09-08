/**
 * CN ETF 期权 T 板端到端验证（零依赖 CDP 驱动，配合系统 Chrome headless）。
 *
 * 用法：
 *   1. chrome --headless=new --remote-debugging-port=9222 --window-size=1600,1000 about:blank
 *   2. curl http://127.0.0.1:9222/json/list 取 page target 的 webSocketDebuggerUrl
 *   3. node cdp-verify.mjs <wsUrl> <tokenizedURL> <outPng>
 *
 * 流程：登录 token → 切 A股自选 → 选上证50ETF → 等「期权」页签出现（显隐判据：
 * 名册命中 6 位码）→ 点页签 → 等 T 表真实数据渲染 → 抓表文本 + 截图留证。
 */
const [, , wsUrl, pageUrl, outPng] = process.argv
if (!wsUrl || !pageUrl || !outPng) {
  console.error('usage: node cdp-verify.mjs <wsUrl> <pageUrl> <outPng>')
  process.exit(1)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message))
    else resolve(msg.result)
  }
}

function cdp(method, params = {}) {
  const id = ++seq
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const res = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) {
    throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails).slice(0, 400))
  }
  return res.result.value
}

async function waitFor(expression, label, timeout = 25000, interval = 500) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (await evalJS(expression)) return
    await sleep(interval)
  }
  throw new Error('timeout waiting for: ' + label)
}

await cdp('Page.enable')
await cdp('Runtime.enable')
await cdp('Page.navigate', { url: pageUrl })
await waitFor(`document.readyState === 'complete'`, 'page load')

// 1. UI 挂载（自选区出现）
await waitFor(
  `[...document.querySelectorAll('button,[role=tab]')].some(e => e.textContent.trim() === 'A股')`,
  'sidebar A股 tab',
)

// 2. 切 A股市场
await evalJS(`[...document.querySelectorAll('button,[role=tab]')].find(e => e.textContent.trim() === 'A股').click()`)

// 3. 点上证50ETF（期权注册标的；种子自选自带）
await waitFor(
  `[...document.querySelectorAll('*')].some(e => e.childElementCount === 0 && e.textContent.trim() === '上证50ETF')`,
  '上证50ETF row',
)
await evalJS(`[...document.querySelectorAll('*')].find(e => e.childElementCount === 0 && e.textContent.trim() === '上证50ETF').click()`)

// 4. 「期权」页签显隐判据：名册命中 6 位码后才出现
await waitFor(
  `[...document.querySelectorAll('button[role=tab]')].some(e => e.textContent.trim() === '期权')`,
  '期权 tab (registry hit)',
)

// 5. 点页签 → T 表挂载
await evalJS(`[...document.querySelectorAll('button[role=tab]')].find(e => e.textContent.trim() === '期权').click()`)
await waitFor(`!!document.querySelector('[data-dshtrading-options-stage] table tbody tr')`, 'T-board rows')

// 6. 抓证据：页签条 + 到期月胶囊 + 前 3 行 + 元行
const evidence = await evalJS(`(() => {
  const root = document.querySelector('[data-dshtrading-options-stage]')
  const tabs = [...document.querySelectorAll('button[role=tab]')].map(e => e.textContent.trim())
  const pills = [...root.querySelectorAll('[role=tablist] [role=tab]')].map(e =>
    (e.dataset.active ? '*' : '') + e.textContent.trim()).filter(Boolean)
  const head = [...root.querySelectorAll('thead tr')].map(tr =>
    [...tr.children].map(c => c.textContent.trim()).join(' | '))
  const rows = [...root.querySelectorAll('tbody tr')].slice(0, 3).map(tr =>
    [...tr.children].map(c => c.textContent.trim()).join(' | '))
  const meta = [...root.querySelectorAll('label')].map(l => l.textContent.trim() + '=' + l.parentElement.textContent.trim().replace(l.textContent.trim(), ''))
  return { tabs, pills, head, rows, meta, rowCount: root.querySelectorAll('tbody tr').length }
})()`)

// 7. 截图留证
const shot = await cdp('Page.captureScreenshot', { format: 'png' })
const { writeFileSync } = await import('node:fs')
writeFileSync(outPng, Buffer.from(shot.data, 'base64'))

console.log(JSON.stringify(evidence, null, 1))
console.log('screenshot ->', outPng)
process.exit(0)
