'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'market-chat-research-'));
process.env.MARKET_DISABLE_WARM = '1';
process.env.MARKET_DATA_DIR = TEST_DATA_DIR;
process.env.LLM_BASE_URL = 'http://mock-llm.local/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'mock-model';
delete process.env.MARKET_PASSWORD;

const NativeResponse = global.Response;
const realFetch = global.fetch;

function tencentQuote(code) {
  const fields = Array(55).fill('');
  fields[1] = '贵州茅台';
  fields[3] = '1500';
  fields[4] = '1485';
  fields[5] = '1490';
  fields[30] = '20260713150000';
  fields[31] = '15';
  fields[32] = '1.01';
  fields[33] = '1510';
  fields[34] = '1480';
  fields[36] = '12345';
  fields[37] = '185000';
  fields[38] = '0.42';
  fields[39] = '25';
  fields[43] = '2.02';
  fields[45] = '19000';
  fields[46] = '8';
  return `v_${code}="${fields.join('~')}";`;
}

function researchRows(startPrice, dailyChange) {
  const start = Date.UTC(2024, 11, 1);
  let close = startPrice;
  return Array.from({ length: 400 }, (_, index) => {
    if (index) close *= 1 + dailyChange;
    const date = new Date(start + index * 86400000).toISOString().slice(0, 10);
    return [date, String(close), String(close), String(close * 1.01), String(close * 0.99), String(1000 + index)];
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

test('个股研究意图只覆盖投研问题，并在首次模型请求前自动注入研究卡', async () => {
  const llmBodies = [];
  const klineRequests = [];
  global.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url === 'http://mock-llm.local/v1/chat/completions') {
      llmBodies.push(JSON.parse(init.body));
      return new NativeResponse(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'MOCK_OK' } }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('qt.gtimg.cn/q=sh600519')) {
      return new NativeResponse(tencentQuote('sh600519'), { status: 200 });
    }
    if (url.includes('web.ifzq.gtimg.cn/appstock/app/fqkline/get')) {
      klineRequests.push(url);
      if (url.includes('sh600519,day,,,400,qfq')) {
        return new NativeResponse(JSON.stringify({
          data: { sh600519: { qfqday: researchRows(100, 0.002) } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('sh000300,day,,,400,qfq')) {
        return new NativeResponse(JSON.stringify({
          data: { sh000300: { qfqday: researchRows(200, 0.001) } },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };

  const {
    server,
    cache,
    hasStockResearchIntent,
  } = require('../server');
  const stockContext = { code: 'sh600519', name: '贵州茅台', market: 'cn' };

  for (const prompt of [
    '综合分析一下这只股票',
    '近20日表现和波动率怎么样？',
    '跑赢大盘了吗，最大回撤是多少？',
    '那风险呢？',
    '52周位置和量能如何？',
    '能买吗，仓位怎么控制？',
    '分析一下sh600519',
  ]) assert.equal(hasStockResearchIntent(prompt, stockContext), true, prompt);

  for (const prompt of [
    '公司什么时候成立？',
    '最新公告是什么？',
    '估值和净利润怎么样？',
    '经营风险大吗？',
    '今天大盘怎么样？',
    '今天市场风险如何？',
    '把“风险提示”翻译成英文',
    '分析一下AAPL',
    '纳斯达克风险怎么样？',
    '道琼斯风险如何？',
    '美债风险如何？',
    '创业板风险怎么样？',
    '上证风险如何？',
  ]) assert.equal(hasStockResearchIntent(prompt, stockContext), false, prompt);

  const usContext = { code: 'AAPL', name: 'Apple', market: 'us' };
  for (const prompt of [
    'TSLA风险怎么样？', 'tsla风险怎么样？', 'TSLA能买吗？', 'F能买吗？',
    'TSLA波动率如何？', '$tsla最大回撤是多少？', '分析一下tsla', '看看tsla',
    '研究一下tsla', '评价tsla', '分析一下brk.b', 'tsla值得买吗？',
    'tsla止损位在哪？', 'aapl与tsla谁的风险更高？', '相对tsla表现如何？',
    'MA能买吗？', 'AI风险怎么样？', 'AI最大回撤是多少？', '相对MA表现如何？',
    '跟tsla比，风险如何？', '和tsla相比风险如何？', '对于tsla，风险怎么样？',
    'tsla目前值得买吗？', 'aapl、tsla哪个风险更高？', '标普500和tsla比风险如何？',
    '我想问MA目前值得买吗？', '我觉得AI现在能买吗？', '持有MA的话，该减仓吗？',
    '我的MA目前值得买吗？', '最近持有的MA应该减仓吗？',
    '我的AI目前值得买吗？', '我的PB目前值得买吗？',
    'Microsoft风险怎么样？', 'Berkshire最大回撤是多少？',
    '纳斯达克风险怎么样？', '道琼斯风险如何？', '美债风险如何？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, usContext), false, prompt);
  }
  for (const prompt of ['^GSPC最大回撤是多少？', '^GSPC风险怎么样？', '标普500风险怎么样？']) {
    assert.equal(hasStockResearchIntent(prompt, usContext), false, prompt);
  }
  for (const prompt of [
    'AAPL风险怎么样？', 'aapl风险怎么样？', '风险？', 'AAPL能买吗？',
    '分析一下aapl', 'Apple风险怎么样？', '分析一下Apple',
    '用AI分析AAPL风险', '用AI分析风险', '用AI分析AAPL风险，能买吗？', '相对^GSPC表现如何？',
    '相对S&P500表现如何？', 'AAPL vs ^GSPC表现', 'AAPL与^GSPC表现',
    'AAPL与^GSPC谁的风险更高？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, usContext), true, prompt);
  }
  for (const prompt of ['sh000300最大回撤是多少？', 'sh000300风险怎么样？', '沪深300风险怎么样？', '600036风险怎么样？', '000858能买吗？']) {
    assert.equal(hasStockResearchIntent(prompt, stockContext), false, prompt);
  }
  for (const prompt of [
    '600519风险怎么样？', '分析一下600519', '看看600519', '600519怎么样？',
    '相对sh000300表现如何？', '和000300比表现如何？', '贵州茅台与沪深300谁的风险更高？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, stockContext), true, prompt);
  }
  const hkContext = { code: 'hk00700', name: '腾讯控股', market: 'hk' };
  for (const prompt of [
    '09988风险怎么样？', '9988能买吗？', '3690风险怎么样？',
    'hkHSI风险怎么样？', '恒生指数最大回撤是多少？', '恒生科技风险怎么样？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, hkContext), false, prompt);
  }
  for (const prompt of [
    '00700风险怎么样？', '分析一下00700', '00700怎么样？', '分析一下700',
    '700怎么样？', '相对hkHSI表现如何？', '相对HSI表现如何？',
  ]) {
    assert.equal(hasStockResearchIntent(prompt, hkContext), true, prompt);
  }
  const hsbcContext = { code: 'hk00005', name: '汇丰控股', market: 'hk' };
  assert.equal(hasStockResearchIntent('代码5能买吗？', hsbcContext), true);
  assert.equal(hasStockResearchIntent('港股16风险怎么样？', hsbcContext), false);
  const fordContext = { code: 'F', name: 'Ford Motor', market: 'us' };
  assert.equal(hasStockResearchIntent('分析一下f', fordContext), true);
  for (const prompt of ['大盘最大回撤是多少？', '市场52周表现如何？', '指数波动率怎么样？']) {
    assert.equal(hasStockResearchIntent(prompt, stockContext), false, prompt);
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const positive = await postChat(port, {
      sessionId: 'research-positive',
      message: '分析股票 贵州茅台（代码：sh600519，市场：A股）。综合分析阶段表现、波动和最大回撤。',
      stockContext,
    });
    assert.equal(positive.status, 200);
    const positiveEvents = parseSSE(positive.text);
    assert.ok(positiveEvents.some((event) =>
      event.type === 'tool' && event.name === 'get_research_card'
      && event.args.code === 'sh600519' && event.args.auto === true));
    assert.ok(positiveEvents.some((event) => event.type === 'answer' && event.content === 'MOCK_OK'));
    assert.equal(llmBodies.length, 1, 'mock模型首轮应直接拿到研究卡，不依赖后续工具轮次');
    const positiveMessages = llmBodies[0].messages;
    const researchIndex = positiveMessages.findIndex((message) =>
      message.role === 'system' && message.content.includes('服务器已自动计算本轮个股研究卡'));
    const userIndex = positiveMessages.findIndex((message) => message.role === 'user');
    assert.ok(researchIndex >= 0 && researchIndex < userIndex);
    const researchMessage = positiveMessages[researchIndex].content;
    for (const marker of ['sh600519', '"returns"', '"risk"', '"benchmark"', '"meta"', '"stale"', '不能证明涨跌原因']) {
      assert.ok(researchMessage.includes(marker), marker);
    }
    assert.ok(researchMessage.length < 8000, `研究卡自动上下文过长：${researchMessage.length}`);
    assert.equal(klineRequests.filter((url) => url.includes('day,,,400,qfq')).length, 2);

    cache.clear();
    const beforeNegativeKlines = klineRequests.length;
    const negative = await postChat(port, {
      sessionId: 'research-negative',
      message: '分析股票 贵州茅台（代码：sh600519，市场：A股）。公司什么时候成立？',
      stockContext,
    });
    assert.equal(negative.status, 200);
    const negativeEvents = parseSSE(negative.text);
    assert.ok(!negativeEvents.some((event) => event.type === 'tool' && event.name === 'get_research_card'));
    assert.ok(negativeEvents.some((event) => event.type === 'answer' && event.content === 'MOCK_OK'));
    assert.equal(llmBodies.length, 2);
    assert.ok(!llmBodies[1].messages.some((message) =>
      message.role === 'system' && message.content.includes('服务器已自动计算本轮个股研究卡')));
    assert.equal(klineRequests.length, beforeNegativeKlines);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cache.clear();
    global.fetch = realFetch;
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
});
