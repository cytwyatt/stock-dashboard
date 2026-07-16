'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');

const { AUTH_MAXAGE, createAuth } = require('../src/http/auth');
const { createStaticServer } = require('../src/http/static');
const { sendJSON } = require('../src/http/response');
const { createHttpHandler } = require('../src/http/router');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mockRequest({ url = '/', method = 'GET', headers = {}, body = '' } = {}) {
  const req = Readable.from(body ? [body] : []);
  req.url = url;
  req.method = method;
  req.headers = headers;
  return req;
}

function mockResponse({ gzipOK = false } = {}) {
  return {
    gzipOK,
    headersSent: false,
    writableEnded: false,
    status: null,
    headers: null,
    body: undefined,
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
      return this;
    },
    write(chunk) {
      this.body = chunk;
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.body = chunk;
      this.writableEnded = true;
      return this;
    },
  };
}

function loginHandler(auth, staticServer = null) {
  const fallbackStatic = staticServer || {
    resolvePath: () => '/index.html',
    serve(req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('ok');
    },
  };
  return createHttpHandler({
    port: 3888,
    auth,
    staticServer: fallbackStatic,
    marketService: {},
    chatService: {},
    llmConfigStore: {},
    llmClient: {},
    watchlistStore: {},
    chatStore: {},
    marketMeta() {},
    sanitizeCode: (value) => value,
    marketForCode: () => 'cn',
    env: {},
    logger: { error() {} },
  });
}

test('auth 未配置时完全禁用；配置后只接受正确口令和 market_auth cookie', () => {
  const disabled = createAuth();
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.token, '');
  assert.equal(disabled.maxAge, AUTH_MAXAGE);
  assert.equal(disabled.verify('anything'), true);
  assert.equal(disabled.isAuthed({ headers: {} }), true);

  const auth = createAuth({ password: 'correct horse' });
  const expectedToken = crypto.createHash('sha256')
    .update('market-auth:correct horse')
    .digest('hex');
  assert.equal(auth.enabled, true);
  assert.equal(auth.token, expectedToken);
  assert.equal(auth.verify('correct horse'), true);
  assert.equal(auth.verify('wrong'), false);
  assert.deepEqual(auth.parseCookies({ headers: { cookie: 'a=1; market_auth=token=with=equals; b=2' } }), {
    a: '1', market_auth: 'token=with=equals', b: '2',
  });
  assert.equal(auth.isAuthed({ headers: {} }), false);
  assert.equal(auth.isAuthed({ headers: { cookie: 'market_auth=wrong' } }), false);
  assert.equal(auth.isAuthed({ headers: { cookie: `foo=1; market_auth=${auth.token}` } }), true);
});

test('登录路由对正确口令下发 HttpOnly cookie，错误口令返回 401 且不下发 cookie', async () => {
  const auth = createAuth({ password: 'secret' });
  const handler = loginHandler(auth);

  const ok = mockResponse();
  await handler(mockRequest({
    url: '/__login', method: 'POST', body: 'password=secret',
  }), ok);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.Location, '/');
  assert.equal(ok.headers['Set-Cookie'],
    `market_auth=${auth.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_MAXAGE}`);
  assert.equal(ok.headers['Set-Cookie'].includes('Secure'), false);
  assert.equal(ok.body, undefined);

  const bad = mockResponse();
  await handler(mockRequest({
    url: '/__login', method: 'POST', body: 'password=wrong',
  }), bad);
  assert.equal(bad.status, 401);
  assert.equal(bad.headers['Set-Cookie'], undefined);
  assert.equal(bad.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.match(String(bad.body), /口令错误/);

  const denied = mockResponse();
  await handler(mockRequest({ url: '/api/news' }), denied);
  assert.equal(denied.status, 401);
  assert.deepEqual(JSON.parse(denied.body), { error: '未授权' });

  const allowed = mockResponse();
  await handler(mockRequest({ headers: { cookie: `market_auth=${auth.token}` } }), allowed);
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body, 'ok');
});

