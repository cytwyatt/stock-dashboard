'use strict';

const YAHOO_USER_AGENT = 'Mozilla/5.0';

const US_INDICES = Object.freeze([
  { code: '^DJI', name: '道琼斯' },
  { code: '^IXIC', name: '纳斯达克' },
  { code: '^GSPC', name: '标普500' },
]);

const US_MACRO = Object.freeze([
  { code: '^VIX', name: '恐慌指数 VIX' },
  { code: '^TNX', name: '美债10年期', unit: '%' },
  { code: 'DX-Y.NYB', name: '美元指数' },
  { code: 'GC=F', name: '黄金' },
  { code: 'CL=F', name: '原油 WTI' },
  { code: 'BTC-USD', name: '比特币' },
]);

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const defaultNum = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function createYahooScheduler() {
  let chain = Promise.resolve();
  let lastRequestAt = 0;

  function run(task, {
    now = Date.now,
    sleep = defaultSleep,
    minIntervalMs = 1000,
  } = {}) {
    const execute = async () => {
      const wait = Math.max(0, lastRequestAt + minIntervalMs - now());
      if (wait) await sleep(wait);
      try {
        return await task();
      } finally {
        lastRequestAt = now();
      }
    };
    const promise = chain.then(execute, execute);
    chain = promise.catch(() => {});
    return promise;
  }

  return { run };
}

const defaultYahooScheduler = createYahooScheduler();

function fmtTimeInTZ(epochSec, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochSec * 1000));
}

function yahooRange(days) {
  if (days <= 22) return '1mo';
  if (days <= 66) return '3mo';
  if (days <= 132) return '6mo';
  if (days <= 365) return '1y';
  return '2y';
}

function parseSparkQuotes(payload, defs, {
  annotateMarketData,
  formatTime = fmtTimeInTZ,
} = {}) {
  const results = (payload.spark && payload.spark.result) || [];
  const quotes = defs.map(({ code, name, unit }) => {
    const result = results.find((item) => item.symbol === code);
    const meta = result && result.response && result.response[0] && result.response[0].meta;
    if (!meta) return null;
    const prev = meta.chartPreviousClose || meta.previousClose || 0;
    const price = meta.regularMarketPrice || 0;
    return {
      code,
      name: name || meta.shortName || meta.longName || code,
      unit: unit || '',
      currency: meta.currency || null,
      price,
      prevClose: prev,
      open: 0,
      change: +(price - prev).toFixed(2),
      changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0,
      high: meta.regularMarketDayHigh || 0,
      low: meta.regularMarketDayLow || 0,
      amount: 0,
      time: meta.regularMarketTime
        ? `美东 ${formatTime(meta.regularMarketTime, meta.exchangeTimezoneName || 'America/New_York')}`
        : '',
      asOf: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '',
    };
  }).filter(Boolean);
  const currencies = [...new Set(quotes.map((quote) => quote.currency).filter(Boolean))];
  const zones = [...new Set(results
    .map((result) => result && result.response && result.response[0] && result.response[0].meta)
    .filter(Boolean)
    .map((meta) => meta.exchangeTimezoneName)
    .filter(Boolean))];
  return annotateMarketData(quotes, {
    market: 'us',
    source: 'Yahoo Finance',
    currency: currencies.length === 1 ? currencies[0] : null,
    timezone: zones.length === 1 ? zones[0] : 'America/New_York',
    asOf: quotes.map((quote) => quote.asOf).filter(Boolean).sort().at(-1) || '',
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
  });
}

