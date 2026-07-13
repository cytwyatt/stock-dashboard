'use strict';

const CN_INDICES = Object.freeze([
  'sh000001',
  'sz399001',
  'sz399006',
  'sh000300',
  'sh000688',
]);
const HK_INDICES = Object.freeze(['hkHSI', 'hkHSCEI', 'hkHSTECH']);

const defaultNum = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(`${name} must be a function`);
  return value;
}

function parseTencentIndices(text, codes, market, deps) {
  const { annotateMarketData, num, fmtCNTime, fmtHKTime, isoTencentTime } = deps;
  const out = [];
  for (const code of codes) {
    const match = text.match(new RegExp(`v_${code}="([^"]*)"`));
    if (!match) continue;
    const fields = match[1].split('~');
    if (fields.length < 35) continue;
    out.push({
      code,
      name: fields[1],
      currency: market === 'hk' ? 'HKD' : 'CNY',
      price: num(fields[3]),
      prevClose: num(fields[4]),
      open: num(fields[5]),
      change: num(fields[31]),
      changePct: num(fields[32]),
      high: num(fields[33]),
      low: num(fields[34]),
      amount: market === 'hk' ? num(fields[37]) : num(fields[37]) * 1e4,
      time: market === 'hk' ? fmtHKTime(fields[30]) : fmtCNTime(fields[30]),
      asOf: isoTencentTime(fields[30], market),
    });
  }
  return annotateMarketData(out, {
    market,
    source: '腾讯行情',
    currency: market === 'hk' ? 'HKD' : 'CNY',
    timezone: market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai',
    asOf: out.map((quote) => quote.asOf).filter(Boolean).sort().at(-1) || '',
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
  });
}

function parseTencentMinute(payload, code, deps) {
  const { annotateMarketData, num, isHKCode, isoMinuteTime } = deps;
  const node = payload.data && payload.data[code];
  if (!node || !node.data) throw new Error('no minute data');
  const quote = (node.qt && node.qt[code]) || [];
  const prevClose = num(quote[4]);
  const date = node.data.date || '';
  let previousCumulative = null;
  const points = (node.data.data || []).map((line) => {
    const [time, price, cumulative] = line.split(' ');
    const cumulativeVolume = num(cumulative);
    const volume = previousCumulative == null
      ? cumulativeVolume
      : Math.max(0, cumulativeVolume - previousCumulative);
    previousCumulative = cumulativeVolume;
    return {
      t: `${time.slice(0, 2)}:${time.slice(2)}`,
      price: num(price),
      vol: volume,
    };
  });
  const market = isHKCode(code) ? 'hk' : 'cn';
  const last = points[points.length - 1];
  return annotateMarketData({ code, date, prevClose, points }, {
    market,
    source: '腾讯行情',
    currency: market === 'hk' ? 'HKD' : 'CNY',
    timezone: market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai',
    asOf: last ? isoMinuteTime(date, last.t) : '',
    adjustmentBasis: 'none',
  });
}

function parseTencentKline(payload, code, period, deps) {
  const { annotateMarketData, num, isHKCode } = deps;
  const node = payload.data && payload.data[code];
  if (!node) throw new Error('no kline data');
  const adjusted = node[`qfq${period}`];
  const hasAdjusted = Array.isArray(adjusted) && adjusted.length > 0;
  const rows = hasAdjusted ? adjusted : node[period] || [];
  const out = rows.map((row) => ({
    date: row[0],
    open: num(row[1]),
    close: num(row[2]),
    high: num(row[3]),
    low: num(row[4]),
    volume: num(row[5]),
  }));
  const market = isHKCode(code) ? 'hk' : 'cn';
  return annotateMarketData(out, {
    market,
    source: '腾讯行情',
    currency: market === 'hk' ? 'HKD' : 'CNY',
    timezone: market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai',
    asOf: out.length ? out[out.length - 1].date : '',
    adjustmentBasis: hasAdjusted ? 'provider_qfq' : 'raw_fallback',
    adjustmentCoverage: hasAdjusted ? 1 : 0,
  });
}

