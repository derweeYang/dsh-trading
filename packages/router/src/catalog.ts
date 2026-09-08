/**
 * 内置标的字典（host 侧 SSOT，issue #33 / P4）：每市场常见标的的 symbol + 中文名
 * 静态种子。原为 client-ui-trading 内部常量（且无消费方），升位到 router 供
 * `instruments_search` 工具与桥共用；**静态快照**——新上市标的靠动态全集
 * （registry.active(market).listInstruments?()）与本表并集兜底。
 *
 * 词汇纪律：symbol 一律市场规范词汇（docs/symbol-vocabulary.md）。
 *
 * 纯数据模块（零依赖，浏览器/Node 双端安全）。
 * @module @dshtrading/router/catalog
 */

/** 市场词汇（与 api MarketId 同词汇；本地定义保持本模块零依赖）。 */
export type CatalogMarket = 'cn'

export interface CatalogEntry {
  symbol: string
  name: string
  pinyin?: string
}

export const SYMBOL_CATALOG: Record<CatalogMarket, CatalogEntry[]> = {
  cn: [
    { symbol: '000001.SH', name: '上证指数', pinyin: 'SZZS,SHANGZHENG,SHANGZHENGZHISHU,SZZH' },
    { symbol: '399001.SZ', name: '深证成指', pinyin: 'SZCZ,SHENZHENGCHENGZHI' },
    { symbol: '399006.SZ', name: '创业板指', pinyin: 'CYBZ,CHUANGYEBANZHI,CYB' },
    { symbol: '000688.SH', name: '科创50', pinyin: 'KC50,KECHUANG50,KECHUANG,KC' },
    { symbol: '000300.SH', name: '沪深300', pinyin: 'HS300,HUSHEN300,HS' },
    { symbol: '000016.SH', name: '上证50', pinyin: 'SZ50,SHANGZHENG50,SZ' },
    { symbol: '000905.SH', name: '中证500', pinyin: 'ZZ500,ZHONGZHENG500,ZZ' },
    { symbol: '000852.SH', name: '中证1000', pinyin: 'ZZ1000,ZHONGZHENG1000' },
    { symbol: '588000.SH', name: '科创50ETF', pinyin: 'KC50ETF,588000' },
    { symbol: '588080.SH', name: '易方达科创50ETF', pinyin: 'YFDKC50ETF,588080' },
    { symbol: '510050.SH', name: '上证50ETF', pinyin: 'SZ50ETF,50ETF,510050,HUAXIA50' },
    { symbol: '510300.SH', name: '沪深300ETF', pinyin: 'HS300ETF,510300' },
    { symbol: '510500.SH', name: '中证500ETF', pinyin: 'ZZ500ETF,510500' },
    { symbol: '159919.SZ', name: '嘉实沪深300ETF', pinyin: 'JSHS300ETF,159919' },
    { symbol: '159915.SZ', name: '创业板ETF', pinyin: 'CYBETF,159915' },
    { symbol: '159901.SZ', name: '深证100ETF', pinyin: 'SZ100ETF,159901' },
    { symbol: '159922.SZ', name: '嘉实中证500ETF', pinyin: 'JSZZ500ETF,159922' },
    { symbol: '600519.SH', name: '贵州茅台', pinyin: 'GZMT,MT,GUIZHOUMAOTAI,MAOTAI' },
    { symbol: '000001.SZ', name: '平安银行', pinyin: 'PAYH,PA,PINGANYINHANG,PINGAN' },
    { symbol: '600036.SH', name: '招商银行', pinyin: 'ZSYH,ZS,ZHAOSHANGYINHANG,ZHAOSHANG' },
    { symbol: '000333.SZ', name: '美的集团', pinyin: 'MDJT,MD,MEIDEJITUAN,MEIDE' },
    { symbol: '000651.SZ', name: '格力电器', pinyin: 'GLDQ,GL,GELIDIANQI,GELI' },
    { symbol: '601318.SH', name: '中国平安', pinyin: 'ZGPA,PA,ZHONGGUOPINGAN,PINGAN' },
    { symbol: '600900.SH', name: '长江电力', pinyin: 'CJDL,CHANGJIANGDIANLI' },
    { symbol: '601398.SH', name: '工商银行', pinyin: 'GSYH,GS,GONGSHANGYINHANG,GONGHANG' },
    { symbol: '601988.SH', name: '中国银行', pinyin: 'ZGYH,ZG,ZHONGGUOYINHANG,ZHONGHANG' },
    { symbol: '601939.SH', name: '建设银行', pinyin: 'JSYH,JS,JIANSHANG,JIANHANG' },
    { symbol: '600030.SH', name: '中信证券', pinyin: 'ZXZQ,ZX,ZHONGXINZHENGQUAN,ZHONGXIN' },
    { symbol: '601899.SH', name: '紫金矿业', pinyin: 'ZJKY,ZJ,ZIJINKUANGYE,ZIJIN' },
    { symbol: '000002.SZ', name: '万科A', pinyin: 'WKA,WK,WANKEA,WANKE' },
    { symbol: '002594.SZ', name: '比亚迪', pinyin: 'BYD,BIYADI' },
    { symbol: '300750.SZ', name: '宁德时代', pinyin: 'NDSD,ND,NINGDESHIDAI,NINGDE' },
    { symbol: '002475.SZ', name: '立讯精密', pinyin: 'LXJM,LX,LIXUNJINMI,LIXUN' },
    { symbol: '603259.SH', name: '药明康德', pinyin: 'YMKD,YM,YAOMINGKANGDE,YAOMING' },
    { symbol: '600276.SH', name: '恒瑞医药', pinyin: 'HRYY,HR,HENGRUIYIYAO,HENGRUI' },
    { symbol: '000858.SZ', name: '五粮液', pinyin: 'WLY,WULIANGYE' },
    { symbol: '002415.SZ', name: '海康威视', pinyin: 'HKWS,HK,HAIKANGWEISHI,HAIKANG' },
    { symbol: '688981.SH', name: '中芯国际', pinyin: 'ZXGJ,ZX,ZHONGXINGUOJI,ZHONGXIN' },
    { symbol: '601012.SH', name: '隆基绿能', pinyin: 'LJLN,LJ,LONGJILVNENG,LONGJI' },
    { symbol: '600887.SH', name: '伊利股份', pinyin: 'YLGF,YL,YILIGUFEN,YILI' },
    { symbol: '601888.SH', name: '中国中免', pinyin: 'ZGZM,ZM,ZHONGGUOZHONGMIAN,ZHONGMIAN' },
    { symbol: '600028.SH', name: '中国石化', pinyin: 'ZGSH,SH,ZHONGGUOSHIHUA,ZHONGSHIHUA' },
    { symbol: '601857.SH', name: '中国石油', pinyin: 'ZGSY,SY,ZHONGGUOSHIYOU,ZHONGSHIYOU' },
    { symbol: '601668.SH', name: '中国建筑', pinyin: 'ZGJZ,JZ,ZHONGGUOJIANZHU,ZHONGJIAN' },
    { symbol: '601728.SH', name: '中国电信', pinyin: 'ZGDX,DX,ZHONGGUODIANXIN,ZHONGDIANXIN' },
    { symbol: '600941.SH', name: '中国移动', pinyin: 'ZGYD,YD,ZHONGGUOYIDONG,ZHONGYIDONG' },
    { symbol: '600050.SH', name: '中国联通', pinyin: 'ZGLT,LT,ZHONGGUOLIANTONG,ZHONGLIANTONG' },
    { symbol: '300059.SZ', name: '东方财富', pinyin: 'DFCF,DC,DONGFANGCAIFU,DONGCAI' },
    { symbol: '300124.SZ', name: '汇川技术', pinyin: 'HCJS,HC,HUICHUANJISHU,HUICHUAN' },
    { symbol: '002230.SZ', name: '科大讯飞', pinyin: 'KDXF,XF,KEDAXUNFEI,XUNFEI' },
    { symbol: '688111.SH', name: '金山办公', pinyin: 'JSBG,WPS,JINSHANBANGONG,JINSHAN' },
    { symbol: '688041.SH', name: '海光信息', pinyin: 'HGXX,HG,HAIGUANGXINXI,HAIGUANG' },
    { symbol: '002371.SZ', name: '北方华创', pinyin: 'BFHC,HC,BEIFANGHUACHUANG,HUACHUANG' },
    { symbol: '603501.SH', name: '韦尔股份', pinyin: 'WEGF,WE,WEIERGUFEN,WEIER' },
    { symbol: '600584.SH', name: '长电科技', pinyin: 'CDKJ,CD,CHANGDIANKEJI,CHANGDIAN' },
    { symbol: '601127.SH', name: '赛力斯', pinyin: 'SLS,SAILISI' },
    { symbol: '002714.SZ', name: '牧原股份', pinyin: 'MYGF,MY,MUYUANGUFEN,MUYUAN' },
    { symbol: '002745.SZ', name: '木林森', pinyin: 'MLS,MULINSEN' },
    { symbol: '002240.SZ', name: '盛新锂能', pinyin: 'SXLN,SX,SHENGXINLINENG,SHENGXIN' },
    { symbol: '002466.SZ', name: '天齐锂业', pinyin: 'TQLY,TQ,TIANQILIYE,TIANQI' },
    { symbol: '002460.SZ', name: '赣锋锂业', pinyin: 'GFLY,GF,GANFENGLIYE,GANFENG' },
    { symbol: '600438.SH', name: '通威股份', pinyin: 'TWGF,TW,TONGWEIGUFEN,TONGWEI' },
    { symbol: '300274.SZ', name: '阳光电源', pinyin: 'YGDY,YG,YANGGUANGDIANYUAN,YANGGUANG' },
    { symbol: '600000.SH', name: '浦发银行', pinyin: 'PFYH,PF,PUFAYINHANG,PUFA' },
    { symbol: '002142.SZ', name: '宁波银行', pinyin: 'NBYH,NB,NINGBOYINHANG,NINGBO' },
    { symbol: '601166.SH', name: '兴业银行', pinyin: 'XYYH,XY,XINGYEYINHANG,XINGYE' },
    { symbol: '601919.SH', name: '中远海控', pinyin: 'ZYHK,ZY,ZHONGYUANHAIKONG,HAIKONG' },
    { symbol: '000063.SZ', name: '中兴通讯', pinyin: 'ZXTX,ZX,ZHONGXINGTONGXUN,ZHONGXIN' },
    { symbol: '002241.SZ', name: '歌尔股份', pinyin: 'GEGF,GE,GEERGUFEN,GEER' },
    { symbol: '300433.SZ', name: '蓝思科技', pinyin: 'LSKJ,LS,LANSIKEJI,LANSI' },
    { symbol: '603986.SH', name: '兆易创新', pinyin: 'ZYCX,ZY,ZHAOYICHUANGXIN,ZHAOYI' },
    { symbol: '002156.SZ', name: '通富微电', pinyin: 'TFMD,TF,TONGFUWEIDIAN,TONGFU' },
    { symbol: '600460.SH', name: '士兰微', pinyin: 'SLW,SL,SHILANWEI' },
    { symbol: '300014.SZ', name: '亿纬锂能', pinyin: 'YWLN,YW,YIWEILINENG,YIWEI' },
    { symbol: '300015.SZ', name: '爱尔眼科', pinyin: 'AEYK,AE,AERYANKE,AIER' },
  ],
}

