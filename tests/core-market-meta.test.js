'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const marketMetaModule = require('../src/core/market-meta');
const {
  MARKET_DATA_META,
  MARKET_DEFAULTS,
  annotateMarketData,
  getMarketDataMeta,
  marketMeta,
} = marketMetaModule;

test('MARKET_DATA_META 在模块内唯一，注解可合并且不进入 JSON', () => {
  assert.equal(require('../src/core/market-meta').MARKET_DATA_META, MARKET_DATA_META);
  assert.equal(typeof MARKET_DATA_META, 'symbol');
  assert.equal(MARKET_DATA_META.description, 'marketDataMeta');

  const data = { value: 1 };
  assert.equal(annotateMarketData(data, { market: 'cn', source: 'first' }), data);
  annotateMarketData(data, { source: 'second', currency: 'CNY' });
  assert.deepEqual(getMarketDataMeta(data), {
    market: 'cn',
    source: 'second',
    currency: 'CNY',
  });
  assert.deepEqual(Object.getOwnPropertySymbols(data), [MARKET_DATA_META]);
  const descriptor = Object.getOwnPropertyDescriptor(data, MARKET_DATA_META);
  assert.equal(descriptor.enumerable, false);
  assert.equal(descriptor.writable, false);
  assert.equal(descriptor.configurable, true);
  assert.equal(JSON.stringify(data), '{"value":1}');

  assert.equal(annotateMarketData(null, { market: 'cn' }), null);
  assert.deepEqual(getMarketDataMeta('plain text'), {});
});

test('marketMeta 合并市场默认值、数据内口径和显式覆盖', () => {
  assert.deepEqual(MARKET_DEFAULTS, {
    cn: { currency: 'CNY', timezone: 'Asia/Shanghai' },
    hk: { currency: 'HKD', timezone: 'Asia/Hong_Kong' },
    us: { currency: 'USD', timezone: 'America/New_York' },
  });

  const data = annotateMarketData([], {
    market: 'cn',
    source: 'fixture',
    asOf: '2026-07-13T15:00:00+08:00',
    adjustmentBasis: 'provider_qfq',
    adjustmentCoverage: 0,
    coverage: { bars: 10 },
  });
  const meta = marketMeta({
    data,
    fetchedAt: 1000,
    stale: false,
    staleSince: null,
  }, {
    currency: null,
    stale: true,
    amountUnit: 'base_currency',
  });

  assert.equal(meta.schemaVersion, 1);
  assert.equal(meta.market, 'cn');
  assert.equal(meta.source, 'fixture');
  assert.equal(meta.currency, null);
  assert.equal(meta.timezone, 'Asia/Shanghai');
  assert.equal(meta.asOf, '2026-07-13T15:00:00+08:00');
  assert.equal(meta.asOfBasis, 'provider');
  assert.equal(meta.fetchedAt, '1970-01-01T00:00:01.000Z');
  assert.match(meta.requestedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(meta.stale, true);
  assert.equal(meta.staleSince, null);
  assert.equal(meta.adjustmentBasis, 'provider_qfq');
  assert.equal(meta.amountUnit, 'base_currency');
  assert.equal(meta.adjustmentCoverage, 0);
  assert.deepEqual(meta.coverage, { bars: 10 });
});

test('marketMeta 无上游时间时以 fetchedAt 为 asOf，并优先采用 entry staleSince', () => {
  const meta = marketMeta({
    data: {},
    fetchedAt: 1000,
    stale: true,
    staleSince: 2000,
  }, { market: 'hk' });

  assert.equal(meta.currency, 'HKD');
  assert.equal(meta.timezone, 'Asia/Hong_Kong');
  assert.equal(meta.asOf, '1970-01-01T00:00:01.000Z');
  assert.equal(meta.asOfBasis, 'fetch_time');
  assert.equal(meta.stale, true);
  assert.equal(meta.staleSince, '1970-01-01T00:00:02.000Z');
  assert.equal(meta.adjustmentBasis, 'none');
  assert.equal(meta.amountUnit, null);
  assert.equal(Object.hasOwn(meta, 'adjustmentCoverage'), false);
  assert.equal(Object.hasOwn(meta, 'coverage'), false);
});
