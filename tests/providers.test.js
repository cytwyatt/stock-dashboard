'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHttpClient } = require('../src/providers/http-client');
const {
  createYahooScheduler,
  createYahooProvider,
  parseSparkQuotes,
  parseYahooKline,
  parseYahooRank,
} = require('../src/providers/yahoo');
const {
  createTencentProvider,
  parseTencentMarketTurnover,
  parseTencentTurnoverSessions,
} = require('../src/providers/tencent');
const {
  createSinaProvider,
  parseSinaRankCN,
  parseSinaStockNewsPage,
} = require('../src/providers/sina');
const {
  createMarketData,
  summarizeSectorBreadth,
} = require('../src/services/market-data');

const META = Symbol('testMarketMeta');

function annotateMarketData(data, meta) {
  Object.defineProperty(data, META, {
    value: { ...(data[META] || {}), ...meta },
    configurable: true,
  });
  return data;
}

const getMeta = (data) => data[META] || {};
const num = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};
const isCNCode = (code) => /^(sh|sz|bj)\d{6}$/.test(code);
const isHKCode = (code) => /^hk(\d{5}|[A-Z]+)$/.test(code);
const isTXCode = (code) => isCNCode(code) || isHKCode(code);
const fmtCNTime = (value) => value && value.length >= 12
  ? `${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`
  : value;
const fmtHKTime = (value) => {
  const match = /^\d{4}\/(\d{2})\/(\d{2}) (\d{2}:\d{2})/.exec(value || '');
  return match ? `${match[1]}-${match[2]} ${match[3]}` : value;
};
function isoTencentTime(value, market = 'cn') {
  const string = String(value || '');
  if (market === 'hk') {
    const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(string);
    return match
      ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+08:00`
      : '';
  }
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(string);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+08:00`
    : '';
}
function isoMinuteTime(date, time) {
  if (!/^\d{8}$/.test(String(date || '')) || !/^\d{2}:\d{2}$/.test(String(time || ''))) {
    return '';
  }
  const string = String(date);
  return `${string.slice(0, 4)}-${string.slice(4, 6)}-${string.slice(6, 8)}T${time}:00+08:00`;
}

function tencentDeps(fetchText) {
  return {
    fetchText,
    annotateMarketData,
    num,
    isHKCode,
    fmtCNTime,
    fmtHKTime,
    isoTencentTime,
    isoMinuteTime,
  };
}

function turnoverPayload(code, sessions) {
  return { data: { [code]: { data: sessions } } };
}

test('HTTP client 保留请求头、编码与 429 两阶段退避', async () => {
  const calls = [];
  const waits = [];
  const body = new TextEncoder().encode('成功').buffer;
  const client = createHttpClient({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (calls.length < 3) return { status: 429, ok: false, arrayBuffer: async () => body };
      return { status: 200, ok: true, arrayBuffer: async () => body };
    },
    sleep: async (ms) => waits.push(ms),
    timeoutSignal: () => 'timeout-signal',
  });

  const text = await client.fetchText('https://example.test/data', {
    referer: 'https://example.test/',
    ua: 'fixture-agent',
  });

  assert.equal(text, '成功');
  assert.deepEqual(waits, [1500, 3000]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].options, {
    headers: { 'User-Agent': 'fixture-agent', Referer: 'https://example.test/' },
    signal: 'timeout-signal',
  });
});

