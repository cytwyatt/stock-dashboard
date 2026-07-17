'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { annotateMarketData, marketMeta } = require('../src/core/market-meta');
const { marketReviewSystemPrompt } = require('../src/ai/prompts');
const {
  REVIEW_SCHEMA_VERSION,
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
    synthesisOutlook: {
      integratedAssessment: '综合全部可用证据看，核心指数的收盘结构与近阶段表现保持一致，市场内部线索仍有分化，因此后续判断需要同时观察价格延续性、量能配合和风险信号，而不能由单一指标外推。',
      summary: '基准情景偏向震荡偏强，但方向仍取决于指数结构能否延续，并需保留转弱情景。',
      evidenceRefs: {
        integratedAssessment: ['indices', 'indexHistory'],
        summary: ['indices', 'indexHistory'],
      },
      citationRefs: { integratedAssessment: [], summary: [] },
      baseCase: {
        bias: '震荡偏强',
        text: '若指数收盘结构与阶段表现继续一致，市场更可能维持震荡偏强，但仍需后续交易确认。',
        conditions: ['核心指数维持当前收盘结构', '阶段表现未出现明显转弱'],
        invalidations: ['核心指数与阶段表现转为明显背离'],
        evidenceRefs: ['indices', 'indexHistory'],
        citationRefs: [],
      },
      upsideScenario: {
        bias: '偏强',
        text: '若指数结构进一步改善且阶段表现同步增强，偏强情景的重要性将上升。',
        conditions: ['核心指数与阶段表现同步改善'],
        invalidations: ['指数改善缺少阶段表现确认'],
        evidenceRefs: ['indices', 'indexHistory'],
        citationRefs: [],
      },
      downsideScenario: {
        bias: '偏弱',
        text: '若核心指数转弱并与阶段表现形成同向压力，偏弱情景的重要性将上升。',
        conditions: ['核心指数与阶段表现同步转弱'],
        invalidations: ['核心指数重新恢复当前收盘结构'],
        evidenceRefs: ['indices', 'indexHistory'],
        citationRefs: [],
      },
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

function serviceCompletion(stance = '数据不足') {
  const payload = JSON.parse(completion(stance));
  payload.synthesisOutlook.evidenceRefs.integratedAssessment.push('overview');
  return JSON.stringify(payload);
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
  llmConfig = null,
  completionText = serviceCompletion(),
  completionMeta = null,
  klineStale = false,
  indicesRows = null,
  klineByCode = {},
  newsRows = null,
  sectorsData = [],
  rankDataByDirection = {},
  quotesData = [],
} = {}) {
  const calls = { indices: 0, kline: 0, llm: 0 };
  const llmRequests = [];
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
    llmConfigStore: {
      getLLMConfig: () => ({
        apiKey,
        model: 'test-model',
        baseUrl: 'https://example.test',
        ...(llmConfig || {}),
      }),
    },
    llmClient: {
      async complete(config, messages, tools, options) {
        calls.llm++;
        llmRequests.push({ config, messages, tools, options });
        return {
          content: completionText,
          ...(completionMeta ? { _completionMeta: completionMeta } : {}),
        };
      },
    },
    marketMeta,
    annotateMarketData,
    marketReviewSystemPrompt: () => 'review prompt',
    now: () => timestamp,
    logger: { error() {} },
  });
  return { service, store, calls, llmRequests };
}

test('盘后复盘 v2 提示词固定综合研判与条件式展望契约', () => {
  assert.equal(REVIEW_SCHEMA_VERSION, 2);
  const prompt = marketReviewSystemPrompt();
  for (const field of [
    'synthesisOutlook', 'integratedAssessment', 'summary', 'baseCase',
    'upsideScenario', 'downsideScenario', 'conditions', 'invalidations', 'evidenceRefs',
  ]) {
    assert.match(prompt, new RegExp(field));
  }
  assert.match(prompt, /未来一至五个交易日/);
  assert.match(prompt, /(?:不得|禁止).*(?:阿拉伯数字|数字)/);
  assert.match(prompt, /(?:不得|禁止).*(?:必然|一定|保证|确定性)/);
  assert.match(prompt, /(?:不得|禁止).*(?:买卖|仓位|收益承诺|投资建议)/);
  assert.match(prompt, /可验证、可失效的情景推演/);
});