const dynamicCatalogs = new Map<CatalogMarket, CatalogEntry[]>()

/** 注入某市场的动态标的全集（由桥端点拉取并入）。 */
export function setDynamicCatalog(market: CatalogMarket, entries: Array<{ symbol: string; name?: string; pinyin?: string }>): void {
  const normalized: CatalogEntry[] = entries.map((e) => ({
    symbol: e.symbol,
    name: e.name ?? e.symbol,
    pinyin: e.pinyin,
  }))
  dynamicCatalogs.set(market, normalized)
}

/** 累加/增量更新某市场的动态标的名称（由实时行情查询或联想补齐触发）。 */
export function updateDynamicCatalog(market: CatalogMarket, entries: Array<{ symbol: string; name?: string; pinyin?: string }>): void {
  const existing = dynamicCatalogs.get(market) ?? []
  const map = new Map<string, CatalogEntry>()
  for (const e of existing) {
    map.set(e.symbol.toUpperCase(), e)
  }
  for (const e of entries) {
    if (!e.symbol || !e.name) continue
    const sym = e.symbol.toUpperCase()
    // 忽略占位符名字，如 "000938" 或 "000938 (A股)"
    if (e.name === e.symbol || /\(A股\)|\(港股\)/.test(e.name)) continue
    const old = map.get(sym)
    map.set(sym, {
      symbol: e.symbol,
      name: e.name,
      pinyin: e.pinyin ?? old?.pinyin,
    })
  }
  dynamicCatalogs.set(market, Array.from(map.values()))
}

