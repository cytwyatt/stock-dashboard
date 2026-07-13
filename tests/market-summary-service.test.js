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
  SUMMARY_SCHEMA_VERSION,
  parseMarketSummary,
  compactQuote,
  createMarketSummaryService,
} = require('../src/ai/market-summary-service');

const evidenceItem = (text, evidenceRefs = ['indices'], claimType = 'observation') => ({
  text,
  claimType,
  evidenceRefs,
});

const VALID_SUMMARY = Object.freeze({
  stance: '偏强',
  headline: '主要指数方向偏强',
  breadth: '市场广度与指数方向一致',
  signals: [evidenceItem('主要指数上涨')],
  risks: [evidenceItem('留意指数方向是否变化')],
  watchPoints: [evidenceItem('关注后续指数一致性')],
});

const INDEX_FIXTURES = Object.freeze({
  cn: [
    ['sh000001', '上证指数'],
    ['sz399001', '深证成指'],
    ['sz399006', '创业板指'],
    ['sh000300', '沪深300'],
    ['sh000688', '科创50'],
  ],
  hk: [
    ['hkHSI', '恒生指数'],
    ['hkHSCEI', '恒生国企指数'],
    ['hkHSTECH', '恒生科技指数'],
  ],
  us: [
    ['^DJI', '道琼斯'],
    ['^IXIC', '纳斯达克'],
    ['^GSPC', '标普500'],
  ],
});

function createHarness({
  configured = true,
  open = true,
  timestamp = Date.parse('2026-07-13T15:00:00.000Z'),
  failures = [],
  staleComponents = [],
  indexCount,
  indexChanges,
  indexAgeMs = 2000,
  overviewUp = 2800,
  overviewTotal = 5000,
  limitCountComplete = true,
  treasuryPrevClose = 4.28,
} = {}) {
  let clock = timestamp;
  let sessionState = {
    code: open ? 'regular' : 'closed',
    label: open ? '常规交易时段' : '已收盘',
    isOpen: open,
  };
  let config = {
    baseUrl: 'https://llm.example.test/v1',
    model: 'summary-model',
    apiKey: configured ? 'test-secret-key' : '',
  };
  let completeImpl = async (_config, messages) => {
    const userMessage = messages.find((message) => message.role === 'user');
    const evidence = JSON.parse(userMessage.content.slice(userMessage.content.indexOf('\n') + 1));
    const ref = evidence.components[0].name;
    return {
      content: JSON.stringify({
        stance: evidence.serverStance,
        headline: '当前盘面方向与结构如证据所示',
        breadth: evidence.breadthAvailable ? '可用宽度数据见概况' : '暂无真实全市场宽度数据',
        signals: [evidenceItem('观察可用行情组件', [ref])],
        risks: [evidenceItem('留意可用行情组件后续变化', [ref])],
        watchPoints: [evidenceItem('关注下一时点数据', [ref])],
      }),
    };
  };
  const marketCalls = [];
  const llmCalls = [];
  const errors = [];
  const failed = new Set(failures);
  const stale = new Set(staleComponents);
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
    return {
      data,
      fetchedAt: clock,
      stale: stale.has(component),
      staleSince: stale.has(component) ? clock : null,
    };
  }

  const marketService = {
    async indices(market) {
      marketCalls.push(['indices', market]);
      if (failed.has('indices')) throw new Error('indices unavailable');
      const definitions = INDEX_FIXTURES[market];
      const limit = indexCount == null ? definitions.length : indexCount;
      return entry(definitions.slice(0, limit).map(([code, name], index) => ({
        code,
        name,
        asOf: new Date(clock - indexAgeMs).toISOString(),
        price: 100 + index,
        change: 1,
        changePct: Array.isArray(indexChanges) && indexChanges[index] != null
          ? indexChanges[index]
          : 1.25 - index * 0.05,
      })), market, 'indices');
    },
    async overview(market) {
      marketCalls.push(['overview', market]);
      if (failed.has('overview')) throw new Error('overview unavailable');
      if (market === 'us') {
        const asOf = new Date(clock - 86400000).toISOString();
        return entry([
          {
            code: '^TNX', name: '美债10年期', unit: '%', asOf,
            price: 4.2, prevClose: treasuryPrevClose, change: -0.08, changePct: -1.87,
          },
          {
            code: '^VIX', name: '恐慌指数 VIX', asOf,
            price: 16, change: -0.4, changePct: -2.44,
          },
          {
            code: 'DX-Y.NYB', name: '美元指数', asOf,
            price: 99, change: 0.2, changePct: 0.2,
          },
        ], market, 'overview');
      }
      return entry({
        up: overviewUp,
        nonUp: Math.max(0, overviewTotal - overviewUp),
        total: overviewTotal,
        limitUp: 50,
        limitDown: 5,
        limitCountComplete,
        turnover: 123456789,
        breadthBasis: 'sector_up_vs_total',
      }, market, 'overview');
    },
    async sectors() {
      marketCalls.push(['sectors']);
      if (failed.has('sectors')) throw new Error('sectors unavailable');
      return entry([
        {
          name: '科技', changePct: 2.1, inflow: 250000000, up: 60, total: 80,
          leader: { name: '领涨股', changePct: 5.2 },
        },
        {
          name: '金融', changePct: 0.5, inflow: -100000000, up: 30, total: 50,
          leader: { name: '金融股', changePct: 2.2 },
        },
        {
          name: '能源', changePct: -1, inflow: -200000000, up: 10, total: 40,
          leader: { name: '能源股', changePct: 1.2 },
        },
      ], 'cn', 'sectors');
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
      ...sessionState,
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
    setOpen(value) {
      sessionState = {
        code: value ? 'regular' : 'closed',
        label: value ? '常规交易时段' : '已收盘',
        isOpen: value,
      };
    },
    setSession(code, label, isOpen = false) { sessionState = { code, label, isOpen }; },
    setConfig(value) { config = { ...config, ...value }; },
    setCompleteImpl(value) { completeImpl = value; },
  };
}

