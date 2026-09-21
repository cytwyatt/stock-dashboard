'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { createTradingCalendar } = require('../src/core/trading-calendar');
const { createMarketSignalService } = require('../src/services/market-signal-service');

function endingHistory(endDate, length = 55) {
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Array.from({ length }, (_, index) => {
    const offset = length - 1 - index;
    return {
      date: new Date(end - offset * 86400000).toISOString().slice(0, 10),
      open: 100 + index, high: 102 + index, low: 99 + index,
      close: 101 + index, volume: index === length - 1 ? 200 : 100,
    };
  });
}

test('补充日线只通过 marketService 有限请求，重试与服务重建复用不可变快照', async () => {
  const reviewDate = '2026-07-14';
  const rows = endingHistory(reviewDate);
  const saved = new Map();
  const key = (market, date, version) => `${market}:${date}:${version}`;
  const store = {
    find(market, date, version) { return saved.get(key(market, date, version)) || null; },
    saveImmutable(snapshot) { saved.set(key(snapshot.market, snapshot.reviewDate, snapshot.rulesVersion), structuredClone(snapshot)); return snapshot; },
  };
  let klineCalls = 0;
  const marketService = {
    async kline(code) {
      klineCalls++;
      return { data: structuredClone(rows), stale: false, meta: { source: `synthetic:${code}` } };
    },
  };
  const options = {
    marketService,
    marketSignalStore: store,
    tradingCalendar: createTradingCalendar(),
    marketMeta: (entry) => ({ stale: entry.stale, source: entry.meta.source }),
    crypto,
    now: () => Date.parse('2026-07-14T20:20:00Z'),
  };
  const input = {
    market: 'us', reviewDate,
    components: [{
      name: 'usSectorProxies', data: { stats: { total: 11, up: 8 } },
      meta: { source: 'synthetic', asOf: '2026-07-14T19:59:00Z' },
    }],
    indexHistories: [{ code: '^GSPC', name: '标普500', rows, source: 'synthetic' }],
    associationEvidenceRefs: ['indexHistory', 'usSectorProxies'],
  };
  const first = await createMarketSignalService(options).buildSnapshot(input);
  const second = await createMarketSignalService(options).buildSnapshot(input);
  assert.equal(klineCalls, 4);
  assert.equal(first.inputHash, second.inputHash);
  assert.equal(first.inputSnapshotId, second.inputSnapshotId);
  assert.equal(first.nextSessionDate, '2026-07-15');
  assert.equal(first.methodology, 'heuristic_unvalidated');
  assert.equal(first.isPredictionProbability, false);
  assert.ok(first.computedSignals.some((signal) => signal.id === 'breadth:us-sector-etf'));
});
