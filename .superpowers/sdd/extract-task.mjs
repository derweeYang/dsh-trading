import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const planPath = process.argv[2]
const n = process.argv[3]
const dest = process.argv[4]
const plan = readFileSync(planPath, 'utf8')
const lines = plan.split(/\n/)
let infence = false
let intask = false
const out = []
const start = new RegExp(`^#{1,6}[ \\t]+Task[ \\t]+${n}([^0-9]|$)`)
const anyTask = /^#{1,6}[ \t]+Task[ \t]+\d+/
for (const line of lines) {
  if (line.startsWith('```')) infence = !infence
  if (!infence && anyTask.test(line)) intask = start.test(line)
  if (intask) out.push(line)
}
mkdirSync(new URL('.', `file:///${dest.replace(/\\/g, '/')}`), { recursive: true })
writeFileSync(dest, out.join('\n'))
console.log(`wrote ${dest}: ${out.length} lines`)