function evidenceFromCall(call) {
  const userMessage = call.messages.find((message) => message.role === 'user');
  const separator = userMessage.content.indexOf('\n');
  return JSON.parse(userMessage.content.slice(separator + 1));
}

test('parseMarketSummary 接受 v2 结构并严格校验 stance、claimType、因果措辞和证据引用', () => {
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
    () => parseMarketSummary(JSON.stringify({ ...VALID_SUMMARY, stance: '震荡' })),
    /stance 非法/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({ ...VALID_SUMMARY, signals: '不是数组' })),
    /signals 格式异常/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem('主要指数上涨', ['indices'], 'causal')],
    })),
    /claimType 非法/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem('政策推动指数上涨', ['indices'])],
    })),
    /因果表述/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem('油价上涨提振市场', ['indices'])],
    })),
    /因果表述/,
  );
  for (const text of [
    '科技板块领涨并支撑指数走高',
    '指数走强得益于科技板块',
    '科技板块助推指数上涨',
    '指数在科技板块带领下上涨',
  ]) {
    assert.throws(
      () => parseMarketSummary(JSON.stringify({
        ...VALID_SUMMARY,
        signals: [evidenceItem(text, ['indices'])],
      })),
      /因果表述/,
    );
  }
  assert.throws(
    () => parseMarketSummary(JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem('引用不存在的板块', ['sectors'])],
    }), { allowedEvidenceRefs: new Set(['indices']) }),
    /无效证据 sectors/,
  );
  assert.deepEqual(parseMarketSummary(JSON.stringify({
    ...VALID_SUMMARY,
    risks: [],
    watchPoints: [],
  })), {
    ...VALID_SUMMARY,
    risks: [],
    watchPoints: [],
  });
  assert.throws(
    () => parseMarketSummary(JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem('指数与宏观代理同步走弱', ['indices', 'macroProxies'], 'association')],
    }), { allowAssociation: false }),
    /跨时点关联不可靠/,
  );
  assert.throws(
    () => parseMarketSummary(JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem('成交额明显放量', ['overview'])],
    }), { allowVolumeComparison: false }),
    /无历史基准的量能比较/,
  );
});

test('美债收益率仅在有效前收存在时计算基点变化', () => {
  assert.equal(compactQuote({
    code: '^TNX', name: '美债10年期', price: 4.609, prevClose: 4.569,
  }).changeBp, 4);
  assert.equal(compactQuote({
    code: '^TNX', name: '美债10年期', price: 4.2, prevClose: 0,
  }).changeBp, null);
});