test('Yahoo provider 的所有请求共享同一条串行队列', async () => {
  const starts = [];
  let releaseFirst;
  const yahoo = createYahooProvider({
    fetchText: async (url, options) => {
      starts.push({ url, options });
      if (url === 'first') {
        return new Promise((resolve) => { releaseFirst = resolve; });
      }
      return 'second-result';
    },
    annotateMarketData,
    minIntervalMs: 0,
  });

  const first = yahoo.yahooFetch('first');
  const second = yahoo.yahooFetch('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts.map((call) => call.url), ['first']);
  assert.equal(starts[0].options.ua, 'Mozilla/5.0');

  releaseFirst('first-result');
  assert.equal(await first, 'first-result');
  assert.equal(await second, 'second-result');
  assert.deepEqual(starts.map((call) => call.url), ['first', 'second']);
});

test('多个 Yahoo provider 注入同一 runtime scheduler 后仍全局串行', async () => {
  const scheduler = createYahooScheduler();
  const starts = [];
  let releaseFirst;
  const makeProvider = (label) => createYahooProvider({
    fetchText: async (url) => {
      starts.push(`${label}:${url}`);
      if (url === 'first') return new Promise((resolve) => { releaseFirst = resolve; });
      return 'second-result';
    },
    annotateMarketData,
    minIntervalMs: 0,
    scheduler,
  });
  const firstProvider = makeProvider('a');
  const secondProvider = makeProvider('b');

  const first = firstProvider.yahooFetch('first');
  const second = secondProvider.yahooFetch('second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['a:first']);

  releaseFirst('first-result');
  assert.equal(await first, 'first-result');
  assert.equal(await second, 'second-result');
  assert.deepEqual(starts, ['a:first', 'b:second']);
});

test('Yahoo spark 含金额字段时声明基础币种金额单位', () => {
  const quotes = parseSparkQuotes({
    spark: {
      result: [{
        symbol: '^GSPC',
        response: [{
          meta: {
            currency: 'USD',
            exchangeTimezoneName: 'America/New_York',
            chartPreviousClose: 6000,
            regularMarketPrice: 6010,
            regularMarketTime: 1783968000,
          },
        }],
      }],
    },
  }, [{ code: '^GSPC', name: '标普500' }], { annotateMarketData });

  assert.equal(quotes[0].amount, 0);
  assert.equal(getMeta(quotes).amountUnit, 'base_currency');
});

test('Yahoo K线解析用复权因子同步调整整根 OHLC', () => {
  const result = {
    meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' },
    timestamp: [1598275800, 1598362200],
    indicators: {
      quote: [{
        open: [90, 49], close: [100, 50], high: [110, 52], low: [80, 48],
        volume: [1000, 1200],
      }],
      adjclose: [{ adjclose: [50, 50] }],
    },
  };
  const rows = parseYahooKline(result, { annotateMarketData });
  assert.deepEqual(rows.map(({ open, close, high, low }) => ({ open, close, high, low })), [
    { open: 45, close: 50, high: 55, low: 40 },
    { open: 49, close: 50, high: 52, low: 48 },
  ]);
  assert.equal(getMeta(rows).adjustmentBasis, 'split_dividend_adjusted');
  assert.equal(getMeta(rows).adjustmentCoverage, 1);
});

test('腾讯分时把累计成交量差分为每分钟成交量', async () => {
  const provider = createTencentProvider(tencentDeps(async () => JSON.stringify({
    data: {
      sh600000: {
        qt: { sh600000: ['', '', '', '', '10.5'] },
        data: {
          date: '20260713',
          data: ['0930 10.50 100', '0931 10.60 135', '0932 10.55 160'],
        },
      },
    },
  })));

  const minute = await provider.getMinute('sh600000');
  assert.deepEqual(minute.points.map((point) => point.vol), [100, 35, 25]);
  assert.deepEqual(minute.points.map((point) => point.t), ['09:30', '09:31', '09:32']);
  assert.equal(getMeta(minute).asOf, '2026-07-13T09:32:00+08:00');
});

test('腾讯市场成交额取第四列，并按沪深共同分钟与前一交易日同期对齐', () => {
  const payloads = {
    sh000001: turnoverPayload('sh000001', [
      {
        date: '20260713',
        data: ['0930 10 800000 80', '1000 11 2800000 280', '1500 12 9000000 1000'],
      },
      {
        date: '20260714',
        data: ['0930 10 1000000 100', '1000 11 3000000 300', '1001 12 9999999 999'],
      },
    ]),
    sz399001: turnoverPayload('sz399001', [
      {
        date: '20260714',
        data: ['0930 20 2000000 200', '1000 21 4000000 400'],
      },
      {
        date: '20260713',
        data: ['0930 20 1800000 180', '1000 21 3200000 320', '1500 22 9900000 1200'],
      },
    ]),
  };

  const sessions = parseTencentTurnoverSessions(payloads.sh000001, 'sh000001');
  assert.deepEqual(sessions.map((session) => session.date), ['20260714', '20260713']);
  assert.equal(sessions[0].points.at(-1).amount, 999, '金额来自第四列，不得误取累计成交量');

  const result = parseTencentMarketTurnover(payloads, 'cn');
  assert.equal(result.turnover, 700, '沪市迟到的 10:01 数据必须丢弃');
  assert.deepEqual(result.comparison, {
    available: true,
    previous: 600,
    change: 100,
    changePct: 16.67,
    mode: 'previous_trading_day_same_time',
    currentDate: '2026-07-14',
    previousDate: '2026-07-13',
    asOfTime: '10:00',
    basis: 'sh_sz_market_total',
  });
});

test('前一交易日缺少完全相同分钟时不冒充同期成交额', () => {
  const current = (code, amount) => turnoverPayload(code, [
    { date: '20260714', data: [`1000 10 100 ${amount}`] },
    { date: '20260713', data: [`0959 10 90 ${amount - 10}`] },
  ]);
  const result = parseTencentMarketTurnover({
    sh000001: current('sh000001', 100),
    sz399001: current('sz399001', 200),
  }, 'cn');
  assert.equal(result.turnover, 300);
  assert.equal(result.comparison.available, false);
  assert.equal(result.comparison.previous, null);
  assert.equal(result.comparison.reason, 'previous_same_time_missing');
  assert.equal(result.comparison.asOfTime, '10:00');
});

test('腾讯港股成交额收盘后做收盘对收盘，缺失金额不补零', () => {
  const complete = parseTencentMarketTurnover({
    hkHSI: turnoverPayload('hkHSI', [
      { date: '20260714', data: ['1600 24340 31291554 3000'] },
      { date: '20260713', data: ['1600 24213 30951461 2500'] },
    ]),
  }, 'hk');
  assert.deepEqual(complete, {
    turnover: 3000,
    comparison: {
      available: true,
      previous: 2500,
      change: 500,
      changePct: 20,
      mode: 'previous_trading_day_close',
      currentDate: '2026-07-14',
      previousDate: '2026-07-13',
      asOfTime: '16:00',
      basis: 'tencent_hsi_market_turnover',
    },
  });

  const missing = parseTencentMarketTurnover({
    hkHSI: turnoverPayload('hkHSI', [
      { date: '20260714', data: ['1600 24340 31291554 invalid'] },
      { date: '20260713', data: ['1600 24213 30951461 2500'] },
    ]),
  }, 'hk');
  assert.equal(missing.turnover, null);
  assert.equal(missing.comparison.available, false);
  assert.equal(missing.comparison.previous, null);
  assert.equal(missing.comparison.reason, 'current_turnover_missing');
});

test('腾讯成交额 provider 并行请求沪深并保留基础币种元数据', async () => {
  const calls = [];
  const fixtures = {
    sh000001: turnoverPayload('sh000001', [
      { date: '20260714', data: ['1500 10 10000 1000'] },
      { date: '20260713', data: ['1500 10 9000 900'] },
    ]),
    sz399001: turnoverPayload('sz399001', [
      { date: '20260714', data: ['1500 20 20000 2000'] },
      { date: '20260713', data: ['1500 20 18000 1800'] },
    ]),
  };
  const provider = createTencentProvider(tencentDeps(async (url) => {
    calls.push(url);
    const code = new URL(url).searchParams.get('code');
    return JSON.stringify(fixtures[code]);
  }));

  const result = await provider.getMarketTurnover('cn');
  assert.deepEqual(calls.map((url) => new URL(url).searchParams.get('code')).sort(), [
    'sh000001', 'sz399001',
  ]);
  assert.equal(result.turnover, 3000);
  assert.equal(result.comparison.previous, 2700);
  assert.equal(getMeta(result).currency, 'CNY');
  assert.equal(getMeta(result).amountUnit, 'base_currency');
  assert.equal(getMeta(result).asOf, '2026-07-14T15:00:00+08:00');
  assert.match(getMeta(result).coverage.turnover, /不含北交所/);
});

test('腾讯港股 K 线使用 hkfqkline，港股报价不误用 A 股单位和字段', async () => {
  const calls = [];
  const fields = Array(50).fill('');
  Object.assign(fields, {
    1: '腾讯控股', 3: '500', 4: '495', 5: '498',
    30: '2026/07/13 16:08:11', 31: '5', 32: '1.01',
    33: '505', 34: '490', 36: '12345', 37: '6789000',
    38: '0', 39: '20', 43: '3.03', 45: '48000', 46: 'Tencent',
    48: '510', 49: '300',
  });
  const provider = createTencentProvider(tencentDeps(async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/hkfqkline/')) {
      return JSON.stringify({
        data: { hk00700: { qfqday: [['2026-07-11', '490', '500', '505', '488', '1000']] } },
      });
    }
    return `v_hk00700="${fields.join('~')}";`;
  }));

  const kline = await provider.getKline('hk00700', 90, 'day');
  const quote = await provider.getQuote('hk00700');

  assert.match(calls[0].url, /\/hkfqkline\/get\?param=hk00700,day,,,90,qfq$/);
  assert.equal(getMeta(kline).adjustmentBasis, 'provider_qfq');
  assert.deepEqual(calls[1].options, { encoding: 'gbk' });
  assert.equal(quote.volume, 12345);
  assert.equal(quote.amount, 6789000);
  assert.equal(quote.mktcap, 48000 * 1e8);
  assert.equal(quote.time, '07-13 16:08');
  assert.equal(quote.asOf, '2026-07-13T16:08:11+08:00');
  for (const absent of ['turnoverRate', 'pb', 'bids', 'asks']) {
    assert.equal(Object.hasOwn(quote, absent), false, absent);
  }
});

