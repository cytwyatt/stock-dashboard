'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { annotateMarketData, marketMeta } = require('../src/core/market-meta');
const {
  parseMarketReview,
  compactNews,
  freezeOptionalComponent,
  associationEligibleComponents,
  marketCloseTimestamp,
  isCompletedReviewDate,
  previousWeekday,
  createMarketReviewService,
} = require('../src/ai/market-review-service');

function completion(stance = '数据不足') {
  return JSON.stringify({
    stance,
    headline: '核心指数收涨，但当前指数覆盖有限，结论需要结合完整数据理解。',
    cardSummary: '核心指数结束当日交易，近五日表现与成交额比较提供了主要观察线索。',
    themes: ['指数收盘表现', '量能与宽度'],
    keyRisk: '指数覆盖不足会降低对全市场结构的判断能力。',
    executiveSummary: '当日核心指数完成交易，收盘方向和近五日区间共同构成价格主线。市场宽度、成交额比较、行业表现与代表性个股样本需要分层理解；其中样本不能替代全市场统计，新闻标题也只能作为待核验线索。当前证据更适合描述已经发生的盘面结构，而不是推演确定性的后市方向。',
    prominentEvidenceRefs: {
      headline: ['indices'],
      cardSummary: ['indices', 'indexHistory'],
      themes: [['indices'], ['indices', 'indexHistory']],
      keyRisk: ['indices'],
      executiveSummary: ['indices', 'indexHistory'],
    },
    sections: {
      indexPerformance: [{
        text: '核心指数当日上涨1%，近五日收益由历史日线计算。',
        claimType: 'observation', evidenceRefs: ['indices', 'indexHistory'], citationRefs: [],
      }],
      breadthLiquidity: [], leadership: [], crossAsset: [], drivers: [], risks: [],
      nextSessionWatch: [],
    },
  });
}

function createMemoryStore() {
  const reviews = new Map();
  const attempts = new Map();
  const key = (market, date) => `${market}:${date}`;
  return {
    latest(market) {
      return [...reviews.values()]
        .filter((review) => review.market === market)
        .sort((a, b) => b.reviewDate.localeCompare(a.reviewDate))[0] || null;
    },
    find(market, date) { return reviews.get(key(market, date)) || null; },
    upsert(review) { reviews.set(key(review.market, review.reviewDate), structuredClone(review)); return review; },
    getAttempt(market, date) { return attempts.get(key(market, date)) || null; },
    recordAttempt(market, date, attempt) { attempts.set(key(market, date), { ...attempt }); },
    clearAttempt(market, date) { return attempts.delete(key(market, date)); },
    reviews,
    attempts,
  };
}

function entry(data, meta = {}) {
  annotateMarketData(data, {
    market: meta.market || 'cn',
    source: meta.source || '测试行情',
    currency: meta.currency || 'CNY',
    timezone: meta.timezone || 'Asia/Shanghai',
    asOf: meta.asOf || '2026-07-14T15:00:00+08:00',
    adjustmentBasis: meta.adjustmentBasis || 'none',
    amountUnit: 'base_currency',
  });
  return { data, fetchedAt: Date.parse('2026-07-14T07:01:00Z'), stale: false, staleSince: null };
}