test('未配置 API Key 时返回可展示状态，不读行情、不调 LLM', async () => {
  const harness = createHarness({ configured: false });

  const result = await harness.service.getSummary('invalid-market');

  assert.equal(result.data.available, false);
  assert.equal(result.data.configured, false);
  assert.equal(result.data.market, 'cn');
  assert.equal(result.data.schemaVersion, SUMMARY_SCHEMA_VERSION);
  assert.deepEqual(result.data.horizon, {
    code: 'current_or_latest_session',
    label: '当前或最近交易时段盘面',
    isForecast: false,
  });
  assert.equal(result.data.confidence.label, '证据质量');
  assert.equal(result.data.confidence.isPredictionProbability, false);
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
      assert.equal(evidence.schemaVersion, SUMMARY_SCHEMA_VERSION);
      assert.equal(evidence.market, item.market);
      assert.deepEqual(evidence.components.map((component) => component.name), item.components);
      assert.equal(evidence.horizon.isForecast, false);
      assert.equal(result.data.schemaVersion, SUMMARY_SCHEMA_VERSION);
      assert.equal(result.data.stance, '偏强');
      assert.equal(result.data.confidence.label, '证据质量');
      assert.equal(result.data.confidence.isPredictionProbability, false);
      assert.deepEqual(result.data.headlineEvidenceRefs,
        item.market === 'cn' ? ['indices', 'overview'] : ['indices']);
      if (item.market === 'cn') {
        const overview = evidence.components.find((component) => component.name === 'overview');
        assert.equal(overview.data.nonUp, 2200);
        assert.equal(overview.data.upRatioPct, 56);
        assert.equal(overview.data.limitBalance, 45);
        assert.equal(overview.data.turnoverHasHistoricalBaseline, false);
        const sectors = evidence.components.find((component) => component.name === 'sectors');
        assert.equal(sectors.data.stats.upRatioPct, 66.67);
        assert.equal(sectors.data.stats.medianChangePct, 0.5);
        assert.equal(evidence.derived.indexConsistency.direction, 'up');
        assert.equal(evidence.derived.indexConsistency.coverageRatio, 1);
        assert.equal(evidence.breadthAvailable, true);
        assert.equal(result.data.breadthBasis, 'market_breadth');
        assert.deepEqual(result.data.breadthEvidenceRefs, ['overview']);
        assert.match(result.data.breadth, /上涨2800家、未上涨2200家，上涨占比56%/);
        assert.match(evidence.limitations.join(' '), /不能据此判断放量或缩量/);
        assert.ok(result.data.confidence.score >= 75);
      }
      if (item.market === 'us') {
        assert.match(evidence.limitations.join(' '), /美股涨跌榜.*不纳入证据/);
        const macro = evidence.components.find((component) => component.name === 'macroProxies').data;
        assert.deepEqual(macro[0], {
          code: '^TNX',
          name: '美债10年期',
          currency: null,
          assetType: 'government_bond_yield',
          unit: '%',
          asOf: new Date(harness.now() - 86400000).toISOString(),
          yieldPct: 4.2,
          changeBp: -8,
        });
        assert.equal(Object.hasOwn(macro[0], 'changePct'), false);
        assert.equal(macro[1].assetType, 'volatility_index');
        assert.equal(macro[1].unit, 'index_points');
        assert.equal(macro[1].currency, null);
        assert.equal(macro[2].assetType, 'currency_index');
        assert.equal(macro[2].unit, 'index_points');
        assert.equal(macro[2].currency, null);
        assert.equal(result.data.coreAsOf, new Date(harness.now() - 2000).toISOString());
        assert.equal(result.data.evidenceRange.earliest,
          new Date(harness.now() - 86400000).toISOString());
        assert.equal(result.data.dataAsOf, result.data.coreAsOf);
        assert.equal(result.data.breadthAvailable, false);
        assert.equal(result.data.breadthBasis, 'coverage');
        assert.deepEqual(result.data.breadthEvidenceRefs, []);
        assert.match(result.data.breadth, /宏观代理不能替代市场宽度/);
        assert.equal(result.data.freshness.evidenceTimeAligned, false);
        assert.match(result.data.dataWarnings.join(' '), /跨组件仅作分别观察/);
        assert.ok(result.data.confidence.score <= 70);
      }
      if (item.market === 'hk') assert.ok(result.data.confidence.score <= 70);
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
  assert.equal(degraded.data.quality.indicesSufficient, false);
  assert.equal(degraded.data.confidence.level, 'low');
  assert.match(degraded.data.headline, /主要指数数据暂不可用/);
  assert.deepEqual(degraded.data.headlineEvidenceRefs, []);

  const insufficient = createHarness({ indexCount: 1 });
  const insufficientResult = await insufficient.service.getSummary('us');
  assert.equal(insufficientResult.data.stance, '数据不足');
  assert.equal(insufficientResult.data.quality.indicesAvailable, true);
  assert.equal(insufficientResult.data.quality.indicesSufficient, false);
  assert.match(insufficientResult.data.dataWarnings.join(' '), /主要指数覆盖不足/);

  const unavailable = createHarness({
    failures: ['indices', 'overview', 'sectors', 'rank'],
  });
  await assert.rejects(
    unavailable.service.getSummary('cn'),
    /大盘总结所需行情暂不可用/,
  );
  assert.equal(unavailable.llmCalls.length, 0);
});

