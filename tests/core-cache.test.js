'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CACHE_MAX,
  cache,
  cached,
  cachedEntry,
  createCacheRuntime,
} = require('../src/core/cache');

test('显式 cache runtime 相互隔离，单个 runtime 内仍合并同 key 请求', async () => {
  const first = createCacheRuntime();
  const second = createCacheRuntime();
  let firstLoads = 0;
  let secondLoads = 0;

  assert.equal(await first.cached('same', 1000, async () => ++firstLoads), 1);
  assert.equal(await first.cached('same', 1000, async () => ++firstLoads), 1);
  assert.equal(await second.cached('same', 1000, async () => ++secondLoads), 1);
  assert.equal(firstLoads, 1);
  assert.equal(secondLoads, 1);
  assert.notEqual(first.cache, second.cache);
  assert.notEqual(first.inflight, second.inflight);
});

test('fresh cache 保留 fetchedAt，命中时不重复执行 loader，cached 只返回 data', async () => {
  const realNow = Date.now;
  let now = 1000;
  let calls = 0;
  Date.now = () => now;
  cache.clear();
  try {
    const first = await cachedEntry('fresh', 100, async () => {
      calls++;
      return { value: 1 };
    });
    assert.deepEqual(first, {
      data: { value: 1 },
      fetchedAt: 1000,
      stale: false,
      staleSince: null,
    });

    now = 1050;
    const hit = await cachedEntry('fresh', 100, async () => {
      calls++;
      throw new Error('fresh cache should skip loader');
    });
    assert.deepEqual(hit, first);
    assert.equal(calls, 1);

    const data = await cached('data-only', 100, async () => ({ value: 2 }));
    assert.deepEqual(data, { value: 2 });
  } finally {
    cache.clear();
    Date.now = realNow;
  }
});

test('同 key 并发请求合并为一次 loader 调用', async () => {
  cache.clear();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const loader = async () => {
    calls++;
    await gate;
    return { value: 7 };
  };
  try {
    const first = cachedEntry('shared', 1000, loader);
    const second = cachedEntry('shared', 1000, loader);
    assert.equal(calls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
  } finally {
    cache.clear();
  }
});

test('刷新失败返回旧值，不更新 fetchedAt，并在短冷却后允许恢复', async () => {
  const realNow = Date.now;
  const realError = console.error;
  const errors = [];
  let now = 1000;
  Date.now = () => now;
  console.error = (message) => errors.push(message);
  cache.clear();
  try {
    await cachedEntry('stale', 100, async () => ({ value: 1 }));

    now = 1200;
    const stale = await cachedEntry('stale', 100, async () => {
      throw new Error('upstream unavailable');
    });
    assert.deepEqual(stale, {
      data: { value: 1 },
      fetchedAt: 1000,
      stale: true,
      staleSince: 1200,
    });
    assert.match(errors[0], /^\[stale\] stale: upstream unavailable，返回上次缓存$/);

    now = 1250;
    let coolingLoaderCalled = false;
    const cooling = await cachedEntry('stale', 100, async () => {
      coolingLoaderCalled = true;
      return { value: 99 };
    });
    assert.equal(coolingLoaderCalled, false);
    assert.deepEqual(cooling, stale);

    now = 1400;
    const recovered = await cachedEntry('stale', 100, async () => ({ value: 2 }));
    assert.deepEqual(recovered, {
      data: { value: 2 },
      fetchedAt: 1400,
      stale: false,
      staleSince: null,
    });
  } finally {
    cache.clear();
    Date.now = realNow;
    console.error = realError;
  }
});

test('长 TTL 的 stale 重试冷却最多 15 秒，并保留首次 staleSince', async () => {
  const realNow = Date.now;
  const realError = console.error;
  let now = 1000;
  Date.now = () => now;
  console.error = () => {};
  cache.clear();
  try {
    await cachedEntry('stale-long', 60000, async () => ({ value: 1 }));

    now = 62000;
    const firstFailure = await cachedEntry('stale-long', 60000, async () => {
      throw new Error('first failure');
    });
    assert.equal(firstFailure.fetchedAt, 1000);
    assert.equal(firstFailure.staleSince, 62000);

    now = 76999;
    let calledDuringCooldown = false;
    await cachedEntry('stale-long', 60000, async () => {
      calledDuringCooldown = true;
      return { value: 2 };
    });
    assert.equal(calledDuringCooldown, false);

    now = 77001;
    let calledAfterCooldown = false;
    const repeatedFailure = await cachedEntry('stale-long', 60000, async () => {
      calledAfterCooldown = true;
      throw new Error('second failure');
    });
    assert.equal(calledAfterCooldown, true);
    assert.equal(repeatedFailure.fetchedAt, 1000);
    assert.equal(repeatedFailure.staleSince, 62000);
  } finally {
    cache.clear();
    Date.now = realNow;
    console.error = realError;
  }
});

test('缓存以 Map 顺序实现 LRU，命中会刷新位置且最多保留 1000 项', async () => {
  const realNow = Date.now;
  Date.now = () => 1000;
  cache.clear();
  try {
    for (let index = 0; index < CACHE_MAX; index++) {
      await cachedEntry(`lru:${index}`, 10000, async () => index);
    }
    assert.equal(cache.size, CACHE_MAX);

    await cachedEntry('lru:0', 10000, async () => -1);
    await cachedEntry(`lru:${CACHE_MAX}`, 10000, async () => CACHE_MAX);

    assert.equal(cache.size, CACHE_MAX);
    assert.equal(cache.has('lru:0'), true);
    assert.equal(cache.has('lru:1'), false);
    assert.equal(cache.has(`lru:${CACHE_MAX}`), true);
  } finally {
    cache.clear();
    Date.now = realNow;
  }
});
