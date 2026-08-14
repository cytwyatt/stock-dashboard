'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { LLM_TOOLS, createToolRunner } = require('../src/ai/tools');

function createHarness({ quoteError = null } = {}) {
  const calls = [];
  const result = {
    asOf: '2026-08-14T14:00:00.000Z',
    stock: { code: 'AAPL', name: 'Apple Inc.', market: 'us' },
    coverage: { supported: true, source: 'Yahoo Finance' },
    events: [],
  };
  const stockEventsService = {
    normalizeCode(raw) {
      calls.push(['normalizeCode', raw]);
      const value = String(raw || '').trim();
      if (!value) return '';
      if (/^(?:sh|sz|bj|hk)/i.test(value)) return value.toLowerCase();
      return value.toUpperCase();
    },
    supports(code) {
      calls.push(['supports', code]);
      return /^(?:sh|sz|bj)\d{6}$/.test(code) || code === 'AAPL';
    },
    async getStockEvents(code, options) {
      calls.push(['getStockEvents', code, options]);
      return result;
    },
  };
  const marketService = {
    async quote(code) {
      calls.push(['quote', code]);
      if (quoteError) throw quoteError;
      return { data: { code, name: 'Apple Inc.' } };
    },
  };
  const runner = createToolRunner({
    marketService,
    stockEventsService,
    marketMeta: () => ({}),
    marketForCode: () => 'us',
    sanitizeCode: (code) => code,
  });
  return { runner, calls, result };
}

test('get_stock_events tool advertises A-share and US-stock coverage', () => {
  const tool = LLM_TOOLS.find((item) => item.function.name === 'get_stock_events');

  assert.ok(tool);
  assert.match(tool.function.description, /A股或美股/);
  assert.match(tool.function.parameters.properties.code.description, /AAPL/);
});

test('get_stock_events normalizes AAPL, resolves its quote name, and forwards options', async () => {
  const harness = createHarness();

  const result = await harness.runner.run('get_stock_events', {
    code: ' aapl ',
    lookbackHours: 48,
  });

  assert.equal(result, harness.result);
  assert.deepEqual(harness.calls, [
    ['normalizeCode', ' aapl '],
    ['supports', 'AAPL'],
    ['quote', 'AAPL'],
    ['getStockEvents', 'AAPL', {
      name: 'Apple Inc.',
      lookbackHours: 48,
      limit: 8,
    }],
  ]);
});

test('get_stock_events rejects empty and unsupported HK codes before quote/news I/O', async (t) => {
  await t.test('empty', async () => {
    const harness = createHarness();

    await assert.rejects(
      harness.runner.run('get_stock_events', { code: '  ' }),
      /需要有效的A股或美股代码/,
    );
    assert.deepEqual(harness.calls, [['normalizeCode', '  ']]);
  });

  await t.test('HK', async () => {
    const harness = createHarness();

    await assert.rejects(
      harness.runner.run('get_stock_events', { code: 'HK00700' }),
      /目前仅支持A股和美股个股/,
    );
    assert.deepEqual(harness.calls, [
      ['normalizeCode', 'HK00700'],
      ['supports', 'hk00700'],
    ]);
  });
});

test('get_stock_events continues without a name when quote lookup fails', async () => {
  const harness = createHarness({ quoteError: new Error('quote down') });

  const result = await harness.runner.run('get_stock_events', { code: 'aapl' });

  assert.equal(result, harness.result);
  assert.deepEqual(harness.calls, [
    ['normalizeCode', 'aapl'],
    ['supports', 'AAPL'],
    ['quote', 'AAPL'],
    ['getStockEvents', 'AAPL', {
      name: '',
      lookbackHours: undefined,
      limit: 8,
    }],
  ]);
});
