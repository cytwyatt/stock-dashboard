'use strict';

const CACHE_TTL = Object.freeze({
  indices: 15000,
  minuteTX: 30000,
  minuteOther: 60000,
  kline: 300000,
  sectors: 30000,
  rankClosed: 600000,
  rankCNHKOpen: 30000,
  rankUSOpen: 90000,
  overview: 60000,
  quote: 15000,
  quotes: 30000,
  search: 300000,
  news: 180000,
});

const cacheKeys = Object.freeze({
  indices: (market) => `idx:${market}`,
  minute: (code) => `min:${code}`,
  kline: (code, days, period) => `k:${code}:${days}:${period}`,
  sectors: () => 'sectors',
  rank: (market, dir, regime) => `rank:${market}:${dir}${regime ? `:${regime}` : ''}`,
  overview: (market) => `overview:${market}`,
  quote: (code) => `q:${code}`,
  quotes: (codes) => `qs:${codes.join(',')}`,
  search: (query) => `s:${query}`,
  news: () => 'news',
});

function immediateEntry(data) {
  return {
    data,
    fetchedAt: Date.now(),
    stale: false,
    staleSince: null,
  };
}

function normalizeMarket(market) {
  return market === 'us' || market === 'hk' ? market : 'cn';
}

function normalizeOverviewMarket(market) {
  return market === 'us' || market === 'hk' ? market : 'cn';
}

function normalizeDirection(dir) {
  return dir === 'down' ? 'down' : 'up';
}

function normalizeKlineDays(days) {
  const parsed = parseInt(String(days == null ? 90 : days), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
}

function normalizeKlinePeriod(period) {
  return ['day', 'week', 'month'].includes(period) ? period : 'day';
}

function createMarketService(deps) {
  const {
    cachedEntry,
    getIndices,
    getMinute,
    getKline,
    getResearchCardEntry,
    getSectors,
    getRankCN,
    getRankHK,
    getRankUS,
    getOverviewCN,
    getOverviewHK,
    getOverviewUS,
    getQuote,
    getQuotes,
    searchStocks,
    getNews,
    isTXCode,
    isMarketOpen,
  } = deps;

  const service = {
    async indices(market) {
      const normalizedMarket = normalizeMarket(market);
      return cachedEntry(
        cacheKeys.indices(normalizedMarket),
        CACHE_TTL.indices,
        () => getIndices(normalizedMarket)
      );
    },

    async minute(code = 'sh000001') {
      const ttl = isTXCode(code) ? CACHE_TTL.minuteTX : CACHE_TTL.minuteOther;
      return cachedEntry(cacheKeys.minute(code), ttl, () => getMinute(code));
    },

    async kline(code = 'sh000001', days = 90, period = 'day') {
      const normalizedDays = normalizeKlineDays(days);
      const normalizedPeriod = normalizeKlinePeriod(period);
      return cachedEntry(
        cacheKeys.kline(code, normalizedDays, normalizedPeriod),
        CACHE_TTL.kline,
        () => getKline(code, normalizedDays, normalizedPeriod)
      );
    },

    async research(code) {
      return getResearchCardEntry(code, (...args) => service.kline(...args));
    },

    async sectors() {
      return cachedEntry(cacheKeys.sectors(), CACHE_TTL.sectors, getSectors);
    },

    async rank(market, dir) {
      const normalizedMarket = normalizeMarket(market);
      const normalizedDir = normalizeDirection(dir);
      const provider = normalizedMarket === 'us'
        ? getRankUS
        : normalizedMarket === 'hk' ? getRankHK : getRankCN;
      const open = isMarketOpen(normalizedMarket);
      const key = cacheKeys.rank(normalizedMarket, normalizedDir, open ? 'open' : 'closed');
      const ttl = !open
        ? CACHE_TTL.rankClosed
        : normalizedMarket === 'us' ? CACHE_TTL.rankUSOpen : CACHE_TTL.rankCNHKOpen;
      return cachedEntry(
        key,
        ttl,
        () => provider(normalizedDir)
      );
    },

    async overview(market) {
      const normalizedMarket = normalizeOverviewMarket(market);
      const provider = normalizedMarket === 'us'
        ? getOverviewUS
        : normalizedMarket === 'hk'
          ? getOverviewHK
          : async () => getOverviewCN(await service.sectors());
      return cachedEntry(
        cacheKeys.overview(normalizedMarket),
        CACHE_TTL.overview,
        provider
      );
    },

    async quote(code) {
      return cachedEntry(cacheKeys.quote(code), CACHE_TTL.quote, () => getQuote(code));
    },

    async quotes(codes) {
      const normalizedCodes = Array.isArray(codes) ? codes.filter(Boolean).slice(0, 50) : [];
      if (!normalizedCodes.length) return immediateEntry([]);
      return cachedEntry(
        cacheKeys.quotes(normalizedCodes),
        CACHE_TTL.quotes,
        () => getQuotes(normalizedCodes)
      );
    },

    async search(query) {
      const normalizedQuery = String(query || '').trim().slice(0, 20);
      if (!normalizedQuery) return immediateEntry([]);
      return cachedEntry(
        cacheKeys.search(normalizedQuery),
        CACHE_TTL.search,
        () => searchStocks(normalizedQuery)
      );
    },

    async news() {
      return cachedEntry(cacheKeys.news(), CACHE_TTL.news, getNews);
    },
  };

  return service;
}

module.exports = {
  CACHE_TTL,
  cacheKeys,
  createMarketService,
};
