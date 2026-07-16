'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CACHE_TTL,
  cacheKeys,
  PROFILE_INDUSTRY_LIMIT,
  PROFILE_INDUSTRY_CONCURRENCY,
  createMarketService,
} = require('../src/services/market-service');
const { createCacheRuntime } = require('../src/core/cache');
const { annotateMarketData, getMarketDataMeta } = require('../src/core/market-meta');

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
    getOverviewHK: provider('getOverviewHK'),
    getOverviewUS: provider('getOverviewUS'),
    getQuote: provider('getQuote'),
    getQuotes: provider('getQuotes'),
    getProfile: provider('getProfile'),
    searchStocks: provider('searchStocks'),
    getNews: provider('getNews'),
    getMarketDataMeta: () => ({}),
    annotateMarketData,
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
  assert.equal(PROFILE_INDUSTRY_LIMIT, 20);
  assert.equal(PROFILE_INDUSTRY_CONCURRENCY, 3);
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
    profile: 86400000,
    profileRefresh: 300000,
  });
  assert.equal(cacheKeys.indices('hk'), 'idx:hk');
  assert.equal(cacheKeys.minute('AAPL'), 'min:AAPL');
  assert.equal(cacheKeys.kline('sh600519', 90, 'day'), 'k:sh600519:90:day');
  assert.equal(cacheKeys.sectors(), 'sectors');
  assert.equal(cacheKeys.rank('us', 'down'), 'rank:us:down');
  assert.equal(cacheKeys.rank('us', 'down', 'open'), 'rank:us:down:open');
  assert.equal(cacheKeys.overview('cn'), 'overview:cn');
  assert.equal(cacheKeys.overview('hk'), 'overview:hk');
  assert.equal(cacheKeys.quote('AAPL'), 'q:AAPL');
  assert.equal(cacheKeys.quotes(['sh600519', 'AAPL']), 'qs:sh600519,AAPL');
  assert.equal(cacheKeys.search('茅台'), 's:茅台');
  assert.equal(cacheKeys.news(), 'news');
  assert.equal(cacheKeys.profile('AAPL'), 'profile:AAPL');
  assert.equal(cacheKeys.profileRefresh('AAPL'), 'profile-refresh:AAPL');
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
      invoke: (service) => service.overview('hk'),
      key: 'overview:hk', ttl: 60000, provider: 'getOverviewHK', args: [],
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

test('profile 以 5 分钟候选刷新完整 24 小时缓存', async () => {
  const { service, cacheCalls, providerCalls } = createHarness();
  const entry = await service.profile('AAPL');
  assert.deepEqual(cacheCalls, [
    { key: 'profile-refresh:AAPL', ttl: 300000 },
    { key: 'profile:AAPL', ttl: 86400000 },
  ]);
  assert.deepEqual(providerCalls, [{ name: 'getProfile', args: ['AAPL'] }]);
  assert.equal(entry.fetchedAt, 123);
});

function createProfileCacheHarness(loader) {
  let clock = 1000;
  const logs = [];
  const runtime = createCacheRuntime({
    now: () => clock,
    logger: { error: (message) => logs.push(message) },
  });
  const service = createMarketService({
    cachedEntry: runtime.cachedEntry,
    getProfile: loader,
    getMarketDataMeta,
    annotateMarketData,
  });
  return {
    service,
    logs,
    advance(ms) { clock += ms; },
  };
}

function profileData(version, complete, reason = null) {
  return annotateMarketData({ version }, {
    coverage: { complete, reason },
  });
}

test('过期完整 profile 不被 partial 覆盖，并在短周期后重试', async () => {
  let mode = 'complete-v1';
  let calls = 0;
  const harness = createProfileCacheHarness(async () => {
    calls++;
    if (mode === 'partial') return profileData('partial', false, 'industry_unavailable');
    return profileData(mode, true);
  });

  const first = await harness.service.profile('sh600519');
  assert.equal(first.data.version, 'complete-v1');
  assert.equal(first.stale, false);
  assert.equal(calls, 1);

  harness.advance(CACHE_TTL.profile + 1);
  mode = 'partial';
  const fallback = await harness.service.profile('sh600519');
  assert.equal(fallback.data.version, 'complete-v1');
  assert.equal(fallback.stale, true);
  assert.equal(getMarketDataMeta(fallback.data).coverage.complete, true);
  assert.equal(calls, 2);
  assert.match(harness.logs.at(-1), /industry_unavailable/);

  harness.advance(CACHE_TTL.profileRefresh + 1);
  mode = 'complete-v2';
  const refreshed = await harness.service.profile('sh600519');
  assert.equal(refreshed.data.version, 'complete-v2');
  assert.equal(refreshed.stale, false);
  assert.equal(calls, 3);
});

