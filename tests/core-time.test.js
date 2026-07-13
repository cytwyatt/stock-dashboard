'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  fmtCNTime,
  fmtHKTime,
  isoTencentTime,
  isoMinuteTime,
  fmtTimeInTZ,
  dateInTimezone,
  isMarketOpen,
  isMarketOpenSrv,
} = require('../src/core/time');

test('腾讯时间显示与 ISO 格式保持现有 A/H 股口径', () => {
  assert.equal(fmtCNTime('20260707161445'), '07-07 16:14');
  assert.equal(fmtCNTime('short'), 'short');
  assert.equal(fmtCNTime(null), null);

  assert.equal(fmtHKTime('2026/07/09 16:08:11'), '07-09 16:08');
  assert.equal(fmtHKTime('invalid'), 'invalid');
  assert.equal(fmtHKTime(null), null);

  assert.equal(isoTencentTime('20260707161445', 'cn'), '2026-07-07T16:14:45+08:00');
  assert.equal(isoTencentTime('202607071614', 'cn'), '2026-07-07T16:14:00+08:00');
  assert.equal(isoTencentTime('2026/07/09 16:08:11', 'hk'), '2026-07-09T16:08:11+08:00');
  assert.equal(isoTencentTime('2026/07/09 16:08', 'hk'), '2026-07-09T16:08:00+08:00');
  assert.equal(isoTencentTime('invalid', 'cn'), '');
  assert.equal(isoTencentTime('invalid', 'hk'), '');

  assert.equal(isoMinuteTime('20260713', '09:30'), '2026-07-13T09:30:00+08:00');
  assert.equal(isoMinuteTime('2026-07-13', '09:30'), '');
  assert.equal(isoMinuteTime('20260713', '930'), '');
});

test('时区格式化辅助函数使用目标市场本地时间', () => {
  const date = new Date('2026-07-13T16:30:00Z');
  assert.equal(dateInTimezone('Asia/Shanghai', date), '2026-07-14');
  assert.equal(dateInTimezone('America/New_York', date), '2026-07-13');
  assert.equal(
    fmtTimeInTZ(Date.parse('2026-07-13T13:30:00Z') / 1000, 'America/New_York'),
    '09:30'
  );
});

test('开市判断保持各市场周末与起止分钟边界', () => {
  assert.equal(isMarketOpenSrv, isMarketOpen);
  const cases = [
    ['cn', '2026-07-13T01:14:00Z', false],
    ['cn', '2026-07-13T01:15:00Z', true],
    ['cn', '2026-07-13T04:00:00Z', true],
    ['cn', '2026-07-13T07:05:00Z', true],
    ['cn', '2026-07-13T07:06:00Z', false],
    ['hk', '2026-07-13T01:14:00Z', false],
    ['hk', '2026-07-13T01:15:00Z', true],
    ['hk', '2026-07-13T04:00:00Z', true],
    ['hk', '2026-07-13T08:15:00Z', true],
    ['hk', '2026-07-13T08:16:00Z', false],
    ['us', '2026-07-13T13:24:00Z', false],
    ['us', '2026-07-13T13:25:00Z', true],
    ['us', '2026-07-13T20:05:00Z', true],
    ['us', '2026-07-13T20:06:00Z', false],
    ['cn', '2026-07-12T03:00:00Z', false],
    ['hk', '2026-07-12T03:00:00Z', false],
    ['us', '2026-07-12T15:00:00Z', false],
  ];
  for (const [market, iso, expected] of cases) {
    assert.equal(isMarketOpen(market, new Date(iso)), expected, `${market} ${iso}`);
  }

  assert.equal(isMarketOpen('unknown', new Date('2026-07-13T01:15:00Z')), true);
});
