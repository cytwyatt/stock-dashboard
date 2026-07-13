'use strict';

const STOCK_EVENT_RE = /涨停|跌停|暴涨|暴跌|大涨|大跌|异动|回收|火箭|航天|发射|试验|成功|突破|中标|订单|政策|重组|业绩|公告/;
const LOW_SIGNAL_NEWS_RE = /融资买入|融资余额|大宗交易|基金重仓|主力净流入/;
const STOCK_EVENT_CACHE_TTL = 180000;

function createStockEventsService({
  cached,
  getStockNewsCN,
  isCNCode,
  isHKCode,
  isKnownHKCode,
  now = () => Date.now(),
}) {
  function selectStockEvents(items, { code, name = '', lookbackHours = 72, limit = 8 } = {}) {
    const current = now();
    const hours = Math.max(6, Math.min(168, Number(lookbackHours) || 72));
    const maxItems = Math.max(1, Math.min(10, Number(limit) || 8));
    const cutoff = current - hours * 3600000;
    const codeDigits = String(code || '').replace(/^\D+/, '');
    const stockName = String(name || '').trim();
    return items
      .filter((item) => item.time >= cutoff && item.time <= current + 300000)
      .map((item) => {
        const direct = !!(stockName && item.title.includes(stockName))
          || !!(codeDigits && item.title.includes(codeDigits));
        const eventLike = STOCK_EVENT_RE.test(item.title);
        const lowSignal = LOW_SIGNAL_NEWS_RE.test(item.title);
        const ageHours = Math.max(0, (current - item.time) / 3600000);
        const score = (direct ? 60 : 0) + (eventLike ? 25 : 0) - (lowSignal ? 20 : 0)
          + Math.max(0, 18 - ageHours / 4);
        return {
          ...item,
          relation: direct ? 'direct' : eventLike ? 'related_event' : 'stock_page',
          score: +score.toFixed(2),
        };
      })
      .sort((a, b) => b.score - a.score || b.time - a.time)
      .slice(0, maxItems)
      .map(({ score, ...item }) => item);
  }

  async function getStockEvents(rawCode, options = {}) {
    const raw = String(rawCode || '').trim();
    const lower = raw.toLowerCase();
    const hkCode = /^hk/i.test(raw) ? `hk${raw.slice(2).toUpperCase()}` : '';
    const code = isCNCode(lower)
      ? lower
      : isKnownHKCode(hkCode)
        ? hkCode
        : raw.toUpperCase();
    if (!isCNCode(code)) {
      return {
        asOf: new Date(now()).toISOString(),
        stock: { code, market: isHKCode(code) ? 'hk' : 'us' },
        coverage: { supported: false, reason: '第一阶段个股资讯目前仅支持A股' },
        events: [],
      };
    }
    const bundle = await cached(`stock-events:cn:${code}`, STOCK_EVENT_CACHE_TTL, async () => ({
      items: await getStockNewsCN(code),
      fetchedAt: new Date(now()).toISOString(),
    }));
    const all = bundle.items;
    const fetchedAtMs = Date.parse(bundle.fetchedAt);
    const current = now();
    const stale = !Number.isFinite(fetchedAtMs) || current - fetchedAtMs > STOCK_EVENT_CACHE_TTL;
    const events = selectStockEvents(all, { code, ...options });
    return {
      asOf: bundle.fetchedAt,
      requestedAt: new Date(current).toISOString(),
      stock: { code, name: String(options.name || '').slice(0, 80), market: 'cn' },
      coverage: {
        supported: true,
        source: '新浪财经个股资讯',
        stale,
        ...(stale ? { warning: '资讯源刷新失败或缓存已过期，以下结果可能遗漏最新事件' } : {}),
        lookbackHours: Math.max(6, Math.min(168, Number(options.lookbackHours) || 72)),
        found: all.length,
        returned: events.length,
      },
      events,
    };
  }

  return { selectStockEvents, getStockEvents };
}

module.exports = {
  STOCK_EVENT_CACHE_TTL,
  createStockEventsService,
};