function createHarness({
  timestamp = Date.parse('2026-07-14T07:20:00Z'),
  store = createMemoryStore(),
  apiKey = 'test-key',
  completionText = completion(),
  klineStale = false,
  indicesRows = null,
  klineByCode = {},
  newsRows = null,
  sectorsData = [],
  rankDataByDirection = {},
  quotesData = [],
} = {}) {
  const calls = { indices: 0, kline: 0, llm: 0 };
  const history = Array.from({ length: 22 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 5, 23 + index)).toISOString().slice(0, 10),
    open: 100 + index,
    close: 101 + index,
    high: 102 + index,
    low: 99 + index,
    volume: 1000 + index,
  }));
  history[history.length - 1].date = '2026-07-14';
  const defaultIndices = [{
    code: 'sh000001', name: '上证指数', currency: 'CNY', price: 3200,
    prevClose: 3168.32, changePct: 1, open: 3170, high: 3210, low: 3160,
    amount: 1e12, asOf: '2026-07-14T15:00:00+08:00',
  }];
  const marketService = {
    async indices() {
      calls.indices++;
      return entry(structuredClone(indicesRows || defaultIndices));
    },
    async kline(code) {
      calls.kline++;
      const config = klineByCode[code] || {};
      const bars = structuredClone(config.history || history);
      if (config.latestDate) bars[bars.length - 1].date = config.latestDate;
      const result = entry(bars, {
        adjustmentBasis: 'provider_qfq',
        ...(config.asOf ? { asOf: config.asOf } : {}),
      });
      result.stale = Object.prototype.hasOwnProperty.call(config, 'stale')
        ? config.stale
        : klineStale;
      result.staleSince = result.stale ? Date.parse('2026-07-14T07:10:00Z') : null;
      return result;
    },
    async overview() {
      return entry({
        up: 3200, nonUp: 2100, total: 5300, turnover: 2.1e12,
        comparison: {
          available: true, previous: 2e12, change: 1e11, changePct: 5,
          mode: 'previous_trading_day_close', currentDate: '2026-07-14',
          previousDate: '2026-07-13', asOfTime: '15:00', basis: 'sh_sz_market_total',
        },
        limitUp: 80, limitDown: 5, limitCountComplete: true,
      });
    },
    async sectors() { return entry(structuredClone(sectorsData)); },
    async rank(market, direction) {
      return entry(structuredClone(rankDataByDirection[direction] || []), { market });
    },
    async news() {
      return entry(structuredClone(newsRows || [{
        title: 'A股测试市场新闻', url: 'https://finance.sina.com.cn/test',
        time: Date.parse('2026-07-14T06:00:00Z'), media: '新浪财经',
      }]));
    },
    async quotes() { return entry(structuredClone(quotesData)); },
  };
  const service = createMarketReviewService({
    marketService,
    marketReviewStore: store,
    llmConfigStore: { getLLMConfig: () => ({ apiKey, model: 'test-model', baseUrl: 'https://example.test' }) },
    llmClient: {
      async complete() { calls.llm++; return { content: completionText }; },
    },
    marketMeta,
    annotateMarketData,
    marketReviewSystemPrompt: () => 'review prompt',
    now: () => timestamp,
    logger: { error() {} },
  });
  return { service, store, calls };
}

test('盘后复盘 JSON 严格校验证据引用与事件归因引用', () => {
  const allowed = {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'news'],
    allowedCitationRefs: ['news:1'],
    associationEvidenceRefs: ['indices', 'indexHistory', 'news'],
  };
  const parsed = parseMarketReview(completion(), allowed);
  assert.equal(parsed.sections.indexPerformance[0].claimType, 'observation');

  const invalid = JSON.parse(completion());
  invalid.sections.drivers = [{
    text: '某事件推动指数上涨。', claimType: 'reported_cause',
    evidenceRefs: ['news'], citationRefs: [],
  }];
  assert.throws(() => parseMarketReview(JSON.stringify(invalid), allowed), /缺少新闻引用/);

  invalid.sections.drivers[0] = {
    text: '政策变化推动指数上涨。', claimType: 'reported_cause',
    evidenceRefs: ['news'], citationRefs: ['news:1'],
  };
  assert.throws(() => parseMarketReview(JSON.stringify(invalid), allowed), /缺少明确来源归属/);

  invalid.sections.drivers[0] = {
    text: '据新浪财经报道，政策变化推动指数上涨。', claimType: 'reported_cause',
    evidenceRefs: ['news'], citationRefs: ['news:1'],
  };
  assert.equal(parseMarketReview(JSON.stringify(invalid), allowed).sections.drivers[0].claimType, 'reported_cause');

  invalid.sections.drivers[0] = {
    text: '资金推动指数上涨。', claimType: 'observation',
    evidenceRefs: ['indices'], citationRefs: [],
  };
  assert.throws(() => parseMarketReview(JSON.stringify(invalid), allowed), /无引用因果/);

  const technical = JSON.parse(completion());
  technical.sections.nextSessionWatch = [{
    text: '关注3200点支撑位是否有效。', claimType: 'observation',
    evidenceRefs: ['indices'], citationRefs: [],
  }];
  assert.doesNotThrow(() => parseMarketReview(JSON.stringify(technical), allowed));
});

test('显著文本必须绑定对齐证据且不允许模型自报阿拉伯数字', () => {
  const allowed = {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'overview'],
    associationEvidenceRefs: ['indices', 'indexHistory'],
  };
  const missingRefs = JSON.parse(completion());
  delete missingRefs.prominentEvidenceRefs;
  assert.throws(() => parseMarketReview(JSON.stringify(missingRefs), allowed), /prominentEvidenceRefs/);

  const unaligned = JSON.parse(completion());
  unaligned.prominentEvidenceRefs.cardSummary = ['overview'];
  assert.throws(() => parseMarketReview(JSON.stringify(unaligned), allowed), /prominentEvidenceRefs\.cardSummary/);

  const numeric = JSON.parse(completion());
  numeric.headline = '核心指数上涨1%。';
  assert.throws(() => parseMarketReview(JSON.stringify(numeric), allowed), /未经服务端校验的数字/);
});