test('新浪 A 股榜单继续过滤新股、ST、低价和低成交额', () => {
  const row = (symbol, name, trade, amount) => ({
    symbol, name, trade, amount, pricechange: 1, changepercent: 10, turnoverratio: 2,
  });
  const rank = parseSinaRankCN([
    row('sh600001', 'N新股', 20, 5e7),
    row('sh600002', 'ST风险', 20, 5e7),
    row('sh600003', '低价股', 0.9, 5e7),
    row('sh600004', '无量股', 20, 1e7),
    row('sh600005', '正常股份', 20, 5e7),
  ], 20, { annotateMarketData, num });
  assert.deepEqual(rank.map((item) => item.code), ['sh600005']);
  assert.equal(getMeta(rank).amountUnit, 'base_currency');
});

test('新浪港股榜单并行抓三页并按原顺序质量过滤', async () => {
  const urls = [];
  const provider = createSinaProvider({
    fetchText: async (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const fixtures = {
        1: [
          { symbol: '00001', name: '仙股', lasttrade: 0.5, amount: 9e7 },
          { symbol: '00002', name: '合格一', lasttrade: 10, amount: 3e7, pricechange: 1, changepercent: 11 },
        ],
        2: [
          { symbol: '00003', name: '无量股', lasttrade: 10, amount: 1e7 },
          { symbol: '00004', name: '合格二', lasttrade: 8, amount: 4e7, pricechange: 1, changepercent: 9 },
        ],
        3: [{ symbol: '00005', name: '合格三', lasttrade: 7, amount: 5e7 }],
      };
      return JSON.stringify(fixtures[page]);
    },
    annotateMarketData,
    isCNCode,
    num,
  });

  const rank = await provider.getRankHK('up', 2);
  assert.equal(urls.length, 3);
  assert.deepEqual(rank.map((item) => item.code), ['hk00002', 'hk00004']);
});

