/**
 * 股票行情看板 - 本地服务
 * 无第三方依赖，Node 18+ 即可运行：node server.js
 * 数据来源：A股用腾讯行情/新浪财经；美股用 Yahoo Finance；新闻用新浪财经
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3888;
const PUBLIC_DIR = path.join(__dirname, 'public');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- 简单内存缓存（刷新失败时返回过期数据兜底；同 key 并发请求合并） ----------
const cache = new Map();
const inflight = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expire > Date.now()) return hit.data;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const data = await fn();
      cache.set(key, { expire: Date.now() + ttlMs, data });
      return data;
    } catch (err) {
      if (hit) {
        console.error(`[stale] ${key}: ${err.message}，返回上次缓存`);
        return hit.data;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

async function fetchText(url, { referer, encoding = 'utf-8', ua } = {}, attempt = 0) {
  const res = await fetch(url, {
    headers: { 'User-Agent': ua || UA, ...(referer ? { Referer: referer } : {}) },
    signal: AbortSignal.timeout(10000),
  });
  if (res.status === 429 && attempt < 2) {
    // Yahoo 等接口限流时退避重试
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return fetchText(url, { referer, encoding, ua }, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  return new TextDecoder(encoding).decode(buf);
}

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Yahoo 代码可含 ^ . = -（如 ^DJI、BTC-USD、GC=F、BRK.B）
const sanitizeCode = (s) => String(s).replace(/[^a-zA-Z0-9.^=-]/g, '').slice(0, 20);

// "20260707161445" -> "07-07 16:14"
const fmtCNTime = (s) =>
  s && s.length >= 12 ? `${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}` : s;

// ---------- Yahoo Finance（美股） ----------
const US_INDICES = [
  { code: '^DJI', name: '道琼斯' },
  { code: '^IXIC', name: '纳斯达克' },
  { code: '^GSPC', name: '标普500' },
];
// sh/sz/bj 前缀为A股（走腾讯），其余（^DJI、AAPL 等）走 Yahoo
const isCNCode = (code) => /^(sh|sz|bj)\d{6}$/.test(code);

// Yahoo 限流敏感（按 UA+IP 分桶）：单独用简短 UA，所有请求串行排队，至少间隔 1 秒
const YAHOO_UA = 'Mozilla/5.0';
let yahooChain = Promise.resolve();
let yahooLast = 0;
function yahooFetch(url) {
  const run = async () => {
    const wait = Math.max(0, yahooLast + 1000 - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fetchText(url, { ua: YAHOO_UA });
    } finally {
      yahooLast = Date.now();
    }
  };
  const p = yahooChain.then(run, run);
  yahooChain = p.catch(() => {});
  return p;
}

async function yahooChart(symbol, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const j = JSON.parse(await yahooFetch(url));
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error(`yahoo: no data for ${symbol}`);
  return r;
}

function fmtTimeInTZ(epochSec, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochSec * 1000));
}

// spark 接口一次请求返回一组报价，避免触发 Yahoo 限流
async function sparkQuotes(defs) {
  const symbols = defs.map((d) => d.code).join(',');
  const url = `https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(symbols)}&range=1d&interval=5m`;
  const j = JSON.parse(await yahooFetch(url));
  const results = (j.spark && j.spark.result) || [];
  return defs.map(({ code, name, unit }) => {
    const r = results.find((x) => x.symbol === code);
    const m = r && r.response && r.response[0] && r.response[0].meta;
    if (!m) return null;
    const prev = m.chartPreviousClose || m.previousClose || 0;
    const price = m.regularMarketPrice || 0;
    return {
      code,
      name: name || m.shortName || m.longName || code,
      unit: unit || '',
      price,
      prevClose: prev,
      open: 0,
      change: +(price - prev).toFixed(2),
      changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0,
      high: m.regularMarketDayHigh || 0,
      low: m.regularMarketDayLow || 0,
      amount: 0,
      time: m.regularMarketTime
        ? `美东 ${fmtTimeInTZ(m.regularMarketTime, m.exchangeTimezoneName)}`
        : '',
    };
  }).filter(Boolean);
}

const getIndicesUS = () => sparkQuotes(US_INDICES);

// 美股分时（Yahoo，5 分钟粒度）
async function getMinuteUS(code) {
  const r = await yahooChart(code, '1d', '5m');
  const q = r.indicators.quote[0] || {};
  const ts = r.timestamp || [];
  const tz = r.meta.exchangeTimezoneName;
  const points = [];
  for (let i = 0; i < ts.length; i++) {
    const price = q.close && q.close[i];
    if (price == null) continue;
    points.push({
      t: fmtTimeInTZ(ts[i], tz),
      price: +price.toFixed(2),
      vol: (q.volume && q.volume[i]) || 0,
    });
  }
  return {
    code,
    date: '',
    prevClose: r.meta.chartPreviousClose || r.meta.previousClose || 0,
    points,
  };
}

// 美股K线（Yahoo）
function yahooRange(days) {
  if (days <= 22) return '1mo';
  if (days <= 66) return '3mo';
  if (days <= 132) return '6mo';
  return '1y';
}

async function getKlineUS(code, days, period = 'day') {
  const interval = { day: '1d', week: '1wk', month: '1mo' }[period];
  const range =
    period === 'week' ? '2y' : period === 'month' ? '10y' : yahooRange(days);
  const r = await yahooChart(code, range, interval);
  const q = r.indicators.quote[0] || {};
  const ts = r.timestamp || [];
  const tz = r.meta.exchangeTimezoneName;
  const dfmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const out = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close == null || q.close[i] == null) continue;
    out.push({
      date: dfmt.format(new Date(ts[i] * 1000)),
      open: +q.open[i].toFixed(2),
      close: +q.close[i].toFixed(2),
      high: +q.high[i].toFixed(2),
      low: +q.low[i].toFixed(2),
      volume: q.volume[i] || 0,
    });
  }
  return out;
}

// ---------- 指数实时报价（A股：腾讯，GBK 编码） ----------
const CN_INDICES = ['sh000001', 'sz399001', 'sz399006', 'sh000300', 'sh000688'];

async function getIndices(market) {
  if (market === 'us') return getIndicesUS();
  const codes = CN_INDICES;
  const text = await fetchText(`https://qt.gtimg.cn/q=${codes.join(',')}`, {
    encoding: 'gbk',
  });
  const out = [];
  for (const code of codes) {
    const m = text.match(new RegExp(`v_${code}="([^"]*)"`));
    if (!m) continue;
    const f = m[1].split('~');
    if (f.length < 35) continue;
    out.push({
      code,
      name: f[1],
      price: num(f[3]),
      prevClose: num(f[4]),
      open: num(f[5]),
      change: num(f[31]),
      changePct: num(f[32]),
      high: num(f[33]),
      low: num(f[34]),
      amount: num(f[37]), // 成交额（万元）
      time: fmtCNTime(f[30]),
    });
  }
  return out;
}

// ---------- 分时数据（A股：腾讯 / 美股：Yahoo） ----------
async function getMinute(code) {
  if (!isCNCode(code)) return getMinuteUS(code);
  const j = JSON.parse(
    await fetchText(
      `https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=${code}`
    )
  );
  const node = j.data && j.data[code];
  if (!node || !node.data) throw new Error('no minute data');
  const qt = (node.qt && node.qt[code]) || [];
  const prevClose = num(qt[4]);
  const date = node.data.date || '';
  let prevCum = null; // 腾讯的成交量是累计值，差分得到每分钟量
  const points = (node.data.data || []).map((line) => {
    const [t, price, cum] = line.split(' ');
    const cumV = num(cum);
    const vol = prevCum == null ? cumV : Math.max(0, cumV - prevCum);
    prevCum = cumV;
    // 腾讯时间格式 "0930" -> "09:30"，与美股格式统一
    return { t: `${t.slice(0, 2)}:${t.slice(2)}`, price: num(price), vol };
  });
  return { code, date, prevClose, points };
}

// ---------- K线数据（A股：腾讯 / 美股：Yahoo，period: day/week/month） ----------
async function getKline(code, days = 90, period = 'day') {
  if (!isCNCode(code)) return getKlineUS(code, days, period);
  const api = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${code},${period},,,${days},qfq`;
  const j = JSON.parse(await fetchText(api));
  const node = j.data && j.data[code];
  if (!node) throw new Error('no kline data');
  const arr = node[`qfq${period}`] || node[period] || [];
  return arr.map((k) => ({
    date: k[0],
    open: num(k[1]),
    close: num(k[2]),
    high: num(k[3]),
    low: num(k[4]),
    volume: num(k[5]),
  }));
}

// ---------- 行业板块（腾讯） ----------
async function getSectors() {
  const j = JSON.parse(
    await fetchText(
      'https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=hy&sort_type=price&direct=down&offset=0&count=200'
    )
  );
  const list = ((j.data && j.data.rank_list) || []).map((s) => {
    // zgb = "上涨家数/总家数"
    const [up, total] = (s.zgb || '').split('/').map((x) => parseInt(x, 10) || 0);
    return {
      code: s.code,
      name: s.name,
      changePct: num(s.zdf),
      turnover: num(s.turnover), // 成交额（万元）
      inflow: num(s.zljlr), // 主力净流入（万元，可为负）
      up,
      total,
      leader: s.lzg
        ? { code: s.lzg.code, name: s.lzg.name, changePct: num(s.lzg.zdf) }
        : null,
    };
  });
  list.sort((a, b) => b.changePct - a.changePct);
  return list;
}

// ---------- 涨跌幅榜 ----------
async function getRankCN(dir, count = 20) {
  const asc = dir === 'down' ? 1 : 0;
  const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=${count + 20}&sort=changepercent&asc=${asc}&node=hs_a`;
  const j = JSON.parse(
    await fetchText(url, { referer: 'https://finance.sina.com.cn' })
  );
  return (j || [])
    .filter((s) => num(s.trade) > 0) // 去掉停牌
    .slice(0, count)
    .map((s) => ({
      code: s.symbol,
      name: s.name,
      price: num(s.trade),
      change: num(s.pricechange),
      changePct: num(s.changepercent),
      amount: num(s.amount),
      turnover: num(s.turnoverratio),
    }));
}

// 美股涨跌榜（Yahoo 预置筛选器，已按价格/成交量过滤掉仙股）
async function getRankUS(dir, count = 20) {
  const scrId = dir === 'down' ? 'day_losers' : 'day_gainers';
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count + 5}`;
  const j = JSON.parse(await yahooFetch(url));
  const quotes =
    (j.finance && j.finance.result && j.finance.result[0] && j.finance.result[0].quotes) || [];
  return quotes.slice(0, count).map((q) => ({
    code: q.symbol,
    name: q.shortName || q.longName || q.symbol,
    price: num(q.regularMarketPrice),
    change: num(q.regularMarketChange),
    changePct: num(q.regularMarketChangePercent),
    market: q.fullExchangeName || '',
  }));
}

// ---------- 个股详情报价 ----------
async function getQuote(code) {
  if (!isCNCode(code)) {
    const r = await yahooChart(code, '1d', '5m');
    const m = r.meta;
    const prev = m.chartPreviousClose || m.previousClose || 0;
    const price = m.regularMarketPrice || 0;
    return {
      code,
      market: 'us',
      name: m.longName || m.shortName || code,
      price,
      prevClose: prev,
      open: 0,
      change: +(price - prev).toFixed(2),
      changePct: prev ? +(((price - prev) / prev) * 100).toFixed(2) : 0,
      high: m.regularMarketDayHigh || 0,
      low: m.regularMarketDayLow || 0,
      volume: m.regularMarketVolume || 0,
      week52High: m.fiftyTwoWeekHigh || 0,
      week52Low: m.fiftyTwoWeekLow || 0,
      time: m.regularMarketTime
        ? `美东 ${fmtTimeInTZ(m.regularMarketTime, m.exchangeTimezoneName)}`
        : '',
    };
  }
  const text = await fetchText(`https://qt.gtimg.cn/q=${code}`, { encoding: 'gbk' });
  const m = text.match(new RegExp(`v_${code}="([^"]*)"`));
  if (!m) throw new Error('no quote for ' + code);
  const f = m[1].split('~');
  // 五档盘口：f[9..18] 买一~买五 价/量，f[19..28] 卖一~卖五 价/量（量单位：手）
  const level5 = (start) =>
    [0, 1, 2, 3, 4].map((i) => [num(f[start + i * 2]), num(f[start + i * 2 + 1])]);
  return {
    code,
    market: 'cn',
    bids: level5(9),
    asks: level5(19),
    name: f[1],
    price: num(f[3]),
    prevClose: num(f[4]),
    open: num(f[5]),
    change: num(f[31]),
    changePct: num(f[32]),
    high: num(f[33]),
    low: num(f[34]),
    volume: num(f[36]) * 100, // 手 -> 股
    amount: num(f[37]) * 1e4, // 万元 -> 元
    turnoverRate: num(f[38]),
    pe: num(f[39]),
    amplitude: num(f[43]),
    mktcap: num(f[45]) * 1e8, // 亿 -> 元
    pb: num(f[46]),
    time: fmtCNTime(f[30]),
  };
}

// 批量简要报价（自选股列表用）
async function getQuotes(codes) {
  const cn = codes.filter(isCNCode);
  const us = codes.filter((c) => !isCNCode(c));
  const out = new Map();
  const jobs = [];
  if (cn.length) {
    jobs.push(
      fetchText(`https://qt.gtimg.cn/q=${cn.join(',')}`, { encoding: 'gbk' }).then((text) => {
        for (const code of cn) {
          const m = text.match(new RegExp(`v_${code}="([^"]*)"`));
          if (!m) continue;
          const f = m[1].split('~');
          out.set(code, {
            code,
            market: 'cn',
            name: f[1],
            price: num(f[3]),
            change: num(f[31]),
            changePct: num(f[32]),
          });
        }
      })
    );
  }
  if (us.length) {
    jobs.push(
      sparkQuotes(us.map((c) => ({ code: c }))).then((quotes) => {
        for (const q of quotes) out.set(q.code, { ...q, market: 'us' });
      })
    );
  }
  await Promise.all(jobs);
  return codes.map((c) => out.get(c)).filter(Boolean);
}

// ---------- 个股搜索（腾讯 smartbox，支持代码/中文/拼音） ----------
async function searchStocks(q) {
  const text = await fetchText(
    `https://smartbox.gtimg.cn/s3/?v=2&q=${encodeURIComponent(q)}&t=all`,
    { encoding: 'gbk' }
  );
  const m = text.match(/v_hint="([^"]*)"/);
  if (!m || m[1] === 'N;') return [];
  const decode = (s) =>
    s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  return m[1]
    .split('^')
    .map((item) => {
      const [mkt, code, name, , type] = item.split('~');
      if (!/^GP/.test(type || '')) return null; // 只保留股票
      if (mkt === 'sh' || mkt === 'sz' || mkt === 'bj') {
        return { code: mkt + code, name: decode(name), market: 'cn' };
      }
      if (mkt === 'us') {
        // 美股代码带交易所后缀，如 aapl.oq -> AAPL
        return { code: code.split('.')[0].toUpperCase(), name: decode(name), market: 'us' };
      }
      return null; // 港股等暂不支持
    })
    .filter(Boolean)
    .slice(0, 10);
}

// ---------- 市场概况 ----------
// 数涨停/跌停：按涨跌幅排序翻页统计（主板 ±10%、创业/科创 ±20%，不含 ST）
async function countLimit(dir) {
  const asc = dir === 'down' ? 1 : 0;
  let count = 0;
  for (let page = 1; page <= 3; page++) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=changepercent&asc=${asc}&node=hs_a`;
    const j = JSON.parse(await fetchText(url, { referer: 'https://finance.sina.com.cn' }));
    if (!Array.isArray(j) || !j.length) break;
    let pageMin = Infinity;
    for (const s of j) {
      if (num(s.trade) <= 0) continue;
      const pct = Math.abs(num(s.changepercent));
      pageMin = Math.min(pageMin, pct);
      const is20cm = /^(sh68|sz30)/.test(s.symbol); // 科创板/创业板 20%
      if (pct >= (is20cm ? 19.8 : 9.8) && !/ST/i.test(s.name)) count++;
    }
    if (pageMin < 9.8) break; // 已排序，后面不会再有涨跌停
  }
  return count;
}

async function getOverviewCN() {
  const sectors = await cached('sectors', 30000, getSectors);
  let up = 0, total = 0, turnover = 0;
  for (const s of sectors) {
    up += s.up;
    total += s.total;
    turnover += s.turnover;
  }
  const [limitUp, limitDown] = await Promise.all([countLimit('up'), countLimit('down')]);
  return { up, down: total - up, total, turnover, limitUp, limitDown };
}

const US_MACRO = [
  { code: '^VIX', name: '恐慌指数 VIX' },
  { code: '^TNX', name: '美债10年期', unit: '%' },
  { code: 'DX-Y.NYB', name: '美元指数' },
  { code: 'GC=F', name: '黄金' },
  { code: 'CL=F', name: '原油 WTI' },
  { code: 'BTC-USD', name: '比特币' },
];

const getOverviewUS = () => sparkQuotes(US_MACRO);

// ---------- 自选股（服务器端持久化，tailnet 内所有设备共享） ----------
const DATA_DIR = path.join(__dirname, 'data');
const WATCH_FILE = path.join(DATA_DIR, 'watchlist.json');

function readWatchlist() {
  try {
    return JSON.parse(fs.readFileSync(WATCH_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeWatchlist(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = WATCH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, WATCH_FILE); // 原子替换，避免写一半损坏
}

// ---------- 新闻（新浪财经滚动） ----------
async function getNews(count = 30) {
  const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=${count}&page=1`;
  const j = JSON.parse(await fetchText(url));
  return ((j.result && j.result.data) || []).map((n) => ({
    title: n.title,
    url: n.url,
    time: parseInt(n.intime, 10) * 1000,
    media: n.media_name || '',
  }));
}

// ---------- LLM 问答（OpenAI 兼容协议：DeepSeek/Kimi/通义/GLM/OpenAI 均可用） ----------
const LLM_FILE = path.join(DATA_DIR, 'llm.json');

function getLLMConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(LLM_FILE, 'utf8')); } catch { /* 未配置 */ }
  return {
    baseUrl: (process.env.LLM_BASE_URL || cfg.baseUrl || 'https://api.deepseek.com/v1').replace(/\/$/, ''),
    apiKey: process.env.LLM_API_KEY || cfg.apiKey || '',
    model: process.env.LLM_MODEL || cfg.model || 'deepseek-chat',
  };
}

