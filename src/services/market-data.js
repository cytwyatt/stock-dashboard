'use strict';

function summarizeSectorBreadth(sectors) {
  let up = 0;
  let total = 0;
  let turnover = 0;
  for (const sector of sectors || []) {
    up += Math.max(0, Number(sector.up) || 0);
    total += Math.max(0, Number(sector.total) || 0);
    turnover += Number(sector.turnover) || 0;
  }
  up = Math.min(up, total);
  return { up, nonUp: Math.max(0, total - up), total, turnover };
}

function requireMethod(target, method, provider) {
  if (!target || typeof target[method] !== 'function') {
    throw new TypeError(`${provider}.${method} must be a function`);
  }
}

function latestAsOf(values) {
  const candidates = values.filter(Boolean);
  const dated = candidates
    .map((value) => ({ value, timestamp: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.timestamp));
  if (dated.length) {
    return dated.reduce((latest, item) => item.timestamp > latest.timestamp ? item : latest).value;
  }
  return candidates.sort().at(-1) || '';
}

/**
 * Cross-market routing and composition layer. Providers fetch and parse one
 * upstream; this facade decides which upstream to use without adding caching.
 */
function createMarketData({
  yahoo,
  tencent,
  sina,
  annotateMarketData,
  isTXCode,
} = {}) {
  if (typeof annotateMarketData !== 'function') {
    throw new TypeError('annotateMarketData must be a function');
  }
  if (typeof isTXCode !== 'function') throw new TypeError('isTXCode must be a function');

  for (const method of ['getIndices', 'getMinute', 'getKline', 'getQuote', 'getQuotes', 'getRank', 'getOverview']) {
    requireMethod(yahoo, method, 'yahoo');
  }
  for (const method of ['getIndices', 'getMinute', 'getKline', 'getSectors', 'getQuote', 'getQuotes', 'searchStocks']) {
    requireMethod(tencent, method, 'tencent');
  }
  for (const method of ['getRankCN', 'getRankHK', 'countLimit', 'getNews', 'getStockNewsCN']) {
    requireMethod(sina, method, 'sina');
  }

  const getIndices = (market) => market === 'us'
    ? yahoo.getIndices()
    : tencent.getIndices(market);

  const getMinute = (code) => isTXCode(code)
    ? tencent.getMinute(code)
    : yahoo.getMinute(code);

  const getKline = (code, days = 90, period = 'day') => isTXCode(code)
    ? tencent.getKline(code, days, period)
    : yahoo.getKline(code, days, period);

  const getQuote = (code) => isTXCode(code)
    ? tencent.getQuote(code)
    : yahoo.getQuote(code);

  async function getQuotes(codes) {
    const tencentCodes = codes.filter(isTXCode);
    const yahooCodes = codes.filter((code) => !isTXCode(code));
    const out = new Map();
    const jobs = [];
    if (tencentCodes.length) {
      jobs.push(tencent.getQuotes(tencentCodes).then((quotes) => {
        for (const quote of quotes) out.set(quote.code, quote);
      }));
    }
    if (yahooCodes.length) {
      jobs.push(yahoo.getQuotes(yahooCodes).then((quotes) => {
        for (const quote of quotes) out.set(quote.code, { ...quote, market: 'us' });
      }));
    }
    await Promise.all(jobs);
    const result = codes.map((code) => out.get(code)).filter(Boolean);
    return annotateMarketData(result, {
      market: null,
      source: tencentCodes.length && yahooCodes.length
        ? '腾讯行情 / Yahoo Finance'
        : tencentCodes.length ? '腾讯行情' : 'Yahoo Finance',
      currency: null,
      timezone: null,
      asOf: latestAsOf([...out.values()].map((quote) => quote.asOf)),
      adjustmentBasis: 'none',
      amountUnit: 'base_currency',
    });
  }

  async function getOverviewCN(sectorEntry) {
    const breadth = summarizeSectorBreadth(sectorEntry.data);
    const [limitUp, limitDown] = await Promise.all([
      sina.countLimit('up'),
      sina.countLimit('down'),
    ]);
    return annotateMarketData({
      ...breadth,
      down: null,
      flat: null,
      breadthBasis: 'sector_up_vs_total',
      limitUp: limitUp.count,
      limitDown: limitDown.count,
      limitCountComplete: limitUp.complete && limitDown.complete,
    }, {
      market: 'cn',
      source: '腾讯行情 / 新浪财经',
      currency: 'CNY',
      timezone: 'Asia/Shanghai',
      asOf: new Date(sectorEntry.fetchedAt).toISOString(),
      asOfBasis: 'fetch_time',
      stale: sectorEntry.stale,
      staleSince: sectorEntry.staleSince
        ? new Date(sectorEntry.staleSince).toISOString()
        : null,
      adjustmentBasis: 'none',
      amountUnit: 'base_currency',
      coverage: {
        breadth: '行业上涨家数 / 行业总家数；未上涨包含平盘与停牌',
        priceLimitRules: '主板10%、创业板/科创板20%、北交所30%',
        priceLimitExclusions: 'N/C新股、ST、退市整理',
        priceLimitComplete: limitUp.complete && limitDown.complete,
      },
    });
  }

  const getRankCN = (dir, count) => sina.getRankCN(dir, count);
  const getRankHK = (dir, count) => sina.getRankHK(dir, count);
  const getRankUS = (dir, count) => yahoo.getRank(dir, count);

  return {
    getIndices,
    getMinute,
    getKline,
    getSectors: () => tencent.getSectors(),
    getRankCN,
    getRankHK,
    getRankUS,
    getRank: (market, dir, count) => market === 'us'
      ? getRankUS(dir, count)
      : market === 'hk' ? getRankHK(dir, count) : getRankCN(dir, count),
    getQuote,
    getQuotes,
    searchStocks: (query) => tencent.searchStocks(query),
    getOverviewCN,
    getOverviewUS: () => yahoo.getOverview(),
    getNews: (count) => sina.getNews(count),
    getStockNewsCN: (code) => sina.getStockNewsCN(code),
    countLimit: (dir) => sina.countLimit(dir),
  };
}

module.exports = {
  latestAsOf,
  summarizeSectorBreadth,
  createMarketData,
};
