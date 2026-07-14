'use strict';

// Keep this below the shortest market-service TTL (indices: 15s), so hot
// entries are refreshed before a user request has to perform upstream I/O.
const CACHE_WARM_INTERVAL_MS = 5000;

function createCacheWarmer({ marketService, isMarketOpen, logger = console }) {
  const warm = (label, fn) => Promise.resolve()
    .then(fn)
    .catch((error) => logger.error(`[warm] ${label}: ${error.message}`));

  function warmOnce() {
    if (isMarketOpen('cn')) {
      warm('indices:cn', () => marketService.indices('cn'));
      warm('minute:sh000001', () => marketService.minute('sh000001'));
      warm('sectors', () => marketService.sectors());
      warm('rank:cn:up', () => marketService.rank('cn', 'up'));
      warm('rank:cn:down', () => marketService.rank('cn', 'down'));
      warm('overview:cn', () => marketService.overview('cn'));
      warm('news', () => marketService.news());
    }
    if (isMarketOpen('hk')) {
      warm('indices:hk', () => marketService.indices('hk'));
      warm('minute:hkHSI', () => marketService.minute('hkHSI'));
      warm('rank:hk:up', () => marketService.rank('hk', 'up'));
      warm('rank:hk:down', () => marketService.rank('hk', 'down'));
      warm('overview:hk', () => marketService.overview('hk'));
      warm('news', () => marketService.news());
    }
    if (isMarketOpen('us')) {
      warm('indices:us', () => marketService.indices('us'));
      warm('minute:^DJI', () => marketService.minute('^DJI'));
      warm('rank:us:up', () => marketService.rank('us', 'up'));
      warm('rank:us:down', () => marketService.rank('us', 'down'));
      warm('overview:us', () => marketService.overview('us'));
      warm('news', () => marketService.news());
    }
  }

  function start(intervalMs = CACHE_WARM_INTERVAL_MS) {
    const timer = setInterval(warmOnce, intervalMs);
    warmOnce();
    return timer;
  }

  return { warmOnce, start };
}

module.exports = { CACHE_WARM_INTERVAL_MS, createCacheWarmer };