// 提供给 LLM 的工具集（复用现有数据函数，全部走缓存）
const LLM_TOOLS = [
  { name: 'get_indices', description: '获取大盘指数实时行情。market=cn 返回上证/深成/创业板/沪深300/科创50；market=us 返回道琼斯/纳斯达克/标普500', parameters: { type: 'object', properties: { market: { type: 'string', enum: ['cn', 'us'] } }, required: ['market'] } },
  { name: 'get_quote', description: '获取单只股票的详细实时报价（价格、涨跌幅、成交量额、换手率、市盈率、市值、五档盘口等）。A股代码格式如 sh600519/sz300750，美股代码如 AAPL/TSLA，也支持 ^VIX、GC=F 黄金、BTC-USD 等', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'get_kline', description: '获取股票或指数的K线历史（日K/周K/月K，最近最多40根，含开高低收和成交量）', parameters: { type: 'object', properties: { code: { type: 'string' }, period: { type: 'string', enum: ['day', 'week', 'month'] } }, required: ['code'] } },
  { name: 'get_intraday', description: '获取当日分时走势（抽样点位），可用于判断盘中走势形态', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'get_sectors', description: '获取A股31个申万行业板块的涨跌幅、主力资金净流入（亿元）和领涨股，可判断市场热点和资金流向', parameters: { type: 'object', properties: {} } },
  { name: 'get_rank', description: '获取涨幅榜或跌幅榜个股。market=cn 沪深两市，market=us 美股', parameters: { type: 'object', properties: { market: { type: 'string', enum: ['cn', 'us'] }, dir: { type: 'string', enum: ['up', 'down'] } }, required: ['market', 'dir'] } },
  { name: 'get_overview', description: '获取市场概况。market=cn 返回涨跌家数、涨停跌停数、两市成交额；market=us 返回VIX恐慌指数、美债收益率、美元指数、黄金、原油、比特币', parameters: { type: 'object', properties: { market: { type: 'string', enum: ['cn', 'us'] } }, required: ['market'] } },
  { name: 'get_news', description: '获取最新财经新闻标题列表（新浪财经滚动要闻）', parameters: { type: 'object', properties: {} } },
  { name: 'search_stock', description: '按名称/代码/拼音搜索股票，返回股票代码。回答个股问题前如果不确定代码，先用这个工具查', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
].map((t) => ({ type: 'function', function: t }));

async function runLLMTool(name, args) {
  switch (name) {
    case 'get_indices': {
      const m = args.market === 'us' ? 'us' : 'cn';
      return cached(`idx:${m}`, 15000, () => getIndices(m));
    }
    case 'get_quote': {
      const code = sanitizeCode(args.code || '');
      return cached(`q:${code}`, 15000, () => getQuote(code));
    }
    case 'get_kline': {
      const code = sanitizeCode(args.code || '');
      const period = ['day', 'week', 'month'].includes(args.period) ? args.period : 'day';
      const data = await cached(`k:${code}:120:${period}`, 300000, () => getKline(code, 120, period));
      return data.slice(-40);
    }
    case 'get_intraday': {
      const code = sanitizeCode(args.code || '');
      const d = await cached(`min:${code}`, isCNCode(code) ? 30000 : 60000, () => getMinute(code));
      // 抽样：每10个点取1个 + 最后一个点，控制token
      const pts = d.points.filter((_, i) => i % 10 === 0);
      if (d.points.length) pts.push(d.points[d.points.length - 1]);
      return { code: d.code, prevClose: d.prevClose, points: pts.map((p) => ({ t: p.t, price: p.price })) };
    }
    case 'get_sectors': {
      const list = await cached('sectors', 30000, getSectors);
      return list.map((s) => ({
        name: s.name,
        changePct: s.changePct,
        inflowYi: +(s.inflow / 1e4).toFixed(2),
        leader: s.leader ? `${s.leader.name} ${s.leader.changePct}%` : '',
      }));
    }
    case 'get_rank': {
      const m = args.market === 'us' ? 'us' : 'cn';
      const dir = args.dir === 'down' ? 'down' : 'up';
      const fn = m === 'us' ? getRankUS : getRankCN;
      return cached(`rank:${m}:${dir}`, m === 'us' ? 90000 : 30000, () => fn(dir));
    }
    case 'get_overview': {
      const m = args.market === 'us' ? 'us' : 'cn';
      const fn = m === 'us' ? getOverviewUS : getOverviewCN;
      return cached(`overview:${m}`, 60000, fn);
    }
    case 'get_news':
      return cached('news', 180000, () => getNews());
    case 'search_stock':
      return cached(`s:${args.query}`, 300000, () => searchStocks(String(args.query || '').slice(0, 20)));
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function maskKey(k) {
  if (!k) return '';
  return k.length > 8 ? `${k.slice(0, 4)}****${k.slice(-4)}` : '****';
}

function writeLLMConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = LLM_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, LLM_FILE);
}

// 测试当前配置能否连通（发一条极短消息，不带工具）
async function testLLMConfig() {
  const cfg = getLLMConfig();
  if (!cfg.apiKey) return { ok: false, message: '尚未填写 API Key' };
  try {
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: '只需回复两个字：OK' }],
        max_tokens: 16,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      return { ok: false, message: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    }
    const j = await res.json();
    const reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return { ok: true, message: `连接成功，${cfg.model} 回复：${reply.slice(0, 30) || '(空)'}` };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

function llmSystemPrompt() {
  const now = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short' }).format(new Date());
  return `你是一个股票行情分析助手，嵌在用户自建的行情看板网站里。当前北京时间：${now}。

规则：
1. 回答必须基于工具返回的实时数据，需要数据时先调用工具。绝不编造价格、涨跌幅等数字；数据里没有的信息就明说没有。
2. A股代码带 sh/sz 前缀（如 sh600519 贵州茅台、sh000001 上证指数、sz399006 创业板指）；美股用代码（AAPL）、指数用 ^DJI 道琼斯 / ^IXIC 纳斯达克 / ^GSPC 标普500。不确定个股代码时先用 search_stock 查。
3. 分析要言之有物：结合涨跌家数、板块资金流向、新闻等多维度，先给结论再给依据。
4. 用简体中文回答，Markdown 格式（可用加粗、列表，不要用表格）。保持简洁，别堆砌所有数字。
5. 数据可能有延迟，你的分析不构成投资建议——只需在明显给出操作倾向时简短提示一次，不必每条回答都加免责声明。`;
}

async function llmComplete(cfg, messages) {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, tools: LLM_TOOLS, tool_choice: 'auto', temperature: 0.3 }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`LLM 接口返回 ${res.status}: ${body}`);
  }
  const j = await res.json();
  if (!j.choices || !j.choices[0]) throw new Error('LLM 返回格式异常');
  return j.choices[0].message;
}

