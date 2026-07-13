'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createEvidenceBuilder } = require('../src/ai/evidence');

const CN_CONTEXT = { code: 'sh600519', name: '贵州茅台', market: 'cn' };

function makeQuote(changePct = 1.5, overrides = {}) {
  return {
    code: 'sh600519',
    name: '贵州茅台行情名称',
    market: 'cn',
    price: 1500,
    prevClose: 1480,
    open: 1490,
    high: 1510,
    low: 1475,
    change: 20,
    changePct,
    time: '2026-07-13 15:00:00',
    volume: 123456,
    amount: 987654321,
    extra: 'must be removed',
    ...overrides,
  };
}

function createHarness({
  quote = makeQuote(),
  quoteError = null,
  researchEntry = { data: {} },
  researchError = null,
  stockEvents = { asOf: '2026-07-13T15:00:00.000Z', events: [{ title: '事件' }] },
  stockEventsError = null,
  meta = {},
  now = () => Date.UTC(2026, 6, 13, 12, 34, 56),
  isCNCode = (code) => /^(sh|sz|bj)\d{6}$/.test(code),
} = {}) {
  const calls = [];
  const errors = [];
  const marketService = {
    async quote(code) {
      calls.push(['quote', code]);
      if (quoteError) throw quoteError;
      return { data: quote };
    },
    async research(code) {
      calls.push(['research', code]);
      if (researchError) throw researchError;
      return researchEntry;
    },
  };
  const stockEventsService = {
    async getStockEvents(code, options) {
      calls.push(['stockEvents', code, options]);
      if (stockEventsError) throw stockEventsError;
      return stockEvents;
    },
  };
  const marketForCode = (code) => {
    calls.push(['marketForCode', code]);
    return 'derived-market';
  };
  const marketMeta = (entry, spec) => {
    calls.push(['marketMeta', entry, spec]);
    return meta;
  };
  const logger = {
    error(message) {
      errors.push(message);
    },
  };
  const builder = createEvidenceBuilder({
    marketService,
    stockEventsService,
    marketMeta,
    marketForCode,
    isCNCode,
    logger,
    now,
  });
  return { ...builder, calls, errors, researchEntry, stockEvents };
}

test('builder guards return null without callbacks or I/O', async () => {
  const harness = createHarness();
  const tools = [];
  const onTool = (name, args) => tools.push([name, args]);

  assert.equal(await harness.buildAutomaticStockResearch(null, '综合分析', { onTool }), null);
  assert.equal(await harness.buildAutomaticStockResearch(
    CN_CONTEXT,
    '公司什么时候成立？',
    { onTool },
  ), null);
  assert.equal(await harness.buildAutomaticStockEvidence(null, '为什么涨？', { onTool }), null);
  assert.equal(await harness.buildAutomaticStockEvidence(
    CN_CONTEXT,
    '今天价格是多少？',
    { onTool },
  ), null);

  assert.deepEqual(tools, []);
  assert.deepEqual(harness.calls, []);
  assert.deepEqual(harness.errors, []);
});

test('automatic research reports its tool, uses derived market metadata, and compacts output', async () => {
  const data = {
    code: 'sh600519',
    market: 'cn',
    currency: 'CNY',
    analysisAsOf: '2026-07-13',
    lastTradeDate: '2026-07-13',
    comparisonAsOf: '2026-07-13',
    latestBarComplete: false,
    historySessions: 400,
    alignedSessions: 398,
    latestClose: 1500,
    benchmark: { code: 'sh000300' },
    returns: { '20d': { assetPct: 3.2 } },
    range52: { positionPct: 75 },
    risk: { annualizedVolatility20Pct: 18 },
    volume20: { ratio: 1.2 },
    quality: { degraded: false },
    signals: [{ type: 'volume' }],
    privateField: 'drop me',
  };
  const meta = {
    source: '腾讯行情',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    asOf: '2026-07-13T07:00:00.000Z',
    fetchedAt: '2026-07-13T07:00:01.000Z',
    stale: true,
    staleSince: '2026-07-13T07:01:00.000Z',
    adjustmentBasis: 'qfq',
    adjustmentCoverage: 0.98,
    coverage: { benchmark: true },
    amountUnit: 'base_currency',
  };
  const entry = { data, fetchedAt: 1234, stale: true };
  const harness = createHarness({ researchEntry: entry, meta });
  const toolCalls = [];

  const result = await harness.buildAutomaticStockResearch(
    CN_CONTEXT,
    '近20日表现和波动率怎么样？',
    { onTool: (name, args) => toolCalls.push([name, args]) },
  );

  assert.deepEqual(toolCalls, [[
    'get_research_card',
    { code: 'sh600519', auto: true },
  ]]);
  assert.deepEqual(harness.calls, [
    ['research', 'sh600519'],
    ['marketForCode', 'sh600519'],
    ['marketMeta', entry, { market: 'derived-market' }],
  ]);
  assert.deepEqual(result, {
    data: {
      code: data.code,
      market: data.market,
      currency: data.currency,
      analysisAsOf: data.analysisAsOf,
      lastTradeDate: data.lastTradeDate,
      comparisonAsOf: data.comparisonAsOf,
      latestBarComplete: data.latestBarComplete,
      historySessions: data.historySessions,
      alignedSessions: data.alignedSessions,
      latestClose: data.latestClose,
      benchmark: data.benchmark,
      returns: data.returns,
      range52: data.range52,
      risk: data.risk,
      volume20: data.volume20,
      quality: data.quality,
      signals: data.signals,
    },
    meta: {
      source: meta.source,
      currency: meta.currency,
      timezone: meta.timezone,
      asOf: meta.asOf,
      fetchedAt: meta.fetchedAt,
      stale: meta.stale,
      staleSince: meta.staleSince,
      adjustmentBasis: meta.adjustmentBasis,
      adjustmentCoverage: meta.adjustmentCoverage,
      coverage: meta.coverage,
    },
  });
  assert.equal('privateField' in result.data, false);
  assert.equal('amountUnit' in result.meta, false);
  assert.deepEqual(harness.errors, []);
});