test('旧缓存或盘中超龄核心指数降级为数据不足，旧宽度不参与 stance', async () => {
  const staleIndices = createHarness({ staleComponents: ['indices'] });
  const staleIndexResult = await staleIndices.service.getSummary('cn');
  assert.equal(staleIndexResult.data.stance, '数据不足');
  assert.equal(staleIndexResult.data.quality.indicesStale, true);
  assert.ok(staleIndexResult.data.confidence.score <= 40);
  assert.match(staleIndexResult.data.dataWarnings.join(' '), /旧缓存.*主要指数/);
  assert.match(staleIndexResult.data.headline, /时效不足/);

  const staleOverview = createHarness({ staleComponents: ['overview'] });
  const staleOverviewResult = await staleOverview.service.getSummary('cn');
  assert.equal(staleOverviewResult.data.breadthAvailable, false);
  assert.equal(staleOverviewResult.data.stance, '偏强');
  assert.match(staleOverviewResult.data.headline, /指数层面偏强.*宽度暂未验证/);

  const agedOpen = createHarness({ indexAgeMs: 31 * 60 * 1000, open: true });
  const agedOpenResult = await agedOpen.service.getSummary('us');
  assert.equal(agedOpenResult.data.stance, '数据不足');
  assert.equal(agedOpenResult.data.freshness.coreTooOldInOpenSession, true);
  assert.ok(agedOpenResult.data.confidence.score <= 40);
  assert.match(agedOpenResult.data.dataWarnings.join(' '), /超过30分钟未更新/);

  const agedClosed = createHarness({ indexAgeMs: 31 * 60 * 1000, open: false });
  const agedClosedResult = await agedClosed.service.getSummary('us');
  assert.equal(agedClosedResult.data.freshness.coreTooOldInOpenSession, false);
  assert.equal(agedClosedResult.data.stance, '偏强');
});

test('美债缺少有效前收时不伪造基点变化并进入数据质量提示', async () => {
  const harness = createHarness({ treasuryPrevClose: 0 });
  const result = await harness.service.getSummary('us');
  const evidence = evidenceFromCall(harness.llmCalls[0]);
  const treasury = evidence.components
    .find((component) => component.name === 'macroProxies').data
    .find((row) => row.code === '^TNX');
  assert.equal(treasury.changeBp, null);
  assert.match(result.data.dataWarnings.join(' '), /缺少有效前收.*基点变化不可用/);
});

test('证据跨时点时拒绝模型建立同步关联', async () => {
  const harness = createHarness();
  harness.setCompleteImpl(async () => ({
    content: JSON.stringify({
      ...VALID_SUMMARY,
      signals: [evidenceItem(
        '主要指数与宏观代理同步变化',
        ['indices', 'macroProxies'],
        'association',
      )],
    }),
  }));
  await assert.rejects(harness.service.getSummary('us'), /跨时点关联不可靠/);
  assert.equal(harness.llmCalls.length, 2);
});

test('模型输出未通过金融语义校验时只重试一次并接受修正结果', async () => {
  const harness = createHarness();
  let attempts = 0;
  harness.setCompleteImpl(async () => {
    attempts += 1;
    if (attempts === 1) {
      return {
        content: JSON.stringify({
          ...VALID_SUMMARY,
          signals: [evidenceItem('主要指数推动市场上涨')],
        }),
      };
    }
    return { content: JSON.stringify(VALID_SUMMARY) };
  });

  const result = await harness.service.getSummary('cn');
  assert.equal(result.data.available, true);
  assert.equal(attempts, 2);
  assert.equal(harness.llmCalls.length, 2);
  assert.match(
    harness.llmCalls[1].messages.at(-1).content,
    /上一次输出未通过结构或金融语义校验/,
  );
});

