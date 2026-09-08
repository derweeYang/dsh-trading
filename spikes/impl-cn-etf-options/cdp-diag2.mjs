/** 诊断：点 Options 透镜后 dump OptionsStage 实际 DOM 文本 + 报错。page-level CDP。 */
const [, , pageWs, pageUrl, outDir] = process.argv
if (!pageWs || !pageUrl || !outDir) { console.error('usage: node cdp-diag2.mjs <pageWs> <pageUrl> <outDir>'); process.exit(1) }
const { writeFileSync } = await import('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const RE_LENS_OPT = /期权|Options/
const ws = new WebSocket(pageWs)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0; const pending = new Map()
const logs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) } else if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') { logs.push(m) } }
function cdp(method, params = {}) { const id = ++seq; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })) }) }
async function evalJS(expr) { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error('page ex: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }
async function waitFor(expr, label, timeout = 25000) { const t0 = Date.now(); while (Date.now() - t0 < timeout) { try { if (await evalJS(expr)) return } catch {} await sleep(500) } throw new Error('timeout: ' + label) }

await cdp('Page.enable'); await cdp('Runtime.enable')
await cdp('Page.navigate', { url: pageUrl }); await sleep(4000)
await waitFor(`[...document.querySelectorAll('button,[role=tab]')].some(e => e.textContent.trim() === 'A股')`, 'A股')
await evalJS(`[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='A股').click()`)
await waitFor(`[...document.querySelectorAll('*')].some(e => e.childElementCount===0 && e.textContent.trim()==='上证50ETF')`, '上证50ETF')
await evalJS(`[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent.trim()==='上证50ETF').click()`)
await waitFor(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');if(!l)return false;return [...l.querySelectorAll('button[role=tab]')].some(b=>${RE_LENS_OPT}.test(b.textContent))})()`, 'Options lens')
await evalJS(`(function(){const l=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='spot or options lens');[...l.querySelectorAll('button[role=tab]')].find(b=>${RE_LENS_OPT}.test(b.textContent)).click()})()`)
await sleep(10000)
const state = await evalJS(`(function(){
  const root=document.querySelector('[data-dshtrading-options-stage]')
  if(!root) return { mounted:false }
  const expList=[...document.querySelectorAll('div[role=tablist]')].find(d=>d.getAttribute('aria-label')==='option expiry months')
  return {
    mounted:true,
    innerText: root.innerText.replace(/\\s+/g,' ').slice(0,800),
    expiryPills: expList?[...expList.querySelectorAll('button[role=tab]')].map(b=>b.textContent.trim()):[],
    tbodyRows: root.querySelectorAll('tbody tr').length,
    hasTable: !!root.querySelector('table')
  }
})()`)
writeFileSync(`${outDir}/diag2.json`, Buffer.from(JSON.stringify(state, null, 1)))
console.log(JSON.stringify(state, null, 1))
console.log('=== logs (' + logs.length + ') ===')
for (const l of logs.slice(0, 30)) {
  if (l.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(l.params.exceptionDetails?.exception?.description || l.params.exceptionDetails?.text).slice(0, 400))
  else console.log('LOG', (l.params.args||[]).map(a=>a.value??a.description??'').join(' ').slice(0, 400))
}
process.exit(0)
