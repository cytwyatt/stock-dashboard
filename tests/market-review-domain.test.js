'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { finite, summarizeIndexHistory } = require('../src/domain/market-review');

test('严格数值转换区分缺失、布尔值与真实零值', () => {
  assert.equal(finite(null), null);
  assert.equal(finite(undefined), null);
  assert.equal(finite('  '), null);
  assert.equal(finite(false), null);
  assert.equal(finite(true), null);
  assert.equal(finite(NaN), null);
  assert.equal(finite(Infinity), null);
  assert.equal(finite(0), 0);
  assert.equal(finite('0'), 0);
});

test('盘后指数历史计算多周期收益、20日位置与不含当日的量能基准', () => {
  const rows = Array.from({ length: 22 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    open: 99 + index,
    close: 100 + index,
    high: 101 + index,
    low: 98 + index,
    volume: index === 21 ? 300 : 100,
  }));
  const result = summarizeIndexHistory(rows);
  assert.equal(result.latestDate, '2026-06-22');
  assert.deepEqual(result.latestBar, {
    date: '2026-06-22',
    open: 120,
    high: 122,
    low: 119,
    close: 121,
    volume: 300,
    previousClose: 120,
    change: 1,
    changePct: 0.83,
  });
  assert.equal(result.returns.oneDayPct, 0.83);
  assert.equal(result.returns.fiveDayPct, 4.31);
  assert.equal(result.returns.twentyDayPct, 19.8);
  assert.equal(result.range20.high, 122);
  assert.equal(result.range20.low, 100);
  assert.equal(result.range20.positionPct, 95.45);
  assert.equal(result.volume.average20, 100);
  assert.equal(result.volume.ratioToAverage20, 3);
  assert.equal(result.volume.sampleCount, 20);
});

test('盘后指数历史不足或无效时返回 null 指标而不是补零', () => {
  const result = summarizeIndexHistory([
    { date: 'bad', close: 10 },
    { date: '2026-07-11', close: 0 },
    { date: '2026-07-14', close: 10, high: 10, low: 10, volume: null },
  ]);
  assert.equal(result.returns.oneDayPct, null);
  assert.equal(result.latestBar.previousClose, null);
  assert.equal(result.latestBar.change, null);
  assert.equal(result.latestBar.changePct, null);
  assert.equal(result.returns.fiveDayPct, null);
  assert.equal(result.range20.positionPct, null);
  assert.equal(result.volume.ratioToAverage20, null);
  assert.equal(summarizeIndexHistory([]), null);

  const shortVolumeHistory = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-07-${String(index + 1).padStart(2, '0')}`,
    close: 100 + index,
    high: 101 + index,
    low: 99 + index,
    volume: 1000 + index,
  }));
  assert.equal(summarizeIndexHistory(shortVolumeHistory).volume.average20, null);
  assert.equal(summarizeIndexHistory(shortVolumeHistory).volume.ratioToAverage20, null);
});

test('完整窗口遇到缺失值不会缩短分母，重复交易日不增加样本', () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({
    date: `2026-06-${String(index + 1).padStart(2, '0')}`,
    close: 100 + index,
    high: 101 + index,
    low: 99 + index,
    volume: index === 4 ? null : 100,
  }));
  rows.push({
    date: '2026-06-21', close: 130, high: 131, low: null, volume: 200,
  });
  const result = summarizeIndexHistory(rows);
  assert.equal(result.observations, 21);
  assert.equal(result.latestBar.close, 130);
  assert.equal(result.volume.sampleCount, 19);
  assert.equal(result.volume.average20, null);
  assert.equal(result.range20.low, null);
  assert.equal(result.range20.lowSampleCount, 19);
  assert.deepEqual(result.quality.duplicateDates, ['2026-06-21']);
  assert.deepEqual(result.quality.conflictingDuplicateDates, ['2026-06-21']);
  assert.equal(result.quality.duplicateResolution, 'last_row_wins');
});