function parseYahooMinute(result, code, {
  annotateMarketData,
  formatTime = fmtTimeInTZ,
} = {}) {
  const quote = result.indicators.quote[0] || {};
  const timestamps = result.timestamp || [];
  const timezone = result.meta.exchangeTimezoneName || 'America/New_York';
  const points = [];
  let lastDataTs = null;
  for (let index = 0; index < timestamps.length; index++) {
    const price = quote.close && quote.close[index];
    if (price == null) continue;
    lastDataTs = timestamps[index];
    points.push({
      t: formatTime(timestamps[index], timezone),
      price: +price.toFixed(2),
      vol: (quote.volume && quote.volume[index]) || 0,
    });
  }
  return annotateMarketData({
    code,
    date: '',
    prevClose: result.meta.chartPreviousClose || result.meta.previousClose || 0,
    points,
  }, {
    market: 'us',
    source: 'Yahoo Finance',
    currency: result.meta.currency || null,
    timezone: timezone || 'America/New_York',
    asOf: lastDataTs ? new Date(lastDataTs * 1000).toISOString() : '',
    adjustmentBasis: 'none',
  });
}

function parseYahooKline(result, { annotateMarketData } = {}) {
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const adjusted =
    (result.indicators && result.indicators.adjclose && result.indicators.adjclose[0]
      && result.indicators.adjclose[0].adjclose) || [];
  const timestamps = result.timestamp || [];
  const timezone = result.meta.exchangeTimezoneName || 'America/New_York';
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const out = [];
  let adjustedCount = 0;
  const roundPrice = (value) => +value.toFixed(4);
  const valueAt = (arr, index) => arr && arr[index] != null ? Number(arr[index]) : NaN;
  for (let index = 0; index < timestamps.length; index++) {
    const rawClose = valueAt(quote.close, index);
    const rawOpen = valueAt(quote.open, index);
    const rawHigh = valueAt(quote.high, index);
    const rawLow = valueAt(quote.low, index);
    if (![rawOpen, rawClose, rawHigh, rawLow].every(Number.isFinite) || rawClose === 0) continue;
    const adjustedClose = valueAt(adjusted, index);
    const hasAdjusted = Number.isFinite(adjustedClose) && adjustedClose > 0;
    const factor = hasAdjusted ? adjustedClose / rawClose : 1;
    if (hasAdjusted) adjustedCount++;
    out.push({
      date: dateFormatter.format(new Date(timestamps[index] * 1000)),
      open: roundPrice(rawOpen * factor),
      close: roundPrice(rawClose * factor),
      high: roundPrice(rawHigh * factor),
      low: roundPrice(rawLow * factor),
      volume: (quote.volume && quote.volume[index]) || 0,
    });
  }
  const coverage = out.length ? adjustedCount / out.length : 0;
  const adjustmentBasis = coverage === 1
    ? 'split_dividend_adjusted'
    : coverage === 0 ? 'raw_fallback' : 'partial_adjusted';
  return annotateMarketData(out, {
    market: 'us',
    source: 'Yahoo Finance',
    currency: result.meta.currency || null,
    timezone,
    asOf: out.length ? out[out.length - 1].date : '',
    adjustmentBasis,
    adjustmentCoverage: +coverage.toFixed(4),
  });
}

function parseYahooQuote(result, code, {
  annotateMarketData,
  formatTime = fmtTimeInTZ,
} = {}) {
  const meta = result.meta;
  const prev = meta.chartPreviousClose || meta.previousClose || 0;
  const price = meta.regularMarketPrice || 0;
  const asOf = meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : '';
  return annotateMarketData({
    code,
    market: 'us',
    currency: meta.currency || null,
    name: meta.longName || meta.shortName || code,
    price,
    prevClose: prev,
    open: 0,
    change: +(price - prev).toFixed(2),
    changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0,
    high: meta.regularMarketDayHigh || 0,
    low: meta.regularMarketDayLow || 0,
    volume: meta.regularMarketVolume || 0,
    week52High: meta.fiftyTwoWeekHigh || 0,
    week52Low: meta.fiftyTwoWeekLow || 0,
    time: meta.regularMarketTime
      ? `美东 ${formatTime(meta.regularMarketTime, meta.exchangeTimezoneName || 'America/New_York')}`
      : '',
    asOf,
  }, {
    market: 'us',
    source: 'Yahoo Finance',
    currency: meta.currency || null,
    timezone: meta.exchangeTimezoneName || 'America/New_York',
    asOf,
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
  });
}

