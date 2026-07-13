'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  sanitizeCode,
  isCNCode,
  isHKCode,
  isKnownHKCode,
  isTXCode,
  marketForCode,
} = require('../src/core/symbols');

test('sanitizeCode 仅保留当前支持的代码字符并限制为 20 位', () => {
  assert.equal(sanitizeCode(null), '');
  assert.equal(sanitizeCode(' $BRK.B /测试 '), 'BRK.B');
  assert.equal(sanitizeCode('^DJI'), '^DJI');
  assert.equal(sanitizeCode('GC=F'), 'GC=F');
  assert.equal(sanitizeCode('BTC-USD'), 'BTC-USD');
  assert.equal(sanitizeCode('12345678901234567890EXTRA'), '12345678901234567890');
});

test('A股、港股和腾讯代码判断保持大小写与已知指数约束', () => {
  for (const code of ['sh600519', 'sz300750', 'bj920943']) assert.equal(isCNCode(code), true, code);
  for (const code of ['SH600519', 'sh60051', 'hk00700', 'AAPL']) assert.equal(isCNCode(code), false, code);

  for (const code of ['hk00700', 'hkHSI', 'hkHSCEI', 'hkHSTECH', 'hkABC']) {
    assert.equal(isHKCode(code), true, code);
  }
  for (const code of ['HK00700', 'hkhsi', 'hk700', 'hk12A45']) assert.equal(isHKCode(code), false, code);

  for (const code of ['hk00700', 'hkHSI', 'hkHSCEI', 'hkHSTECH']) {
    assert.equal(isKnownHKCode(code), true, code);
  }
  assert.equal(isKnownHKCode('hkABC'), false);
  assert.equal(isTXCode('sh600519'), true);
  assert.equal(isTXCode('hkABC'), true);
  assert.equal(isTXCode('AAPL'), false);
});

test('marketForCode 对非 A/H 代码统一路由到美股/Yahoo', () => {
  assert.equal(marketForCode('sh600519'), 'cn');
  assert.equal(marketForCode('hk00700'), 'hk');
  assert.equal(marketForCode('hkHSI'), 'hk');
  assert.equal(marketForCode('AAPL'), 'us');
  assert.equal(marketForCode('^DJI'), 'us');
  assert.equal(marketForCode('invalid'), 'us');
});