// ---------- 对话会话存储（服务器端，跨设备共享） ----------
const CHATS_FILE = path.join(DATA_DIR, 'chats.json');

function readChats() {
  try { return JSON.parse(fs.readFileSync(CHATS_FILE, 'utf8')); } catch { return { sessions: [] }; }
}
function writeChats(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CHATS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CHATS_FILE);
}

function sseSend(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

async function handleChat(req, res, body) {
  const { sessionId, message } = JSON.parse(body);
  const text = String(message || '').trim().slice(0, 2000);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  const cfg = getLLMConfig();
  try {
    if (!cfg.apiKey) {
      sseSend(res, { type: 'error', message: '尚未配置模型 API Key——点击左侧「⚙ 模型设置」，选择服务商并填入 Key 即可使用。' });
      return res.end();
    }
    if (!text) { sseSend(res, { type: 'error', message: '消息为空' }); return res.end(); }

    const store = readChats();
    let session = store.sessions.find((s) => s.id === sessionId);
    if (!session) {
      session = { id: sessionId || `c${Date.now()}`, title: '', createdAt: Date.now(), messages: [] };
      store.sessions.unshift(session);
    }
    if (!session.title) session.title = text.slice(0, 24);
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = Date.now();
    writeChats(store);

    // 上下文：系统提示 + 最近12条历史（含刚追加的这条用户消息）
    const convo = [
      { role: 'system', content: llmSystemPrompt() },
      ...session.messages.slice(-12).map((m) => ({ role: m.role, content: m.content })),
    ];

    let answer = '';
    for (let round = 0; round < 6; round++) {
      const msg = await llmComplete(cfg, convo);
      if (msg.tool_calls && msg.tool_calls.length) {
        convo.push(msg);
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* 参数解析失败按空处理 */ }
          sseSend(res, { type: 'tool', name: tc.function.name, args });
          let result;
          try {
            result = await runLLMTool(tc.function.name, args);
          } catch (e) {
            result = { error: e.message };
          }
          convo.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify(result).slice(0, 12000),
          });
        }
        continue;
      }
      answer = msg.content || '';
      break;
    }
    if (!answer) answer = '（分析轮次超限，请换个更具体的问题）';

    session.messages.push({ role: 'assistant', content: answer });
    session.updatedAt = Date.now();
    const store2 = readChats();
    const idx = store2.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) store2.sessions[idx] = session; else store2.sessions.unshift(session);
    writeChats(store2);

    sseSend(res, { type: 'answer', content: answer, sessionId: session.id, title: session.title });
  } catch (e) {
    console.error('[chat]', e.message);
    sseSend(res, { type: 'error', message: e.message });
  }
  res.end();
}