test('综合研判与条件式展望严格解析合法结构并拒绝高风险表述', () => {
  const allowed = {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'overview'],
    associationEvidenceRefs: ['indices', 'indexHistory'],
  };
  const valid = JSON.parse(completion());
  const parsed = parseMarketReview(JSON.stringify(valid), allowed);
  assert.deepEqual(parsed.synthesisOutlook, valid.synthesisOutlook);

  const invalidCases = [
    {
      name: '模型自报数字',
      mutate(payload) { payload.synthesisOutlook.baseCase.conditions[0] = '核心指数站上3200点'; },
      error: /数字|阿拉伯数字/,
    },
    {
      name: '确定性预测',
      mutate(payload) {
        payload.synthesisOutlook.upsideScenario.text = '未来一定会持续上涨，市场方向不会再改变，任何回落都可以被视为已经结束。';
      },
      error: /确定|必然|一定|保证/,
    },
    {
      name: '无条件方向断言',
      mutate(payload) {
        payload.synthesisOutlook.baseCase.text = '市场将全面走高，强势行情延续；结论已经明确，后续仍需观察确认。';
      },
      error: /确定|预测|条件式/,
    },
    {
      name: '用模糊可能性措辞包装确定性判断',
      mutate(payload) {
        payload.synthesisOutlook.summary = '未来市场全面上扬，强势格局已经确立，整体风险有限；这是当前最可能的结果。';
      },
      error: /确定|预测|条件式/,
    },
    {
      name: '空洞条件包装确定性方向',
      mutate(payload) {
        payload.synthesisOutlook.summary = '若后续继续观察，市场上行方向已无悬念，整体风险已经十分有限，这是当前最有把握且不会改变的判断。';
      },
      error: /确定|预测|可验证/,
    },
    {
      name: '综合研判无来源因果',
      mutate(payload) {
        payload.synthesisOutlook.integratedAssessment = '由于政策持续发力，指数与阶段表现已经形成明确结论，市场内部的全部信息都支持这一判断，未来方向也已经十分清晰，整体风险可以忽略。';
      },
      error: /因果|因果表述/,
    },
    {
      name: '买卖与仓位建议',
      mutate(payload) { payload.synthesisOutlook.downsideScenario.invalidations[0] = '建议立即买入并加仓。'; },
      error: /买卖|买入|仓位|投资建议|建议/,
    },
    {
      name: '条件不是字符串',
      mutate(payload) { payload.synthesisOutlook.baseCase.conditions[0] = { text: '核心指数改善' }; },
      error: /必须是文本/,
    },
    {
      name: '偏强情景方向错配',
      mutate(payload) {
        payload.synthesisOutlook.upsideScenario.text = '若核心指数持续转弱且内部压力扩大，偏弱风险可能进一步上升，市场结构也可能呈现更广泛的恶化迹象。';
        payload.synthesisOutlook.upsideScenario.conditions = ['核心指数与阶段表现同步转弱'];
      },
      error: /方向不一致/,
    },
    {
      name: '偏强条件词不得掩盖偏弱结果',
      mutate(payload) {
        payload.synthesisOutlook.upsideScenario.text = '若核心指数短暂改善后持续转弱，偏弱风险可能进一步上升并形成更广泛弱势。';
      },
      error: /方向不一致/,
    },
    {
      name: '偏弱条件词不得掩盖偏强结果',
      mutate(payload) {
        payload.synthesisOutlook.downsideScenario.text = '若核心指数短暂转弱后持续改善，偏强态势可能增强并扩散，内部结构也更有利于进一步修复。';
      },
      error: /方向不一致/,
    },
    {
      name: '偏强情景的成立与失效条件反向',
      mutate(payload) {
        payload.synthesisOutlook.upsideScenario.conditions = ['核心指数持续转弱且内部压力扩大'];
        payload.synthesisOutlook.upsideScenario.invalidations = ['核心指数与阶段表现同步改善'];
      },
      error: /方向不一致|反向失效信号/,
    },
    {
      name: '基准偏向与正文错配',
      mutate(payload) {
        payload.synthesisOutlook.baseCase.text = '若指数收盘结构转弱且阶段表现同步承压，基准标签仍写作震荡偏强，但实际情景为震荡偏弱并需等待后续确认。';
      },
      error: /基准偏向不一致/,
    },
    {
      name: '成立与失效条件重复',
      mutate(payload) {
        payload.synthesisOutlook.baseCase.invalidations = [payload.synthesisOutlook.baseCase.conditions[0]];
      },
      error: /重复/,
    },
    {
      name: '情景正文重复',
      mutate(payload) {
        payload.synthesisOutlook.downsideScenario.text = payload.synthesisOutlook.upsideScenario.text;
      },
      error: /方向不一致|正文重复/,
    },
    {
      name: '引用未对齐证据',
      mutate(payload) { payload.synthesisOutlook.baseCase.evidenceRefs = ['overview']; },
      error: /时点未对齐|evidenceRefs/,
    },
  ];
  for (const scenario of invalidCases) {
    const payload = structuredClone(valid);
    scenario.mutate(payload);
    assert.throws(
      () => parseMarketReview(JSON.stringify(payload), allowed),
      scenario.error,
      scenario.name,
    );
  }

  const narrowSynthesis = structuredClone(valid);
  narrowSynthesis.synthesisOutlook.evidenceRefs.integratedAssessment = [
    'indices', 'indexHistory', 'overview',
  ];
  assert.throws(() => parseMarketReview(JSON.stringify(narrowSynthesis), {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'overview', 'sectors', 'macroProxies'],
    associationEvidenceRefs: ['indices', 'indexHistory', 'overview', 'sectors', 'macroProxies'],
  }), /证据类别/);
});

