'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createStockEventsService } = require('../src/services/stock-events-service');
const {
  CACHE_WARM_INTERVAL_MS,
  createCacheWarmer,
} = require('../src/services/cache-warmer');

test('个股事件服务按 A/美股分缓存，并区分标题直指与 Yahoo 主次关联', async () => {
  let current = Date.parse('2026-07-13T08:00:00Z');
  const cacheCalls = [];
  const newsCalls = [];
  const service = createStockEventsService({
    cached: async (key, ttl, loader) => {
      cacheCalls.push({ key, ttl });
      return loader();
    },
    getStockNews: async (code) => {
      newsCalls.push(code);
      if (code === 'sh600519') return [{
        title: '贵州茅台发布业绩公告',
        time: current - 60000,
        source: '新浪财经',
        url: 'https://finance.sina.com.cn/example',
      }];
      return [{
        title: 'Apple announces a product launch',
        time: current - 60000,
        source: 'Reuters',
        url: 'https://finance.yahoo.com/news/apple',
        primaryTicker: 'MSFT',
        relatedTickers: ['MSFT', 'AAPL'],
      }, {
        title: 'Quarterly outlook changes',
        time: current - 120000,
        source: 'Example Wire',
        url: 'https://finance.yahoo.com/news/outlook',
        primaryTicker: 'AAPL',
        relatedTickers: ['AAPL'],
      }, {
        title: 'Semiconductor supply update',
        time: current - 180000,
        source: 'Example Wire',
        url: 'https://finance.yahoo.com/news/supply',
        primaryTicker: 'NVDA',
        relatedTickers: ['NVDA', 'AAPL'],
      }, {
        title: 'Pineapple demand update',
        time: current - 240000,
        source: 'Example Wire',
        url: 'https://finance.yahoo.com/news/pineapple',
        primaryTicker: 'AAPL',
        relatedTickers: ['AAPL'],
      }];
    },
    isCNCode: (code) => /^sh\d{6}$/.test(code),
    isHKCode: (code) => /^hk(?:\d{5}|[A-Z]+)$/.test(code),
    isKnownHKCode: (code) => /^hk\d{5}$/.test(code),
    now: () => current,
  });

  const cn = await service.getStockEvents('SH600519', { name: '贵州茅台' });
  const us = await service.getStockEvents('aapl', { name: 'Apple Inc.' });
  const unsupported = await service.getStockEvents('HK00700');

  assert.equal(service.normalizeCode(' aapl '), 'AAPL');
  assert.equal(service.supports('AAPL'), true);
  assert.equal(service.supports('F'), true);
  assert.equal(service.supports('hk00700'), false);
  assert.equal(service.supports('bad/ticker'), false);
  for (const code of ['^VIX', 'GC=F', 'BTC-USD', 'DX-Y.NYB']) {
    assert.equal(service.supports(code), false, code);
  }
  assert.deepEqual(cacheCalls, [
    { key: 'stock-events:cn:sh600519', ttl: 180000 },
    { key: 'stock-events:us:AAPL', ttl: 180000 },
  ]);
  assert.deepEqual(newsCalls, ['sh600519', 'AAPL']);
  assert.equal(cn.coverage.source, '新浪财经个股资讯');
  assert.equal(cn.events[0].relation, 'direct');
  assert.equal(us.stock.market, 'us');
  assert.equal(us.coverage.source, 'Yahoo Finance 美股个股资讯');
  assert.equal(us.events.find((item) => item.title.startsWith('Apple')).relation, 'direct');
  assert.equal(us.events.find((item) => item.title.startsWith('Quarterly')).relation, 'primary_symbol');
  assert.equal(us.events.find((item) => item.title.startsWith('Semiconductor')).relation, 'related_symbol');
  assert.equal(us.events.find((item) => item.title.startsWith('Pineapple')).relation, 'primary_symbol');
  assert.equal(service.selectStockEvents([{
    title: 'Neutral company update',
    time: current - 300000,
  }], { code: '' })[0].relation, 'stock_page');
  assert.equal(unsupported.coverage.supported, false);
  assert.equal(unsupported.stock.market, 'hk');
});

test('个股事件 bundle 保留抓取时间，旧缓存不会伪装成最新资讯', async () => {
  const current = Date.parse('2026-07-13T08:10:00Z');
  const fetchedAt = '2026-07-13T08:00:00.000Z';
  const service = createStockEventsService({
    cached: async () => ({
      fetchedAt,
      items: [{
        title: 'Apple earnings update',
        time: current - 60000,
        source: 'Reuters',
        url: 'https://finance.yahoo.com/news/apple-earnings',
        primaryTicker: 'AAPL',
        relatedTickers: ['AAPL'],
      }],
    }),
    getStockNews: async () => { throw new Error('loader should not run'); },
    isCNCode: (code) => /^(?:sh|sz|bj)\d{6}$/.test(code),
    isHKCode: (code) => /^hk(?:\d{5}|[A-Z]+)$/.test(code),
    isKnownHKCode: (code) => /^hk(?:\d{5}|HSI|HSCEI|HSTECH)$/.test(code),
    now: () => current,
  });

  const result = await service.getStockEvents('AAPL', { name: 'Apple Inc.' });
  assert.equal(result.asOf, fetchedAt);
  assert.equal(result.coverage.stale, true);
  assert.match(result.coverage.warning, /缓存已过期/);
  assert.equal(result.events[0].relation, 'direct');
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