// ---------- HTTP 服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req, limit = 1e5) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) { req.destroy(); reject(new Error('body too large')); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  if (res.gzipOK && body.length > 1024) {
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    res.writeHead(status, headers);
    return res.end(zlib.gzipSync(body));
  }
  res.writeHead(status, headers);
  res.end(body);
}

// 静态文件：内存缓存 + gzip 预压缩 + 协商缓存（vendor 目录长缓存）
const staticCache = new Map();
function serveStatic(req, res, full) {
  const stat = fs.statSync(full);
  let entry = staticCache.get(full);
  if (!entry || entry.mtime !== stat.mtimeMs) {
    const raw = fs.readFileSync(full);
    entry = { mtime: stat.mtimeMs, raw, gz: zlib.gzipSync(raw) };
    staticCache.set(full, entry);
  }
  const etag = `"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  const headers = {
    'Content-Type': MIME[path.extname(full)] || 'application/octet-stream',
    // vendor 内是带版本的第三方库，长缓存；业务文件每次协商（304 免下载）
    'Cache-Control': full.includes(`${path.sep}vendor${path.sep}`)
      ? 'public, max-age=604800, immutable'
      : 'no-cache',
    ETag: etag,
    Vary: 'Accept-Encoding',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  if (res.gzipOK) {
    headers['Content-Encoding'] = 'gzip';
    res.writeHead(200, headers);
    return res.end(entry.gz);
  }
  res.writeHead(200, headers);
  res.end(entry.raw);
}

// ---------- 访问口令（可选）：设了环境变量 MARKET_PASSWORD 才启用 ----------
// 用途：把服务通过 Tailscale Funnel 暴露到公网时挡住陌生人。
// 不设该变量则完全不生效，Tailscale 私网内直连行为不变。
const AUTH_PASSWORD = process.env.MARKET_PASSWORD || '';
const AUTH_TOKEN = AUTH_PASSWORD
  ? crypto.createHash('sha256').update('market-auth:' + AUTH_PASSWORD).digest('hex')
  : '';
const AUTH_MAXAGE = 60 * 60 * 24 * 30; // cookie 有效期 30 天

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function isAuthed(req) {
  if (!AUTH_TOKEN) return true;
  return parseCookies(req).market_auth === AUTH_TOKEN;
}
function safeEq(a, b) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function loginPage(err) {
  // 自包含登录页，不依赖任何静态资源；输入框字号 16px 防 iOS 缩放
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>行情看板 · 登录</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0e1117;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  form{width:min(88vw,320px);padding:28px 24px;background:#171b22;border:1px solid #262c36;
    border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{margin:0 0 4px;font-size:20px}
  p{margin:0 0 18px;font-size:13px;color:#8b949e}
  input{width:100%;padding:11px 12px;font-size:16px;border-radius:8px;border:1px solid #30363d;
    background:#0d1117;color:#e6e6e6;outline:none}
  input:focus{border-color:#e5484d}
  button{width:100%;margin-top:14px;padding:11px;font-size:15px;font-weight:600;border:0;
    border-radius:8px;background:#e5484d;color:#fff;cursor:pointer}
  .err{color:#e5484d;font-size:13px;margin-top:10px;min-height:16px}
</style></head><body>
<form method="POST" action="/__login">
  <h1>📈 行情看板</h1>
  <p>请输入访问口令</p>
  <input type="password" name="password" placeholder="口令" autofocus autocomplete="current-password">
  <div class="err">${err ? err : ''}</div>
  <button type="submit">进入</button>
</form></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  res.gzipOK = /\bgzip\b/.test(req.headers['accept-encoding'] || '');

  // 口令门：仅在设置了 MARKET_PASSWORD 时启用
  if (AUTH_TOKEN) {
    if (p === '/__login' && req.method === 'POST') {
      const pw = new URLSearchParams(await readBody(req)).get('password') || '';
      const token = crypto.createHash('sha256').update('market-auth:' + pw).digest('hex');
      if (safeEq(token, AUTH_TOKEN)) {
        // 不加 Secure：Tailscale 私网走 http 也要能登录；公网 funnel 本身是 https
        res.writeHead(302, {
          'Set-Cookie': `market_auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${AUTH_MAXAGE}`,
          Location: '/',
        });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(loginPage('口令错误'));
    }
    if (!isAuthed(req)) {
      if (p.startsWith('/api/')) return sendJSON(res, 401, { error: '未授权' });
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(loginPage(''));
    }
  }

  try {
    if (p === '/api/indices') {
      const market = u.searchParams.get('market') === 'us' ? 'us' : 'cn';
      return sendJSON(res, 200, await cached(`idx:${market}`, 15000, () => getIndices(market)));
    }
    if (p === '/api/minute') {
      const code = sanitizeCode(u.searchParams.get('code') || 'sh000001');
      const ttl = isCNCode(code) ? 30000 : 60000;
      return sendJSON(res, 200, await cached(`min:${code}`, ttl, () => getMinute(code)));
    }
    if (p === '/api/kline') {
      const code = sanitizeCode(u.searchParams.get('code') || 'sh000001');
      const days = Math.min(365, parseInt(u.searchParams.get('days') || '90', 10) || 90);
      const q = u.searchParams.get('period');
      const period = ['day', 'week', 'month'].includes(q) ? q : 'day';
      return sendJSON(res, 200, await cached(`k:${code}:${days}:${period}`, 300000, () => getKline(code, days, period)));
    }
    if (p === '/api/sectors') {
      return sendJSON(res, 200, await cached('sectors', 30000, getSectors));
    }
    if (p === '/api/rank') {
      const market = u.searchParams.get('market') === 'us' ? 'us' : 'cn';
      const dir = u.searchParams.get('dir') === 'down' ? 'down' : 'up';
      const fn = market === 'us' ? getRankUS : getRankCN;
      const ttl = market === 'us' ? 90000 : 30000;
      return sendJSON(res, 200, await cached(`rank:${market}:${dir}`, ttl, () => fn(dir)));
    }
    // LLM 配置（Key 只存服务器，GET 仅返回掩码）
    if (p === '/api/llm-config') {
      if (req.method === 'GET') {
        const cfg = getLLMConfig();
        return sendJSON(res, 200, {
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          configured: !!cfg.apiKey,
          keyMask: maskKey(cfg.apiKey),
        });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        const cur = getLLMConfig();
        const baseUrl = String(body.baseUrl || '').trim().replace(/\/+$/, '').slice(0, 200);
        const model = String(body.model || '').trim().slice(0, 100);
        const apiKey = String(body.apiKey || '').trim().slice(0, 300) || cur.apiKey; // 留空则保留原 Key
        if (!/^https?:\/\/.+/.test(baseUrl)) return sendJSON(res, 400, { error: '接口地址格式不正确' });
        if (!model) return sendJSON(res, 400, { error: '模型名称不能为空' });
        writeLLMConfig({ baseUrl, apiKey, model });
        return sendJSON(res, 200, { ok: true, configured: !!apiKey, keyMask: maskKey(apiKey) });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }
    if (p === '/api/llm-config/test' && req.method === 'POST') {
      return sendJSON(res, 200, await testLLMConfig());
    }
    // LLM 对话
    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      return handleChat(req, res, body);
    }
    if (p === '/api/chat/sessions') {
      if (req.method === 'GET') {
        const store = readChats();
        return sendJSON(res, 200, store.sessions.map((s) => ({
          id: s.id,
          title: s.title || '',
          updatedAt: s.updatedAt || s.createdAt,
          count: s.messages.length,
        })));
      }
      if (req.method === 'POST') {
        const store = readChats();
        const session = { id: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`, title: '', createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
        store.sessions.unshift(session);
        writeChats(store);
        return sendJSON(res, 200, { id: session.id });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }
    const mSess = p.match(/^\/api\/chat\/sessions\/([\w-]+)$/);
    if (mSess) {
      const store = readChats();
      const session = store.sessions.find((s) => s.id === mSess[1]);
      if (req.method === 'GET') {
        if (!session) return sendJSON(res, 404, { error: 'session not found' });
        return sendJSON(res, 200, { id: session.id, title: session.title, messages: session.messages });
      }
      if (req.method === 'DELETE') {
        store.sessions = store.sessions.filter((s) => s.id !== mSess[1]);
        writeChats(store);
        return sendJSON(res, 200, { ok: true });
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }
    if (p === '/api/watchlist') {
      if (req.method === 'GET') return sendJSON(res, 200, readWatchlist());
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 1e5) req.destroy();
        });
        req.on('end', () => {
          try {
            const arr = JSON.parse(body);
            if (!Array.isArray(arr)) throw new Error('expect array');
            const list = arr
              .slice(0, 200)
              .map((s) => ({
                code: sanitizeCode(s.code),
                name: String(s.name || '').slice(0, 40),
                market: s.market === 'us' ? 'us' : 'cn',
              }))
              .filter((s) => s.code);
            writeWatchlist(list);
            sendJSON(res, 200, { ok: true, count: list.length });
          } catch (e) {
            sendJSON(res, 400, { error: e.message });
          }
        });
        return;
      }
      return sendJSON(res, 405, { error: 'method not allowed' });
    }
    if (p === '/api/quote') {
      const code = sanitizeCode(u.searchParams.get('code') || '');
      if (!code) return sendJSON(res, 400, { error: 'code required' });
      return sendJSON(res, 200, await cached(`q:${code}`, 15000, () => getQuote(code)));
    }
    if (p === '/api/quotes') {
      const codes = (u.searchParams.get('codes') || '')
        .split(',')
        .map(sanitizeCode)
        .filter(Boolean)
        .slice(0, 50);
      if (!codes.length) return sendJSON(res, 200, []);
      const key = `qs:${codes.join(',')}`;
      return sendJSON(res, 200, await cached(key, 30000, () => getQuotes(codes)));
    }
    if (p === '/api/search') {
      const q = (u.searchParams.get('q') || '').trim().slice(0, 20);
      if (!q) return sendJSON(res, 200, []);
      return sendJSON(res, 200, await cached(`s:${q}`, 300000, () => searchStocks(q)));
    }
    if (p === '/api/overview') {
      const market = u.searchParams.get('market') === 'us' ? 'us' : 'cn';
      const fn = market === 'us' ? getOverviewUS : getOverviewCN;
      return sendJSON(res, 200, await cached(`overview:${market}`, 60000, fn));
    }
    if (p === '/api/news') {
      return sendJSON(res, 200, await cached('news', 180000, () => getNews()));
    }

    // 静态文件
    let file = p === '/' ? '/index.html' : p;
    file = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    serveStatic(req, res, full);
  } catch (err) {
    console.error(`[ERR] ${p}:`, err.message);
    sendJSON(res, 502, { error: err.message });
  }
});

