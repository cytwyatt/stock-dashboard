'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCacheRuntime } = require('../src/core/cache');
const {
  annotateMarketData,
  getMarketDataMeta,
  marketMeta,
} = require('../src/core/market-meta');
const {
  FORCE_REFRESH_COOLDOWN_MS,
  parseMarketSummary,
  createMarketSummaryService,
} = require('../src/ai/market-summary-service');

const VALID_SUMMARY = Object.freeze({
  stance: '偏强',
  headline: '指数震荡上行',
  breadth: '市场广度与指数方向一致',
  drivers: ['主要指数上涨'],
  risks: ['留意量能变化'],
  watchPoints: ['关注后续广度'],
});

function createHarness({
  configured = true,
  open = true,
  timestamp = Date.parse('2026-07-13T15:00:00.000Z'),
  failures = [],
} = {}) {
  let clock = timestamp;
  let marketOpen = open;
  let config = {
    baseUrl: 'https://llm.example.test/v1',
    model: 'summary-model',
    apiKey: configured ? 'test-secret-key' : '',
  };
  let completeImpl = async () => ({ content: JSON.stringify(VALID_SUMMARY) });
  const marketCalls = [];
  const llmCalls = [];
  const errors = [];
  const failed = new Set(failures);
  const cacheRuntime = createCacheRuntime({
    now: () => clock,
    logger: { error: (message) => errors.push(message) },
  });

  function entry(data, market, component) {
    annotateMarketData(data, {
      market,
      source: `fixture:${component}`,
      currency: market === 'cn' ? 'CNY' : market === 'hk' ? 'HKD' : 'USD',
      timezone: market === 'cn'
        ? 'Asia/Shanghai'
        : market === 'hk' ? 'Asia/Hong_Kong' : 'America/New_York',
      asOf: new Date(clock - 1000).toISOString(),
      adjustmentBasis: 'none',
    });
    return { data, fetchedAt: clock, stale: false, staleSince: null };
  }

  const marketService = {
    async indices(market) {
      marketCalls.push(['indices', market]);
      if (failed.has('indices')) throw new Error('indices unavailable');
      return entry([{
        code: market === 'us' ? '^GSPC' : `${market}-index`,
        name: `${market.toUpperCase()} 指数`,
        asOf: new Date(clock - 2000).toISOString(),
        price: 100,
        changePct: 1.25,
      }], market, 'indices');
    },
    async overview(market) {
      marketCalls.push(['overview', market]);
      if (failed.has('overview')) throw new Error('overview unavailable');
      if (market === 'us') {
        return entry([{
          code: '^TNX', name: '美债10年期', unit: '%',
          asOf: new Date(clock - 86400000).toISOString(),
          price: 4.2, changePct: -2,
        }], market, 'overview');
      }
      return entry({
        up: 2800,
        nonUp: 2200,
        total: 5000,
        limitUp: 50,
        limitDown: 5,
        limitCountComplete: true,
        turnover: 123456789,
        breadthBasis: 'sector_up_vs_total',
      }, market, 'overview');
    },
    async sectors() {
      marketCalls.push(['sectors']);
      if (failed.has('sectors')) throw new Error('sectors unavailable');
      return entry([{
        name: '科技',
        changePct: 2.1,
        inflow: 250000000,
        up: 60,
        total: 80,
        leader: { name: '领涨股', changePct: 5.2 },
      }], 'cn', 'sectors');
    },
    async rank(market, direction) {
      marketCalls.push(['rank', market, direction]);
      if (failed.has('rank')) throw new Error('rank unavailable');
      return entry([{
        code: `${market}-${direction}`,
        name: direction === 'up' ? '代表性上涨股' : '代表性下跌股',
        price: 10,
        changePct: direction === 'up' ? 4.2 : -3.1,
      }], market, `rank-${direction}`);
    },
  };

  const llmClient = {
    async complete(...args) {
      llmCalls.push({
        config: { ...args[0] },
        messages: args[1],
        tools: args[2],
        options: args[3],
      });
      return completeImpl(...args);
    },
  };

  const service = createMarketSummaryService({
    cachedEntry: cacheRuntime.cachedEntry,
    expireCached: cacheRuntime.expireCached,
    marketService,
    llmConfigStore: { getLLMConfig: () => ({ ...config }) },
    llmClient,
    marketMeta,
    annotateMarketData,
    marketSession: () => ({
      code: marketOpen ? 'regular' : 'closed',
      label: marketOpen ? '常规交易时段' : '已收盘',
      isOpen: marketOpen,
      basis: 'regular_hours_without_holiday_calendar',
      calendarAware: false,
    }),
    marketSummarySystemPrompt: () => 'fixture summary system prompt',
    now: () => clock,
  });

  return {
    service,
    cacheRuntime,
    marketCalls,
    llmCalls,
    errors,
    now: () => clock,
    setNow(value) { clock = value; },
    setOpen(value) { marketOpen = value; },
    setConfig(value) { config = { ...config, ...value }; },
    setCompleteImpl(value) { completeImpl = value; },
  };
}

