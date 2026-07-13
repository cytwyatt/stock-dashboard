'use strict';

process.env.MARKET_DISABLE_WARM = '1';
process.env.MARKET_DATA_DIR = '/tmp/market-api-contract-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const NativeResponse = global.Response;
const realFetch = global.fetch;

function jsonResponse(value) {
  return new NativeResponse(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function tencentQuote(code, market = 'cn') {
  const f = Array(55).fill('');
  f[1] = market === 'hk' ? 'Tencent' : 'Moutai';
  f[3] = '1500';
  f[4] = '1490';
  f[5] = '1488';
  f[30] = market === 'hk' ? '2026/07/13 16:00:00' : '20260713150000';
  f[31] = '10';
  f[32] = '0.67';
  f[33] = '1510';
  f[34] = '1480';
  f[36] = '123';
  f[37] = '456';
  f[38] = '1.2';
  f[39] = '20';
  f[43] = '2';
  f[45] = '100';
  f[46] = '5';
  f[48] = '1600';
  f[49] = '1200';
  return `v_${code}="${f.join('~')}";`;
}

function yahooChartFixture() {
  return {
    chart: {
      result: [{
        meta: { currency: 'USD', exchangeTimezoneName: 'America/New_York' },
        timestamp: [1598275800, 1598362200],
        indicators: {
          quote: [{
            open: [90, 49], close: [100, 50], high: [110, 52], low: [80, 48],
            volume: [1000, 1200],
          }],
          adjclose: [{ adjclose: [50, 50] }],
        },
      }],
      error: null,
    },
  };
}

function researchKlineRows(startPrice, dailyChange) {
  const start = Date.UTC(2025, 10, 1);
  let close = startPrice;
  return Array.from({ length: 130 }, (_, i) => {
    if (i) close *= 1 + dailyChange;
    const date = new Date(start + i * 86400000).toISOString().slice(0, 10);
    return [date, String(close), String(close), String(close * 1.01), String(close * 0.99), String(1000 + i)];
  });
}

function installFetchFixture() {
  global.fetch = async (input) => {
    const url = String(input);
    if (url.includes('query1.finance.yahoo.com/v8/finance/chart/AAPL')) {
      return jsonResponse(yahooChartFixture());
    }
    if (url.includes('qt.gtimg.cn/q=sh600519')) {
      return new NativeResponse(tencentQuote('sh600519'), { status: 200 });
    }
    if (url.includes('web.ifzq.gtimg.cn/appstock/app/fqkline/get')) {
      if (url.includes('sh600519,day,,,400,qfq')) {
        return jsonResponse({ data: { sh600519: { qfqday: researchKlineRows(100, 0.002) } } });
      }
      if (url.includes('sh000300,day,,,400,qfq')) {
        return jsonResponse({ data: { sh000300: { qfqday: researchKlineRows(200, 0.001) } } });
      }
      return jsonResponse({
        data: {
          sh600519: {
            qfqday: [
              ['2026-07-10', '1200', '1210', '1215', '1190', '1000'],
              ['2026-07-13', '1210', '1220', '1225', '1205', '1100'],
            ],
          },
        },
      });
    }
    if (url.includes('proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank')) {
      return jsonResponse({
        data: {
          rank_list: [{
            code: 'hy001', name: '测试行业', zdf: '1.2', turnover: '100',
            zljlr: '5', zgb: '2/3', lzg: null,
          }],
        },
      });
    }
    if (url.includes('Market_Center.getHQNodeData')) {
      const down = url.includes('asc=1');
      return jsonResponse(down
        ? [
            { symbol: 'sh600001', name: '测试一', trade: '10', changepercent: '-9.8' },
            { symbol: 'sh600002', name: '测试二', trade: '10', changepercent: '-1' },
          ]
        : [
            { symbol: 'sh600001', name: '测试一', trade: '10', changepercent: '9.8' },
            { symbol: 'sh600002', name: '测试二', trade: '10', changepercent: '1' },
          ]);
    }
    throw new Error(`unexpected fixture URL: ${url}`);
  };
}

function requestJSON(port, path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
  });
}

test('行情API统一返回data/meta并保留金融口径', async () => {
  installFetchFixture();
  const { server, cache } = require('../server');
  cache.clear();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const kline = await requestJSON(port, '/api/kline?code=AAPL&days=30&period=day');
    assert.equal(kline.status, 200);
    assert.equal(kline.body.meta.currency, 'USD');
    assert.equal(kline.body.meta.adjustmentBasis, 'split_dividend_adjusted');
    assert.equal(kline.body.meta.adjustmentCoverage, 1);
    assert.deepEqual(kline.body.data.map((k) => k.close), [50, 50]);

    const cnKline = await requestJSON(port, '/api/kline?code=sh600519&days=30&period=day');
    assert.equal(cnKline.status, 200);
    assert.equal(cnKline.body.meta.currency, 'CNY');
    assert.equal(cnKline.body.meta.adjustmentBasis, 'provider_qfq');
    assert.equal(cnKline.body.meta.adjustmentCoverage, 1);

    const quote = await requestJSON(port, '/api/quote?code=sh600519');
    assert.equal(quote.status, 200);
    assert.equal(quote.body.meta.currency, 'CNY');
    assert.equal(quote.body.meta.timezone, 'Asia/Shanghai');
    assert.equal(quote.body.meta.asOf, '2026-07-13T15:00:00+08:00');
    assert.equal(quote.body.data.currency, 'CNY');
    assert.equal(quote.body.data.amount, 4560000);

    const research = await requestJSON(port, '/api/research?code=sh600519');
    assert.equal(research.status, 200);
    assert.equal(research.body.meta.currency, 'CNY');
    assert.equal(research.body.meta.adjustmentBasis, 'provider_qfq');
    assert.equal(research.body.data.benchmark.code, 'sh000300');
    assert.equal(research.body.data.benchmark.available, true);
    assert.notEqual(research.body.data.returns['120d'].assetPct, null);
    assert.notEqual(research.body.data.returns['120d'].excessPct, null);
    assert.equal(research.body.data.range52.value, null);
    assert.equal(research.body.data.range52.reason, 'insufficient_history');
    assert.equal(research.body.meta.coverage.components.asset.stale, false);
    assert.equal(research.body.meta.coverage.components.benchmark.code, 'sh000300');

    const emptyQuotes = await requestJSON(port, '/api/quotes?codes=');
    assert.equal(emptyQuotes.status, 200);
    assert.deepEqual(emptyQuotes.body.data, []);
    assert.equal(emptyQuotes.body.meta.stale, false);
    assert.equal(emptyQuotes.body.meta.market, null);

    const emptySearch = await requestJSON(port, '/api/search?q=');
    assert.equal(emptySearch.status, 200);
    assert.deepEqual(emptySearch.body, []);

    const overview = await requestJSON(port, '/api/overview?market=cn');
    assert.equal(overview.status, 200);
    assert.deepEqual(
      {
        up: overview.body.data.up,
        nonUp: overview.body.data.nonUp,
        down: overview.body.data.down,
        total: overview.body.data.total,
      },
      { up: 2, nonUp: 1, down: null, total: 3 }
    );
    assert.equal(overview.body.data.turnover, 1000000);
    assert.equal(overview.body.data.limitUp, 1);
    assert.equal(overview.body.data.limitDown, 1);
    assert.equal(overview.body.meta.amountUnit, 'base_currency');
    assert.equal(overview.body.meta.asOfBasis, 'fetch_time');
    assert.match(overview.body.meta.coverage.priceLimitRules, /北交所30%/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    cache.clear();
    global.fetch = realFetch;
  }
});