test('Yahoo 涨跌榜请求行业字段，并安全规范化可选行业分类', async () => {
  let requestedUrl = '';
  const payload = {
    finance: {
      result: [{
        quotes: [
          null,
          {
            symbol: 'AAPL', shortName: 'Apple', currency: 'USD',
            regularMarketPrice: 200, regularMarketChange: 2,
            regularMarketChangePercent: 1, fullExchangeName: 'NasdaqGS',
            sector: '  <b>Technology</b>\u0000  ',
            industry: { raw: ' Consumer   Electronics ' },
          },
          {
            symbol: 'ETF', shortName: 'ETF', currency: 'USD',
            regularMarketPrice: 10, sector: ['invalid'], industry: null,
          },
        ],
      }],
    },
  };
  const provider = createYahooProvider({
    fetchText: async (url) => {
      requestedUrl = url;
      return JSON.stringify(payload);
    },
    annotateMarketData,
    scheduler: { run: (task) => task() },
    minIntervalMs: 0,
  });

  const rank = await provider.getRank('up', 2);
  assert.deepEqual(new URL(requestedUrl).searchParams.get('fields').split(','), [
    'symbol',
    'shortName',
    'longName',
    'currency',
    'regularMarketPrice',
    'regularMarketChange',
    'regularMarketChangePercent',
    'fullExchangeName',
    'sector',
    'industry',
  ]);
  assert.equal(rank.length, 2, '异常空行不应占用返回名额');
  assert.deepEqual(rank[0], {
    code: 'AAPL',
    name: 'Apple',
    currency: 'USD',
    price: 200,
    change: 2,
    changePct: 1,
    market: 'NasdaqGS',
    sector: 'Technology',
    industry: 'Consumer Electronics',
  });
  assert.equal(Object.hasOwn(rank[1], 'sector'), false);
  assert.equal(Object.hasOwn(rank[1], 'industry'), false);

  const capped = parseYahooRank({
    finance: { result: [{ quotes: [{ symbol: 'LONG', sector: 'x'.repeat(300) }] }] },
  }, 1, { annotateMarketData, num });
  assert.equal(capped[0].sector.length, 200);
});