function evidenceFromCall(call) {
  const userMessage = call.messages.find((message) => message.role === 'user');
  const separator = userMessage.content.indexOf('\n');
  return JSON.parse(userMessage.content.slice(separator + 1));
}

test('parseMarketSummary 接受严格 JSON 和 JSON 围栏，拒绝畸形结构与非法 stance', () => {
  assert.deepEqual(parseMarketSummary(JSON.stringify(VALID_SUMMARY)), VALID_SUMMARY);
  assert.deepEqual(
    parseMarketSummary(`\`\`\`json\n${JSON.stringify(VALID_SUMMARY)}\n\`\`\``),
    VALID_SUMMARY,
  );
  assert.throws(
    () => parseMarketSummary('{"stance":"偏强",}'),
    /JSON 解析失败/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({ ...VALID_SUMMARY, stance: '看多' })),
    /stance 非法/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({ ...VALID_SUMMARY, drivers: '不是数组' })),
    /drivers 格式异常/,
  );
});

test('未配置 API Key 时返回可展示状态，不读行情、不调 LLM', async () => {
  const harness = createHarness({ configured: false });

  const result = await harness.service.getSummary('invalid-market');

  assert.equal(result.data.available, false);
  assert.equal(result.data.configured, false);
  assert.equal(result.data.market, 'cn');
  assert.equal(result.stale, false);
  assert.deepEqual(harness.marketCalls, []);
  assert.deepEqual(harness.llmCalls, []);
  assert.equal(harness.cacheRuntime.cache.size, 0);
  assert.equal(getMarketDataMeta(result.data).coverage.reason, 'llm_not_configured');
});

test('三个市场只采集允许的证据：港股不取 overview，美股不取 rank', async (t) => {
  const cases = [
    {
      market: 'cn',
      calls: [
        ['indices', 'cn'],
        ['overview', 'cn'],
        ['sectors'],
        ['rank', 'cn', 'up'],
        ['rank', 'cn', 'down'],
      ],
      components: [
        'indices', 'overview', 'sectors', 'representativeGainers', 'representativeLosers',
      ],
    },
    {
      market: 'hk',
      calls: [
        ['indices', 'hk'],
        ['rank', 'hk', 'up'],
        ['rank', 'hk', 'down'],
      ],
      components: ['indices', 'representativeGainers', 'representativeLosers'],
    },
    {
      market: 'us',
      calls: [
        ['indices', 'us'],
        ['overview', 'us'],
      ],
      components: ['indices', 'macroProxies'],
    },
  ];

  for (const item of cases) {
    await t.test(item.market, async () => {
      const harness = createHarness();
      const result = await harness.service.getSummary(item.market);
      assert.equal(result.data.available, true);
      assert.deepEqual(harness.marketCalls, item.calls);
      assert.equal(harness.llmCalls.length, 1);
      assert.equal(harness.llmCalls[0].tools, null);
      assert.deepEqual(harness.llmCalls[0].options, { temperature: 0.1, maxTokens: 800 });

      const evidence = evidenceFromCall(harness.llmCalls[0]);
      assert.equal(evidence.market, item.market);
      assert.deepEqual(evidence.components.map((component) => component.name), item.components);
      if (item.market === 'cn') {
        const overview = evidence.components.find((component) => component.name === 'overview');
        assert.equal(overview.data.nonUp, 2200);
      }
      if (item.market === 'us') {
        assert.match(evidence.limitations.join(' '), /美股涨跌榜.*不纳入证据/);
        assert.equal(evidence.components.find((component) => component.name === 'macroProxies')
          .data[0].unit, '%');
        assert.equal(evidence.components.find((component) => component.name === 'macroProxies')
          .data[0].asOf, new Date(harness.now() - 86400000).toISOString());
        assert.equal(result.data.dataAsOf, new Date(harness.now() - 86400000).toISOString());
      }
    });
  }
});

