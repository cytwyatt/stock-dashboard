'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeStockFactors } = require('../src/domain/stock-factors');
const { computeResearchCard, normalizeDailySeries } = require('../src/domain/research-card');
const { hasStockResearchIntent, compactResearchCardForEvidence } = require('../src/ai/research-intent');
const { createToolRunner, serializeToolResult } = require('../src/ai/tools');

function fixture(count = 320) {
  let asset = 100, index = 200;
  const stock = [], benchmark = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    const r = (i % 7 - 3) / 1000 + .0005;
    if (i) { index *= 1 + r; asset *= 1 + 1.5 * r + .0003; }
    stock.push({ date, close: asset, high: asset, low: asset, volume: 100 });
    benchmark.push({ date, close: index });
  }
  return { stock, benchmark };
}
const get = (result, id) => result.factors.find((factor) => factor.id === id);
const near = (a, b) => assert.ok(Math.abs(a - b) < .00011, `${a} != ${b}`);

test('个股因子按完整窗口计算动量、相对收益、波动与已知Beta，不依赖报价或LLM', () => {
  const { stock, benchmark } = fixture();
  const analysis = computeStockFactors(stock, benchmark);
  assert.equal(analysis.availableCount, 6);
  near(get(analysis, 'beta').value, 1.5);
  near(get(analysis, 'momentum').value, (stock.at(-22).close / stock.at(-127).close - 1) * 100);
  near(get(analysis, 'relativeStrength').value,
    (stock.at(-1).close / stock.at(-61).close - benchmark.at(-1).close / benchmark.at(-61).close) * 100);
  const rs = stock.slice(-60).map((row, i) => row.close / stock[stock.length - 61 + i].close - 1);
  const mean = rs.reduce((a, b) => a + b, 0) / 60;
  near(get(analysis, 'volatility').value, Math.sqrt(rs.reduce((sum, r) => sum + (r - mean) ** 2, 0) / 59 * 252) * 100);
  assert.equal(get(analysis, 'volume').value, 1);
  assert.equal(get(analysis, 'volume').percentile, 50, '并列中位秩');
  assert.ok(get(analysis, 'drawdown').value >= 0, '回撤以幅度表示');
  assert.equal(get(analysis, 'beta').reference.count, 120);
  assert.equal(get(analysis, 'beta').history.length, 60);
});

test('自身分位严格排除当期，至少60个有效历史观察；未达门槛保留原值', () => {
  const { stock, benchmark } = fixture(81);
  stock.at(-1).volume = 200;
  const full = get(computeStockFactors(stock, benchmark), 'volume');
  assert.equal(full.percentile, 100);
  assert.equal(full.reference.count, 60);
  assert.equal(full.reference.endDate, stock.at(-2).date);
  const short = get(computeStockFactors(stock.slice(1), benchmark), 'volume');
  assert.equal(short.value, 2);
  assert.equal(short.percentile, null);
  assert.equal(short.reference.count, 59);
  assert.equal(short.percentileReason, 'insufficient_reference');
});

test('盘中最后一根与未来基准不能影响完整日因子，停牌不伪造最新成交', () => {
  const { stock, benchmark } = fixture();
  const expected = computeStockFactors(stock.slice(0, -1), benchmark.slice(0, -1));
  stock.at(-1).close *= 100;
  stock.at(-1).volume *= 100;
  benchmark.at(-1).close *= 50;
  const during = computeStockFactors(stock, benchmark, { latestBarComplete: false });
  assert.deepEqual(during.factors, expected.factors);
  assert.equal(during.asOf, stock.at(-2).date);
  const suspended = computeStockFactors(stock.slice(0, -3), benchmark);
  assert.equal(suspended.asOf, stock.at(-4).date);
  assert.ok(suspended.warnings.some((warning) => warning.includes('没有前填')));
});

