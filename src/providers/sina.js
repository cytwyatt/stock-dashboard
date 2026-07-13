'use strict';

const defaultNum = (value) => {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const isAbnormalCNName = (name) => /^(?:N|C)|ST|退/i.test(String(name || ''));

function cnPriceLimitPct(symbol) {
  if (/^bj/.test(symbol || '')) return 30;
  if (/^(sh68|sz30)/.test(symbol || '')) return 20;
  return 10;
}

function isCNPriceLimit(row, dir, num = defaultNum) {
  if (!row || num(row.trade) <= 0 || isAbnormalCNName(row.name)) return false;
  const pct = num(row.changepercent);
  if ((dir === 'up' && pct <= 0) || (dir === 'down' && pct >= 0)) return false;
  return Math.abs(pct) >= cnPriceLimitPct(row.symbol) - 0.2;
}

function parseSinaRankCN(payload, count, { annotateMarketData, num = defaultNum } = {}) {
  const out = (payload || [])
    .filter((stock) =>
      num(stock.trade) >= 1 && num(stock.amount) >= 2e7 && !isAbnormalCNName(stock.name)
    )
    .slice(0, count)
    .map((stock) => ({
      code: stock.symbol,
      name: stock.name,
      currency: 'CNY',
      price: num(stock.trade),
      change: num(stock.pricechange),
      changePct: num(stock.changepercent),
      amount: num(stock.amount),
      turnover: num(stock.turnoverratio),
    }));
  return annotateMarketData(out, {
    market: 'cn',
    source: '新浪财经',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
  });
}

function parseSinaRankHK(pages, count, { annotateMarketData, num = defaultNum } = {}) {
  const out = [];
  for (const payload of pages) {
    if (!Array.isArray(payload)) continue;
    for (const stock of payload) {
      const price = num(stock.lasttrade);
      if (price < 1 || num(stock.amount) < 2e7) continue;
      out.push({
        code: 'hk' + stock.symbol,
        name: stock.name,
        currency: 'HKD',
        price,
        change: num(stock.pricechange),
        changePct: num(stock.changepercent),
        amount: num(stock.amount),
      });
      if (out.length >= count) {
        return annotateMarketData(out, {
          market: 'hk',
          source: '新浪财经',
          currency: 'HKD',
          timezone: 'Asia/Hong_Kong',
          adjustmentBasis: 'none',
          amountUnit: 'base_currency',
        });
      }
    }
  }
  return annotateMarketData(out, {
    market: 'hk',
    source: '新浪财经',
    currency: 'HKD',
    timezone: 'Asia/Hong_Kong',
    adjustmentBasis: 'none',
    amountUnit: 'base_currency',
  });
}

function decodeHtmlText(value) {
  const entities = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  };
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
      const key = entity.toLowerCase();
      if (key[0] !== '#') return entities[key] ?? all;
      const hex = key.startsWith('#x');
      const point = parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
      try {
        return Number.isFinite(point) ? String.fromCodePoint(point) : all;
      } catch {
        return all;
      }
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNewsTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function normalizeSinaNewsUrl(href, pageUrl) {
  try {
    const url = new URL(String(href || '').trim(), pageUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const host = url.hostname.toLowerCase();
    if (!/(^|\.)sina\.com\.cn$/.test(host) && !/(^|\.)sina\.cn$/.test(host)) return '';
    url.hash = '';
    return url.toString().slice(0, 800);
  } catch {
    return '';
  }
}

function parseSinaStockNewsPage(html, pageUrl) {
  const marker = /<(?:div|ul)\b[^>]*class=["'][^"']*\bdatelist\b[^"']*["'][^>]*>/i.exec(html);
  if (!marker) throw new Error('新浪个股资讯页面结构异常：缺少 datelist');
  const start = marker.index + marker[0].length;
  const ends = [html.indexOf('</ul>', start), html.indexOf('</div>', start)]
    .filter((index) => index >= 0);
  const scope = html.slice(start, ends.length ? Math.min(...ends) : start + 200000);
  const linkCount = (scope.match(/<a\b/gi) || []).length;
  const itemPattern = /(\d{4}-\d{2}-\d{2})(?:\s|&nbsp;)*(\d{2}:\d{2})(?:\s|&nbsp;)*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  const seenUrls = new Set();
  const seenTitles = new Set();
  const items = [];
  let match;
  while ((match = itemPattern.exec(scope))) {
    const hrefMatch = /\bhref\s*=\s*(["'])(.*?)\1/i.exec(match[3]);
    const url = normalizeSinaNewsUrl(hrefMatch && hrefMatch[2], pageUrl);
    const title = decodeHtmlText(match[4]).slice(0, 240);
    const time = Date.parse(`${match[1]}T${match[2]}:00+08:00`);
    if (!url || !title || !Number.isFinite(time)) continue;
    const titleKey = `${time}:${normalizeNewsTitle(title)}`;
    if (seenUrls.has(url) || seenTitles.has(titleKey)) continue;
    seenUrls.add(url);
    seenTitles.add(titleKey);
    items.push({
      title,
      url,
      time,
      publishedAt: `${match[1]} ${match[2]}`,
      source: '新浪财经个股资讯',
    });
  }
  if (linkCount && !items.length) throw new Error('新浪个股资讯页面结构异常：资讯解析失败');
  return items.sort((left, right) => right.time - left.time);
}

function parseSinaRollNews(payload) {
  return ((payload.result && payload.result.data) || []).map((news) => ({
    title: news.title,
    url: news.url,
    time: parseInt(news.intime, 10) * 1000,
    media: news.media_name || '',
  }));
}

function createSinaProvider({
  fetchText,
  annotateMarketData,
  isCNCode,
  num = defaultNum,
} = {}) {
  if (typeof fetchText !== 'function') throw new TypeError('fetchText must be a function');
  if (typeof annotateMarketData !== 'function') {
    throw new TypeError('annotateMarketData must be a function');
  }
  if (typeof isCNCode !== 'function') throw new TypeError('isCNCode must be a function');

  const parseDeps = { annotateMarketData, num };

  async function getRankCN(dir, count = 20) {
    const ascending = dir === 'down' ? 1 : 0;
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=1&num=100&sort=changepercent&asc=${ascending}&node=hs_a`;
    const payload = JSON.parse(await fetchText(url, { referer: 'https://finance.sina.com.cn' }));
    return parseSinaRankCN(payload, count, parseDeps);
  }

  async function getRankHK(dir, count = 20) {
    const ascending = dir === 'down' ? 1 : 0;
    const pages = await Promise.all([1, 2, 3].map(async (page) => {
      const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHKStockData?page=${page}&num=60&sort=changepercent&asc=${ascending}&node=qbgg_hk`;
      return JSON.parse(await fetchText(url, {
        referer: 'https://vip.stock.finance.sina.com.cn/mkt/',
      }));
    }));
    return parseSinaRankHK(pages, count, parseDeps);
  }

  async function countLimit(dir) {
    const ascending = dir === 'down' ? 1 : 0;
    let count = 0;
    const seen = new Set();
    const maxPages = 10;
    for (let firstPage = 1; firstPage <= maxPages; firstPage += 2) {
      const pageNumbers = [firstPage, firstPage + 1].filter((page) => page <= maxPages);
      const pages = await Promise.all(pageNumbers.map(async (page) => {
        const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=changepercent&asc=${ascending}&node=hs_a`;
        return JSON.parse(await fetchText(url, { referer: 'https://finance.sina.com.cn' }));
      }));
      for (const payload of pages) {
        if (!Array.isArray(payload) || !payload.length) return { count, complete: true };
        let pageMin = Infinity;
        for (const stock of payload) {
          if (num(stock.trade) <= 0) continue;
          const pct = Math.abs(num(stock.changepercent));
          pageMin = Math.min(pageMin, pct);
          const id = String(stock.symbol || '');
          if (!seen.has(id) && isCNPriceLimit(stock, dir, num)) count++;
          if (id) seen.add(id);
        }
        if (!Number.isFinite(pageMin) || pageMin < 9.8) return { count, complete: true };
      }
    }
    return { count, complete: false };
  }

  async function getNews(count = 30) {
    const url = `https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=${count}&page=1`;
    return parseSinaRollNews(JSON.parse(await fetchText(url)));
  }

  async function getStockNewsCN(rawCode) {
    const code = String(rawCode || '').toLowerCase();
    if (!isCNCode(code)) throw new Error('个股资讯仅支持带 sh/sz/bj 前缀的A股代码');
    const pageUrl = `https://vip.stock.finance.sina.com.cn/corp/go.php/vCB_AllNewsStock/symbol/${code}.phtml`;
    const html = await fetchText(pageUrl, {
      encoding: 'gbk',
      referer: 'https://finance.sina.com.cn/',
    });
    return parseSinaStockNewsPage(html, pageUrl);
  }

  return {
    getRankCN,
    getRankHK,
    countLimit,
    getNews,
    getStockNewsCN,
  };
}

module.exports = {
  isAbnormalCNName,
  cnPriceLimitPct,
  isCNPriceLimit,
  parseSinaRankCN,
  parseSinaRankHK,
  decodeHtmlText,
  normalizeNewsTitle,
  normalizeSinaNewsUrl,
  parseSinaStockNewsPage,
  parseSinaRollNews,
  createSinaProvider,
};