test('association 只能引用收盘附近的对齐组件', () => {
  const components = [
    { name: 'indices', data: [{ asOf: '2026-07-14T15:00:00+08:00' }], meta: { stale: false } },
    { name: 'overview', data: {
      turnoverComparison: { currentDate: '2026-07-14', asOfTime: '12:00' },
    }, meta: { stale: false } },
  ];
  assert.deepEqual(associationEligibleComponents(components, 'cn', '2026-07-14'), ['indices']);

  const payload = JSON.parse(completion());
  payload.sections.breadthLiquidity = [{
    text: '核心指数与市场宽度同向。', claimType: 'association',
    evidenceRefs: ['indices', 'overview'], citationRefs: [],
  }];
  assert.throws(() => parseMarketReview(JSON.stringify(payload), {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'overview'],
    associationEvidenceRefs: ['indices', 'indexHistory'],
  }), /时点未对齐/);
});

test('新闻按市场收盘时刻与相关性冻结，不接受同日盘后标题', () => {
  const cnRows = [
    { title: 'A股收盘前消息', url: 'https://example.com/cn-before', time: Date.parse('2026-07-14T06:59:00Z') },
    { title: 'A股收盘后消息', url: 'https://example.com/cn-after', time: Date.parse('2026-07-14T07:01:00Z') },
    { title: '欧股收盘消息', url: 'https://example.com/eu', time: Date.parse('2026-07-14T06:30:00Z') },
  ];
  assert.deepEqual(
    compactNews(cnRows, { market: 'cn', reviewDate: '2026-07-14' }).map((row) => row.url),
    ['https://example.com/cn-before'],
  );
  assert.equal(marketCloseTimestamp('us', '2026-07-14'), Date.parse('2026-07-14T20:00:00Z'));
  assert.equal(marketCloseTimestamp('us', '2026-01-14'), Date.parse('2026-01-14T21:00:00Z'));
  assert.equal(compactNews([{
    title: '美股盘后消息', url: 'https://example.com/us-after',
    time: Date.parse('2026-07-14T20:01:00Z'),
  }], { market: 'us', reviewDate: '2026-07-14' }).length, 0);
});

test('市场相关新闻筛选后为空时记为缺失且不回退全量新闻', async () => {
  const { service } = createHarness({
    newsRows: [{
      title: '欧股收盘消息', url: 'https://example.com/europe-only',
      time: Date.parse('2026-07-14T06:00:00Z'),
    }],
  });
  const evidence = await service.collectEvidence('cn', new Date('2026-07-14T07:20:00Z'));
  assert.equal(evidence.components.some((component) => component.name === 'news'), false);
  assert.equal(evidence.missing.includes('news'), true);
});

test('跨资产快照不得晚于复盘日收盘', () => {
  const frozen = freezeOptionalComponent('macroProxies', [
    { code: '^VIX', asOf: '2026-07-14T19:59:00Z', changePct: 1 },
    { code: 'BTC-USD', asOf: '2026-07-14T20:30:00Z', changePct: 2 },
  ], {
    stale: false, asOf: '2026-07-14T20:30:00Z', asOfBasis: 'provider',
  }, 'us', '2026-07-14');
  assert.equal(frozen.excluded, undefined);
  assert.deepEqual(frozen.data.map((row) => row.code), ['^VIX']);
  assert.equal(frozen.removed, 1);
});

