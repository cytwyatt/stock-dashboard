'use strict';

process.env.MARKET_DISABLE_WARM = '1';
process.env.MARKET_DATA_DIR = process.env.MARKET_DATA_DIR || '/tmp/market-test-data';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cachedEntry,
  cache,
  cnPriceLimitPct,
  isCNPriceLimit,
  summarizeSectorBreadth,
  parseYahooKline,
  getMarketDataMeta,
  marketMeta,
  isoTencentTime,
} = require('../server');

test('A股涨跌幅限制覆盖主板、创业/科创和北交所，并区分方向', () => {
  assert.equal(cnPriceLimitPct('sh600000'), 10);
  assert.equal(cnPriceLimitPct('sz000001'), 10);
  assert.equal(cnPriceLimitPct('sh688001'), 20);
  assert.equal(cnPriceLimitPct('sz300001'), 20);
  assert.equal(cnPriceLimitPct('bj920001'), 30);

  const row = (symbol, changepercent, name = '测试股份') => ({
    symbol, changepercent, name, trade: 10,
  });
  assert.equal(isCNPriceLimit(row('sh600000', 9.8), 'up'), true);
  assert.equal(isCNPriceLimit(row('sh600000', -9.8), 'up'), false);
  assert.equal(isCNPriceLimit(row('sh600000', -9.8), 'down'), true);
  assert.equal(isCNPriceLimit(row('sh688001', 19.8), 'up'), true);
  assert.equal(isCNPriceLimit(row('sz300001', -19.8), 'down'), true);
  assert.equal(isCNPriceLimit(row('bj920001', 29.79), 'up'), false);
  assert.equal(isCNPriceLimit(row('bj920001', 29.8), 'up'), true);
  assert.equal(isCNPriceLimit(row('bj920001', -29.8), 'down'), true);
  assert.equal(isCNPriceLimit(row('sh600000', 10, 'ST测试'), 'up'), false);
  assert.equal(isCNPriceLimit(row('sh600000', 10, 'N测试'), 'up'), false);
});

test('市场宽度只把可证明的数据称为上涨和未上涨', () => {
  const result = summarizeSectorBreadth([
    { up: 2, total: 3, turnover: 100 },
    { up: 1, total: 2, turnover: 50 },
  ]);
  assert.deepEqual(result, { up: 3, nonUp: 2, total: 5, turnover: 150 });
  assert.equal(result.up + result.nonUp, result.total);
});

function yahooFixture({ adjclose } = {}) {
  return {
    meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' },
    timestamp: [1598275800, 1598362200],
    indicators: {
      quote: [{
        open: [90, 49], close: [100, 50], high: [110, 52], low: [80, 48],
        volume: [1000, 1200],
      }],
      ...(adjclose ? { adjclose: [{ adjclose }] } : {}),
    },
  };
}

test('Yahoo复权因子同步调整整根OHLC，拆股不制造虚假暴跌', () => {
  const data = parseYahooKline(yahooFixture({ adjclose: [50, 50] }));
  assert.deepEqual(
    data.map((k) => ({ open: k.open, close: k.close, high: k.high, low: k.low })),
    [
      { open: 45, close: 50, high: 55, low: 40 },
      { open: 49, close: 50, high: 52, low: 48 },
    ]
  );
  assert.equal(data[1].close / data[0].close - 1, 0);
  const meta = getMarketDataMeta(data);
  assert.equal(meta.adjustmentBasis, 'split_dividend_adjusted');
  assert.equal(meta.adjustmentCoverage, 1);
  assert.equal(meta.currency, 'USD');
});

test('Yahoo缺少复权数据时明确标记raw fallback', () => {
  const data = parseYahooKline(yahooFixture());
  assert.deepEqual(data.map((k) => k.close), [100, 50]);
  assert.equal(getMarketDataMeta(data).adjustmentBasis, 'raw_fallback');
  assert.equal(getMarketDataMeta(data).adjustmentCoverage, 0);
});

test('缓存刷新失败保留成功抓取时间并暴露stale状态', async () => {
  const realNow = Date.now;
  const realError = console.error;
  let now = 1000;
  Date.now = () => now;
  console.error = () => {};
  cache.clear();
  try {
    const fresh = await cachedEntry('test:stale', 100, async () => ({ value: 1 }));
    assert.equal(fresh.fetchedAt, 1000);
    assert.equal(fresh.stale, false);

    now = 1200;
    const stale = await cachedEntry('test:stale', 100, async () => {
      throw new Error('upstream unavailable');
    });
    assert.deepEqual(stale.data, { value: 1 });
    assert.equal(stale.fetchedAt, 1000);
    assert.equal(stale.stale, true);
    assert.equal(stale.staleSince, 1200);

    const meta = marketMeta(stale, { market: 'cn', source: 'fixture' });
    assert.equal(meta.currency, 'CNY');
    assert.equal(meta.timezone, 'Asia/Shanghai');
    assert.equal(meta.stale, true);
    assert.equal(meta.asOf, new Date(1000).toISOString());

    now = 20000;
    const recovered = await cachedEntry('test:stale', 100, async () => ({ value: 2 }));
    assert.deepEqual(recovered.data, { value: 2 });
    assert.equal(recovered.fetchedAt, 20000);
    assert.equal(recovered.stale, false);
  } finally {
    cache.clear();
    Date.now = realNow;
    console.error = realError;
  }
});

test('腾讯行情时间被规范为带时区ISO 8601', () => {
  assert.equal(isoTencentTime('20260707161445', 'cn'), '2026-07-07T16:14:45+08:00');
  assert.equal(isoTencentTime('2026/07/09 16:08:11', 'hk'), '2026-07-09T16:08:11+08:00');
});
