'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CACHE_TTL,
  cacheKeys,
  createMarketService,
} = require('../src/services/market-service');

function createHarness({ marketOpen = true } = {}) {
  const cacheCalls = [];
  const providerCalls = [];
  const provider = (name) => async (...args) => {
    providerCalls.push({ name, args });
    return { provider: name, args };
  };
  const researchProvider = provider('getResearchCardEntry');
  const deps = {
    cachedEntry: async (key, ttl, loader) => {
      const data = await loader();
      cacheCalls.push({ key, ttl });
      return { data, fetchedAt: 123, stale: false, staleSince: null };
    },
    getIndices: provider('getIndices'),
    getMinute: provider('getMinute'),
    getKline: provider('getKline'),
    getResearchCardEntry: async (code) => ({
      data: await researchProvider(code),
      fetchedAt: 456,
      stale: false,
      staleSince: null,
    }),
    getSectors: provider('getSectors'),
    getRankCN: provider('getRankCN'),
    getRankHK: provider('getRankHK'),
    getRankUS: provider('getRankUS'),
    getOverviewCN: provider('getOverviewCN'),
    getOverviewUS: provider('getOverviewUS'),
    getQuote: provider('getQuote'),
    getQuotes: provider('getQuotes'),
    searchStocks: provider('searchStocks'),
    getNews: provider('getNews'),
    isTXCode: (code) => /^(?:sh|sz|bj|hk)/.test(code),
    isMarketOpen: (market) => typeof marketOpen === 'function'
      ? marketOpen(market)
      : marketOpen,
  };
  return {
    service: createMarketService(deps),
    cacheCalls,
    providerCalls,
  };
}

test('缓存 TTL 与 key 保持当前服务端契约', () => {
  assert.deepEqual(CACHE_TTL, {
    indices: 15000,
    minuteTX: 30000,
    minuteOther: 60000,
    kline: 300000,
    sectors: 30000,
    rankClosed: 600000,
    rankCNHKOpen: 30000,
    rankUSOpen: 90000,
    overview: 60000,
    quote: 15000,
    quotes: 30000,
    search: 300000,
    news: 180000,
  });
  assert.equal(cacheKeys.indices('hk'), 'idx:hk');
  assert.equal(cacheKeys.minute('AAPL'), 'min:AAPL');
  assert.equal(cacheKeys.kline('sh600519', 90, 'day'), 'k:sh600519:90:day');
  assert.equal(cacheKeys.sectors(), 'sectors');
  assert.equal(cacheKeys.rank('us', 'down'), 'rank:us:down');
  assert.equal(cacheKeys.rank('us', 'down', 'open'), 'rank:us:down:open');
  assert.equal(cacheKeys.overview('cn'), 'overview:cn');
  assert.equal(cacheKeys.quote('AAPL'), 'q:AAPL');
  assert.equal(cacheKeys.quotes(['sh600519', 'AAPL']), 'qs:sh600519,AAPL');
  assert.equal(cacheKeys.search('茅台'), 's:茅台');
  assert.equal(cacheKeys.news(), 'news');
});

test('各方法使用对应 cache key、TTL 与 provider，并统一返回 entry', async () => {
  const cases = [
    {
      invoke: (service) => service.indices('hk'),
      key: 'idx:hk', ttl: 15000, provider: 'getIndices', args: ['hk'],
    },
    {
      invoke: (service) => service.minute('sh600519'),
      key: 'min:sh600519', ttl: 30000, provider: 'getMinute', args: ['sh600519'],
    },
    {
      invoke: (service) => service.minute('AAPL'),
      key: 'min:AAPL', ttl: 60000, provider: 'getMinute', args: ['AAPL'],
    },
    {
      invoke: (service) => service.kline('AAPL', 400, 'invalid'),
      key: 'k:AAPL:400:day', ttl: 300000, provider: 'getKline', args: ['AAPL', 400, 'day'],
    },
    {
      invoke: (service) => service.sectors(),
      key: 'sectors', ttl: 30000, provider: 'getSectors', args: [],
    },
    {
      invoke: (service) => service.overview('us'),
      key: 'overview:us', ttl: 60000, provider: 'getOverviewUS', args: [],
    },
    {
      invoke: (service) => service.quote('hk00700'),
      key: 'q:hk00700', ttl: 15000, provider: 'getQuote', args: ['hk00700'],
    },
    {
      invoke: (service) => service.quotes(['sh600519', 'AAPL']),
      key: 'qs:sh600519,AAPL', ttl: 30000, provider: 'getQuotes', args: [['sh600519', 'AAPL']],
    },
    {
      invoke: (service) => service.search('  贵州茅台  '),
      key: 's:贵州茅台', ttl: 300000, provider: 'searchStocks', args: ['贵州茅台'],
    },
    {
      invoke: (service) => service.news(),
      key: 'news', ttl: 180000, provider: 'getNews', args: [],
    },
  ];

  for (const item of cases) {
    const { service, cacheCalls, providerCalls } = createHarness();
    const entry = await item.invoke(service);
    assert.deepEqual(cacheCalls, [{ key: item.key, ttl: item.ttl }], item.key);
    assert.deepEqual(providerCalls, [{ name: item.provider, args: item.args }], item.key);
    assert.equal(entry.fetchedAt, 123, item.key);
    assert.equal(entry.stale, false, item.key);
    assert.deepEqual(entry.data, { provider: item.provider, args: item.args }, item.key);
  }
});