test('综合研判引用新闻时必须带白名单来源并在最终结果保留引用', async () => {
  const payload = JSON.parse(serviceCompletion());
  payload.synthesisOutlook.integratedAssessment = '据新浪财经报道，市场政策线索仍值得跟踪；结合指数、阶段表现与成交结构，当前主线存在一定延续性，但内部确认并不充分，不同类别信号之间仍有需要解释的背离，后续判断应以多类条件是否共同兑现来检验，而不能只依赖单一信息。';
  payload.synthesisOutlook.evidenceRefs.integratedAssessment.push('news');
  payload.synthesisOutlook.citationRefs.integratedAssessment = ['news:1'];

  const parsed = parseMarketReview(JSON.stringify(payload), {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'overview', 'news'],
    allowedCitationRefs: ['news:1'],
    associationEvidenceRefs: ['indices', 'indexHistory', 'overview', 'news'],
  });
  assert.deepEqual(parsed.synthesisOutlook.citationRefs.integratedAssessment, ['news:1']);

  const missingCitation = structuredClone(payload);
  missingCitation.synthesisOutlook.citationRefs.integratedAssessment = [];
  assert.throws(() => parseMarketReview(JSON.stringify(missingCitation), {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'overview', 'news'],
    allowedCitationRefs: ['news:1'],
    associationEvidenceRefs: ['indices', 'indexHistory', 'overview', 'news'],
  }), /新闻引用|来源归属|citationRefs/);

  const { service } = createHarness({ completionText: JSON.stringify(payload) });
  const review = await service.ensureReview('cn');
  assert.deepEqual(review.data.detail.synthesisOutlook.citationRefs.integratedAssessment, ['news:1']);
  assert.equal(review.data.citations.some((citation) => citation.id === 'news:1'), true);
});

