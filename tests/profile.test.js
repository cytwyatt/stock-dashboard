'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSinaProvider,
  parseSinaProfileCN,
  parseSinaProfileHK,
} = require('../src/providers/sina');
const {
  createNasdaqProvider,
  parseNasdaqProfile,
} = require('../src/providers/nasdaq');

const META = Symbol('profileMeta');
function annotateMarketData(data, meta) {
  Object.defineProperty(data, META, { value: meta, configurable: true });
  return data;
}

test('新浪 A 股资料解析主营业务与申万行业，并忽略概念板块', () => {
  const companyHtml = `
    <table><tr><td class="ct">主营业务：</td>
      <td colspan="3" class="ccl">白酒系列产品的生产与销售，&amp; 品牌运营。</td>
    </tr></table>`;
  const industryHtml = `
    <table class="comInfo1">
      <tr><td colspan="2">所属行业板块</td></tr>
      <tr><th>所属行业板块</th><th>同行业个股</th></tr>
      <tr><td>白酒</td><td><a href="/corp/view/vCI_CorpInfoLink.php?Type=340301">点击查看</a></td></tr>
      <tr><td colspan="2">备注：此为申万行业分类</td></tr>
    </table>
    <table><tr><td>融资融券</td><td>概念板块</td></tr></table>`;

  assert.deepEqual(parseSinaProfileCN(companyHtml, industryHtml, 'sh600519'), {
    code: 'sh600519',
    market: 'cn',
    available: true,
    sector: null,
    industry: '白酒',
    businessSummary: '白酒系列产品的生产与销售，& 品牌运营。',
    classificationBasis: '新浪财经申万行业分类',
  });
});

test('新浪港股资料解析公司业务，空行业保持 null', () => {
  const html = `
    <table>
      <tr><td class="bgGrey"><span>公司业务</span></td><td>提供云服务<br>以及网络广告。</td></tr>
      <tr><td class="bgGrey">所属行业</td><td></td></tr>
    </table>`;
  assert.deepEqual(parseSinaProfileHK(html, 'hk00700'), {
    code: 'hk00700',
    market: 'hk',
    available: true,
    sector: null,
    industry: null,
    businessSummary: '提供云服务 以及网络广告。',
    classificationBasis: '新浪财经港股公司资料',
  });
});

test('新浪 A 股资料两页并行请求并使用 GBK，港股使用五位代码', async () => {
  const requests = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const provider = createSinaProvider({
    fetchText: async (url, options) => {
      requests.push({ url, options });
      if (url.includes('vCI_CorpInfo/')) {
        await gate;
        return '<tr><td>主营业务：</td><td>生产产品</td></tr>';
      }
      if (url.includes('vCI_CorpOtherInfo/')) {
        release();
        return '<table><tr><th>所属行业板块</th><th>同行业个股</th></tr><tr><td>制造业</td><td><a href="vCI_CorpInfoLink.php">点击查看</a></td></tr><tr><td>备注：此为申万行业分类</td></tr></table>';
      }
      return '<tr><td>公司业务</td><td>软件服务</td></tr><tr><td>所属行业</td><td>软件</td></tr>';
    },
    annotateMarketData,
    isCNCode: (code) => /^(sh|sz|bj)\d{6}$/.test(code),
  });

  const cn = await provider.getProfileCN('sh600519');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.options.encoding === 'gbk'));
  assert.equal(cn.industry, '制造业');
  assert.equal(cn[META].currency, null);
  assert.deepEqual(cn[META].coverage, {
    complete: true,
    reason: null,
    businessSummary: true,
    industry: true,
  });

  const hk = await provider.getProfileHK('hk00700');
  assert.match(requests.at(-1).url, /\/hkstock\/info\/00700\.html$/);
  assert.equal(requests.at(-1).options.encoding, 'gbk');
  assert.equal(hk.industry, '软件');
  await assert.rejects(provider.getProfileHK('hkHSI'), /五位港股代码/);
});

test('新浪 A 股两页之一失败时保留另一页，两页都失败才报错', async () => {
  const partial = createSinaProvider({
    fetchText: async (url) => {
      if (url.includes('vCI_CorpInfo/')) throw new Error('company down');
      return '<table><tr><th>所属行业板块</th><th>同行业个股</th></tr><tr><td>半导体</td><td><a href="vCI_CorpInfoLink.php">点击查看</a></td></tr><tr><td>备注：此为申万行业分类</td></tr></table>';
    },
    annotateMarketData,
    isCNCode: (code) => /^(sh|sz|bj)\d{6}$/.test(code),
  });
  const degraded = await partial.getProfileCN('sh688001');
  assert.equal(degraded.available, true);
  assert.equal(degraded.industry, '半导体');
  assert.equal(degraded.businessSummary, '');
  assert.deepEqual(degraded[META].coverage, {
    complete: false,
    reason: 'business_summary_unavailable',
    businessSummary: false,
    industry: true,
  });

  const failed = createSinaProvider({
    fetchText: async () => { throw new Error('upstream down'); },
    annotateMarketData,
    isCNCode: (code) => /^(sh|sz|bj)\d{6}$/.test(code),
  });
  await assert.rejects(failed.getProfileCN('sh688001'), /公司资料获取失败.*upstream down/);
});