function parseTencentSectors(payload, deps) {
  const { annotateMarketData, num } = deps;
  const list = ((payload.data && payload.data.rank_list) || []).map((sector) => {
    const [up, total] = (sector.zgb || '').split('/').map((value) => parseInt(value, 10) || 0);
    return {
      code: sector.code,
      name: sector.name,
      currency: 'CNY',
      changePct: num(sector.zdf),
      turnover: num(sector.turnover) * 1e4,
      inflow: num(sector.zljlr) * 1e4,
      up,
      total,
      leader: sector.lzg
        ? { code: sector.lzg.code, name: sector.lzg.name, changePct: num(sector.lzg.zdf) }
        : null,
    };
  });
  list.sort((left, right) => right.changePct - left.changePct);
  return annotateMarketData(list, {
    market: 'cn',
    source: '腾讯行情',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
    coverage: { fundFlow: 'provider_estimate' },
  });
}

function parseTencentQuote(text, code, deps) {
  const {
    annotateMarketData,
    num,
    isHKCode,
    fmtCNTime,
    fmtHKTime,
    isoTencentTime,
  } = deps;
  const match = text.match(new RegExp(`v_${code}="([^"]*)"`));
  if (!match) throw new Error('no quote for ' + code);
  const fields = match[1].split('~');
  if (isHKCode(code)) {
    return annotateMarketData({
      code,
      market: 'hk',
      currency: 'HKD',
      name: fields[1],
      price: num(fields[3]),
      prevClose: num(fields[4]),
      open: num(fields[5]),
      change: num(fields[31]),
      changePct: num(fields[32]),
      high: num(fields[33]),
      low: num(fields[34]),
      volume: num(fields[36]),
      amount: num(fields[37]),
      pe: num(fields[39]),
      amplitude: num(fields[43]),
      mktcap: num(fields[45]) * 1e8,
      week52High: num(fields[48]),
      week52Low: num(fields[49]),
      time: fmtHKTime(fields[30]),
      asOf: isoTencentTime(fields[30], 'hk'),
    }, {
      market: 'hk',
      source: '腾讯行情',
      currency: 'HKD',
      timezone: 'Asia/Hong_Kong',
      asOf: isoTencentTime(fields[30], 'hk'),
      adjustmentBasis: 'none',
      amountUnit: 'base_currency',
    });
  }
  const level5 = (start) => [0, 1, 2, 3, 4].map((index) => [
    num(fields[start + index * 2]),
    num(fields[start + index * 2 + 1]),
  ]);
  return annotateMarketData({
    code,
    market: 'cn',
    currency: 'CNY',
    bids: level5(9),
    asks: level5(19),
    name: fields[1],
    price: num(fields[3]),
    prevClose: num(fields[4]),
    open: num(fields[5]),
    change: num(fields[31]),
    changePct: num(fields[32]),
    high: num(fields[33]),
    low: num(fields[34]),
    volume: num(fields[36]) * 100,
    amount: num(fields[37]) * 1e4,
    turnoverRate: num(fields[38]),
    pe: num(fields[39]),
    amplitude: num(fields[43]),
    mktcap: num(fields[45]) * 1e8,
    pb: num(fields[46]),
    time: fmtCNTime(fields[30]),
    asOf: isoTencentTime(fields[30], 'cn'),
  }, {
    market: 'cn',
    source: '腾讯行情',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    asOf: isoTencentTime(fields[30], 'cn'),
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
  });
}

function parseTencentQuotes(text, codes, deps) {
  const {
    annotateMarketData,
    num,
    isHKCode,
    fmtCNTime,
    fmtHKTime,
    isoTencentTime,
  } = deps;
  const out = [];
  for (const code of codes) {
    const match = text.match(new RegExp(`v_${code}="([^"]*)"`));
    if (!match) continue;
    const fields = match[1].split('~');
    const market = isHKCode(code) ? 'hk' : 'cn';
    out.push({
      code,
      market,
      currency: market === 'hk' ? 'HKD' : 'CNY',
      name: fields[1],
      price: num(fields[3]),
      change: num(fields[31]),
      changePct: num(fields[32]),
      time: market === 'hk' ? fmtHKTime(fields[30]) : fmtCNTime(fields[30]),
      asOf: isoTencentTime(fields[30], market),
    });
  }
  return annotateMarketData(out, {
    market: null,
    source: '腾讯行情',
    currency: null,
    timezone: null,
    asOf: out.map((quote) => quote.asOf).filter(Boolean).sort().at(-1) || '',
    adjustmentBasis: 'none',
  });
}

