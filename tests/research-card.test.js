'use strict';

process.env.MARKET_DISABLE_WARM = '1';
process.env.MARKET_DISABLE_REVIEW = '1';
process.env.MARKET_DATA_DIR = process.env.MARKET_DATA_DIR || '/tmp/market-research-test-data';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeDailySeries,
  alignToBenchmarkCalendar,
  computeResearchReturns,
  computeAnnualizedVolatility,
  computeMaxDrawdown,
  compute52WeekRange,
  computeRelativeVolume,
  computeResearchCard,
} = require('../src/domain/research-card');

const bar = (date, close, extra = {}) => ({
  date, open: close, high: close, low: close, close, volume: 100, ...extra,
});

function dates(count, start = Date.UTC(2025, 0, 1)) {
  return Array.from({ length: count }, (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10));
}

test('日线规范化会排序、去重并剔除无效价格', () => {
  const rows = normalizeDailySeries([
    bar('2026-01-03', 103),
    bar('2026-01-01', 100),
    bar('2026-01-02', 101),
    bar('2026-01-02', 102),
    bar('bad-date', 99),
    bar('2026-01-04', 0),
  ]);
  assert.deepEqual(rows.map((row) => [row.date, row.close]), [
    ['2026-01-01', 100],
    ['2026-01-02', 102],
    ['2026-01-03', 103],
  ]);
});

test('收益按基准交易日历对齐，停牌日只向前填充且不使用未来价格', () => {
  const stock = normalizeDailySeries([
    bar('2026-01-01', 100),
    bar('2026-01-03', 110),
    bar('2026-01-06', 121),
  ]);
  const benchmark = normalizeDailySeries([
    bar('2026-01-01', 200),
    bar('2026-01-02', 999),
    bar('2026-01-03', 210),
    bar('2026-01-04', 215),
    bar('2026-01-05', 218),
    bar('2026-01-06', 220),
  ]);
  const aligned = alignToBenchmarkCalendar(stock, benchmark);
  assert.deepEqual(aligned.map((row) => [row.date, row.stockDate, row.stockClose]), [
    ['2026-01-01', '2026-01-01', 100],
    ['2026-01-02', '2026-01-01', 100],
    ['2026-01-03', '2026-01-03', 110],
    ['2026-01-04', '2026-01-03', 110],
    ['2026-01-05', '2026-01-03', 110],
    ['2026-01-06', '2026-01-06', 121],
  ]);
  const returns = computeResearchReturns(aligned, stock, true);
  assert.deepEqual(
    { assetPct: returns['5d'].assetPct, benchmarkPct: returns['5d'].benchmarkPct, excessPct: returns['5d'].excessPct },
    { assetPct: 21, benchmarkPct: 10, excessPct: 11 }
  );

  const tailSuspension = alignToBenchmarkCalendar(
    normalizeDailySeries([bar('2026-01-01', 100), bar('2026-01-03', 110)]),
    benchmark
  );
  assert.deepEqual(tailSuspension.slice(-3).map((row) => [row.date, row.stockDate, row.stockClose]), [
    ['2026-01-04', '2026-01-03', 110],
    ['2026-01-05', '2026-01-03', 110],
    ['2026-01-06', '2026-01-03', 110],
  ]);
});

test('1/5/20/60/120日收益使用N+1个收盘点，历史不足返回null而非0', () => {
  const ds = dates(121);
  let price = 100;
  const stock = ds.map((date, i) => {
    if (i) price *= 1.01;
    return bar(date, price);
  });
  const benchmark = ds.map((date) => bar(date, 100));
  const card = computeResearchCard(stock, benchmark, {
    code: 'TEST', market: 'us', currency: 'USD', benchmarkCode: '^GSPC', benchmarkName: '标普500',
    adjustmentBasis: 'split_dividend_adjusted', benchmarkAdjustmentBasis: 'split_dividend_adjusted',
  });
  assert.deepEqual(
    Object.fromEntries(Object.entries(card.returns).map(([key, value]) => [key, value.assetPct])),
    { '1d': 1, '5d': 5.1, '20d': 22.02, '60d': 81.67, '120d': 230.04 }
  );
  assert.equal(card.returns['120d'].excessPct, 230.04);

  const short = computeResearchCard(stock.slice(-20), benchmark.slice(-20), {
    adjustmentBasis: 'split_dividend_adjusted',
  });
  assert.equal(short.returns['20d'].assetPct, null);
  assert.equal(short.returns['20d'].reason, 'insufficient_history');
});

