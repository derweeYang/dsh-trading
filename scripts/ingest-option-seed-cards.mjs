/**
 * 把 data/options/seed-cards.json 投影进 ~/.dsh/knowledge/cards.json。
 * 走与 knowledge_ingest 相同的 store + 校验（URL 查重则更新）。
 *
 *   node scripts/ingest-option-seed-cards.mjs
 */
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFileKnowledgeCardStore, createKnowledgeIngestTool, createKnowledgeSearchTool } from '../packages/knowledge/src/tool.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const seedPath = path.join(root, 'data', 'options', 'seed-cards.json')
const storePath = process.env.DSH_KNOWLEDGE_CARDS
  ?? path.join(os.homedir(), '.dsh', 'knowledge', 'cards.json')

const seeds = JSON.parse(await readFile(seedPath, 'utf8'))
if (!Array.isArray(seeds) || seeds.length === 0) {
  throw new Error(`empty seed file: ${seedPath}`)
}

const store = createFileKnowledgeCardStore(storePath)
const ingest = createKnowledgeIngestTool(store)
const search = createKnowledgeSearchTool(store)

const prior = await search.execute({ query: 'ETF期权', tags: 'ETF期权', limit: 20, detail: 'summary' })
console.log('--- knowledge_search 查重（ingest 前）---')
console.log(prior)

const lines = []
for (const seed of seeds) {
  const args = {
    title: seed.title,
    summary: seed.summary,
    sourceType: seed.source.type,
    sourceUrl: seed.source.url,
    sourceAuthor: seed.source.author,
    credibility: seed.credibility,
    coreClaimsJson: JSON.stringify(seed.coreClaims),
    factCheckJson: JSON.stringify(seed.factCheck),
    takeawaysJson: JSON.stringify(seed.takeaways ?? []),
    boundariesJson: JSON.stringify(seed.boundaries ?? []),
    tagsJson: JSON.stringify(seed.tags),
  }
  if (seed.source.publishedAt) args.publishedAt = seed.source.publishedAt
  if (seed.tickers?.length) args.tickersJson = JSON.stringify(seed.tickers)
  const result = await ingest.execute(args)
  lines.push(result)
  console.log(result)
}

const after = await search.execute({ query: 'ETF期权', cluster: 'ETF期权', limit: 20, detail: 'summary' })
console.log('--- knowledge_search cluster=ETF期权（ingest 后）---')
console.log(after)
console.log(`store=${storePath}`)
console.log(lines.join('\n'))