function parseTencentSearch(text) {
  const match = text.match(/v_hint="([^"]*)"/);
  if (!match || match[1] === 'N;') return [];
  const decode = (value) => value.replace(
    /\\u([0-9a-fA-F]{4})/g,
    (_, hex) => String.fromCharCode(parseInt(hex, 16))
  );
  return match[1]
    .split('^')
    .map((item) => {
      const [market, code, name, , type] = item.split('~');
      if (!/^GP/.test(type || '')) return null;
      if (market === 'sh' || market === 'sz' || market === 'bj') {
        return { code: market + code, name: decode(name), market: 'cn' };
      }
      if (market === 'hk') {
        return { code: 'hk' + code, name: decode(name), market: 'hk' };
      }
      if (market === 'us') {
        return { code: code.split('.')[0].toUpperCase(), name: decode(name), market: 'us' };
      }
      return null;
    })
    .filter(Boolean)
    .slice(0, 10);
}

function createTencentProvider({
  fetchText,
  annotateMarketData,
  num = defaultNum,
  isHKCode,
  fmtCNTime,
  fmtHKTime,
  isoTencentTime,
  isoMinuteTime,
} = {}) {
  requireFunction(fetchText, 'fetchText');
  requireFunction(annotateMarketData, 'annotateMarketData');
  requireFunction(isHKCode, 'isHKCode');
  requireFunction(fmtCNTime, 'fmtCNTime');
  requireFunction(fmtHKTime, 'fmtHKTime');
  requireFunction(isoTencentTime, 'isoTencentTime');
  requireFunction(isoMinuteTime, 'isoMinuteTime');

  const deps = {
    annotateMarketData,
    num,
    isHKCode,
    fmtCNTime,
    fmtHKTime,
    isoTencentTime,
    isoMinuteTime,
  };

  async function getIndices(market) {
    const codes = market === 'hk' ? HK_INDICES : CN_INDICES;
    const text = await fetchText(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
      encoding: 'gbk',
    });
    return parseTencentIndices(text, codes, market, deps);
  }

  async function getMinute(code) {
    const payload = JSON.parse(await fetchText(
      `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`
    ));
    return parseTencentMinute(payload, code, deps);
  }

  async function getKline(code, days = 90, period = 'day') {
    const endpoint = isHKCode(code) ? 'hkfqkline' : 'fqkline';
    const url = `https://web.ifzq.gtimg.cn/appstock/app/${endpoint}/get?param=${code},${period},,,${days},qfq`;
    const payload = JSON.parse(await fetchText(url));
    return parseTencentKline(payload, code, period, deps);
  }

  async function getSectors() {
    const payload = JSON.parse(await fetchText(
      'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&count=200'
    ));
    return parseTencentSectors(payload, deps);
  }

  async function getQuote(code) {
    const text = await fetchText(`https://qt.gtimg.cn/q=${code}`, { encoding: 'gbk' });
    return parseTencentQuote(text, code, deps);
  }

  async function getQuotes(codes) {
    const text = await fetchText(`https://qt.gtimg.cn/q=${codes.join(',')}`, { encoding: 'gbk' });
    return parseTencentQuotes(text, codes, deps);
  }

  async function searchStocks(query) {
    const text = await fetchText(
      `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(query)}&t=all`,
      { encoding: 'gbk' }
    );
    return parseTencentSearch(text);
  }

  return {
    getIndices,
    getMinute,
    getKline,
    getSectors,
    getQuote,
    getQuotes,
    searchStocks,
  };
}

module.exports = {
  CN_INDICES,
  HK_INDICES,
  parseTencentIndices,
  parseTencentMinute,
  parseTencentKline,
  parseTencentSectors,
  parseTencentQuote,
  parseTencentQuotes,
  parseTencentSearch,
  createTencentProvider,
};