test('基准缺失、滞后、零方差与共同日缺失只降级比较因子', () => {
  const { stock, benchmark } = fixture();
  for (const [rows, reason] of [
    [[], 'benchmark_unavailable'],
    [benchmark.slice(0, -1), 'benchmark_date_mismatch'],
    [benchmark.slice(-30), 'benchmark_insufficient_history'],
    [benchmark.map((row) => ({ ...row, close: 100 })), 'zero_benchmark_variance'],
  ]) {
    const result = computeStockFactors(stock, rows);
    assert.equal(get(result, 'beta').value, null);
    assert.equal(get(result, 'beta').reason, reason);
    assert.notEqual(get(result, 'momentum').value, null);
    assert.notEqual(get(result, 'volatility').value, null);
  }
  const missing = stock.filter((_, i) => i !== stock.length - 10);
  const result = computeStockFactors(missing, benchmark);
  assert.equal(get(result, 'beta').reason, 'missing_joint_sessions');
  assert.equal(get(result, 'relativeStrength').reason, 'missing_joint_sessions');
});

test('空值成交量不能变成0；短历史不补零；真实0量与0波动保留', () => {
  const { stock, benchmark } = fixture();
  const invalid = stock.map((row, i) => ({ ...row, volume: i === stock.length - 1 ? null : row.volume }));
  const card = computeResearchCard(invalid, benchmark);
  assert.equal(get(card.factorAnalysis, 'volume').reason, 'missing_volume');
  assert.equal(normalizeDailySeries(invalid).at(-1).volume, null);
  stock.at(-1).volume = 0;
  const zero = computeStockFactors(stock.map((row) => ({ ...row, close: 100 })), benchmark);
  assert.equal(get(zero, 'volume').value, 0);
  assert.equal(get(zero, 'volatility').value, 0);
  assert.equal(get(zero, 'drawdown').value, 0);
  assert.equal(computeStockFactors(stock.slice(0, 20), []).availableCount, 0);
  assert.equal(computeStockFactors([], []).asOf, null);
});

test('追加未来数据不改写已有历史因子，复权尺度不改变收益型因子', () => {
  const { stock, benchmark } = fixture();
  const old = computeStockFactors(stock.slice(0, -1), benchmark.slice(0, -1));
  const next = computeStockFactors(stock, benchmark);
  for (const factor of next.factors) {
    assert.equal(factor.history.at(-2).value, get(old, factor.id).value);
  }
  const scaled = computeStockFactors(stock.map((row) => ({ ...row, close: row.close * .1 })), benchmark);
  assert.deepEqual(scaled.factors.map((factor) => factor.value), next.factors.map((factor) => factor.value));
});

test('缓存/复权质量和未覆盖维度显式保留，LLM只接收紧凑因子事实', async () => {
  const { stock, benchmark } = fixture();
  const data = computeResearchCard(stock, benchmark, {
    stockStale: true, benchmarkStale: true, adjustmentBasis: 'raw_fallback', benchmarkName: 'synthetic指数',
  });
  assert.equal(data.factorAnalysis.warnings.length, 3);
  assert.ok(data.factorAnalysis.uncovered.includes('价值'));
  const compact = compactResearchCardForEvidence({ data });
  assert.equal(compact.data.factorAnalysis.comparisonBasis, 'own_prior_observations');
  assert.equal(compact.data.factorAnalysis.factors.length, 6);
  assert.equal('history' in compact.data.factorAnalysis.factors[0], false);
  const runner = createToolRunner({ marketService: { research: async () => ({ data }) },
    marketMeta: () => ({ stale: true }), sanitizeCode: (s) => s, marketForCode: () => 'cn' });
  const tool = await runner.run('get_research_card', { code: 'sh600519' });
  assert.equal('history' in tool.data.factorAnalysis.factors[0], false);
  assert.equal(JSON.parse(serializeToolResult(tool)).truncated, undefined);
  assert.ok(data.factorAnalysis.factors[0].history.length, '紧凑工具结果不得改动HTTP响应对象');
});

test('因子意图自动预注入，财务专问和其他标的继续排除', () => {
  const context = { code: 'AAPL', name: 'Apple', market: 'us' };
  for (const question of ['多因子分析', '这只股票的因子画像', '它的动量如何', '市场Beta是多少', '贝塔值', '因子分析']) {
    assert.equal(hasStockResearchIntent(question, context), true, question);
  }
  for (const question of ['TSLA的多因子分析', '价值因子分析', '盈利质量因子如何', '今天大盘因子如何']) {
    assert.equal(hasStockResearchIntent(question, context), false, question);
  }
});
