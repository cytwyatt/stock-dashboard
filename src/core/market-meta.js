'use strict';

const MARKET_DATA_META = Symbol('marketDataMeta');

const MARKET_DEFAULTS = {
  cn: { currency: 'CNY', timezone: 'Asia/Shanghai' },
  hk: { currency: 'HKD', timezone: 'Asia/Hong_Kong' },
  us: { currency: 'USD', timezone: 'America/New_York' },
};

function annotateMarketData(data, meta) {
  if (data && (typeof data === 'object' || typeof data === 'function')) {
    Object.defineProperty(data, MARKET_DATA_META, {
      value: { ...(data[MARKET_DATA_META] || {}), ...meta },
      configurable: true,
    });
  }
  return data;
}

function getMarketDataMeta(data) {
  return (data && data[MARKET_DATA_META]) || {};
}

function marketMeta(entry, spec = {}) {
  const intrinsic = getMarketDataMeta(entry.data);
  const market = spec.market || intrinsic.market || null;
  const defaults = MARKET_DEFAULTS[market] || {};
  const merged = { ...defaults, ...intrinsic, ...spec };
  const fetchedAt = new Date(entry.fetchedAt).toISOString();
  return {
    schemaVersion: 1,
    market,
    source: merged.source || null,
    currency: Object.prototype.hasOwnProperty.call(merged, 'currency') ? merged.currency : null,
    timezone: merged.timezone || null,
    asOf: merged.asOf || fetchedAt,
    asOfBasis: merged.asOfBasis || (merged.asOf ? 'provider' : 'fetch_time'),
    fetchedAt,
    requestedAt: new Date().toISOString(),
    stale: !!(entry.stale || merged.stale),
    staleSince: entry.staleSince
      ? new Date(entry.staleSince).toISOString()
      : merged.staleSince || null,
    adjustmentBasis: merged.adjustmentBasis || 'none',
    amountUnit: merged.amountUnit || null,
    ...(merged.adjustmentCoverage == null
      ? {}
      : { adjustmentCoverage: merged.adjustmentCoverage }),
    ...(merged.coverage ? { coverage: merged.coverage } : {}),
  };
}

module.exports = {
  MARKET_DATA_META,
  MARKET_DEFAULTS,
  annotateMarketData,
  getMarketDataMeta,
  marketMeta,
};