test('20日年化波动率使用简单收益样本标准差并要求21个收盘点', () => {
  const ds = dates(21);
  let price = 100;
  const rows = ds.map((date, i) => {
    if (i) price *= i % 2 ? 1.01 : 0.99;
    return bar(date, price);
  });
  const metric = computeAnnualizedVolatility([], normalizeDailySeries(rows));
  assert.ok(Math.abs(metric.value - 16.29) < 0.01);
  const insufficient = computeAnnualizedVolatility([], normalizeDailySeries(rows.slice(1)));
  assert.equal(insufficient.value, null);
  assert.equal(insufficient.required, 21);
});

test('基准历史短缺不抹掉个股自身收益、波动率和回撤', () => {
  const ds = dates(121);
  const stock = ds.map((date, i) => bar(date, 100 + i));
  const benchmark = ds.slice(-2).map((date, i) => bar(date, 200 + i));
  const card = computeResearchCard(stock, benchmark, {
    adjustmentBasis: 'split_dividend_adjusted',
    benchmarkAdjustmentBasis: 'split_dividend_adjusted',
  });
  assert.notEqual(card.returns['120d'].assetPct, null);
  assert.equal(card.returns['120d'].benchmarkPct, null);
  assert.equal(card.returns['120d'].excessPct, null);
  assert.equal(card.returns['120d'].comparisonReason, 'benchmark_insufficient_history');
  assert.notEqual(card.risk.volatility20.value, null);
  assert.notEqual(card.risk.maxDrawdown120.value, null);
  assert.ok(card.signals.some((signal) => signal.code === 'BENCHMARK_HISTORY_LIMITED'));
});

test('基准失败或使用旧缓存时，个股指标保留且质量状态明确', () => {
  const ds = dates(121);
  const stock = ds.map((date, i) => bar(date, 100 + i));
  const benchmark = ds.map((date, i) => bar(date, 200 + i));
  const unavailable = computeResearchCard(stock, [], { adjustmentBasis: 'provider_qfq' });
  assert.notEqual(unavailable.returns['120d'].assetPct, null);
  assert.equal(unavailable.returns['120d'].excessPct, null);
  assert.notEqual(unavailable.risk.maxDrawdown120.value, null);
  assert.ok(unavailable.signals.some((signal) => signal.code === 'BENCHMARK_UNAVAILABLE'));

  const stale = computeResearchCard(stock, benchmark, {
    adjustmentBasis: 'provider_qfq', benchmarkAdjustmentBasis: 'raw_fallback', benchmarkStale: true,
  });
  assert.equal(stale.quality.comparison.stale, true);
  assert.equal(stale.quality.comparison.degraded, true);
  assert.equal(stale.quality.comparison.adjustmentRequired, false);
  assert.ok(stale.signals.some((signal) => signal.code === 'BENCHMARK_STALE'));
});

test('最大回撤返回负值及对应峰谷日期', () => {
  const ds = dates(6);
  const rows = [100, 120, 90, 95, 80, 110].map((close, i) => bar(ds[i], close));
  const metric = computeMaxDrawdown([], normalizeDailySeries(rows), 5);
  assert.equal(metric.value, -33.33);
  assert.equal(metric.peakDate, ds[1]);
  assert.equal(metric.troughDate, ds[4]);
  assert.equal(metric.currentPct, -8.33);
});