function parseYahooRank(payload, count, { annotateMarketData, num = defaultNum } = {}) {
  const quotes =
    (payload.finance && payload.finance.result && payload.finance.result[0]
      && payload.finance.result[0].quotes) || [];
  const out = quotes.slice(0, count).map((quote) => ({
    code: quote.symbol,
    name: quote.shortName || quote.longName || quote.symbol,
    currency: quote.currency || 'USD',
    price: num(quote.regularMarketPrice),
    change: num(quote.regularMarketChange),
    changePct: num(quote.regularMarketChangePercent),
    market: quote.fullExchangeName || '',
  }));
  const currencies = [...new Set(out.map((quote) => quote.currency).filter(Boolean))];
  return annotateMarketData(out, {
    market: 'us',
    source: 'Yahoo Finance',
    currency: currencies.length === 1 ? currencies[0] : null,
    timezone: 'America/New_York',
    adjustmentBasis: 'none',
  });
}

function createYahooProvider({
  fetchText,
  annotateMarketData,
  now = Date.now,
  sleep = defaultSleep,
  minIntervalMs = 1000,
  formatTime = fmtTimeInTZ,
  num = defaultNum,
  scheduler = defaultYahooScheduler,
} = {}) {
  if (typeof fetchText !== 'function') throw new TypeError('fetchText must be a function');
  if (typeof annotateMarketData !== 'function') {
    throw new TypeError('annotateMarketData must be a function');
  }

  function yahooFetch(url) {
    return scheduler.run(
      () => fetchText(url, { ua: YAHOO_USER_AGENT }),
      { now, sleep, minIntervalMs }
    );
  }

  async function yahooChart(symbol, range, interval, { adjusted = false } = {}) {
    const extras = adjusted ? '&includeAdjustedClose=true&events=div%2Csplits' : '';
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}${extras}`;
    const payload = JSON.parse(await yahooFetch(url));
    const result = payload.chart && payload.chart.result && payload.chart.result[0];
    if (!result) throw new Error(`yahoo: no data for ${symbol}`);
    return result;
  }

  async function sparkQuotes(defs) {
    const symbols = defs.map((def) => def.code).join(',');
    const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols)}&range=1d&interval=5m`;
    const payload = JSON.parse(await yahooFetch(url));
    return parseSparkQuotes(payload, defs, { annotateMarketData, formatTime });
  }

  async function getMinute(code) {
    const result = await yahooChart(code, '1d', '5m');
    return parseYahooMinute(result, code, { annotateMarketData, formatTime });
  }

  async function getKline(code, days, period = 'day') {
    const interval = { day: '1d', week: '1wk', month: '1mo' }[period];
    const range = period === 'week' ? '2y' : period === 'month' ? '10y' : yahooRange(days);
    const result = await yahooChart(code, range, interval, { adjusted: true });
    return parseYahooKline(result, { annotateMarketData });
  }

  async function getRank(dir, count = 20) {
    const screenId = dir === 'down' ? 'day_losers' : 'day_gainers';
    const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${screenId}&count=${count + 5}`;
    const payload = JSON.parse(await yahooFetch(url));
    return parseYahooRank(payload, count, { annotateMarketData, num });
  }

  async function getQuote(code) {
    const result = await yahooChart(code, '1d', '5m');
    return parseYahooQuote(result, code, { annotateMarketData, formatTime });
  }

  return {
    yahooFetch,
    yahooChart,
    sparkQuotes,
    getIndices: () => sparkQuotes(US_INDICES),
    getMinute,
    getKline,
    getRank,
    getQuote,
    getQuotes: (codes) => sparkQuotes(codes.map((code) => ({ code }))),
    getOverview: () => sparkQuotes(US_MACRO),
  };
}

module.exports = {
  YAHOO_USER_AGENT,
  US_INDICES,
  US_MACRO,
  fmtTimeInTZ,
  yahooRange,
  parseSparkQuotes,
  parseYahooMinute,
  parseYahooKline,
  parseYahooQuote,
  parseYahooRank,
  createYahooScheduler,
  defaultYahooScheduler,
  createYahooProvider,
};
