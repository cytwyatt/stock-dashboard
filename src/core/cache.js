'use strict';

const CACHE_MAX = 1000;

function cacheResult(entry) {
  return {
    data: entry.data,
    fetchedAt: entry.fetchedAt,
    stale: !!entry.stale,
    staleSince: entry.staleSince || null,
  };
}

function createCacheRuntime({
  maxEntries = CACHE_MAX,
  now = () => Date.now(),
  logger = console,
} = {}) {
  const cache = new Map();
  const inflight = new Map();

  function setCachedValue(key, value) {
    cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  async function cachedEntry(key, ttlMs, fn) {
    const hit = cache.get(key);
    if (hit && hit.expire > now()) {
      setCachedValue(key, hit);
      return cacheResult(hit);
    }
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const data = await fn();
        const timestamp = now();
        const entry = {
          expire: timestamp + ttlMs,
          fetchedAt: timestamp,
          stale: false,
          data,
        };
        setCachedValue(key, entry);
        return cacheResult(entry);
      } catch (error) {
        if (hit) {
          logger.error(`[stale] ${key}: ${error.message}，返回上次缓存`);
          const timestamp = now();
          const entry = {
            ...hit,
            expire: timestamp + Math.min(ttlMs, 15000),
            stale: true,
            staleSince: hit.staleSince || timestamp,
          };
          setCachedValue(key, entry);
          return cacheResult(entry);
        }
        throw error;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  async function cached(key, ttlMs, fn) {
    return (await cachedEntry(key, ttlMs, fn)).data;
  }

  // Mark an entry expired without deleting its value. The next cachedEntry()
  // call refreshes it, while a failed refresh can still fall back to the old
  // value. This is useful for explicit user-triggered refreshes.
  function expireCached(key) {
    const hit = cache.get(key);
    if (!hit) return false;
    hit.expire = 0;
    return true;
  }

  return { cache, inflight, cached, cachedEntry, expireCached };
}

const defaultCacheRuntime = createCacheRuntime();

module.exports = {
  CACHE_MAX,
  createCacheRuntime,
  defaultCacheRuntime,
  ...defaultCacheRuntime,
};
