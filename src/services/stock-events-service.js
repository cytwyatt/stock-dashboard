'use strict';

const STOCK_EVENT_RE = /涨停|跌停|暴涨|暴跌|大涨|大跌|异动|回收|火箭|航天|发射|试验|成功|突破|中标|订单|政策|重组|业绩|公告|earnings?|revenue|profit|guidance|forecast|acquisition|acquire|merger|deal|contract|order|approval|investigation|lawsuit|launch|recall|dividend|buyback|upgrade|downgrade|partnership|warning|offering|bankruptcy|layoffs?|resigns?|appoints?|beats?|misses?|surges?|plunges?|rall(?:y|ies)|drops?|falls?|jumps?/i;
const LOW_SIGNAL_NEWS_RE = /融资买入|融资余额|大宗交易|基金重仓|主力净流入|price target|analyst rating|insider (?:sale|selling)|options activity|stocks? to (?:buy|watch)/i;
const US_SYMBOL_RE = /^[A-Z0-9^][A-Z0-9.^=_-]{0,19}$/;
const NON_STOCK_YAHOO_SYMBOL_RE = /^(?:\^|DX-Y\.NYB$)|=|-(?:USD|EUR|GBP|JPY|CAD|AUD|CHF|CNY|HKD)$/;
const STOCK_EVENT_CACHE_TTL = 180000;