test('新浪个股资讯仅接受新浪域名、清理锚点并拒绝结构漂移', () => {
  const pageUrl = 'https://vip.stock.finance.sina.com.cn/corp/example.phtml';
  const html = `
    <div class="datelist">
      2026-07-13 09:30 <a href="https://finance.sina.com.cn/a.shtml#section">公司公告 &amp; 进展</a>
      2026-07-13 09:20 <a href="https://evil.example/a">伪造消息</a>
    </div>`;
  const items = parseSinaStockNewsPage(html, pageUrl);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '公司公告 & 进展');
  assert.equal(items[0].url, 'https://finance.sina.com.cn/a.shtml');

  assert.throws(
    () => parseSinaStockNewsPage('<div class="datelist"><a href="/bad">无日期</a></div>', pageUrl),
    /资讯解析失败/
  );
  assert.throws(() => parseSinaStockNewsPage('<main>empty</main>', pageUrl), /缺少 datelist/);
});

function facadeHarness({ marketTurnoverError = false } = {}) {
  const calls = [];
  const yahoo = {
    getIndices: async () => { calls.push(['yahoo.indices']); return []; },
    getMinute: async (code) => { calls.push(['yahoo.minute', code]); return { code }; },
    getKline: async (...args) => { calls.push(['yahoo.kline', ...args]); return []; },
    getQuote: async (code) => { calls.push(['yahoo.quote', code]); return { code }; },
    getQuotes: async (codes) => codes.map((code) => ({ code, asOf: '2026-07-13T20:00:00Z' })),
    getRank: async (...args) => { calls.push(['yahoo.rank', ...args]); return []; },
    getOverview: async () => { calls.push(['yahoo.overview']); return []; },
  };
  const tencent = {
    getIndices: async (market) => { calls.push(['tencent.indices', market]); return []; },
    getMinute: async (code) => { calls.push(['tencent.minute', code]); return { code }; },
    getKline: async (...args) => { calls.push(['tencent.kline', ...args]); return []; },
    getSectors: async () => [],
    getMarketTurnover: async (market) => {
      calls.push(['tencent.marketTurnover', market]);
      if (marketTurnoverError) throw new Error('turnover unavailable');
      const turnover = market === 'hk' ? 300 : 175;
      return annotateMarketData({
        turnover,
        comparison: {
          available: true,
          previous: market === 'hk' ? 250 : 140,
          change: market === 'hk' ? 50 : 35,
          changePct: 25,
          mode: 'previous_trading_day_close',
          currentDate: '2026-07-14',
          previousDate: '2026-07-13',
          asOfTime: market === 'hk' ? '16:00' : '15:00',
          basis: market === 'hk' ? 'tencent_hsi_market_turnover' : 'sh_sz_market_total',
        },
      }, { market, currency: market === 'hk' ? 'HKD' : 'CNY', amountUnit: 'base_currency' });
    },
    getQuote: async (code) => { calls.push(['tencent.quote', code]); return { code }; },
    getQuotes: async (codes) => codes.map((code) => ({
      code,
      // 绝对时间是 2026-07-13T17:00:00Z；字符串日期却比 Yahoo 的 20:00Z 大。
      asOf: '2026-07-14T01:00:00+08:00',
    })),
    searchStocks: async () => [],
  };
  const sina = {
    getRankCN: async (...args) => { calls.push(['sina.rankCN', ...args]); return []; },
    getRankHK: async (...args) => { calls.push(['sina.rankHK', ...args]); return []; },
    countLimit: async (dir) => dir === 'up'
      ? { count: 2, complete: true }
      : { count: 1, complete: false },
    getNews: async () => [],
    getStockNewsCN: async () => [],
    getProfileCN: async (code) => { calls.push(['sina.profileCN', code]); return { code }; },
    getProfileHK: async (code) => { calls.push(['sina.profileHK', code]); return { code }; },
  };
  const nasdaq = {
    getProfile: async (code) => { calls.push(['nasdaq.profile', code]); return { code }; },
  };
  return {
    calls,
    service: createMarketData({
      yahoo,
      tencent,
      sina,
      nasdaq,
      annotateMarketData,
      isCNCode,
      isHKCode,
      isTXCode,
    }),
  };
}