test('新浪资料目标结构漂移时抛错，结构存在但值为空时允许 unavailable', () => {
  assert.throws(
    () => parseSinaProfileCN('<html></html>', '<html></html>', 'sh600000'),
    /结构异常/
  );
  assert.throws(
    () => parseSinaProfileHK('<table><tr><td>公司业务</td><td>业务</td></tr></table>', 'hk00001'),
    /缺少所属行业字段/
  );
  const emptyCN = parseSinaProfileCN(
    '<table><tr><td>主营业务：</td><td></td></tr></table>',
    '<table><tr><th>所属行业板块</th><th>同行业个股</th></tr><tr><td>备注：此为申万行业分类</td></tr></table>',
    'sh600000'
  );
  assert.equal(emptyCN.available, false);
  const emptyHK = parseSinaProfileHK(
    '<table><tr><td>公司业务</td><td></td></tr><tr><td>所属行业</td><td></td></tr></table>',
    'hk00001'
  );
  assert.equal(emptyHK.available, false);
});

test('Nasdaq profile JSON 统一映射板块、行业和业务简介', async () => {
  const payload = {
    data: {
      Sector: { label: 'Sector', value: 'Technology' },
      Industry: { label: 'Industry', value: 'Computer Manufacturing' },
      CompanyDescription: { label: 'Company Description', value: 'Makes devices &amp; services.\nWorldwide.' },
    },
  };
  assert.deepEqual(parseNasdaqProfile(payload, 'AAPL'), {
    code: 'AAPL',
    market: 'us',
    available: true,
    sector: 'Technology',
    industry: 'Computer Manufacturing',
    businessSummary: 'Makes devices & services. Worldwide.',
    classificationBasis: 'Nasdaq Sector / Industry',
  });

  const calls = [];
  const provider = createNasdaqProvider({
    fetchText: async (url, options) => {
      calls.push({ url, options });
      return JSON.stringify(payload);
    },
    annotateMarketData,
  });
  const result = await provider.getProfile('aapl');
  assert.match(calls[0].url, /\/company\/AAPL\/company-profile$/);
  assert.match(calls[0].options.referer, /\/stocks\/aapl$/);
  assert.equal(result.code, 'AAPL');
  assert.equal(result[META].source, 'Nasdaq 公司资料');
  assert.equal(result[META].currency, null);
});

test('Nasdaq 正常 data=null 返回 unavailable，上游错误与畸形响应抛错', () => {
  for (const profile of [
    parseNasdaqProfile({ data: null }, 'UNKNOWN'),
    parseNasdaqProfile({ data: {} }, 'UNKNOWN'),
  ]) {
    assert.equal(profile.available, false);
    assert.equal(profile.sector, null);
    assert.equal(profile.industry, null);
    assert.equal(profile.businessSummary, '');
  }
  assert.throws(
    () => parseNasdaqProfile({ data: null, status: { rCode: 500 } }, 'AAPL'),
    /上游错误：500/
  );
  assert.throws(() => parseNasdaqProfile({}, 'AAPL'), /缺少 data/);
  assert.throws(() => parseNasdaqProfile({ data: 'bad' }, 'AAPL'), /data 非对象/);
  assert.throws(
    () => parseNasdaqProfile({ data: null, message: 'symbol not found' }, 'AAPL'),
    /上游错误：symbol not found/
  );
  assert.throws(
    () => parseNasdaqProfile({ data: null, error: { message: 'blocked' } }, 'AAPL'),
    /上游错误：blocked/
  );
  assert.throws(
    () => parseNasdaqProfile({ data: null, error: { code: 'blocked' } }, 'AAPL'),
    /上游错误/
  );
  assert.equal(parseNasdaqProfile({
    data: null,
    message: 'no company profile',
    status: { rCode: 200 },
  }, 'ETF').available, false);
});

test('Nasdaq 非 JSON 响应不降级为 unavailable', async () => {
  const provider = createNasdaqProvider({
    fetchText: async () => '<html>blocked</html>',
    annotateMarketData,
  });
  await assert.rejects(provider.getProfile('AAPL'), SyntaxError);
});

test('业务描述统一限制为 1200 字符', () => {
  const long = 'A'.repeat(1400);
  const profile = parseNasdaqProfile({
    data: { CompanyDescription: { value: long } },
  }, 'LONG');
  assert.equal(profile.businessSummary.length, 1200);
});