test('非法 K 线天数回退为 90，研究卡所需 400 天不被截断', async () => {
  for (const days of [0, -1, NaN, 'bad']) {
    const { service, cacheCalls, providerCalls } = createHarness();
    await service.kline('AAPL', days, 'day');
    assert.deepEqual(cacheCalls, [{ key: 'k:AAPL:90:day', ttl: 300000 }]);
    assert.deepEqual(providerCalls, [{ name: 'getKline', args: ['AAPL', 90, 'day'] }]);
  }

  const { service, cacheCalls, providerCalls } = createHarness();
  await service.kline('sh600519', 400, 'day');
  assert.deepEqual(cacheCalls, [{ key: 'k:sh600519:400:day', ttl: 300000 }]);
  assert.deepEqual(providerCalls, [{ name: 'getKline', args: ['sh600519', 400, 'day'] }]);
});

test('research 直接复用 getResearchCardEntry 返回的 entry', async () => {
  const { service, cacheCalls, providerCalls } = createHarness();
  const entry = await service.research('sh600519');
  assert.deepEqual(cacheCalls, []);
  assert.deepEqual(providerCalls, [{ name: 'getResearchCardEntry', args: ['sh600519'] }]);
  assert.equal(entry.fetchedAt, 456);
  assert.deepEqual(entry.data, { provider: 'getResearchCardEntry', args: ['sh600519'] });
});

test('A股概况通过统一 sectors 查询注入板块数据', async () => {
  const { service, cacheCalls, providerCalls } = createHarness();
  const entry = await service.overview('cn');
  const sectorData = { provider: 'getSectors', args: [] };
  const sectorEntry = { data: sectorData, fetchedAt: 123, stale: false, staleSince: null };
  assert.deepEqual(cacheCalls, [
    { key: 'sectors', ttl: 30000 },
    { key: 'overview:cn', ttl: 60000 },
  ]);
  assert.deepEqual(providerCalls, [
    { name: 'getSectors', args: [] },
    { name: 'getOverviewCN', args: [sectorEntry] },
  ]);
  assert.deepEqual(entry.data, { provider: 'getOverviewCN', args: [sectorEntry] });
});

test('rank 按市场选择 provider，盘中使用市场 TTL，收盘后统一 10 分钟', async () => {
  const openCases = [
    { market: 'cn', dir: 'up', provider: 'getRankCN', ttl: 30000 },
    { market: 'hk', dir: 'down', provider: 'getRankHK', ttl: 30000 },
    { market: 'us', dir: 'up', provider: 'getRankUS', ttl: 90000 },
  ];
  for (const item of openCases) {
    const { service, cacheCalls, providerCalls } = createHarness({ marketOpen: true });
    await service.rank(item.market, item.dir);
    assert.deepEqual(cacheCalls, [{
      key: `rank:${item.market}:${item.dir}:open`,
      ttl: item.ttl,
    }]);
    assert.deepEqual(providerCalls, [{ name: item.provider, args: [item.dir] }]);
  }

  for (const item of openCases) {
    const { service, cacheCalls, providerCalls } = createHarness({ marketOpen: false });
    await service.rank(item.market, item.dir);
    assert.deepEqual(cacheCalls, [{
      key: `rank:${item.market}:${item.dir}:closed`,
      ttl: 600000,
    }]);
    assert.deepEqual(providerCalls, [{ name: item.provider, args: [item.dir] }]);
  }
});

test('rank 开闭市使用独立 key，避免旧缓存或在途请求跨状态污染', async () => {
  let open = false;
  const { service, cacheCalls } = createHarness({
    marketOpen: () => open,
  });

  await service.rank('cn', 'up');
  assert.deepEqual(cacheCalls.at(-1), { key: 'rank:cn:up:closed', ttl: 600000 });

  open = true;
  await service.rank('cn', 'up');
  assert.deepEqual(cacheCalls.at(-1), { key: 'rank:cn:up:open', ttl: 30000 });
});

test('市场和方向默认值保持当前路由行为', async () => {
  {
    const { service, cacheCalls, providerCalls } = createHarness();
    await service.indices('invalid');
    assert.deepEqual(cacheCalls, [{ key: 'idx:cn', ttl: 15000 }]);
    assert.deepEqual(providerCalls, [{ name: 'getIndices', args: ['cn'] }]);
  }
  {
    const { service, cacheCalls, providerCalls } = createHarness();
    await service.rank('invalid', 'invalid');
    assert.deepEqual(cacheCalls, [{ key: 'rank:cn:up:open', ttl: 30000 }]);
    assert.deepEqual(providerCalls, [{ name: 'getRankCN', args: ['up'] }]);
  }
  {
    const { service, cacheCalls, providerCalls } = createHarness();
    await service.overview('hk');
    const sectorData = { provider: 'getSectors', args: [] };
    const sectorEntry = { data: sectorData, fetchedAt: 123, stale: false, staleSince: null };
    assert.deepEqual(cacheCalls, [
      { key: 'sectors', ttl: 30000 },
      { key: 'overview:cn', ttl: 60000 },
    ]);
    assert.deepEqual(providerCalls, [
      { name: 'getSectors', args: [] },
      { name: 'getOverviewCN', args: [sectorEntry] },
    ]);
  }
});

test('quotes 与 search 空输入即时返回 non-stale entry 且不访问缓存或 provider', async () => {
  const { service, cacheCalls, providerCalls } = createHarness();
  const before = Date.now();
  const quotes = await service.quotes([]);
  const search = await service.search('   ');
  const after = Date.now();

  for (const entry of [quotes, search]) {
    assert.deepEqual(entry.data, []);
    assert.equal(entry.stale, false);
    assert.equal(entry.staleSince, null);
    assert.ok(entry.fetchedAt >= before && entry.fetchedAt <= after);
  }
  assert.deepEqual(cacheCalls, []);
  assert.deepEqual(providerCalls, []);
});
