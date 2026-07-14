'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createApplication,
  createIsolatedApplication,
  createRuntime,
  defaultRuntime,
} = require('../src/bootstrap');

const quietLogger = { log() {}, error() {} };
const env = {
  MARKET_DISABLE_WARM: '1',
  MARKET_DISABLE_REVIEW: '1',
  MARKET_DATA_DIR: '/tmp/market-bootstrap-test',
};
const fetchImpl = async () => { throw new Error('network should not be used during composition'); };

test('默认应用显式使用进程 runtime，缓存与 Yahoo 调度器成对共享', () => {
  const first = createApplication({ env, fetchImpl, logger: quietLogger });
  const second = createApplication({ env, fetchImpl, logger: quietLogger });

  assert.equal(first.runtime, defaultRuntime);
  assert.equal(second.runtime, defaultRuntime);
  assert.equal(first.cache, second.cache);
  assert.equal(first.runtime.yahooScheduler, second.runtime.yahooScheduler);
});

test('隔离应用的缓存与 Yahoo 调度器一起隔离，不产生半隔离状态', () => {
  const first = createIsolatedApplication({ env, fetchImpl, logger: quietLogger });
  const second = createIsolatedApplication({ env, fetchImpl, logger: quietLogger });
  const standalone = createRuntime();

  assert.notEqual(first.runtime, second.runtime);
  assert.notEqual(first.cache, second.cache);
  assert.notEqual(first.runtime.yahooScheduler, second.runtime.yahooScheduler);
  assert.notEqual(standalone.cache, defaultRuntime.cache);
  assert.notEqual(standalone.yahooScheduler, defaultRuntime.yahooScheduler);
});

test('listen 参数同步失败时不会先创建后台定时器', () => {
  const realSetInterval = global.setInterval;
  let intervalCount = 0;
  global.setInterval = () => {
    intervalCount++;
    return { fakeTimer: true };
  };
  try {
    const app = createIsolatedApplication({
      env: { ...env, PORT: 65536, MARKET_DISABLE_REVIEW: '0' },
      fetchImpl,
      logger: quietLogger,
    });
    assert.throws(() => app.startServer(), /bad port|options\.port|ERR_SOCKET_BAD_PORT/i);
    assert.equal(intervalCount, 0);
  } finally {
    global.setInterval = realSetInterval;
  }
});