test('52周高低位按365自然日裁剪，历史不足不冒充完整52周', () => {
  const full = normalizeDailySeries([
    bar('2024-12-01', 100, { high: 200, low: 70 }),
    bar('2025-01-02', 90, { high: 125, low: 80 }),
    bar('2026-01-01', 100, { high: 105, low: 95 }),
  ]);
  const metric = compute52WeekRange(full);
  assert.equal(metric.high, 125);
  assert.equal(metric.low, 80);
  assert.equal(metric.distanceToHighPct, -20);
  assert.equal(metric.distanceAboveLowPct, 25);

  const short = compute52WeekRange(normalizeDailySeries([
    bar('2025-12-01', 90), bar('2026-01-01', 100),
  ]));
  assert.equal(short.value, null);
  assert.equal(short.reason, 'insufficient_history');
});

test('20日相对成交量排除当日自身，盘中时自动退到最近完整交易日', () => {
  const ds = dates(22);
  const rows = ds.map((date, i) => bar(date, 100, { volume: i === 20 ? 250 : i === 21 ? 10 : 100 }));
  const complete = computeRelativeVolume(normalizeDailySeries(rows.slice(0, 21)));
  assert.equal(complete.value, 2.5);
  assert.equal(complete.average20, 100);

  const duringSession = computeRelativeVolume(normalizeDailySeries(rows), { latestBarComplete: false });
  assert.equal(duringSession.value, 2.5);
  assert.equal(duringSession.asOf, ds[20]);
  assert.equal(duringSession.excludedPartialSession, true);
});

test('盘中未完成日不进入波动率和最大回撤', () => {
  const ds = dates(122);
  const stock = ds.map((date, i) => bar(date, i === 121 ? 20 : 100 + i * 0.1));
  const benchmark = ds.map((date, i) => bar(date, 200 + i * 0.1));
  const card = computeResearchCard(stock, benchmark, {
    adjustmentBasis: 'split_dividend_adjusted',
    benchmarkAdjustmentBasis: 'split_dividend_adjusted',
    latestBarComplete: false,
  });
  assert.equal(card.returns['1d'].endDate, ds[121]);
  assert.equal(card.risk.volatility20.asOf, ds[120]);
  assert.equal(card.risk.maxDrawdown120.asOf, ds[120]);
  assert.equal(card.risk.maxDrawdown120.value, 0);
});

test('尾部停牌延用最后收盘并显式区分分析日和最近交易日', () => {
  const stockDates = dates(121);
  const benchmarkDates = dates(124);
  const stock = stockDates.map((date, i) => bar(date, 100 + i));
  const benchmark = benchmarkDates.map((date, i) => bar(date, 200 + i));
  const card = computeResearchCard(stock, benchmark, {
    adjustmentBasis: 'provider_qfq', benchmarkAdjustmentBasis: 'raw_fallback',
  });
  assert.equal(card.lastTradeDate, stockDates[120]);
  assert.equal(card.analysisAsOf, benchmarkDates[123]);
  assert.equal(card.comparisonAsOf, benchmarkDates[123]);
  assert.ok(card.signals.some((signal) => signal.code === 'NO_RECENT_TRADE'));
});

test('52周高低相同时不同时触发接近高位和低位', () => {
  const stock = [bar('2024-12-01', 100), bar('2026-01-01', 100)];
  const card = computeResearchCard(stock, [], { adjustmentBasis: 'provider_qfq' });
  assert.equal(card.range52.positionPct, null);
  assert.equal(card.range52.reason, 'flat_range');
  assert.ok(card.signals.some((signal) => signal.code === 'FLAT_52W_RANGE'));
  assert.ok(!card.signals.some((signal) => signal.code === 'NEAR_52W_HIGH'));
  assert.ok(!card.signals.some((signal) => signal.code === 'NEAR_52W_LOW'));
});

test('原始价回退会保留指标但明确标记质量降级', () => {
  const ds = dates(121);
  const stock = ds.map((date, i) => bar(date, 100 + i));
  const benchmark = ds.map((date, i) => bar(date, 200 + i));
  const card = computeResearchCard(stock, benchmark, {
    adjustmentBasis: 'raw_fallback', benchmarkCode: '^GSPC', benchmarkName: '标普500',
  });
  assert.equal(card.quality.degraded, true);
  assert.equal(card.signals[0].code, 'DEGRADED_ADJUSTMENT');
  assert.notEqual(card.returns['20d'].assetPct, null);
});
