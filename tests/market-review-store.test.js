'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createJsonFileStorage } = require('../src/storage/json-file');
const {
  createMarketReviewStore,
  MAX_REVIEWS_PER_MARKET,
} = require('../src/storage/market-review-store');

function createStore(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-review-store-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const jsonFile = createJsonFileStorage({
    dataDir,
    fs,
    crypto,
    pid: 4242,
    logger: { error() {} },
  });
  return createMarketReviewStore({ dataDir, fs, jsonFile });
}

function review(market, reviewDate, extra = {}) {
  return {
    market,
    reviewDate,
    generatedAt: `${reviewDate}T21:00:00.000Z`,
    headline: `${market} ${reviewDate}`,
    ...extra,
  };
}

test('缺失或损坏文件返回固定规范形状，并清理落盘的非法条目', (t) => {
  const store = createStore(t);
  const empty = {
    version: 1,
    reviews: { cn: [], hk: [], us: [] },
    attempts: {},
  };
  assert.deepEqual(store.readMarketReviews(), empty);

  fs.writeFileSync(store.file, '{bad json');
  assert.deepEqual(store.readMarketReviews(), empty);

  fs.writeFileSync(store.file, JSON.stringify({
    version: 99,
    reviews: {
      cn: [
        review('cn', '2026-07-14'),
        review('us', '2026-02-30'),
        null,
      ],
      hk: 'invalid',
      unknown: [review('us', '2026-07-15')],
    },
    attempts: {
      'cn:2026-07-14': { at: '2026-07-14T21:00:00Z', error: 'timeout' },
      'xx:2026-07-14': { at: 1, error: 'bad market' },
      'us:2026-13-01': { at: 1, error: 'bad date' },
    },
  }));
  assert.deepEqual(store.readMarketReviews(), {
    version: 1,
    reviews: {
      cn: [review('cn', '2026-07-14')],
      hk: [],
      us: [],
    },
    attempts: {
      'cn:2026-07-14': { at: '2026-07-14T21:00:00Z', error: 'timeout' },
    },
  });
});

test('upsert 跨市场保留、同日替换、倒序排列并限制每市场30条', (t) => {
  const store = createStore(t);
  const hk = store.upsert(review('hk', '2026-07-01'));
  assert.deepEqual(hk, review('hk', '2026-07-01'));

  for (let day = 1; day <= MAX_REVIEWS_PER_MARKET + 5; day++) {
    const date = new Date(Date.UTC(2026, 0, day)).toISOString().slice(0, 10);
    store.upsert(review('cn', date));
  }
  store.upsert(review('cn', '2026-02-04', { headline: 'replacement' }));

  const data = store.readMarketReviews();
  assert.equal(data.reviews.cn.length, MAX_REVIEWS_PER_MARKET);
  assert.equal(data.reviews.cn[0].reviewDate, '2026-02-04');
  assert.equal(data.reviews.cn[0].headline, 'replacement');
  assert.equal(data.reviews.cn.at(-1).reviewDate, '2026-01-06');
  assert.deepEqual(data.reviews.hk, [review('hk', '2026-07-01')]);
  assert.deepEqual(store.latest('CN'), data.reviews.cn[0]);
  assert.deepEqual(store.find('cn', '2026-01-20'), review('cn', '2026-01-20'));
  assert.equal(store.find('cn', '2026-01-01'), null);
  assert.equal(store.latest('invalid'), null);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);

  assert.throws(() => store.upsert(review('invalid', '2026-07-14')), /valid market/);
  assert.throws(() => store.upsert(review('cn', '2026-02-30')), /reviewDate/);
});

test('review 与 attempt 在任意嵌套层级剔除凭据，并保留非敏感模型信息', (t) => {
  const store = createStore(t);
  const saved = store.upsert(review('us', '2026-07-14', {
    model: 'deep-model',
    apiKey: ['sk', 'top-secret'].join('-'),
    detail: {
      authorization: 'Bearer abcdefgh',
      provider: { access_token: 'nested-token', baseUrl: 'https://llm.example/v1' },
      note: `request failed with ${['sk', 'leaked-value'].join('-')} in response`,
    },
  }));

  assert.equal(saved.apiKey, undefined);
  assert.equal(saved.detail.authorization, undefined);
  assert.equal(saved.detail.provider.access_token, undefined);
  assert.equal(saved.detail.provider.baseUrl, 'https://llm.example/v1');
  assert.equal(saved.detail.note, 'request failed with [REDACTED] in response');

  store.recordAttempt('us', '2026-07-14', {
    at: 1784062800000,
    error: `Bearer abcdefgh failed; fallback ${['sk', 'another-secret'].join('-')}`,
    apiKey: ['sk', 'attempt-secret'].join('-'),
  });
  assert.deepEqual(store.getAttempt('us', '2026-07-14'), {
    at: 1784062800000,
    error: 'Bearer [REDACTED] failed; fallback [REDACTED]',
  });

  const onDisk = fs.readFileSync(store.file, 'utf8');
  assert.doesNotMatch(onDisk, /sk\x2d|apiKey|authorization|nested-token|abcdefgh/);
  assert.match(onDisk, /deep-model/);
});

test('attempt 可覆盖、清除且不破坏任何市场的 review', (t) => {
  const store = createStore(t);
  store.upsert(review('cn', '2026-07-14'));
  store.upsert(review('us', '2026-07-13'));

  assert.deepEqual(store.recordAttempt('cn', '2026-07-14', {
    at: '2026-07-14T08:10:00.000Z',
    error: new Error('first failure'),
  }), {
    at: '2026-07-14T08:10:00.000Z',
    error: 'Error: first failure',
  });
  store.recordAttempt('cn', '2026-07-14', { at: 200, error: 'second failure' });
  assert.deepEqual(store.getAttempt('cn', '2026-07-14'), {
    at: 200,
    error: 'second failure',
  });
  assert.equal(store.getAttempt('cn', '2026-02-30'), null);
  assert.equal(store.clearAttempt('cn', '2026-07-14'), true);
  assert.equal(store.clearAttempt('cn', '2026-07-14'), false);
  assert.equal(store.getAttempt('cn', '2026-07-14'), null);
  assert.deepEqual(store.latest('cn'), review('cn', '2026-07-14'));
  assert.deepEqual(store.latest('us'), review('us', '2026-07-13'));

  assert.throws(
    () => store.recordAttempt('xx', '2026-07-14', { at: 1, error: 'x' }),
    /valid market/,
  );
  assert.throws(
    () => store.recordAttempt('cn', '2026-02-30', { at: 1, error: 'x' }),
    /reviewDate/,
  );
});
