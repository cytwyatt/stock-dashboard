'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createApplication, createRuntime } = require('../src/bootstrap');

const NativeResponse = global.Response;

function jsonResponse(value) {
  return new NativeResponse(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function postChat(port, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

test('美股原因查询在首次模型请求前自动注入带来源的 Yahoo 个股资讯', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'market-us-events-'));
  const llmBodies = [];
  const upstreamCalls = [];
  const nowSec = Math.floor(Date.now() / 1000);
  const articleUrl = 'https://finance.yahoo.com/news/apple-product-update';
  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    upstreamCalls.push(url);
    if (url.includes('/v8/finance/chart/AAPL')) {
      return jsonResponse({
        chart: {
          result: [{
            meta: {
              currency: 'USD',
              exchangeTimezoneName: 'America/New_York',
              chartPreviousClose: 220,
              regularMarketPrice: 225,
              regularMarketTime: nowSec,
              regularMarketDayHigh: 226,
              regularMarketDayLow: 219,
              regularMarketVolume: 123456,
              longName: 'Apple Inc.',
              hasPrePostMarketData: false,
            },
            timestamp: [nowSec],
            indicators: { quote: [{ close: [225], volume: [123456] }] },
          }],
          error: null,
        },
      });
    }
    if (url.includes('/v1/finance/search')) {
      return jsonResponse({
        quotes: [{ symbol: 'AAPL', quoteType: 'EQUITY' }],
        news: [{
          type: 'STORY',
          title: 'Apple announces a product update',
          publisher: 'Reuters',
          link: articleUrl,
          providerPublishTime: nowSec - 60,
          relatedTickers: ['AAPL'],
        }],
      });
    }
    if (url === 'https://llm.test/v1/chat/completions') {
      llmBodies.push(JSON.parse(init.body));
      return jsonResponse({
        choices: [{
          finish_reason: 'stop',
          message: { role: 'assistant', content: '已基于来源完成分析' },
        }],
      });
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
  const runtime = createRuntime();
  runtime.yahooScheduler = { run: (task) => task() };
  const app = createApplication({
    env: {
      MARKET_DISABLE_WARM: '1',
      MARKET_DISABLE_REVIEW: '1',
      MARKET_DATA_DIR: dataDir,
      LLM_BASE_URL: 'https://llm.test/v1',
      LLM_API_KEY: 'test-key',
      LLM_MODEL: 'fixture-model',
    },
    fetchImpl,
    logger: { log() {}, error() {} },
    runtime,
  });

  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await postChat(app.server.address().port, {
      sessionId: 'us-auto-events',
      message: 'AAPL 今天为什么上涨？',
      stockContext: { code: 'AAPL', name: 'Apple', market: 'us' },
    });
    assert.equal(response.status, 200);
    const events = parseSSE(response.text);
    assert.deepEqual(
      events.filter((event) => event.type === 'tool').map((event) => event.name),
      ['get_quote', 'get_stock_events'],
    );
    assert.equal(events.at(-1).content, '已基于来源完成分析');
    assert.equal(llmBodies.length, 1, '自动证据不应依赖模型先主动调用工具');

    const evidenceMessage = llmBodies[0].messages.find((message) =>
      message.role === 'system' && message.content.includes('自动检索本轮个股异动证据'));
    assert.ok(evidenceMessage);
    assert.match(evidenceMessage.content, /Apple announces a product update/);
    assert.match(evidenceMessage.content, /Reuters/);
    assert.match(evidenceMessage.content, /"relation":"direct"/);
    assert.ok(evidenceMessage.content.includes(articleUrl));
    assert.match(evidenceMessage.content, /"supported":true/);
    assert.ok(upstreamCalls.some((url) => url.includes('/v8/finance/chart/AAPL')));
    assert.ok(upstreamCalls.some((url) => url.includes('/v1/finance/search')));
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
