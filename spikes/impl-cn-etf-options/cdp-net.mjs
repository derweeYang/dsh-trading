/** 抓浏览器侧 /dshtrading/api/options/chain 请求的真实响应（host 桥 → connector → 网关）。 */
const [, , pageWs, pageUrl, outDir] = process.argv
if (!pageWs || !pageUrl || !outDir) { console.error('usage: node cdp-net.mjs <pageWs> <pageUrl> <outDir>'); process.exit(1) }
const { writeFileSync } = await import('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RE_LENS_OPT = /期权|Options/
const ws = new WebSocket(pageWs)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0; const pending = new Map()
const events = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) } else if (m.method) { events.push(m) } }
function cdp(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evalJS(expr) { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page ex: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }
async function waitFor(expr, label, timeout = 25000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await evalJS(expr)) return } catch {} await sleep(500) } throw new Error('timeout: ' + label) }

await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Network.enable')
await cdp('Page.navigate', { url: pageUrl }); await sleep(4000)
await waitFor(`[...document.querySelectorAll('button,[role=tab]')].some(e => e.textContent.trim() === 'A股')`, 'A股')
await evalJS(`[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='A股').click()`)
await waitFor(`[...document.querySelectorAll('*')].some(e => e.childElementCount===0 && e.textContent.trim()==='上证50ETF')`, '上证50ETF')
await evalJS(`[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent.trim()==='上证50ETF').click()`)
await waitFor(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');if(!l)return false;return [...l.querySelectorAll('button[role=tab]')].some(b=>${RE_LENS_OPT}.test(b.textContent))})()`, 'Options lens')
await evalJS(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');[...l.querySelectorAll('button[role=tab]')].find(b=>${RE_LENS_OPT}.test(b.textContent)).click()})()`)
await sleep(15000)
// 收 chain 请求事件
const chainEvts = events.filter(e => /options\/chain/.test(JSON.stringify(e.params?.request?.url || e.params?.response?.url || '')))
const summary = []
for (const e of chainEvts) {
  if (e.method === 'Network.requestWillBeSent' || e.method === 'Network.requestIntercepted') {
    summary.push({ method: e.method, url: e.params?.request?.url })
  } else if (e.method === 'Network.responseReceived') {
    const body = await cdp('Network.getResponseBody', { requestId: e.params.requestId }).catch(() => ({ body: '<no body>' }))
    summary.push({ method: e.method, url: e.params?.response?.url, status: e.params?.response?.status, bodySnippet: (body.body || '').slice(0, 400) })
  } else if (e.method === 'Network.loadingFailed') {
    summary.push({ method: e.method, requestId: e.params?.requestId, error: e.params?.errorText })
  }
}
writeFileSync(`${outDir}/net-chain.json`, Buffer.from(JSON.stringify(summary, null, 1)))
console.log(JSON.stringify(summary, null, 1))
process.exit(0)