test('完整 profile 过期后上游失败时返回旧完整资料并标 stale', async () => {
  let fail = false;
  let calls = 0;
  const harness = createProfileCacheHarness(async () => {
    calls++;
    if (fail) throw new Error('profile upstream down');
    return profileData('complete', true);
  });

  await harness.service.profile('AAPL');
  harness.advance(CACHE_TTL.profile + 1);
  fail = true;
  const fallback = await harness.service.profile('AAPL');
  assert.equal(fallback.data.version, 'complete');
  assert.equal(fallback.stale, true);
  assert.equal(getMarketDataMeta(fallback.data).coverage.complete, true);
  assert.equal(calls, 2);
});

test('首次只有 partial 时照常返回并按 5 分钟缓存，刷新失败不伪装完整', async () => {
  let calls = 0;
  let fail = false;
  const harness = createProfileCacheHarness(async () => {
    calls++;
    if (fail) throw new Error('profile upstream down');
    return profileData('partial', false, 'business_summary_unavailable');
  });

  const first = await harness.service.profile('sh688001');
  assert.equal(first.data.version, 'partial');
  assert.equal(first.stale, false);
  assert.equal(getMarketDataMeta(first.data).coverage.complete, false);
  assert.equal(calls, 1);

  await harness.service.profile('sh688001');
  assert.equal(calls, 1);

  harness.advance(CACHE_TTL.profileRefresh + 1);
  fail = true;
  const stalePartial = await harness.service.profile('sh688001');
  assert.equal(stalePartial.data.version, 'partial');
  assert.equal(stalePartial.stale, true);
  assert.equal(getMarketDataMeta(stalePartial.data).coverage.complete, false);
  assert.equal(calls, 2);
});

test('profileIndustries 精简资料、逐项容错并聚合 partial/stale coverage', async () => {
  const fixtures = {
    OK: annotateMarketData({
      available: true, industry: '软件', sector: '科技', classificationBasis: '测试行业分类',
    }, { market: 'cn', source: '资料源A', timezone: 'Asia/Shanghai', coverage: { complete: true, industry: true } }),
    BIZPART: annotateMarketData({
      available: true, industry: '半导体', sector: null, classificationBasis: '测试行业分类',
    }, {
      market: 'cn', source: '资料源A', timezone: 'Asia/Shanghai',
      coverage: { complete: false, industry: true, reason: 'business_summary_unavailable' },
    }),
    INDPART: annotateMarketData({
      available: true, industry: null, sector: null, classificationBasis: '测试行业分类',
    }, {
      market: 'cn', source: '资料源A', timezone: 'Asia/Shanghai',
      coverage: { complete: false, industry: false, reason: 'industry_unavailable' },
    }),
    NONE: annotateMarketData({
      available: false, industry: null, sector: null, classificationBasis: 'Nasdaq Sector / Industry',
    }, { market: 'us', source: '资料源B', timezone: 'America/New_York' }),
    STALE: annotateMarketData({
      available: true, industry: '旧行业', sector: null, classificationBasis: '测试行业分类',
    }, { market: 'cn', source: '资料源A', timezone: 'Asia/Shanghai', coverage: { complete: true, industry: true } }),
  };
  const service = createMarketService({
    cachedEntry: async (key, ttl, loader) => {
      const data = await loader();
      const stale = key === 'profile:STALE';
      return { data, fetchedAt: 1000, stale, staleSince: stale ? 900 : null };
    },
    getProfile: async (code) => {
      if (code === 'ERR') throw new Error('upstream failed');
      return fixtures[code];
    },
    getMarketDataMeta,
    annotateMarketData,
  });

  const entry = await service.profileIndustries([
    'OK', 'BIZPART', 'INDPART', 'NONE', 'ERR', 'STALE',
  ]);
  assert.deepEqual(entry.data.map(({ code, status, stale }) => ({ code, status, stale })), [
    { code: 'OK', status: 'ok', stale: false },
    { code: 'BIZPART', status: 'ok', stale: false },
    { code: 'INDPART', status: 'partial', stale: false },
    { code: 'NONE', status: 'unavailable', stale: false },
    { code: 'ERR', status: 'error', stale: false },
    { code: 'STALE', status: 'stale', stale: true },
  ]);
  assert.deepEqual(entry.data[0], {
    code: 'OK', industry: '软件', sector: '科技', classificationBasis: '测试行业分类',
    status: 'ok', stale: false,
  });
  assert.deepEqual(entry.data[4], {
    code: 'ERR', industry: null, sector: null, classificationBasis: null,
    status: 'error', stale: false,
  });
  assert.equal(entry.stale, true);
  assert.equal(entry.fetchedAt, 1000, '聚合接口保留最早的实际资料抓取时间');
  assert.equal(entry.staleSince, 900);
  assert.deepEqual(getMarketDataMeta(entry.data).coverage, {
    requested: 6,
    withClassification: 3,
    ok: 2,
    unavailable: 1,
    partial: 1,
    error: 1,
    stale: 1,
    complete: false,
  });
  assert.equal(getMarketDataMeta(entry.data).market, null, '混合市场不得冒充单一市场');
  assert.equal(getMarketDataMeta(entry.data).source, '资料源A / 资料源B');
});