test('生成结果把模型综合研判映射为固定周期卡片与三种详情情景', async () => {
  const payload = JSON.parse(serviceCompletion());
  const { service, store, calls, llmRequests } = createHarness({
    completionText: JSON.stringify(payload),
  });

  const review = await service.ensureReview('cn');

  assert.equal(calls.llm, 1);
  assert.equal(review.data.schemaVersion, 2);
  assert.match(llmRequests[0].messages[1].content, /未来一至五个交易日/);
  assert.deepEqual(review.data.card.outlook, {
    horizon: '未来一至五个交易日',
    bias: payload.synthesisOutlook.baseCase.bias,
    summary: payload.synthesisOutlook.summary,
    evidenceRefs: payload.synthesisOutlook.evidenceRefs.summary,
    citationRefs: payload.synthesisOutlook.citationRefs.summary,
  });

  const synthesis = review.data.detail.synthesisOutlook;
  assert.equal(synthesis.horizon, '未来一至五个交易日');
  assert.equal(synthesis.integratedAssessment, payload.synthesisOutlook.integratedAssessment);
  assert.deepEqual(synthesis.evidenceRefs, {
    integratedAssessment: payload.synthesisOutlook.evidenceRefs.integratedAssessment,
  });
  assert.deepEqual(synthesis.citationRefs, {
    integratedAssessment: payload.synthesisOutlook.citationRefs.integratedAssessment,
  });
  assert.equal(synthesis.confidence.isProbability, false);
  assert.equal(synthesis.confidence.level, 'medium');
  assert.ok(Array.isArray(synthesis.confidence.reasons));
  assert.equal(synthesis.scenarios.length, 3);
  assert.equal(new Set(synthesis.scenarios.map((scenario) => scenario.key)).size, 3);
  assert.ok(synthesis.scenarios.every((scenario) => scenario.title));
  assert.deepEqual(synthesis.scenarios.map((scenario) => ({
    text: scenario.text,
    conditions: scenario.conditions,
    invalidations: scenario.invalidations,
    evidenceRefs: scenario.evidenceRefs,
  })), [
    payload.synthesisOutlook.baseCase,
    payload.synthesisOutlook.upsideScenario,
    payload.synthesisOutlook.downsideScenario,
  ].map(({ text, conditions, invalidations, evidenceRefs }) => ({
    text, conditions, invalidations, evidenceRefs,
  })));
  assert.equal(synthesis.scenarios[0].bias, payload.synthesisOutlook.baseCase.bias);
  assert.equal(review.data.generationMeta.synthesisFallbackUsed, false);
  assert.deepEqual(store.find('cn', '2026-07-14').card.outlook, review.data.card.outlook);
});

test('综合研判未通过语义校验时使用确定性降级且不重复请求模型', async () => {
  const payload = JSON.parse(serviceCompletion());
  payload.synthesisOutlook.summary = '未来预计上涨10%，可以立即买入。';
  const { service, calls } = createHarness({ completionText: JSON.stringify(payload) });

  const review = await service.ensureReview('cn');

  assert.equal(review.data.status, 'ready');
  assert.equal(calls.llm, 1);
  assert.equal(review.data.generationMeta.synthesisFallbackUsed, true);
  assert.notEqual(review.data.card.outlook.summary, payload.synthesisOutlook.summary);
  assert.doesNotMatch(review.data.card.outlook.summary, /\d|买入/);
  assert.equal(review.data.card.outlook.horizon, '未来一至五个交易日');
  assert.equal(review.data.card.outlook.bias, '数据不足');
  assert.equal(review.data.detail.synthesisOutlook.confidence.isProbability, false);
  assert.equal(review.data.detail.synthesisOutlook.confidence.level, 'low');
  const fallbackBase = review.data.detail.synthesisOutlook.scenarios
    .find((scenario) => scenario.key === 'base');
  assert.match(fallbackBase.conditions.join(' '), /缺失|尚未形成一致方向/);
  assert.match(fallbackBase.invalidations.join(' '), /恢复|稳定的同向确认/);
  assert.ok(review.data.dataWarnings.some((warning) => (
    /综合研判|条件式展望/.test(warning) && /降级|确定性|未通过/.test(warning)
  )));
});

