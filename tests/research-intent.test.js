'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  unwrapStockChatQuestion,
  targetsDifferentStock,
  hasStockResearchIntent,
  isAbnormalQuote,
  compactQuoteForEvidence,
  compactResearchCardForEvidence,
} = require('../src/ai/research-intent');

test('前端股票问句包装会被剥离，空内文仍保留原始问题', () => {
  assert.equal(
    unwrapStockChatQuestion('  分析股票 贵州茅台（代码：sh600519，市场：A股）。近20日表现？  '),
    '近20日表现？'
  );
  assert.equal(
    unwrapStockChatQuestion('分析股票 贵州茅台。'),
    '分析股票 贵州茅台。'
  );
  assert.equal(unwrapStockChatQuestion(null), '');
});

test('研究意图保持指标、风险、决策、一般分析与非价格问题的优先级', () => {
  const context = { code: 'sh600519', name: '贵州茅台', market: 'cn' };
  for (const prompt of [
    '综合分析一下这只股票',
    '近20日表现和波动率怎么样？',
    '跑赢大盘了吗，最大回撤是多少？',
    '那风险呢？',
    '52周位置和量能如何？',
    '能买吗，仓位怎么控制？',
    '分析一下sh600519',
    '估值和波动率怎么样？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, context), true, prompt);
  }

  for (const prompt of [
    '',
    '公司什么时候成立？',
    '最新公告是什么？',
    '估值和净利润怎么样？',
    '经营风险大吗？',
    '今天大盘怎么样？',
    '今天市场风险如何？',
    '把“风险提示”翻译成英文',
    '大盘最大回撤是多少？',
    '市场52周表现如何？',
    '指数波动率怎么样？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, context), false, prompt);
  }

  assert.equal(hasStockResearchIntent('风险？'), true);
  assert.equal(hasStockResearchIntent('公司什么时候成立？'), false);
});

test('目标识别允许当前股票与明确比较基准，并拒绝其他股票和市场目标', () => {
  const cn = { code: 'sh600519', name: '贵州茅台', market: 'cn' };
  for (const prompt of [
    '600519风险怎么样？',
    '分析一下600519',
    '相对sh000300表现如何？',
    '和000300比表现如何？',
    '贵州茅台与沪深300谁的风险更高？',
  ]) {
    assert.equal(targetsDifferentStock(prompt, cn), false, prompt);
    assert.equal(hasStockResearchIntent(prompt, cn), true, prompt);
  }
  for (const prompt of [
    '600036风险怎么样？',
    '分析一下AAPL',
    '沪深300风险怎么样？',
    '纳斯达克风险怎么样？',
    '黄金风险怎么样？',
  ]) {
    assert.equal(targetsDifferentStock(prompt, cn), true, prompt);
    assert.equal(hasStockResearchIntent(prompt, cn), false, prompt);
  }
  assert.equal(targetsDifferentStock('任意问题', null), false);
});

test('美股 ticker、英文名称、歧义 ticker 与 S&P500 基准维持当前识别规则', () => {
  const context = { code: 'AAPL', name: 'Apple', market: 'us' };
  for (const prompt of [
    'AAPL风险怎么样？',
    'aapl风险怎么样？',
    'Apple风险怎么样？',
    '用AI分析AAPL风险',
    '用AI分析风险',
    '相对^GSPC表现如何？',
    '相对S&P500表现如何？',
    'AAPL与^GSPC谁的风险更高？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, context), true, prompt);
  }
  for (const prompt of [
    'TSLA风险怎么样？',
    '$tsla最大回撤是多少？',
    '分析一下brk.b',
    'aapl与tsla谁的风险更高？',
    '相对tsla表现如何？',
    'MA能买吗？',
    'AI风险怎么样？',
    'Microsoft风险怎么样？',
    '^GSPC风险怎么样？',
    '标普500风险怎么样？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, context), false, prompt);
  }

  const ford = { code: 'F', name: 'Ford Motor', market: 'us' };
  assert.equal(hasStockResearchIntent('分析一下f', ford), true);
});

test('港股目标允许五位代码、去零短码和默认基准，其他短码仍被识别为另一标的', () => {
  const tencent = { code: 'hk00700', name: '腾讯控股', market: 'hk' };
  for (const prompt of [
    '00700风险怎么样？',
    '分析一下700',
    '700怎么样？',
    '相对hkHSI表现如何？',
    '相对HSI表现如何？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, tencent), true, prompt);
  }
  for (const prompt of [
    '09988风险怎么样？',
    '9988能买吗？',
    'hkHSI风险怎么样？',
    '恒生指数最大回撤是多少？',
    '恒生科技风险怎么样？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, tencent), false, prompt);
  }

  const hsbc = { code: 'hk00005', name: '汇丰控股', market: 'hk' };
  assert.equal(hasStockResearchIntent('代码5能买吗？', hsbc), true);
  assert.equal(hasStockResearchIntent('港股16风险怎么样？', hsbc), false);
  assert.equal(targetsDifferentStock('2025年表现如何？', tencent), true);
});

test('异动阈值按绝对涨跌幅 7% 判断并保持数字转换行为', () => {
  assert.equal(isAbnormalQuote(null), false);
  assert.equal(isAbnormalQuote({ changePct: 6.999 }), false);
  assert.equal(isAbnormalQuote({ changePct: '7' }), true);
  assert.equal(isAbnormalQuote({ changePct: -7 }), true);
  assert.equal(isAbnormalQuote({ changePct: 'not-a-number' }), false);
});

test('报价证据只保留固定字段且原样保留空值和零值', () => {
  assert.equal(compactQuoteForEvidence(null), null);
  const quote = {
    code: 'sh600519',
    name: '贵州茅台',
    market: 'cn',
    price: 0,
    prevClose: null,
    open: 1490,
    high: 1510,
    low: 1480,
    change: -1,
    changePct: -0.1,
    time: '',
    volume: 999,
    pe: 20,
    nested: { ignored: true },
  };
  assert.deepEqual(compactQuoteForEvidence(quote), {
    code: 'sh600519',
    name: '贵州茅台',
    market: 'cn',
    price: 0,
    prevClose: null,
    open: 1490,
    high: 1510,
    low: 1480,
    change: -1,
    changePct: -0.1,
    time: '',
  });
});

test('研究卡证据按 data/meta 白名单压缩并保留嵌套对象引用', () => {
  const returns = { '20d': { assetPct: 3.2 } };
  const coverage = { start: '2025-01-01', end: '2026-01-01' };
  const compact = compactResearchCardForEvidence({
    data: {
      code: 'AAPL',
      market: 'us',
      currency: 'USD',
      analysisAsOf: '2026-07-13',
      lastTradeDate: '2026-07-13',
      comparisonAsOf: '2026-07-13',
      latestBarComplete: false,
      historySessions: 300,
      alignedSessions: 298,
      latestClose: 210,
      benchmark: { code: '^GSPC' },
      returns,
      range52: { positionPct: 80 },
      risk: { volatility20Pct: 20 },
      volume20: { ratio: 1.2 },
      quality: { degraded: false },
      signals: [],
      bars: ['ignored'],
      secret: 'ignored',
    },
    meta: {
      source: 'Yahoo',
      currency: 'USD',
      timezone: 'America/New_York',
      asOf: '2026-07-13T16:00:00-04:00',
      fetchedAt: '2026-07-13T20:00:05.000Z',
      stale: true,
      staleSince: '2026-07-13T20:00:00.000Z',
      adjustmentBasis: 'adjusted_close_ratio',
      adjustmentCoverage: 0,
      coverage,
      requestedAt: 'ignored',
    },
    extra: 'ignored',
  });

  assert.deepEqual(Object.keys(compact.data), [
    'code', 'market', 'currency', 'analysisAsOf', 'lastTradeDate',
    'comparisonAsOf', 'latestBarComplete', 'historySessions', 'alignedSessions',
    'latestClose', 'benchmark', 'returns', 'range52', 'risk', 'volume20',
    'quality', 'signals',
  ]);
  assert.deepEqual(Object.keys(compact.meta), [
    'source', 'currency', 'timezone', 'asOf', 'fetchedAt', 'stale',
    'staleSince', 'adjustmentBasis', 'adjustmentCoverage', 'coverage',
  ]);
  assert.equal(compact.data.returns, returns);
  assert.equal(compact.meta.coverage, coverage);
  assert.equal(compact.meta.adjustmentCoverage, 0);
  assert.equal('bars' in compact.data, false);
  assert.equal('requestedAt' in compact.meta, false);

  const empty = compactResearchCardForEvidence(null);
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), { data: {}, meta: {} });
});