function cleanStockName(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function stockNameAliases(value) {
  const name = cleanStockName(value);
  if (!name) return [];
  const aliases = new Set([name.toLocaleLowerCase('en-US')]);
  if (/^[\x00-\x7f]+$/.test(name)) {
    const base = name
      .replace(/\s+(?:incorporated|inc\.?|corporation|corp\.?|company|co\.?|limited|ltd\.?|plc|holdings?|group)(?:\s+.*)?$/i, '')
      .replace(/\s+class\s+[a-z]$/i, '')
      .trim();
    if (base) aliases.add(base.toLocaleLowerCase('en-US'));
    const first = base.split(/\s+/)[0] || '';
    if (first.length >= 4 && !/^(?:the|new|global|american|united)$/i.test(first)) {
      aliases.add(first.toLocaleLowerCase('en-US'));
    }
  }
  return [...aliases].filter((alias) => alias.length >= 2);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleIncludesAlias(title, alias) {
  if (!/^[\x00-\x7f]+$/.test(alias)) return title.includes(alias);
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(alias)}(?:$|[^a-z0-9])`, 'i').test(title);
}

function createStockEventsService({
  cached,
  getStockNews,
  isCNCode,
  isHKCode,
  isKnownHKCode,
  now = () => Date.now(),
}) {
  if (typeof cached !== 'function' || typeof getStockNews !== 'function') {
    throw new TypeError('cached and getStockNews must be functions');
  }
  if (typeof isCNCode !== 'function' || typeof isHKCode !== 'function'
      || typeof isKnownHKCode !== 'function') {
    throw new TypeError('stock code predicates must be functions');
  }

  function normalizeCode(rawCode) {
    const raw = String(rawCode || '').normalize('NFKC').trim();
    if (!raw) return '';
    const lower = raw.toLowerCase();
    if (isCNCode(lower)) return lower;
    if (/^hk/i.test(raw)) {
      const hkCode = `hk${raw.slice(2).toUpperCase()}`;
      return isHKCode(hkCode) || isKnownHKCode(hkCode) ? hkCode : '';
    }
    const upper = raw.toUpperCase();
    return US_SYMBOL_RE.test(upper) ? upper : '';
  }

  function supports(rawCode) {
    const code = normalizeCode(rawCode);
    return !!code && (isCNCode(code) || (!isHKCode(code) && !isKnownHKCode(code)
      && !NON_STOCK_YAHOO_SYMBOL_RE.test(code)));
  }

  function titleDirectlyMentionsStock(title, code, name) {
    const normalizedTitle = String(title || '').normalize('NFKC');
    const foldedTitle = normalizedTitle.toLocaleLowerCase('en-US');
    if (stockNameAliases(name).some((alias) => titleIncludesAlias(foldedTitle, alias))) return true;
    if (isCNCode(code)) return normalizedTitle.includes(code.slice(2));
    if (code.length === 1) return new RegExp(`\\$${escapeRegExp(code)}(?:$|[^A-Z0-9])`, 'i').test(normalizedTitle);
    return new RegExp(`(?:^|[^A-Z0-9])\\$?${escapeRegExp(code)}(?:$|[^A-Z0-9])`, 'i')
      .test(normalizedTitle);
  }

  function selectStockEvents(items, { code, name = '', lookbackHours = 72, limit = 8 } = {}) {
    const current = now();
    const hours = Math.max(6, Math.min(168, Number(lookbackHours) || 72));
    const maxItems = Math.max(1, Math.min(10, Number(limit) || 8));
    const cutoff = current - hours * 3600000;
    const normalizedCode = normalizeCode(code);
    const hasCode = !!normalizedCode;
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && typeof item === 'object'
        && Number.isFinite(Number(item.time))
        && Number(item.time) >= cutoff && Number(item.time) <= current + 300000
        && typeof item.title === 'string' && item.title.trim())
      .map((item) => {
        const relatedTickers = Array.isArray(item.relatedTickers)
          ? item.relatedTickers.map((ticker) => String(ticker).toUpperCase())
          : [];
        const primary = hasCode
          && String(item.primaryTicker || '').toUpperCase() === normalizedCode;
        const tagged = hasCode && relatedTickers.includes(normalizedCode);
        const direct = hasCode
          && titleDirectlyMentionsStock(item.title, normalizedCode, name);
        const eventLike = STOCK_EVENT_RE.test(item.title);
        const lowSignal = LOW_SIGNAL_NEWS_RE.test(item.title);
        const ageHours = Math.max(0, (current - Number(item.time)) / 3600000);
        const relation = direct
          ? 'direct'
          : primary ? 'primary_symbol'
            : tagged ? 'related_symbol'
              : eventLike ? 'related_event' : 'stock_page';
        const associationScore = direct ? 60 : primary ? 40 : tagged ? 20 : 0;
        const score = associationScore + (eventLike ? 25 : 0) - (lowSignal ? 20 : 0)
          + Math.max(0, 18 - ageHours / 4);
        return {
          ...item,
          relation,
          score: +score.toFixed(2),
        };
      })
      .sort((a, b) => b.score - a.score || b.time - a.time)
      .slice(0, maxItems)
      .map(({ score, ...item }) => item);
  }

  async function getStockEvents(rawCode, options = {}) {
    const code = normalizeCode(rawCode);
    const market = isCNCode(code) ? 'cn' : isHKCode(code) ? 'hk' : 'us';
    if (!supports(code)) {
      return {
        asOf: new Date(now()).toISOString(),
        stock: { code, market },
        coverage: {
          supported: false,
          reason: market === 'hk'
            ? '个股资讯目前支持A股与美股，暂不支持港股'
            : '个股资讯代码无效或暂不支持',
        },
        events: [],
      };
    }
    const bundle = await cached(`stock-events:${market}:${code}`, STOCK_EVENT_CACHE_TTL, async () => ({
      items: await getStockNews(code),
      fetchedAt: new Date(now()).toISOString(),
    }));
    if (!bundle || !Array.isArray(bundle.items)) throw new Error('个股资讯缓存结构异常');
    const all = bundle.items;
    const fetchedAtMs = Date.parse(bundle.fetchedAt);
    const current = now();
    const stale = !Number.isFinite(fetchedAtMs) || current - fetchedAtMs > STOCK_EVENT_CACHE_TTL;
    const events = selectStockEvents(all, { code, ...options });
    const name = cleanStockName(options.name);
    return {
      asOf: bundle.fetchedAt,
      requestedAt: new Date(current).toISOString(),
      stock: { code, name, market },
      coverage: {
        supported: true,
        source: market === 'cn' ? '新浪财经个股资讯' : 'Yahoo Finance 美股个股资讯',
        stale,
        ...(stale ? { warning: '资讯源刷新失败或缓存已过期，以下结果可能遗漏最新事件' } : {}),
        lookbackHours: Math.max(6, Math.min(168, Number(options.lookbackHours) || 72)),
        found: all.length,
        returned: events.length,
      },
      events,
    };
  }

  return { normalizeCode, supports, selectStockEvents, getStockEvents };
}

module.exports = {
  STOCK_EVENT_CACHE_TTL,
  createStockEventsService,
};