function createIndustryConcurrencyService(getProfile) {
  return createMarketService({
    cachedEntry: async (key, ttl, loader) => ({
      data: await loader(), fetchedAt: 1000, stale: false, staleSince: null,
    }),
    getProfile,
    getMarketDataMeta,
    annotateMarketData,
  });
}

test('profileIndustries 跨批次共享并发上限3，并在 service 层去重和限制20只', async () => {
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const service = createIndustryConcurrencyService(async (code) => {
    calls.push(code);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return annotateMarketData({ available: true, industry: `行业${code}` }, {
      source: '测试资料', coverage: { complete: true, industry: true },
    });
  });

  const codes = Array.from({ length: 25 }, (_, index) => `C${index}`);
  const [first, second] = await Promise.all([
    service.profileIndustries([codes[0].toLowerCase(), codes[0], ...codes]),
    service.profileIndustries(['X0', 'X1', 'X2', 'X3']),
  ]);
  assert.equal(maxActive, 3);
  assert.equal(first.data.length, 20);
  assert.deepEqual(first.data.map((item) => item.code), codes.slice(0, 20));
  assert.deepEqual(second.data.map((item) => item.code), ['X0', 'X1', 'X2', 'X3']);
  assert.equal(calls.filter((code) => code === 'C0').length, 1);
});

test('直接 profile 详情不被 profileIndustries 低优先级队列阻塞', async () => {
  let rankStarted = 0;
  let directStarted = false;
  const releases = [];
  const service = createIndustryConcurrencyService(async (code) => {
    if (code === 'DIRECT') {
      directStarted = true;
      return annotateMarketData({ available: true, industry: '直达' }, {
        coverage: { complete: true, industry: true },
      });
    }
    rankStarted++;
    return new Promise((resolve) => releases.push(() => resolve(annotateMarketData({
      available: true, industry: `行业${code}`,
    }, { coverage: { complete: true, industry: true } }))));
  });

  const batch = service.profileIndustries(['A', 'B', 'C', 'D']);
  while (rankStarted < 3) await new Promise((resolve) => setImmediate(resolve));
  const direct = await service.profile('DIRECT');
  assert.equal(directStarted, true);
  assert.equal(direct.data.industry, '直达');
  assert.equal(rankStarted, 3, '第四个榜单任务仍应在共享队列中');

  while (releases.length) releases.shift()();
  while (rankStarted < 4) await new Promise((resolve) => setImmediate(resolve));
  while (releases.length) releases.shift()();
  await batch;
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
    assert.deepEqual(cacheCalls, [{ key: 'overview:hk', ttl: 60000 }]);
    assert.deepEqual(providerCalls, [{ name: 'getOverviewHK', args: [] }]);
  }
  {
    const { service, cacheCalls, providerCalls } = createHarness();
    await service.overview('invalid');
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