/** 获取静态快照 ∪ 动态全集融合后的标的列表（静态优先保留中文名，动态补充新标的）。 */
export function getMergedCatalog(market: CatalogMarket): CatalogEntry[] {
  const staticList = SYMBOL_CATALOG[market] ?? []
  const dynamicList = dynamicCatalogs.get(market) ?? []
  if (dynamicList.length === 0) return staticList
  const seen = new Set<string>()
  const merged: CatalogEntry[] = []
  for (const entry of staticList) {
    seen.add(entry.symbol.toUpperCase())
    merged.push(entry)
  }
  for (const entry of dynamicList) {
    const sym = entry.symbol.toUpperCase()
    if (!seen.has(sym)) {
      seen.add(sym)
      merged.push(entry)
    }
  }
  return merged
}

/**
 * 联想搜索：静态 ∪ 动态全集融合，symbol 前缀/包含（大小写不敏感）或中文名包含，返回前 limit 条。
 * 空查询返回空（不打扰）。
 */
export function searchSymbols(market: CatalogMarket, query: string, limit = 8): CatalogEntry[] {
  const q = query.trim().toUpperCase()
  if (q === '') return []
  const catalog = getMergedCatalog(market)
  const scored: Array<{ entry: CatalogEntry; score: number }> = []
  for (const entry of catalog) {
    const symbol = entry.symbol.toUpperCase()
    const name = entry.name ? entry.name.toUpperCase() : ''
    const pinyinList = entry.pinyin ? entry.pinyin.toUpperCase().split(',') : []
    let score = -1
    if (symbol === q || name === q || pinyinList.includes(q)) score = 0
    else if (symbol.startsWith(q) || name.startsWith(q) || pinyinList.some(p => p.startsWith(q))) score = 1
    else if (name && name.includes(q)) score = 2
    else if (symbol.includes(q) || pinyinList.some(p => p.includes(q))) score = 3
    if (score >= 0) scored.push({ entry, score })
  }

  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.entry)
}

