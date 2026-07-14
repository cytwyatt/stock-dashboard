'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { createJsonFileStorage } = require('../src/storage/json-file');
const { createWatchlistStore } = require('../src/storage/watchlist-store');
const { createLLMConfigStore, normalizeLLMBaseUrl } = require('../src/storage/llm-config-store');
const { createChatStore } = require('../src/storage/chat-store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-storage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function jsonFile(dataDir, fsImpl = fs, logger = { error() {} }) {
  return createJsonFileStorage({ dataDir, fs: fsImpl, crypto, pid: 4242, logger });
}

const sanitizeCode = (value) => String(value ?? '').replace(/[^a-zA-Z0-9.^=-]/g, '').slice(0, 20);
const isCNCode = (code) => /^(sh|sz|bj)\d{6}$/.test(code);
const isKnownHKCode = (code) => /^hk(\d{5}|HSI|HSCEI|HSTECH)$/.test(code);

test('仅导入 storage 模块不会读取 MARKET_DATA_DIR 或创建文件', () => {
  const marker = path.join(os.tmpdir(), `market-storage-import-${process.pid}-${Date.now()}`);
  const previous = process.env.MARKET_DATA_DIR;
  process.env.MARKET_DATA_DIR = marker;
  try {
    for (const modulePath of [
      '../src/storage/json-file',
      '../src/storage/watchlist-store',
      '../src/storage/llm-config-store',
      '../src/storage/chat-store',
      '../src/storage/market-review-store',
    ]) {
      delete require.cache[require.resolve(modulePath)];
      require(modulePath);
    }
    assert.equal(fs.existsSync(marker), false);
  } finally {
    if (previous === undefined) delete process.env.MARKET_DATA_DIR;
    else process.env.MARKET_DATA_DIR = previous;
  }
});

test('原子 JSON 写入创建目录、fsync/rename 后只留下 0600 正式文件', (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  const file = path.join(dataDir, 'sample.json');
  const storage = jsonFile(dataDir);

  storage.writeDataJSON(file, { value: 1, nested: { ok: true } });
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  "value": 1,\n  "nested": {\n    "ok": true\n  }\n}');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dataDir), ['sample.json']);

  storage.writeDataJSON(file, { value: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { value: 2 });
  assert.deepEqual(fs.readdirSync(dataDir), ['sample.json']);
});

test('原子写失败会关闭并删除唯一临时文件；权限保护忽略缺失文件并记录其他错误', (t) => {
  const root = tempDir(t);
  const dataDir = path.join(root, 'data');
  const file = path.join(dataDir, 'sample.json');
  const failingFs = {
    mkdirSync: fs.mkdirSync,
    chmodSync: fs.chmodSync,
    openSync: fs.openSync,
    writeFileSync: fs.writeFileSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    renameSync() { throw new Error('rename failed'); },
    unlinkSync: fs.unlinkSync,
  };
  assert.throws(() => jsonFile(dataDir, failingFs).writeDataJSON(file, { secret: true }), /rename failed/);
  assert.deepEqual(fs.readdirSync(dataDir), []);

  fs.writeFileSync(file, '{}', { mode: 0o644 });
  jsonFile(dataDir).protectDataFile(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.doesNotThrow(() => jsonFile(dataDir).protectDataFile(path.join(dataDir, 'missing.json')));

  const logs = [];
  const deniedFs = { chmodSync() { const error = new Error('denied'); error.code = 'EACCES'; throw error; } };
  jsonFile(dataDir, deniedFs, { error: (message) => logs.push(message) }).protectDataFile(file);
  assert.deepEqual(logs, [`[chmod] ${file}: denied`]);
});

test('watchlist 保持 200 项上限、字段规范化、重复项与写前不二次规范化语义', (t) => {
  const dataDir = tempDir(t);
  const store = createWatchlistStore({ dataDir, fs, jsonFile: jsonFile(dataDir), sanitizeCode });
  const longName = '名'.repeat(45);
  const normalized = store.normalizeWatchlist([
    { code: ' sh600519!? ', name: longName, market: 'hk' },
    { code: 'AAPL', name: 123, market: 'us' },
    { code: 'AAPL', name: 'duplicate', market: 'invalid' },
    null,
  ]);
  assert.deepEqual(normalized, [
    { code: 'sh600519', name: '名'.repeat(40), market: 'hk' },
    { code: 'AAPL', name: '123', market: 'us' },
    { code: 'AAPL', name: 'duplicate', market: 'cn' },
  ]);

  const cappedBeforeFiltering = Array.from({ length: 200 }, () => ({}));
  cappedBeforeFiltering.push({ code: 'AAPL', name: 'too late', market: 'us' });
  assert.deepEqual(store.normalizeWatchlist(cappedBeforeFiltering), []);
  assert.deepEqual(store.normalizeWatchlist({}), []);

  const raw = [{ code: ' AAPL!? ', name: 'Apple', market: 'invalid', extra: true }];
  store.writeWatchlist(raw);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.file, 'utf8')), raw);
  assert.deepEqual(store.readWatchlist(), [{ code: 'AAPL', name: 'Apple', market: 'cn' }]);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);

  fs.writeFileSync(store.file, '{bad json');
  assert.deepEqual(store.readWatchlist(), []);
});