test('static 只解析 publicDir 内现有文件，拒绝路径越界、目录与缺失文件', (t) => {
  const root = tempDir(t);
  const publicDir = path.join(root, 'public');
  fs.mkdirSync(path.join(publicDir, 'nested'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<h1>home</h1>');
  fs.writeFileSync(path.join(publicDir, 'app.js'), 'console.log("ok")');
  fs.writeFileSync(path.join(root, 'secret.txt'), 'secret');
  const staticServer = createStaticServer({ publicDir });

  assert.equal(staticServer.resolvePath('/'), path.join(publicDir, 'index.html'));
  assert.equal(staticServer.resolvePath('/app.js'), path.join(publicDir, 'app.js'));
  for (const pathname of [
    '/../secret.txt',
    '../../secret.txt',
    '/nested/../../secret.txt',
    '/missing.js',
    '/nested',
  ]) assert.equal(staticServer.resolvePath(pathname), null, pathname);
});

test('static 按扩展名与 vendor 路径设置 MIME/缓存，支持 ETag 304 和 gzip', (t) => {
  const publicDir = tempDir(t);
  const vendorDir = path.join(publicDir, 'vendor');
  fs.mkdirSync(vendorDir);
  const script = 'window.answer = 42;';
  const appFile = path.join(publicDir, 'app.js');
  const vendorFile = path.join(vendorDir, 'lib.js');
  fs.writeFileSync(appFile, script);
  fs.writeFileSync(vendorFile, script);
  const staticServer = createStaticServer({ publicDir });

  const plain = mockResponse();
  staticServer.serve({ headers: {} }, plain, appFile);
  assert.equal(plain.status, 200);
  assert.equal(plain.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.equal(plain.headers['Cache-Control'], 'no-cache');
  assert.equal(plain.headers.Vary, 'Accept-Encoding');
  assert.match(plain.headers.ETag, /^"\d+-\d+"$/);
  assert.equal(Buffer.from(plain.body).toString(), script);

  const notModified = mockResponse();
  staticServer.serve({ headers: { 'if-none-match': plain.headers.ETag } }, notModified, appFile);
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.ETag, plain.headers.ETag);
  assert.equal(notModified.body, undefined);

  const compressed = mockResponse({ gzipOK: true });
  staticServer.serve({ headers: {} }, compressed, appFile);
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers['Content-Encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(compressed.body).toString(), script);
  assert.equal(staticServer.cache.size, 1);

  const vendor = mockResponse();
  staticServer.serve({ headers: {} }, vendor, vendorFile);
  assert.equal(vendor.headers['Cache-Control'], 'public, max-age=604800, immutable');
});

test('sendJSON 小响应保持明文，大于 1024 字符且客户端支持时使用 gzip', () => {
  const smallData = { ok: true };
  const small = mockResponse({ gzipOK: true });
  sendJSON(small, 201, smallData);
  assert.equal(small.status, 201);
  assert.deepEqual(small.headers, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  assert.equal(small.body, JSON.stringify(smallData));

  const largeData = { text: 'x'.repeat(2048) };
  const large = mockResponse({ gzipOK: true });
  sendJSON(large, 200, largeData);
  assert.equal(large.status, 200);
  assert.equal(large.headers['Content-Encoding'], 'gzip');
  assert.equal(large.headers.Vary, 'Accept-Encoding');
  assert.deepEqual(JSON.parse(zlib.gunzipSync(large.body).toString()), largeData);

  const unsupported = mockResponse();
  sendJSON(unsupported, 200, largeData);
  assert.equal(unsupported.headers['Content-Encoding'], undefined);
  assert.equal(unsupported.body, JSON.stringify(largeData));
});

test('公司资料路由只接受 GET，校验代码并返回统一市场元数据', async () => {
  const calls = [];
  const handler = createHttpHandler({
    port: 3888,
    auth: createAuth(),
    staticServer: { resolvePath: () => null },
    marketService: {
      async profile(code) {
        calls.push(code);
        return {
          data: { code, market: 'us', available: true, sector: 'Technology' },
          fetchedAt: 1000,
          stale: false,
          staleSince: null,
        };
      },
    },
    chatService: {},
    llmConfigStore: {},
    llmClient: {},
    watchlistStore: {},
    chatStore: {},
    marketMeta: (entry, spec) => ({ ...spec, fetchedAt: entry.fetchedAt }),
    sanitizeCode: (value) => String(value || '').replace(/[^A-Z]/g, ''),
    marketForCode: () => 'us',
    env: {},
    logger: { error() {} },
  });

  const missing = mockResponse();
  await handler(mockRequest({ url: '/api/profile?code=' }), missing);
  assert.equal(missing.status, 400);
  assert.deepEqual(JSON.parse(missing.body), { error: 'code required' });

  const method = mockResponse();
  await handler(mockRequest({ url: '/api/profile?code=AAPL', method: 'POST' }), method);
  assert.equal(method.status, 405);

  const ok = mockResponse();
  await handler(mockRequest({ url: '/api/profile?code=AAPL' }), ok);
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, ['AAPL']);
  assert.deepEqual(JSON.parse(ok.body), {
    data: { code: 'AAPL', market: 'us', available: true, sector: 'Technology' },
    meta: { market: 'us', currency: null, fetchedAt: 1000 },
  });
});

test('AI 大盘总结路由规范化市场，并区分 GET 缓存读取与 POST 手动刷新', async () => {
  const calls = [];
  const handler = createHttpHandler({
    port: 3888,
    auth: createAuth(),
    staticServer: { resolvePath: () => null },
    marketService: {},
    marketSummaryService: {
      async getSummary(market, options) {
        calls.push({ market, options });
        return {
          data: { configured: true, market, headline: `${market} summary` },
          fetchedAt: 1000,
          stale: false,
          staleSince: null,
        };
      },
    },
    chatService: {},
    llmConfigStore: {},
    llmClient: {},
    watchlistStore: {},
    chatStore: {},
    marketMeta: (entry, spec) => ({
      market: spec.market,
      currency: spec.currency,
      source: 'AI test',
      asOf: new Date(entry.fetchedAt).toISOString(),
      fetchedAt: new Date(entry.fetchedAt).toISOString(),
      stale: entry.stale,
    }),
    sanitizeCode: (value) => value,
    marketForCode: () => 'cn',
    env: {},
    logger: { error() {} },
  });

  const get = mockResponse();
  await handler(mockRequest({ url: '/api/market-summary?market=invalid', method: 'GET' }), get);
  assert.equal(get.status, 200);
  assert.equal(JSON.parse(get.body).data.market, 'cn');
  assert.equal(JSON.parse(get.body).meta.currency, null);
  assert.deepEqual(calls[0], { market: 'cn', options: { force: false } });

  const post = mockResponse();
  await handler(mockRequest({
    url: '/api/market-summary?market=us',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ market: 'hk' }),
  }), post);
  assert.equal(post.status, 200);
  assert.equal(JSON.parse(post.body).meta.market, 'hk');
  assert.deepEqual(calls[1], { market: 'hk', options: { force: true } });

  const malformed = mockResponse();
  await handler(mockRequest({
    url: '/api/market-summary', method: 'POST', body: '{bad',
  }), malformed);
  assert.equal(malformed.status, 400);

  const method = mockResponse();
  await handler(mockRequest({ url: '/api/market-summary', method: 'PUT' }), method);
  assert.equal(method.status, 405);
  assert.equal(calls.length, 2);
});

test('AI 盘后复盘路由只允许 GET，并让旧总结地址兼容读取同一份持久化复盘', async () => {
  const calls = [];
  const handler = createHttpHandler({
    port: 3888,
    auth: createAuth(),
    staticServer: { resolvePath: () => null },
    marketService: {},
    marketReviewService: {
      async ensureReview(market) {
        calls.push(market);
        return {
          data: { available: true, status: 'ready', market, reviewDate: '2026-07-14' },
          fetchedAt: 1000, stale: false, staleSince: null,
        };
      },
    },
    chatService: {}, llmConfigStore: {}, llmClient: {}, watchlistStore: {}, chatStore: {},
    marketMeta: (entry, spec) => ({ market: spec.market, currency: spec.currency, stale: false }),
    sanitizeCode: (value) => value,
    marketForCode: () => 'cn',
    env: {}, logger: { error() {} },
  });

  const review = mockResponse();
  await handler(mockRequest({ url: '/api/market-review?market=hk' }), review);
  assert.equal(review.status, 200);
  assert.equal(JSON.parse(review.body).data.market, 'hk');

  const alias = mockResponse();
  await handler(mockRequest({ url: '/api/market-summary?market=us' }), alias);
  assert.equal(alias.status, 200);
  assert.equal(JSON.parse(alias.body).data.status, 'ready');

  const post = mockResponse();
  await handler(mockRequest({ url: '/api/market-review', method: 'POST' }), post);
  assert.equal(post.status, 405);

  const aliasPost = mockResponse();
  await handler(mockRequest({ url: '/api/market-summary', method: 'POST' }), aliasPost);
  assert.equal(aliasPost.status, 405);
  assert.deepEqual(calls, ['hk', 'us']);
});

test('模型配置 API 分离问答与盘后复盘模型、兼容旧客户端并分别测试连接', async () => {
  const env = {};
  let stored = {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: 'test-private-key',
    model: 'deepseek-v4-flash',
    marketReviewModel: 'custom-review-model',
  };
  const testedModels = [];
  const effectiveConfig = () => {
    const model = env.LLM_MODEL || stored.model;
    const fallbackMarketReviewModel = model;
    return {
      baseUrl: stored.baseUrl,
      apiKey: stored.apiKey,
      model,
      marketReviewModel: env.LLM_MARKET_REVIEW_MODEL
        || env.LLM_MODEL
        || stored.marketReviewModel
        || fallbackMarketReviewModel,
      fallbackMarketReviewModel,
    };
  };
  const handler = createHttpHandler({
    port: 3888,
    auth: createAuth(),
    staticServer: { resolvePath: () => null },
    marketService: {},
    chatService: {},
    llmConfigStore: {
      getLLMConfig: effectiveConfig,
      getStoredLLMConfig: () => ({ ...stored }),
      normalizeLLMBaseUrl: (value) => new URL(value).toString().replace(/\/+$/, ''),
      writeLLMConfig: (value) => { stored = { ...value }; },
    },
    llmClient: {
      async testConfig(config) {
        testedModels.push(config.model);
        return { ok: true, message: `${config.model} OK` };
      },
    },
    watchlistStore: {},
    chatStore: {},
    marketMeta() {},
    sanitizeCode: (value) => value,
    marketForCode: () => 'cn',
    env,
    logger: { error() {} },
  });

  const get = mockResponse();
  await handler(mockRequest({ url: '/api/llm-config' }), get);
  assert.deepEqual(JSON.parse(get.body), {
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    marketReviewModel: 'custom-review-model',
    effectiveMarketReviewModel: 'custom-review-model',
    fallbackMarketReviewModel: 'deepseek-v4-flash',
    suggestedMarketReviewModel: '',
    marketReviewModelManaged: false,
    configured: true,
    keyMask: 'test****-key',
  });
  assert.doesNotMatch(get.body, /test-private-key/);

  const legacyPost = mockResponse();
  await handler(mockRequest({
    url: '/api/llm-config',
    method: 'POST',
    body: JSON.stringify({
      baseUrl: stored.baseUrl, model: stored.model, apiKey: '',
    }),
  }), legacyPost);
  assert.equal(legacyPost.status, 200);
  assert.equal(stored.marketReviewModel, 'custom-review-model');

  const clearOverride = mockResponse();
  await handler(mockRequest({
    url: '/api/llm-config',
    method: 'POST',
    body: JSON.stringify({
      baseUrl: stored.baseUrl, model: stored.model, marketReviewModel: '', apiKey: '',
    }),
  }), clearOverride);
  assert.equal(clearOverride.status, 200);
  assert.equal(stored.marketReviewModel, '');
  assert.equal(JSON.parse(clearOverride.body).effectiveMarketReviewModel, 'deepseek-v4-flash');

  const setReviewModel = mockResponse();
  await handler(mockRequest({
    url: '/api/llm-config',
    method: 'POST',
    body: JSON.stringify({
      baseUrl: stored.baseUrl,
      model: stored.model,
      marketReviewModel: 'deepseek-v4-pro',
      apiKey: '',
    }),
  }), setReviewModel);
  assert.equal(setReviewModel.status, 200);

  const connectionTest = mockResponse();
  await handler(mockRequest({ url: '/api/llm-config/test', method: 'POST' }), connectionTest);
  assert.equal(connectionTest.status, 200);
  assert.equal(JSON.parse(connectionTest.body).ok, true);
  assert.deepEqual(testedModels, ['deepseek-v4-flash', 'deepseek-v4-pro']);

  env.LLM_MARKET_REVIEW_MODEL = 'managed-review-model';
  const managed = mockResponse();
  await handler(mockRequest({
    url: '/api/llm-config',
    method: 'POST',
    body: JSON.stringify({
      baseUrl: stored.baseUrl,
      model: stored.model,
      marketReviewModel: 'attempted-change',
      apiKey: '',
    }),
  }), managed);
  assert.equal(managed.status, 400);
  assert.match(JSON.parse(managed.body).error, /环境变量/);
});