test('无行级时点的收盘板块/榜单可以从同日稳定后抓取归一，跨日抓取仍排除', () => {
  const dataByName = {
    sectors: { stats: { totalCount: 1 }, leaders: [{ name: '科技' }] },
    representativeGainers: [{ code: 'sh600000', name: '测试' }],
  };
  for (const [name, data] of Object.entries(dataByName)) {
    const sameDay = freezeOptionalComponent(name, data, {
      stale: false,
      asOf: '2026-07-14T07:15:00Z',
      fetchedAt: '2026-07-14T07:15:00Z',
      asOfBasis: 'fetch_time',
    }, 'cn', '2026-07-14');
    assert.equal(sameDay.excluded, undefined);
    assert.equal(sameDay.meta.asOfBasis, 'completed_session');

    const nextDay = freezeOptionalComponent(name, data, {
      stale: false,
      asOf: '2026-07-18T02:00:00Z',
      fetchedAt: '2026-07-18T02:00:00Z',
      asOfBasis: 'fetch_time',
    }, 'cn', '2026-07-17');
    assert.equal(nextDay.excluded, true);
  }

  const beforeStable = freezeOptionalComponent('representativeGainers', dataByName.representativeGainers, {
    stale: false,
    asOf: '2026-07-14T07:05:00Z',
    fetchedAt: '2026-07-14T07:05:00Z',
    asOfBasis: 'fetch_time',
  }, 'cn', '2026-07-14');
  assert.equal(beforeStable.excluded, true);

  const stale = freezeOptionalComponent('sectors', dataByName.sectors, {
    stale: true,
    asOf: '2026-07-14T07:15:00Z',
    fetchedAt: '2026-07-14T07:15:00Z',
    asOfBasis: 'fetch_time',
  }, 'cn', '2026-07-14');
  assert.equal(stale.excluded, true);
  assert.match(stale.reason, /旧缓存/);
});

test('成交额降级时无 currentDate 的当日 overview 可归一为已完成交易日', () => {
  const data = {
    up: 20, nonUp: 10, total: 30, turnover: 1e11,
    turnoverComparison: {
      available: false, currentDate: '', asOfTime: '', basis: 'sector_sum_fallback',
    },
  };
  const sameDay = freezeOptionalComponent('overview', data, {
    stale: false,
    asOf: '2026-07-14T07:15:00Z',
    fetchedAt: '2026-07-14T07:15:00Z',
    asOfBasis: 'fetch_time',
  }, 'cn', '2026-07-14');
  assert.equal(sameDay.excluded, undefined);
  assert.equal(sameDay.meta.asOfBasis, 'completed_session');

  const weekend = freezeOptionalComponent('overview', data, {
    stale: false,
    asOf: '2026-07-18T02:00:00Z',
    fetchedAt: '2026-07-18T02:00:00Z',
    asOfBasis: 'fetch_time',
  }, 'cn', '2026-07-17');
  assert.equal(weekend.excluded, true);
});

test('三个市场收盘缓冲按当地时区判断，并自动覆盖美股夏冬令时', () => {
  assert.equal(isCompletedReviewDate('cn', '2026-07-14', new Date('2026-07-14T07:09:00Z')), false);
  assert.equal(isCompletedReviewDate('cn', '2026-07-14', new Date('2026-07-14T07:10:00Z')), true);
  assert.equal(isCompletedReviewDate('hk', '2026-07-14', new Date('2026-07-14T08:14:00Z')), false);
  assert.equal(isCompletedReviewDate('hk', '2026-07-14', new Date('2026-07-14T08:15:00Z')), true);
  assert.equal(isCompletedReviewDate('us', '2026-07-14', new Date('2026-07-14T20:14:00Z')), false);
  assert.equal(isCompletedReviewDate('us', '2026-07-14', new Date('2026-07-14T20:15:00Z')), true);
  assert.equal(isCompletedReviewDate('us', '2026-01-14', new Date('2026-01-14T21:14:00Z')), false);
  assert.equal(isCompletedReviewDate('us', '2026-01-14', new Date('2026-01-14T21:15:00Z')), true);
  assert.equal(previousWeekday('2026-07-13'), '2026-07-10');
});

test('收盘缓冲前只返回 scheduled，不采集行情或调用模型', async () => {
  const { service, calls } = createHarness({ timestamp: Date.parse('2026-07-14T06:59:00Z') });
  const result = await service.ensureReview('cn');
  assert.equal(result.data.status, 'scheduled');
  assert.equal(result.data.available, false);
  assert.deepEqual(calls, { indices: 0, kline: 0, llm: 0 });
});

test('同一市场交易日并发请求、后续请求与服务重建都只生成一次', async () => {
  const sharedStore = createMemoryStore();
  const first = createHarness({ store: sharedStore });
  const results = await Promise.all(Array.from({ length: 8 }, () => first.service.ensureReview('cn')));
  assert.equal(first.calls.llm, 1);
  assert.equal(first.calls.indices, 1);
  assert.ok(results.every((result) => result.data.reviewDate === '2026-07-14'));
  assert.equal(sharedStore.reviews.size, 1);
  assert.deepEqual(results[0].data.card.evidenceRefs.headline, ['indices']);
  assert.deepEqual(results[0].data.detail.evidenceRefs.executiveSummary, ['indices', 'indexHistory']);

  await first.service.getSummary('cn');
  assert.equal(first.calls.llm, 1);
  const rebuilt = createHarness({ store: sharedStore, completionText: 'must not be used' });
  const stored = await rebuilt.service.ensureReview('cn');
  assert.equal(stored.data.status, 'ready');
  assert.equal(rebuilt.calls.llm, 0);
  assert.equal(rebuilt.calls.indices, 0);
});