test('服务端按指数方向和A股宽度确定 stance，覆盖模型值且不用单点截面“震荡”', async () => {
  const strong = createHarness();
  strong.setCompleteImpl(async () => ({
    content: JSON.stringify({ ...VALID_SUMMARY, stance: '偏弱', headline: '模型给出相反方向' }),
  }));
  const strongResult = await strong.service.getSummary('cn');
  assert.equal(strongResult.data.stance, '偏强');
  assert.match(strongResult.data.headline, /市场宽度确认.*盘面偏强/);
  assert.equal(strongResult.data.quality.modelStanceOverridden, true);
  assert.doesNotMatch(strongResult.data.dataWarnings.join(' '), /模型方向标签/);

  const breadthDivergence = createHarness({ overviewUp: 2000 });
  const divergenceResult = await breadthDivergence.service.getSummary('cn');
  assert.equal(divergenceResult.data.stance, '分化');

  const neutral = createHarness({
    overviewUp: 2500,
    indexChanges: [0.2, -0.1, 0.15, -0.05, 0.1],
  });
  const neutralResult = await neutral.service.getSummary('cn');
  assert.equal(neutralResult.data.derived.indexConsistency.neutralRange, true);
  assert.equal(neutralResult.data.stance, '中性');
  assert.notEqual(neutralResult.data.stance, '震荡');

  const mostlyFlat = createHarness({
    overviewUp: 2500,
    indexChanges: [1, 0, 0, 0, 0],
  });
  const mostlyFlatResult = await mostlyFlat.service.getSummary('cn');
  assert.equal(mostlyFlatResult.data.derived.indexConsistency.direction, 'flat');
  assert.equal(mostlyFlatResult.data.stance, '中性');

  const hkMixed = createHarness({ indexChanges: [0.3, 0.2, -0.9] });
  const hkMixedResult = await hkMixed.service.getSummary('hk');
  assert.equal(hkMixedResult.data.stance, '分化');
  assert.equal(hkMixedResult.data.headline, '主要指数方向不一致，指数层面呈现分化。');
});

test('A股无量能基准进入证据限制，不完整涨跌停进入确定性警告', async () => {
  const harness = createHarness({ limitCountComplete: false });
  const result = await harness.service.getSummary('cn');
  const evidence = evidenceFromCall(harness.llmCalls[0]);
  const warnings = result.data.dataWarnings.join(' ');
  assert.match(evidence.limitations.join(' '), /不能据此判断放量或缩量/);
  assert.doesNotMatch(warnings, /不能判断放量或缩量/);
  assert.match(warnings, /涨跌停统计不完整/);
  assert.equal(result.data.derived.breadth.limitCountComplete, false);
  assert.ok(result.data.confidence.reasons.includes('涨跌停统计不完整'));
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

test('具体 session.code 与 LLM 配置使用 v2 隔离缓存 key，旧 v1 缓存不可复用', async () => {
  const harness = createHarness({ open: true });

  await harness.service.getSummary('us');
  harness.setConfig({ model: 'another-model' });
  await harness.service.getSummary('us');
  harness.setConfig({ model: 'summary-model' });
  harness.setSession('pre', '盘前', false);
  await harness.service.getSummary('us');
  harness.setSession('closed', '已收盘', false);
  await harness.service.getSummary('us');

  assert.equal(harness.llmCalls.length, 4);
  assert.deepEqual(
    harness.llmCalls.map((call) => evidenceFromCall(call).session.label),
    ['常规交易时段', '常规交易时段', '盘前', '已收盘'],
  );
  const keys = [...harness.cacheRuntime.cache.keys()];
  assert.equal(keys.length, 4);
  assert.equal(keys.every((key) => key.startsWith('ai:market-summary:v2:us:')), true);
  assert.equal(keys.filter((key) => key.includes(':regular:')).length, 2);
  assert.equal(keys.filter((key) => key.includes(':pre:')).length, 1);
  assert.equal(keys.filter((key) => key.includes(':closed:')).length, 1);
  assert.equal(keys.some((key) => key.includes(':v1:')), false);
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