test('automatic research turns service failures into a compact fallback and injected log', async () => {
  const harness = createHarness({ researchError: new Error('research down') });
  const tools = [];

  const result = await harness.buildAutomaticStockResearch(
    CN_CONTEXT,
    '综合分析一下这只股票',
    { onTool: (name, args) => tools.push([name, args]) },
  );

  assert.deepEqual(result, {
    data: { code: 'sh600519', market: 'cn' },
    meta: null,
    error: '研究卡暂时不可用',
  });
  assert.deepEqual(tools, [[
    'get_research_card',
    { code: 'sh600519', auto: true },
  ]]);
  assert.deepEqual(harness.calls, [['research', 'sh600519']]);
  assert.deepEqual(harness.errors, ['[stock-research] sh600519: research down']);
});

test('reason intent fetches events even for a normal move and compacts the quote', async () => {
  const quote = makeQuote(1.5);
  const stockEvents = {
    asOf: '2026-07-13T15:00:00.000Z',
    coverage: { supported: true },
    events: [{ title: '公司公告', url: 'https://example.test/event' }],
  };
  const harness = createHarness({ quote, stockEvents });
  const order = [];

  const result = await harness.buildAutomaticStockEvidence(
    CN_CONTEXT,
    '这只股票为什么涨？',
    { onTool: (name, args) => order.push([name, args]) },
  );

  assert.deepEqual(order, [
    ['get_quote', { code: 'sh600519', auto: true }],
    ['get_stock_events', { code: 'sh600519', lookbackHours: 72, auto: true }],
  ]);
  assert.deepEqual(harness.calls, [
    ['quote', 'sh600519'],
    ['stockEvents', 'sh600519', {
      name: '贵州茅台行情名称',
      lookbackHours: 72,
      limit: 8,
    }],
  ]);
  assert.deepEqual(result, {
    reasonIntent: true,
    abnormalMove: false,
    quote: {
      code: quote.code,
      name: quote.name,
      market: quote.market,
      price: quote.price,
      prevClose: quote.prevClose,
      open: quote.open,
      high: quote.high,
      low: quote.low,
      change: quote.change,
      changePct: quote.changePct,
      time: quote.time,
    },
    stockEvents,
  });
  assert.equal('volume' in result.quote, false);
  assert.equal('extra' in result.quote, false);
  assert.deepEqual(harness.errors, []);
});

test('checkMove uses an inclusive absolute 7 percent threshold', async (t) => {
  for (const { value, abnormal } of [
    { value: '7', abnormal: true },
    { value: -7, abnormal: true },
    { value: 6.99, abnormal: false },
    { value: '-6.99', abnormal: false },
  ]) {
    await t.test(String(value), async () => {
      const harness = createHarness({ quote: makeQuote(value) });
      const tools = [];
      const result = await harness.buildAutomaticStockEvidence(
        CN_CONTEXT,
        '今天表现如何？',
        {
          checkMove: true,
          onTool: (name, args) => tools.push([name, args]),
        },
      );

      if (abnormal) {
        assert.equal(result.reasonIntent, false);
        assert.equal(result.abnormalMove, true);
        assert.deepEqual(tools.map(([name]) => name), ['get_quote', 'get_stock_events']);
        assert.deepEqual(harness.calls.map(([name]) => name), ['quote', 'stockEvents']);
      } else {
        assert.equal(result, null);
        assert.deepEqual(tools.map(([name]) => name), ['get_quote']);
        assert.deepEqual(harness.calls, [['quote', 'sh600519']]);
      }
    });
  }
});