// ---------- 盘中缓存预热：后台定时刷新热点数据，用户请求永远命中热缓存 ----------
function isMarketOpenSrv(market) {
  const tz = market === 'us' ? 'America/New_York' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((x) => x.type === t).value;
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  return market === 'us' ? mins >= 565 && mins <= 965 : mins >= 555 && mins <= 905;
}

// key/ttl 与路由保持一致，预热的数据能被请求直接命中
const warm = (key, ttl, fn) =>
  cached(key, ttl, fn).catch((e) => console.error(`[warm] ${key}: ${e.message}`));

function warmCaches() {
  if (isMarketOpenSrv('cn')) {
    warm('idx:cn', 15000, () => getIndices('cn'));
    warm('min:sh000001', 30000, () => getMinute('sh000001'));
    warm('sectors', 30000, getSectors);
    warm('rank:cn:up', 30000, () => getRankCN('up'));
    warm('rank:cn:down', 30000, () => getRankCN('down'));
    warm('overview:cn', 60000, getOverviewCN);
    warm('news', 180000, () => getNews());
  }
  if (isMarketOpenSrv('us')) {
    warm('idx:us', 15000, () => getIndices('us'));
    warm('min:^DJI', 60000, () => getMinute('^DJI'));
    warm('rank:us:up', 90000, () => getRankUS('up'));
    warm('rank:us:down', 90000, () => getRankUS('down'));
    warm('overview:us', 60000, getOverviewUS);
    warm('news', 180000, () => getNews());
  }
}
setInterval(warmCaches, 25000);

server.listen(PORT, () => {
  console.log(`行情看板已启动: http://localhost:${PORT}`);
  warmCaches();
});
