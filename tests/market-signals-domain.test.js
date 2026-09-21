'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SIGNAL_RULES,
  alignedRelativeReturn,
  buildDirectionalSignals,
  trendFacts,
  yieldChangeBp,
} = require('../src/domain/market-signals');

function history(length, { start = 100, step = 1 } = {}) {
  return Array.from({ length }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    open: start + index * step - 0.5,
    close: start + index * step,
    high: start + index * step + 0.5,
    low: start + index * step - 1,
    volume: index === length - 1 ? 200 : 100,
  }));
}

test('趋势窗口严格校验 MA、斜率与排除当日的此前20日突破', () => {
  const rows = history(55);
  rows.at(-1).close = 1000;
  rows.at(-1).high = 5000;
  const result = trendFacts(rows, { code: '^GSPC', name: '标普500', source: 'synthetic' });
  assert.equal(result.available, true);
  assert.equal(result.side, 'bullish');
  assert.equal(result.flags.breakoutPrior20, true);
  const priorHigh = result.metrics.find((item) => item.id.endsWith(':prior20-high'));
  assert.equal(priorHigh.value, rows.at(-2).high);
  assert.equal(priorHigh.sampleCount, 20);

  const short = trendFacts(history(49), { code: '^GSPC' });
  assert.equal(short.available, false);
  assert.equal(short.side, null);
  assert.match(short.reason, /50/);
});

test('相对收益只按共同交易日对齐，收益率水平变化正确换算为基点', () => {
  const asset = [
    ['2026-01-02', 100], ['2026-01-05', 101], ['2026-01-06', 102],
    ['2026-01-07', 103], ['2026-01-08', 104], ['2026-01-09', 110],
  ].map(([date, close]) => ({ date, close }));
  const benchmark = [
    ['2026-01-01', 90], ['2026-01-02', 100], ['2026-01-05', 100],
    ['2026-01-06', 100], ['2026-01-07', 100], ['2026-01-08', 100],
    ['2026-01-09', 100],
  ].map(([date, close]) => ({ date, close }));
  const result = alignedRelativeReturn(asset, benchmark, 5);
  assert.equal(result.startDate, '2026-01-02');
  assert.equal(result.endDate, '2026-01-09');
  assert.equal(result.valuePct, 10);
  assert.equal(yieldChangeBp(4.25, 4.30), 5);
  assert.equal(yieldChangeBp(null, 4.3), null);
});

test('A股宽度与成交额只在完整口径下形成方向信号', () => {
  const rows = history(55);
  const components = [
    {
      name: 'overview',
      data: {
        up: 3600, nonUp: 2400, total: 6000, upRatioPct: 60,
        breadthBasis: 'synthetic',
        turnoverComparison: {
          available: true, changePct: 6, mode: 'previous_trading_day_close',
          basis: 'sh_sz_market_total', currentDate: rows.at(-1).date,
        },
      },
      meta: { source: 'synthetic' },
    },
    {
      name: 'sectors', data: { stats: { totalCount: 10, upRatioPct: 70 } },
      meta: { source: 'synthetic' },
    },
  ];
  const result = buildDirectionalSignals({
    market: 'cn', reviewDate: rows.at(-1).date,
    indexHistories: [{ code: 'sh000001', name: '上证指数', rows, source: 'synthetic' }],
    components,
    alignedEvidenceRefs: ['overview', 'sectors', 'indexHistory'],
  });
  assert.equal(result.computedSignals.find((item) => item.id === 'breadth:cn:market').side, 'bullish');
  assert.equal(result.computedSignals.find((item) => item.id === 'liquidity:cn:price-volume').side, 'bullish');

  components[0].data.turnoverComparison.mode = 'previous_trading_day_same_time';
  const degraded = buildDirectionalSignals({
    market: 'cn', reviewDate: rows.at(-1).date,
    indexHistories: [{ code: 'sh000001', rows, source: 'synthetic' }],
    components,
    alignedEvidenceRefs: ['overview', 'sectors', 'indexHistory'],
  });
  const turnover = degraded.computedSignals.find((item) => item.id === 'liquidity:cn:price-volume');
  assert.equal(turnover.state, 'unavailable');
  assert.equal(turnover.side, null);
});

test('美股行业 ETF 分母不完整时不可用，完整分母才应用初始阈值', () => {
  const rows = history(55);
  const make = (total, up) => buildDirectionalSignals({
    market: 'us', reviewDate: rows.at(-1).date,
    indexHistories: [{ code: '^GSPC', rows, source: 'synthetic' }],
    relativeHistories: { SPY: rows, QQQ: rows, SOXX: rows, RSP: rows },
    components: [{
      name: 'usSectorProxies', data: { stats: { total, up } }, meta: { source: 'synthetic' },
    }],
    alignedEvidenceRefs: ['indexHistory', 'usSectorProxies'],
  }).computedSignals.find((item) => item.id === 'breadth:us-sector-etf');
  assert.equal(make(10, 8).state, 'unavailable');
  assert.equal(make(10, 8).side, null);
  assert.equal(make(11, SIGNAL_RULES.usSectorBreadth.bullishMinUp).side, 'bullish');
  assert.equal(make(11, SIGNAL_RULES.usSectorBreadth.bearishMaxUp).side, 'bearish');
});