test('quote failures are logged; reason intent continues while checkMove alone stops', async (t) => {
  await t.test('reason intent falls back to context name and still fetches events', async () => {
    const harness = createHarness({ quoteError: new Error('quote down') });
    const tools = [];
    const result = await harness.buildAutomaticStockEvidence(
      CN_CONTEXT,
      '有什么最新消息？',
      { onTool: (name, args) => tools.push([name, args]) },
    );

    assert.equal(result.reasonIntent, true);
    assert.equal(result.abnormalMove, false);
    assert.equal(result.quote, null);
    assert.deepEqual(result.stockEvents, harness.stockEvents);
    assert.deepEqual(tools.map(([name]) => name), ['get_quote', 'get_stock_events']);
    assert.deepEqual(harness.calls, [
      ['quote', 'sh600519'],
      ['stockEvents', 'sh600519', {
        name: '贵州茅台',
        lookbackHours: 72,
        limit: 8,
      }],
    ]);
    assert.deepEqual(harness.errors, ['[stock-evidence] quote sh600519: quote down']);
  });

  await t.test('checkMove without reason returns null after quote failure', async () => {
    const harness = createHarness({ quoteError: new Error('quote down') });
    const tools = [];
    const result = await harness.buildAutomaticStockEvidence(
      CN_CONTEXT,
      '今天表现如何？',
      {
        checkMove: true,
        onTool: (name, args) => tools.push([name, args]),
      },
    );

    assert.equal(result, null);
    assert.deepEqual(tools.map(([name]) => name), ['get_quote']);
    assert.deepEqual(harness.calls, [['quote', 'sh600519']]);
    assert.deepEqual(harness.errors, ['[stock-evidence] quote sh600519: quote down']);
  });
});

test('event failures use injected now, market support predicate, and logger', async () => {
  const fixedNow = Date.UTC(2026, 6, 13, 12, 34, 56);
  const checkedCodes = [];
  const harness = createHarness({
    stockEventsError: new Error('news down'),
    now: () => fixedNow,
    isCNCode(code) {
      checkedCodes.push(code);
      return code === 'sh600519';
    },
  });

  const result = await harness.buildAutomaticStockEvidence(CN_CONTEXT, '异动原因是什么？');

  assert.deepEqual(result.stockEvents, {
    asOf: '2026-07-13T12:34:56.000Z',
    stock: CN_CONTEXT,
    coverage: { supported: true, error: '个股资讯源暂时不可用' },
    events: [],
  });
  assert.equal(result.stockEvents.stock, CN_CONTEXT);
  assert.deepEqual(checkedCodes, ['sh600519']);
  assert.deepEqual(harness.errors, ['[stock-evidence] news sh600519: news down']);
});

test('callback exceptions preserve the current asymmetric boundaries', async (t) => {
  await t.test('research callback rejects before service I/O', async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.buildAutomaticStockResearch(
        CN_CONTEXT,
        '综合分析一下这只股票',
        { onTool: () => { throw new Error('research callback failed'); } },
      ),
      /research callback failed/,
    );
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.errors, []);
  });

  await t.test('quote callback is caught as a quote failure and reason intent continues', async () => {
    const harness = createHarness();
    const callbacks = [];
    const result = await harness.buildAutomaticStockEvidence(
      CN_CONTEXT,
      '为什么涨？',
      {
        onTool(name) {
          callbacks.push(name);
          if (name === 'get_quote') throw new Error('quote callback failed');
        },
      },
    );

    assert.deepEqual(callbacks, ['get_quote', 'get_stock_events']);
    assert.equal(result.quote, null);
    assert.equal(result.reasonIntent, true);
    assert.deepEqual(harness.calls, [[
      'stockEvents',
      'sh600519',
      { name: '贵州茅台', lookbackHours: 72, limit: 8 },
    ]]);
    assert.deepEqual(harness.errors, [
      '[stock-evidence] quote sh600519: quote callback failed',
    ]);
  });

  await t.test('event callback rejects outside the event-service try block', async () => {
    const harness = createHarness();
    await assert.rejects(
      harness.buildAutomaticStockEvidence(
        CN_CONTEXT,
        '为什么涨？',
        {
          onTool(name) {
            if (name === 'get_stock_events') throw new Error('event callback failed');
          },
        },
      ),
      /event callback failed/,
    );
    assert.deepEqual(harness.calls, [['quote', 'sh600519']]);
    assert.deepEqual(harness.errors, []);
  });
});