test('market-data facade 只负责跨市场路由，并保持批量报价输入顺序', async () => {
  const { service, calls } = facadeHarness();
  await service.getIndices('us');
  await service.getIndices('hk');
  await service.getMinute('AAPL');
  await service.getMinute('hk00700');
  await service.getKline('sh600000', 90, 'day');
  await service.getQuote('MSFT');
  await service.getProfile('sh600000');
  await service.getProfile('hk00700');
  await service.getProfile('AAPL');
  const quotes = await service.getQuotes(['AAPL', 'sh600000', 'hk00700', 'MSFT']);

  assert.deepEqual(calls, [
    ['yahoo.indices'],
    ['tencent.indices', 'hk'],
    ['yahoo.minute', 'AAPL'],
    ['tencent.minute', 'hk00700'],
    ['tencent.kline', 'sh600000', 90, 'day'],
    ['yahoo.quote', 'MSFT'],
    ['sina.profileCN', 'sh600000'],
    ['sina.profileHK', 'hk00700'],
    ['nasdaq.profile', 'AAPL'],
  ]);
  assert.deepEqual(quotes.map((quote) => quote.code), ['AAPL', 'sh600000', 'hk00700', 'MSFT']);
  assert.equal(quotes[0].market, 'us');
  assert.equal(getMeta(quotes).source, '腾讯行情 / Yahoo Finance');
  assert.equal(getMeta(quotes).asOf, '2026-07-13T20:00:00Z');
  assert.equal(getMeta(quotes).amountUnit, 'base_currency');
});

test('market-data facade 用缓存板块 entry 组合 A 股宽度和涨跌停完整性', async () => {
  const { service } = facadeHarness();
  const result = await service.getOverviewCN({
    data: [
      { up: 2, total: 3, turnover: 100 },
      { up: 1, total: 2, turnover: 50 },
    ],
    fetchedAt: Date.parse('2026-07-13T08:00:00Z'),
    stale: true,
    staleSince: Date.parse('2026-07-13T07:59:00Z'),
  });
  assert.deepEqual(summarizeSectorBreadth([{ up: 3, total: 5, turnover: 150 }]), {
    up: 3, nonUp: 2, total: 5, turnover: 150,
  });
  assert.equal(result.up, 3);
  assert.equal(result.nonUp, 2);
  assert.equal(result.sectorTurnover, 150);
  assert.equal(result.turnover, 175);
  assert.equal(result.comparison.previous, 140);
  assert.equal(result.comparison.basis, 'sh_sz_market_total');
  assert.equal(result.limitUp, 2);
  assert.equal(result.limitDown, 1);
  assert.equal(result.limitCountComplete, false);
  assert.equal(getMeta(result).stale, true);
  assert.equal(getMeta(result).asOf, '2026-07-14T15:00:00+08:00');
  assert.equal(getMeta(result).asOfBasis, 'provider');
  assert.equal(getMeta(result).coverage.priceLimitComplete, false);
});

test('A 股成交额历史源失败时降级为行业汇总且不伪造比较', async () => {
  const { service } = facadeHarness({ marketTurnoverError: true });
  const result = await service.getOverviewCN({
    data: [
      { up: 2, total: 3, turnover: 100 },
      { up: 1, total: 2, turnover: 50 },
    ],
    fetchedAt: Date.parse('2026-07-13T08:00:00Z'),
    stale: false,
    staleSince: null,
  });

  assert.equal(result.sectorTurnover, 150);
  assert.equal(result.turnover, 150);
  assert.equal(result.comparison.available, false);
  assert.equal(result.comparison.previous, null);
  assert.equal(result.comparison.basis, 'sector_sum_fallback');
  assert.equal(result.comparison.reason, 'market_turnover_unavailable');
  assert.equal(getMeta(result).asOfBasis, 'fetch_time');
  assert.equal(getMeta(result).coverage.turnoverBasis, 'sector_sum_fallback');
});

test('港股概况直接复用腾讯同源成交额与元数据', async () => {
  const { service, calls } = facadeHarness();
  const result = await service.getOverviewHK();
  assert.deepEqual(calls, [['tencent.marketTurnover', 'hk']]);
  assert.equal(result.turnover, 300);
  assert.equal(result.comparison.previous, 250);
  assert.equal(getMeta(result).currency, 'HKD');
  assert.equal(getMeta(result).amountUnit, 'base_currency');
});
