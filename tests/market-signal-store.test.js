'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { createJsonFileStorage } = require('../src/storage/json-file');
const {
  MAX_SIGNAL_SNAPSHOTS_PER_MARKET,
  createMarketSignalStore,
} = require('../src/storage/market-signal-store');

function storeFor(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-signal-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const jsonFile = createJsonFileStorage({ dataDir, fs, crypto, logger: { error() {} } });
  return createMarketSignalStore({ dataDir, fs, jsonFile });
}

function snapshot(reviewDate, hash = 'a'.repeat(64), extra = {}) {
  return {
    id: `cn:${reviewDate}:rules-v1:${hash.slice(0, 12)}`,
    market: 'cn', reviewDate, rulesVersion: 'rules-v1', inputHash: hash,
    capturedAt: `${reviewDate}T08:00:00.000Z`, input: { synthetic: true },
    report: { status: 'ready' }, ...extra,
  };
}

test('信号快照按市场、交易日和规则版本不可变，并与30条日报留存独立', (t) => {
  const store = storeFor(t);
  const first = store.saveImmutable(snapshot('2026-07-14'));
  assert.deepEqual(store.saveImmutable(snapshot('2026-07-14')), first);
  assert.throws(
    () => store.saveImmutable(snapshot('2026-07-14', 'b'.repeat(64))),
    /immutable/,
  );
  assert.deepEqual(store.find('cn', '2026-07-14', 'rules-v1'), first);
  assert.equal(MAX_SIGNAL_SNAPSHOTS_PER_MARKET, 500);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
});

test('后验结果写入独立文件，不回写原信号且未到观察期不能填空值', (t) => {
  const store = storeFor(t);
  const saved = store.saveImmutable(snapshot('2026-07-14'));
  assert.throws(() => store.recordOutcome({
    snapshotId: saved.id, horizon: 'next', observedAt: '2026-07-15', value: null,
  }), /non-null/);
  store.recordOutcome({
    snapshotId: saved.id, horizon: 'next', observedAt: '2026-07-15', value: 0,
  });
  assert.equal(store.readOutcomes().outcomes[0].value, 0);
  assert.throws(() => store.recordOutcome({
    snapshotId: saved.id, horizon: 'next', observedAt: '2026-07-15', value: 1,
  }), /immutable/);
  assert.deepEqual(store.find('cn', '2026-07-14', 'rules-v1'), saved);
});

test('信号快照剔除凭据键与正文中的令牌串', (t) => {
  const store = storeFor(t);
  const saved = store.saveImmutable(snapshot('2026-07-14', 'a'.repeat(64), {
    apiKey: ['sk', 'secret-value'].join('-'),
    input: { note: `Bearer abcdef leaked ${['sk', 'hidden-value'].join('-')}` },
  }));
  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.input.note, 'Bearer [REDACTED] leaked [REDACTED]');
});