test('盘后复盘 JSON 严格校验证据引用与事件归因引用', () => {
  const allowed = {
    allowedEvidenceRefs: ['indices', 'indexHistory', 'news'],
    allowedCitationRefs: ['news:1'],
    associationEvidenceRefs: ['indices', 'indexHistory'],
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

test('宽容模式只剔除不合规明细，整体 JSON 与显著文本仍保持严格校验', () => {
  const allowed = {
    allowedEvidenceRefs: ['indices', 'indexHistory'],
    associationEvidenceRefs: ['indices', 'indexHistory'],
  };
  const payload = JSON.parse(completion());
  payload.sections.breadthLiquidity = [
    {
      text: '核心指数收盘数据可用。', claimType: 'observation',
      evidenceRefs: ['indices'], citationRefs: [],
    },
    {
      text: '市场概况数据可用。', claimType: 'observation',
      evidenceRefs: ['overview'], citationRefs: [],
    },
    {
      text: '资金推动指数上涨。', claimType: 'observation',
      evidenceRefs: ['indices'], citationRefs: [],
    },
  ];

  assert.throws(() => parseMarketReview(JSON.stringify(payload), allowed), /evidenceRefs/);
  const parsed = parseMarketReview(JSON.stringify(payload), {
    ...allowed,
    discardInvalidSectionItems: true,
  });
  assert.deepEqual(parsed.sections.breadthLiquidity, [payload.sections.breadthLiquidity[0]]);
  assert.deepEqual(parsed.validationWarnings.map((warning) => warning.reason), [
    'invalid_evidence_refs',
    'unsupported_causal_language',
  ]);

  const invalidHeadline = structuredClone(payload);
  invalidHeadline.headline = '核心指数上涨1%。';
  assert.throws(() => parseMarketReview(JSON.stringify(invalidHeadline), {
    ...allowed,
    discardInvalidSectionItems: true,
  }), /未经服务端校验的数字/);

  const prominentFallback = {
    stance: '数据不足',
    headline: '服务端收盘摘要。',
    cardSummary: '服务端依据已完成日线生成概要。',
    themes: ['指数表现', '阶段表现'],
    keyRisk: '单日表现不足以验证趋势延续性。',
    executiveSummary: '服务端依据已完成交易日的指数和多周期日线生成确定性摘要。',
    prominentEvidenceRefs: {
      headline: ['indices'],
      cardSummary: ['indices', 'indexHistory'],
      themes: [['indices'], ['indexHistory']],
      keyRisk: ['indexHistory'],
      executiveSummary: ['indices', 'indexHistory'],
    },
  };
  const withFallback = parseMarketReview(JSON.stringify(invalidHeadline), {
    ...allowed,
    discardInvalidSectionItems: true,
    prominentFallback,
  });
  assert.equal(withFallback.headline, prominentFallback.headline);
  assert.deepEqual(withFallback.prominentEvidenceRefs, prominentFallback.prominentEvidenceRefs);
  assert.ok(withFallback.validationWarnings.some((warning) => (
    warning.code === 'prominent_fallback'
  )));
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

test('延迟生成时忽略供应商盘后刷新时点，并以最后两根完整日K构造指数收盘快照', async () => {
  const history = [
    {
      date: '2026-07-13', open: 99, high: 101, low: 98, close: 100, volume: 900,
    },
    {
      date: '2026-07-14', open: 101, high: 103, low: 100, close: 102, volume: 1200,
    },
  ];
  const cases = [
    {
      market: 'cn', code: 'sh000001', name: '上证指数',
      quoteAsOf: '2026-07-14T16:14:00+08:00', collectedAt: '2026-07-14T10:20:00Z',
    },
    {
      market: 'hk', code: 'hkHSI', name: '恒生指数',
      quoteAsOf: '2026-07-14T18:30:00+08:00', collectedAt: '2026-07-14T10:40:00Z',
    },
  ];

  for (const scenario of cases) {
    const { service, calls, llmRequests } = createHarness({
      timestamp: Date.parse(scenario.collectedAt),
      indicesRows: [{
        code: scenario.code,
        name: scenario.name,
        price: 9999,
        changePct: -9,
        open: 8888,
        high: 10000,
        low: 8000,
        asOf: scenario.quoteAsOf,
      }],
      klineByCode: { [scenario.code]: { history } },
    });
    const evidence = await service.collectEvidence(scenario.market, new Date(scenario.collectedAt));
    const indices = evidence.components.find((component) => component.name === 'indices');
    assert.deepEqual(indices.data, [{
      code: scenario.code,
      name: scenario.name,
      currency: null,
      assetType: 'equity_index',
      unit: 'index_points',
      asOf: '2026-07-14',
      price: 102,
      close: 102,
      prevClose: 100,
      change: 2,
      changePct: 2,
      open: 101,
      high: 103,
      low: 100,
      volume: 1200,
      snapshotBasis: 'completed_daily_bar',
    }]);
    assert.equal(indices.meta.asOf, '2026-07-14');
    assert.equal(indices.meta.asOfBasis, 'completed_session');
    assert.ok(evidence.associationEvidenceRefs.includes('indices'));

    const review = await service.ensureReview(scenario.market);
    assert.equal(review.data.status, 'ready');
    assert.equal(review.data.reviewDate, '2026-07-14');
    assert.equal(calls.llm, 1);
    assert.deepEqual(llmRequests[0].options, {
      maxTokens: 16000,
      timeoutMs: 300000,
      includeMeta: true,
      temperature: 0.15,
    });
    assert.match(llmRequests[0].messages[1].content, /本次合法 evidenceRefs 仅限/);
    assert.match(llmRequests[0].messages[1].content, /绝不能截断 JSON/);
    assert.deepEqual(review.data.card.metrics[0], {
      label: scenario.name,
      value: '+2.00%',
      detail: '收盘 102',
      tone: 'positive',
    });
  }
});

test('官方 DeepSeek V4 复盘独立使用 Pro、高强度思考与 JSON 模式并记录生成指标', async () => {
  const { service, calls, llmRequests } = createHarness({
    llmConfig: {
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-v4-flash',
      marketReviewModel: 'deepseek-v4-pro',
    },
    completionMeta: {
      finishReason: 'stop',
      model: 'deepseek-v4-pro',
      durationMs: 12345,
      usage: {
        promptTokens: 8000,
        completionTokens: 5000,
        reasoningTokens: 3000,
        totalTokens: 13000,
      },
    },
  });

  const review = await service.ensureReview('cn');

  assert.equal(calls.llm, 1);
  assert.equal(llmRequests[0].config.model, 'deepseek-v4-pro');
  assert.deepEqual(llmRequests[0].options, {
    maxTokens: 32768,
    timeoutMs: 300000,
    includeMeta: true,
    omitTemperature: true,
    thinking: 'enabled',
    reasoningEffort: 'high',
    jsonMode: true,
  });
  assert.equal(review.data.model, 'deepseek-v4-pro');
  assert.deepEqual(review.data.generationMeta, {
    finishReason: 'stop',
    durationMs: 12345,
    usage: {
      promptTokens: 8000,
      completionTokens: 5000,
      reasoningTokens: 3000,
      totalTokens: 13000,
    },
    maxOutputTokens: 32768,
    thinking: 'enabled',
    jsonMode: true,
    droppedItemCount: 0,
    prominentFallbackUsed: false,
    synthesisFallbackUsed: false,
  });
});

test('复盘输出因 token 上限截断时不落盘并进入退避状态', async () => {
  const store = createMemoryStore();
  const { service, calls } = createHarness({
    store,
    completionMeta: { finishReason: 'length', durationMs: 100, usage: null },
  });

  const result = await service.ensureReview('cn');

  assert.equal(calls.llm, 1);
  assert.equal(result.data.status, 'retry_pending');
  assert.equal(store.latest('cn'), null);
  assert.match(store.getAttempt('cn', '2026-07-14').error, /16000 token/);
});

test('复盘输出被内容过滤等非正常原因终止时不保存部分结果', async () => {
  const store = createMemoryStore();
  const { service } = createHarness({
    store,
    completionMeta: { finishReason: 'content_filter', durationMs: 100, usage: null },
  });

  const result = await service.ensureReview('cn');

  assert.equal(result.data.status, 'retry_pending');
  assert.equal(store.latest('cn'), null);
  assert.match(store.getAttempt('cn', '2026-07-14').error, /content_filter/);
});

test('生成复盘时安全剔除单条不合规明细，不重试模型且记录数据提示', async () => {
  const payload = JSON.parse(completion());
  payload.cardSummary = '核心指数上涨1%。';
  payload.sections.risks = [
    {
      text: '指数日内振幅值得持续观察。', claimType: 'observation',
      evidenceRefs: ['indices'], citationRefs: [],
    },
    {
      text: '资金推动指数上涨。', claimType: 'observation',
      evidenceRefs: ['indices'], citationRefs: [],
    },
  ];
  const { service, calls } = createHarness({ completionText: JSON.stringify(payload) });
  const review = await service.ensureReview('cn');

  assert.equal(review.data.status, 'ready');
  assert.equal(calls.llm, 1);
  assert.equal(review.data.card.summary, '核心指数收涨，近阶段价格表现偏强。本次卡片以已完成交易日的指数日线为核心，详细分项仅展示通过证据校验的观察。');
  assert.doesNotMatch(review.data.card.summary, /\d/);
  const risks = review.data.detail.sections.find((section) => section.key === 'risks').items;
  assert.deepEqual(risks, [payload.sections.risks[0]]);
  assert.ok(review.data.dataWarnings.some((warning) => (
    warning.includes('服务端确定性摘要')
  )));
  assert.ok(review.data.dataWarnings.some((warning) => (
    warning.includes('risks[1]') && warning.includes('已安全剔除')
  )));
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

test('同日已落盘的 v1 历史复盘保持原样并且不会为 v2 字段重新生成', async () => {
  const store = createMemoryStore();
  const legacy = {
    schemaVersion: 1,
    available: true,
    configured: true,
    status: 'ready',
    market: 'cn',
    marketLabel: 'A股',
    reviewDate: '2026-07-14',
    generatedAt: '2026-07-14T07:15:00.000Z',
    card: { stance: '中性', headline: '旧结构复盘', summary: '旧结构没有条件式展望。' },
    detail: { executiveSummary: '旧结构执行摘要。', sections: [] },
  };
  store.upsert(legacy);
  const { service, calls } = createHarness({
    store,
    completionText: 'must not be used',
  });

  const result = await service.ensureReview('cn');

  assert.equal(result.data.schemaVersion, 1);
  assert.equal(result.data.card.headline, legacy.card.headline);
  assert.equal(result.data.card.outlook, undefined);
  assert.equal(result.data.detail.synthesisOutlook, undefined);
  assert.deepEqual(calls, { indices: 0, kline: 0, llm: 0 });
  assert.deepEqual(store.find('cn', '2026-07-14'), legacy);
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
