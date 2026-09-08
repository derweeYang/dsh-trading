/**
 * 诊断：导航到上证50ETF 后 dump 双透镜相关 DOM 状态 + 捕获 console/异常。
 */
const [, , browserWs, pageUrl, outDir] = process.argv
if (!browserWs || !pageUrl || !outDir) { console.error('usage: node cdp-diag.mjs <browserWs> <pageUrl> <outDir>'); process.exit(1) }
const { writeFileSync } = await import('node:fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ws = new WebSocket(browserWs)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) } }
function cdp(method, params = {}, sid) { const id = ++seq; const p = { id, method, params }; if (sid) p.sessionId = sid; return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify(p)) }) }
const logs = []
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id !== undefined && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(m.error.message)) : resolve(m.result) } else if (m.method === 'Runtime.consoleAPICalled' || m.method === 'Runtime.exceptionThrown') { logs.push(m) } }
async function evalJS(expr, sid) { const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, sid); if (r.exceptionDetails) throw new Error('page ex: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value }

const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true })
await cdp('Page.enable', {}, sessionId); await cdp('Runtime.enable', {}, sessionId)
await cdp('Runtime.addBinding', { name: 'diag' }, sessionId).catch(() => {})

await cdp('Page.navigate', { url: pageUrl }, sessionId)
await sleep(3000)
await evalJS(`[...document.querySelectorAll('button,[role=tab]')].find(e=>e.textContent.trim()==='A股')?.click()`, sessionId).catch(()=>{})
await sleep(1500)
await evalJS(`[...document.querySelectorAll('*')].find(e=>e.childElementCount===0&&e.textContent.trim()==='上证50ETF')?.click()`, sessionId).catch(()=>{})
await sleep(6000)

const state = await evalJS(`(function(){
  const lists = [...document.querySelectorAll('div[role=tablist]')].map(d=>({label:d.getAttribute('aria-label'),tabs:[...d.querySelectorAll('button[role=tab]')].map(b=>({t:b.textContent.trim(),active:b.getAttribute('data-active')==='true'}))}))
  const bodyText = document.body.innerText
  const hasOpt = bodyText.includes('期权'); const hasOptions = bodyText.includes('Options')
  const hasSpot = bodyText.includes('现货'); const hasSpotEn = bodyText.includes('Spot')
  const optStage = !!document.querySelector('[data-dshtrading-options-stage]')
  const lens = lists.find(l=>l.label==='spot or options lens')
  return { tablists: lists, hasOpt, hasOptions, hasSpot, hasSpotEn, optStage, lensTabs: lens?lens.tabs:null, bodyLen: bodyText.length }
})()`, sessionId)
writeFileSync(`${outDir}/diag.json`, Buffer.from(JSON.stringify(state, null, 1)))
console.log(JSON.stringify(state, null, 1))
console.log('=== console/exception logs (' + logs.length + ') ===')
for (const l of logs.slice(0, 20)) {
  if (l.method === 'Runtime.exceptionThrown') console.log('EXC', JSON.stringify(l.params.exceptionDetails?.exception?.description || l.params.exceptionDetails?.text).slice(0, 300))
  else console.log('LOG', (l.params.args||[]).map(a=>a.value??a.description??'').join(' ').slice(0, 300))
}
process.exit(0)