test('LLM 配置保持文件值、环境变量优先级、默认值与非法 URL 降级语义', (t) => {
  const dataDir = tempDir(t);
  const env = {};
  const store = createLLMConfigStore({ dataDir, fs, jsonFile: jsonFile(dataDir), env });
  const saved = {
    baseUrl: 'https://file.example/v1/',
    apiKey: 'file-key',
    model: 'file-model',
    extra: 'preserved',
  };
  store.writeLLMConfig(saved);
  assert.deepEqual(store.getStoredLLMConfig(), saved);
  assert.deepEqual(store.getLLMConfig(), {
    baseUrl: 'https://file.example/v1',
    apiKey: 'file-key',
    model: 'file-model',
  });
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);

  env.LLM_BASE_URL = 'https://env.example/api/';
  env.LLM_API_KEY = 'env-key';
  env.LLM_MODEL = 'env-model';
  assert.deepEqual(store.getLLMConfig(), {
    baseUrl: 'https://env.example/api',
    apiKey: 'env-key',
    model: 'env-model',
  });

  env.LLM_BASE_URL = ' not a url/// ';
  assert.equal(store.getLLMConfig().baseUrl, 'not a url');
  fs.writeFileSync(store.file, '{bad json');
  delete env.LLM_BASE_URL;
  delete env.LLM_API_KEY;
  delete env.LLM_MODEL;
  assert.deepEqual(store.getStoredLLMConfig(), {});
  assert.deepEqual(store.getLLMConfig(), {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
  });
});

test('LLM base URL 只接受无认证信息、query 与 hash 的 http(s) 地址', () => {
  assert.equal(normalizeLLMBaseUrl(' https://api.example.com/v1/// '), 'https://api.example.com/v1');
  assert.equal(normalizeLLMBaseUrl('http://localhost:8080'), 'http://localhost:8080');
  for (const value of [
    'ftp://api.example.com/v1',
    'https://user:pass@api.example.com/v1',
    'https://api.example.com/v1?q=1',
    'https://api.example.com/v1#hash',
  ]) assert.throws(() => normalizeLLMBaseUrl(value), /invalid LLM base URL/);
  // new URL() 本身无法解析时保留原生 TypeError，与原 server.js 一致。
  assert.throws(() => normalizeLLMBaseUrl('not a url'), { name: 'TypeError' });
});

test('chat session ID 与股票上下文规范化保持原有边界', (t) => {
  const dataDir = tempDir(t);
  const randomValues = [0.1, 0.2];
  const store = createChatStore({
    dataDir,
    fs,
    jsonFile: jsonFile(dataDir),
    isCNCode,
    isKnownHKCode,
    now: () => 1700000000000,
    random: () => randomValues.shift(),
  });

  assert.equal(store.isValidChatSessionId('abc_DEF-123'), true);
  assert.equal(store.isValidChatSessionId('a'.repeat(80)), true);
  assert.equal(store.isValidChatSessionId('a'.repeat(81)), false);
  assert.equal(store.isValidChatSessionId('bad id'), false);
  const first = `c1700000000000${(0.1).toString(36).slice(2, 6)}`;
  const second = `c1700000000000${(0.2).toString(36).slice(2, 6)}`;
  assert.equal(store.createChatSessionId(new Set([first])), second);

  assert.deepEqual(store.normalizeStockContext({
    code: ' SH600519 ', name: ' 贵\u0000州   茅台 ', market: 'cn', extra: true,
  }), { code: 'sh600519', name: '贵 州 茅台', market: 'cn' });
  assert.deepEqual(store.normalizeStockContext({ code: 'hk00700', name: '腾讯', market: 'hk' }), {
    code: 'hk00700', name: '腾讯', market: 'hk',
  });
  assert.deepEqual(store.normalizeStockContext({ code: 'aapl', name: 'Apple', market: 'us' }), {
    code: 'AAPL', name: 'Apple', market: 'us',
  });
  assert.equal(store.normalizeStockContext({ code: 'sh600519', name: '', market: 'us' }), null);
  assert.equal(store.normalizeStockContext({ code: 'hk00700', name: '', market: 'us' }), null);
  assert.equal(store.normalizeStockContext({ code: 'AAPL', name: 'x'.repeat(201), market: 'us' }), null);
});

