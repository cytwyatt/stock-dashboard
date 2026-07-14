'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStockEventsService } = require('../src/services/stock-events-service');
const {
  CACHE_WARM_INTERVAL_MS,
  createCacheWarmer,
} = require('../src/services/cache-warmer');

test('个股事件服务保留专用 bundle 抓取时间与 stale 语义', async () => {
  let current = Date.parse('2026-07-13T08:00:00Z');
  const cacheCalls = [];
  const service = createStockEventsService({
    cached: async (key, ttl, loader) => {
      cacheCalls.push({ key, ttl });
      return loader();
    },
    getStockNewsCN: async () => [{
      title: '贵州茅台发布业绩公告',
      time: current - 60000,
      timeText: '2026-07-13 15:59',
      source: '新浪财经',
      url: 'https://finance.sina.com.cn/example',
    }],
    isCNCode: (code) => /^sh\d{6}$/.test(code),
    isHKCode: (code) => /^hk/.test(code),
    isKnownHKCode: (code) => /^hk\d{5}$/.test(code),
    now: () => current,
  });

  const result = await service.getStockEvents('SH600519', { name: '贵州茅台' });
  assert.deepEqual(cacheCalls, [{ key: 'stock-events:cn:sh600519', ttl: 180000 }]);
  assert.equal(result.coverage.stale, false);
  assert.equal(result.events[0].relation, 'direct');
  assert.equal(result.asOf, '2026-07-13T08:00:00.000Z');

  current += 181000;
  const unsupported = await service.getStockEvents('AAPL');
  assert.equal(unsupported.coverage.supported, false);
  assert.equal(unsupported.stock.market, 'us');
});

test('缓存预热只通过 marketService 调用当前开市市场', async () => {
  assert.ok(CACHE_WARM_INTERVAL_MS < 15000, '预热周期必须短于最短行情 TTL');
  const calls = [];
  const marketService = new Proxy({}, {
    get: (_, method) => async (...args) => { calls.push([method, ...args]); },
  });
  const warmer = createCacheWarmer({
    marketService,
    isMarketOpen: (market) => market === 'cn',
    logger: { error() {} },
  });
  warmer.warmOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['indices', 'cn'],
    ['minute', 'sh000001'],
    ['sectors'],
    ['rank', 'cn', 'up'],
    ['rank', 'cn', 'down'],
    ['overview', 'cn'],
    ['news'],
  ]);
});

test('港股开市时预热独立市场概况成交额', async () => {
  const calls = [];
  const marketService = new Proxy({}, {
    get: (_, method) => async (...args) => { calls.push([method, ...args]); },
  });
  const warmer = createCacheWarmer({
    marketService,
    isMarketOpen: (market) => market === 'hk',
    logger: { error() {} },
  });
  warmer.warmOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['indices', 'hk'],
    ['minute', 'hkHSI'],
    ['rank', 'hk', 'up'],
    ['rank', 'hk', 'down'],
    ['overview', 'hk'],
    ['news'],
  ]);
});