/** 跨市场联想：全部市场字典合并搜索（自选页签的添加是跨市场的）。 */
export interface Suggestion extends CatalogEntry {
  market: CatalogMarket
}

export function searchAllMarkets(query: string, limit = 8): Suggestion[] {
  const q = query.trim().toUpperCase()
  if (q === '') return []
  const markets: CatalogMarket[] = ['cn']
  const all: Array<{ entry: Suggestion; score: number }> = []
  for (const market of markets) {
    const catalog = getMergedCatalog(market)
    for (const entry of catalog) {
      const symbol = entry.symbol.toUpperCase()
      const name = entry.name ? entry.name.toUpperCase() : ''
      const pinyinList = entry.pinyin ? entry.pinyin.toUpperCase().split(',') : []
      let score = -1
      if (symbol === q || name === q || pinyinList.includes(q)) score = 0
      else if (symbol.startsWith(q) || name.startsWith(q) || pinyinList.some(p => p.startsWith(q))) score = 1
      else if (name && name.includes(q)) score = 2
      else if (symbol.includes(q) || pinyinList.some(p => p.includes(q))) score = 3
      if (score >= 0) all.push({ entry: { ...entry, market }, score })
    }
  }
  return all.sort((a, b) => a.score - b.score).slice(0, limit).map(s => s.entry)
}