test('chat read/write 保留根级额外字段，缺失、损坏或 sessions 非数组时返回空 store', (t) => {
  const dataDir = tempDir(t);
  const store = createChatStore({
    dataDir,
    fs,
    jsonFile: jsonFile(dataDir),
    isCNCode,
    isKnownHKCode,
  });
  assert.deepEqual(store.readChats(), { sessions: [] });

  const data = { version: 2, sessions: [{ id: 'one', messages: [] }] };
  store.writeChats(data);
  assert.deepEqual(store.readChats(), data);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);

  fs.writeFileSync(store.file, JSON.stringify({ sessions: 'invalid', version: 3 }));
  assert.deepEqual(store.readChats(), { sessions: [] });
  fs.writeFileSync(store.file, '{bad json');
  assert.deepEqual(store.readChats(), { sessions: [] });
});

test('chat 迁移丢弃非法会话、修复消息/上下文/重复 ID，保留内容且二次运行不写盘', (t) => {
  const dataDir = tempDir(t);
  const baseJsonFile = jsonFile(dataDir);
  const file = path.join(dataDir, 'chats.json');
  baseJsonFile.writeDataJSON(file, {
    version: 7,
    sessions: [
      null,
      [],
      { id: 'dup', title: 'first', messages: 'invalid', stockContext: { code: 'bad', market: 'cn' }, keep: 1 },
      { id: 'dup', title: 'second', messages: [{ role: 'user', content: 'hello' }], stockContext: { market: 'hk', name: '  腾讯   控股 ', code: 'HK00700' } },
      { id: 'bad id', title: 'third', messages: [] },
      { id: 'fine', title: 'fourth', messages: [], stockContext: { code: 'AAPL', name: 'Apple', market: 'us' } },
    ],
  });

  let writes = 0;
  const trackingJsonFile = {
    protectDataFile: baseJsonFile.protectDataFile,
    writeDataJSON(target, data) {
      writes++;
      return baseJsonFile.writeDataJSON(target, data);
    },
  };
  const randomValues = [0.1, 0.2, 0.3];
  const store = createChatStore({
    dataDir,
    fs,
    jsonFile: trackingJsonFile,
    isCNCode,
    isKnownHKCode,
    now: () => 1700000000000,
    random: () => randomValues.shift(),
  });
  const generated = [0.1, 0.2].map((value) => `c1700000000000${value.toString(36).slice(2, 6)}`);

  assert.equal(store.migrateChatSessionIds(), undefined);
  assert.equal(writes, 1);
  const migrated = store.readChats();
  assert.equal(migrated.version, 7);
  assert.equal(migrated.sessions.length, 4);
  assert.deepEqual(migrated.sessions.map((session) => session.id), ['dup', generated[0], generated[1], 'fine']);
  assert.deepEqual(migrated.sessions[0], { id: 'dup', title: 'first', messages: [], keep: 1 });
  assert.deepEqual(migrated.sessions[1].messages, [{ role: 'user', content: 'hello' }]);
  assert.deepEqual(migrated.sessions[1].stockContext, { code: 'hk00700', name: '腾讯 控股', market: 'hk' });
  assert.deepEqual(migrated.sessions[3].stockContext, { code: 'AAPL', name: 'Apple', market: 'us' });

  assert.equal(store.migrateChatSessionIds(), undefined);
  assert.equal(writes, 1);
});