test('缺少精确核心指数时不会回退到其他指数生成复盘', async () => {
  const { service, store, calls } = createHarness({
    indicesRows: [{
      code: 'sz399001', name: '深证成指', price: 11000, changePct: 1,
      asOf: '2026-07-14T15:00:00+08:00',
    }],
  });
  const result = await service.ensureReview('cn');
  assert.equal(result.data.status, 'retry_pending');
  assert.equal(calls.kline, 0);
  assert.equal(calls.llm, 0);
  assert.equal(store.reviews.size, 0);
});

test('次要指数的旧缓存与跨交易日日线会被排除并进入限制说明', async () => {
  const indicesRows = [
    {
      code: 'sh000001', name: '上证指数', price: 3200, changePct: 1,
      asOf: '2026-07-14T15:00:00+08:00',
    },
    {
      code: 'sz399001', name: '深证成指', price: 11000, changePct: 0.5,
      asOf: '2026-07-14T15:00:00+08:00',
    },
    {
      code: 'sz399006', name: '创业板指', price: 2200, changePct: -0.5,
      asOf: '2026-07-14T15:00:00+08:00',
    },
  ];
  const { service } = createHarness({
    indicesRows,
    klineByCode: {
      sz399001: { stale: true },
      sz399006: { latestDate: '2026-07-13' },
    },
  });
  const evidence = await service.collectEvidence('cn', new Date('2026-07-14T07:20:00Z'));
  const indexRows = evidence.components.find((component) => component.name === 'indices').data;
  const historyRows = evidence.components.find((component) => component.name === 'indexHistory').data;
  assert.deepEqual(indexRows.map((row) => row.code), ['sh000001']);
  assert.deepEqual(historyRows.map((row) => row.code), ['sh000001']);
  assert.ok(evidence.missing.includes('部分次要指数'));
  assert.ok(evidence.limitations.some((item) => item.includes('深证成指') && item.includes('旧缓存')));
  assert.ok(evidence.limitations.some((item) => item.includes('创业板指') && item.includes('不一致')));
});

test('美股证据会同时采集涨跌代表样本', async () => {
  const { service } = createHarness({
    indicesRows: [{
      code: '^GSPC', name: '标普五百', price: 6200, changePct: 0.4,
      asOf: '2026-07-14T16:00:00-04:00',
    }],
    rankDataByDirection: {
      up: [{ code: 'AAPL', name: '苹果', price: 220, changePct: 2, asOf: '2026-07-14T16:00:00-04:00' }],
      down: [{ code: 'MSFT', name: '微软', price: 480, changePct: -1, asOf: '2026-07-14T16:00:00-04:00' }],
    },
    newsRows: [],
  });
  const evidence = await service.collectEvidence('us', new Date('2026-07-14T20:20:00Z'));
  const names = new Set(evidence.components.map((component) => component.name));
  assert.equal(names.has('representativeGainers'), true);
  assert.equal(names.has('representativeLosers'), true);
  assert.ok(evidence.limitations.some((item) => item.includes('美股涨跌榜')));
});

test('核心指数日线为旧缓存时不固化当日复盘', async () => {
  const { service, store, calls } = createHarness({ klineStale: true });
  const result = await service.ensureReview('cn');
  assert.equal(result.data.status, 'retry_pending');
  assert.equal(result.data.available, false);
  assert.equal(calls.llm, 0);
  assert.equal(store.reviews.size, 0);
});

test('模型输出失败会记录退避且保留上一交易日复盘', async () => {
  const store = createMemoryStore();
  store.upsert({
    schemaVersion: 1, available: true, status: 'ready', configured: true,
    market: 'cn', marketLabel: 'A股', reviewDate: '2026-07-13',
    generatedAt: '2026-07-13T07:20:00.000Z', card: { headline: '旧复盘' },
  });
  const { service, calls } = createHarness({ store, completionText: '{bad' });
  const failed = await service.ensureReview('cn');
  assert.equal(calls.llm, 1);
  assert.equal(failed.data.status, 'retry_pending');
  assert.equal(failed.data.reviewDate, '2026-07-13');
  assert.ok(store.getAttempt('cn', '2026-07-14'));

  const again = await service.ensureReview('cn');
  assert.equal(again.data.status, 'retry_pending');
  assert.equal(calls.llm, 1);
});