test('单个行情组件失败时使用其余证据，全部失败时不调用模型', async () => {
  const partial = createHarness({ failures: ['sectors'] });
  const result = await partial.service.getSummary('cn');
  assert.equal(result.data.available, true);
  assert.equal(partial.llmCalls.length, 1);
  const evidence = evidenceFromCall(partial.llmCalls[0]);
  assert.deepEqual(evidence.missing, ['sectors']);
  assert.equal(evidence.components.some((component) => component.name === 'sectors'), false);

  const noIndices = createHarness({ failures: ['indices'] });
  const degraded = await noIndices.service.getSummary('us');
  assert.equal(degraded.data.available, true);
  assert.equal(degraded.data.stance, '数据不足');
  assert.equal(degraded.data.quality.indicesAvailable, false);
  assert.match(degraded.data.headline, /主要指数数据暂不可用/);

  const unavailable = createHarness({
    failures: ['indices', 'overview', 'sectors', 'rank'],
  });
  await assert.rejects(
    unavailable.service.getSummary('cn'),
    /大盘总结所需行情暂不可用/,
  );
  assert.equal(unavailable.llmCalls.length, 0);
});

test('同一市场、市场阶段和模型配置命中缓存', async () => {
  const harness = createHarness();

  const first = await harness.service.getSummary('cn');
  const second = await harness.service.getSummary('cn');

  assert.strictEqual(second.data, first.data);
  assert.equal(second.fetchedAt, first.fetchedAt);
  assert.equal(harness.llmCalls.length, 1);
  assert.equal(harness.marketCalls.length, 5);
  assert.equal(harness.cacheRuntime.cache.size, 1);
});

test('开闭市阶段与 LLM 配置使用隔离缓存 key，key 不泄露 API Key', async () => {
  const harness = createHarness({ open: true });

  await harness.service.getSummary('us');
  harness.setConfig({ model: 'another-model' });
  await harness.service.getSummary('us');
  harness.setConfig({ model: 'summary-model' });
  harness.setOpen(false);
  await harness.service.getSummary('us');

  assert.equal(harness.llmCalls.length, 3);
  assert.deepEqual(
    harness.llmCalls.map((call) => evidenceFromCall(call).session.label),
    ['常规交易时段', '常规交易时段', '已收盘'],
  );
  const keys = [...harness.cacheRuntime.cache.keys()];
  assert.equal(keys.length, 3);
  assert.equal(keys.filter((key) => key.includes(':open:')).length, 2);
  assert.equal(keys.filter((key) => key.includes(':closed:')).length, 1);
  assert.equal(keys.some((key) => key.includes('test-secret-key')), false);
});

test('force 刷新超过冷却期后失败，返回旧总结并标记 stale', async () => {
  const harness = createHarness({ open: true });
  const first = await harness.service.getSummary('cn');
  const refreshAt = harness.now() + FORCE_REFRESH_COOLDOWN_MS + 1;
  harness.setNow(refreshAt);
  harness.setCompleteImpl(async () => { throw new Error('fixture LLM unavailable'); });

  const stale = await harness.service.getSummary('cn', { force: true });

  assert.strictEqual(stale.data, first.data);
  assert.equal(stale.fetchedAt, first.fetchedAt);
  assert.equal(stale.stale, true);
  assert.equal(stale.staleSince, refreshAt);
  assert.equal(harness.llmCalls.length, 2);
  assert.match(harness.errors[0], /fixture LLM unavailable/);
  assert.equal(marketMeta(stale, { market: 'cn' }).stale, true);

  // stale 的 15 秒重试冷却结束后，60 秒手动刷新冷却仍应阻止重复模型计费。
  harness.setNow(refreshAt + 16000);
  const rateLimitedStale = await harness.service.getSummary('cn', { force: true });
  assert.strictEqual(rateLimitedStale.data, first.data);
  assert.equal(rateLimitedStale.stale, true);
  assert.equal(harness.llmCalls.length, 2);
});
