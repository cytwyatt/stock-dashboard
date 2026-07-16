'use strict';

const { normalizeProfileCode } = require('../core/symbols');

const PROFILE_INDUSTRY_LIMIT = 20;
const PROFILE_INDUSTRY_CONCURRENCY = 3;

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
  profile: 24 * 60 * 60 * 1000,
  profileRefresh: 5 * 60 * 1000,
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
  profile: (code) => `profile:${code}`,
  profileRefresh: (code) => `profile-refresh:${code}`,
});

function immediateEntry(data, {
  fetchedAt = Date.now(),
  stale = false,
  staleSince = null,
} = {}) {
  return {
    data,
    fetchedAt,
    stale,
    staleSince,
  };
}

function createTaskLimiter(concurrency) {
  let active = 0;
  const queue = [];

  function drain() {
    while (active < concurrency && queue.length) {
      const { task, resolve, reject } = queue.shift();
      active++;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          active--;
          drain();
        });
    }
  }

  return (task) => new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    drain();
  });
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
    getProfile,
    searchStocks,
    getNews,
    getMarketDataMeta,
    annotateMarketData,
    isTXCode,
    isMarketOpen,
  } = deps;

  // This limiter is scoped to the service singleton, so concurrent HTTP batch
  // requests share the same upstream budget. Direct profile() calls bypass it
  // and remain responsive when a rank enrichment batch is in progress.
  const scheduleProfileIndustry = createTaskLimiter(PROFILE_INDUSTRY_CONCURRENCY);

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

    async profile(code) {
      const normalizedCode = normalizeProfileCode(code);
      try {
        return await cachedEntry(
          cacheKeys.profile(normalizedCode),
          CACHE_TTL.profile,
          async () => {
            const candidate = await cachedEntry(
              cacheKeys.profileRefresh(normalizedCode),
              CACHE_TTL.profileRefresh,
              () => getProfile(normalizedCode)
            );
            const meta = getMarketDataMeta(candidate.data);
            const incomplete = meta.coverage && meta.coverage.complete === false;
            if (candidate.stale || incomplete) {
              const reason = candidate.stale
                ? 'profile_refresh_failed'
                : meta.coverage.reason || 'profile_incomplete';
              const error = new Error(`公司资料未完整刷新：${reason}`);
              error.profileFallbackEntry = candidate;
              throw error;
            }
            return candidate.data;
          }
        );
      } catch (error) {
        // With no previous complete entry, an incomplete candidate remains useful.
        // If a complete entry exists, cachedEntry swallows this error and returns
        // that older entry as stale instead, so partial data never overwrites it.
        if (error && error.profileFallbackEntry) return error.profileFallbackEntry;
        throw error;
      }
    },

    async profileIndustries(codes) {
      const uniqueCodes = [];
      const seen = new Set();
      for (const value of Array.isArray(codes) ? codes : []) {
        const code = normalizeProfileCode(value);
        if (!code || seen.has(code)) continue;
        seen.add(code);
        uniqueCodes.push(code);
        if (uniqueCodes.length >= PROFILE_INDUSTRY_LIMIT) break;
      }

      const loaded = await Promise.all(uniqueCodes.map((code) => scheduleProfileIndustry(async () => {
        try {
          const entry = await service.profile(code);
          const profile = entry.data && typeof entry.data === 'object' ? entry.data : {};
          const meta = getMarketDataMeta(profile) || {};
          const coverage = meta.coverage || {};
          const industry = typeof profile.industry === 'string' && profile.industry.trim()
            ? profile.industry.trim()
            : null;
          const sector = typeof profile.sector === 'string' && profile.sector.trim()
            ? profile.sector.trim()
            : null;
          const hasClassification = !!(industry || sector);
          let status = 'unavailable';
          if (entry.stale) status = 'stale';
          else if (hasClassification) status = 'ok';
          else if (coverage.industry === false || coverage.complete === false) status = 'partial';

          return {
            item: {
              code,
              industry,
              sector,
              classificationBasis: typeof profile.classificationBasis === 'string'
                ? profile.classificationBasis
                : null,
              status,
              stale: !!entry.stale,
            },
            meta,
            fetchedAt: entry.fetchedAt,
            staleSince: entry.staleSince || null,
          };
        } catch {
          return {
            item: {
              code,
              industry: null,
              sector: null,
              classificationBasis: null,
              status: 'error',
              stale: false,
            },
            meta: {},
            fetchedAt: null,
            staleSince: null,
          };
        }
      })));

      const data = loaded.map((result) => result.item);
      const counts = { ok: 0, unavailable: 0, partial: 0, error: 0, stale: 0 };
      for (const item of data) counts[item.status]++;
      const sources = [...new Set(loaded.map((result) => result.meta.source).filter(Boolean))];
      const markets = [...new Set(loaded.map((result) => result.meta.market).filter(Boolean))];
      const timezones = [...new Set(loaded.map((result) => result.meta.timezone).filter(Boolean))];
      const staleSinceValues = loaded
        .map((result) => result.staleSince)
        .filter((value) => Number.isFinite(value));
      const staleSince = staleSinceValues.length ? Math.min(...staleSinceValues) : null;
      const fetchedAtValues = loaded
        .map((result) => result.fetchedAt)
        .filter((value) => Number.isFinite(value));
      const fetchedAt = fetchedAtValues.length ? Math.min(...fetchedAtValues) : Date.now();

      annotateMarketData(data, {
        market: markets.length === 1 ? markets[0] : null,
        source: sources.join(' / ') || '公司资料',
        currency: null,
        timezone: timezones.length === 1 ? timezones[0] : null,
        adjustmentBasis: 'none',
        amountUnit: null,
        coverage: {
          requested: uniqueCodes.length,
          withClassification: data.filter((item) => item.industry || item.sector).length,
          ...counts,
          complete: counts.partial === 0 && counts.error === 0 && counts.stale === 0,
        },
      });
      return immediateEntry(data, {
        fetchedAt,
        stale: counts.stale > 0,
        staleSince,
      });
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
  PROFILE_INDUSTRY_LIMIT,
  PROFILE_INDUSTRY_CONCURRENCY,
  createMarketService,
};
