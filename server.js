/**
 * 股票行情看板 - 本地服务
 * 无第三方依赖，Node 18+ 即可运行：node server.js
 * 数据来源：A股用腾讯行情/新浪财经；美股用 Yahoo Finance；新闻用新浪财经
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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

// ---------- HTTP 服务 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const p = u.pathname;
  res.gzipOK = /\bgzip\b/.test(req.headers['accept-encoding'] || '');

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
