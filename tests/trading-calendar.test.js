'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTradingCalendar } = require('../src/core/trading-calendar');

test('美股交易日历覆盖周末、节假日、DST 与提前收盘', () => {
  const calendar = createTradingCalendar();
  assert.equal(calendar.session('us', '2026-07-03').isTradingDay, false);
  assert.equal(calendar.nextSession('us', '2026-07-02'), '2026-07-06');
  assert.equal(calendar.session('us', '2026-01-14').cutoffAt, '2026-01-14T21:00:00.000Z');
  assert.equal(calendar.session('us', '2026-07-14').cutoffAt, '2026-07-14T20:00:00.000Z');
  assert.deepEqual(
    {
      earlyClose: calendar.session('us', '2026-11-27').earlyClose,
      cutoffAt: calendar.session('us', '2026-11-27').cutoffAt,
    },
    { earlyClose: true, cutoffAt: '2026-11-27T18:00:00.000Z' },
  );
});

test('A股官方休市区间与未知日历范围不会猜测下个交易日', () => {
  const calendar = createTradingCalendar();
  assert.equal(calendar.session('cn', '2026-09-25').isTradingDay, false);
  assert.equal(calendar.nextSession('cn', '2026-09-24'), '2026-09-28');
  assert.equal(calendar.session('cn', '2026-10-01').isTradingDay, false);
  assert.equal(calendar.session('cn', '2028-01-04').calendarStatus, 'unknown');
  assert.equal(calendar.nextSession('cn', '2028-01-04'), null);
});
