'use strict';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function defaultTimeoutSignal(timeoutMs) {
  return AbortSignal.timeout(timeoutMs);
}

/**
 * Create the shared, zero-dependency text HTTP client used by market providers.
 * Provider-specific scheduling (notably Yahoo's global serial queue) belongs in
 * the provider rather than this generic transport.
 */
function createHttpClient({
  fetchImpl = globalThis.fetch,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = 10000,
  sleep = defaultSleep,
  timeoutSignal = defaultTimeoutSignal,
  maxRateLimitRetries = 2,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (typeof timeoutSignal !== 'function') throw new TypeError('timeoutSignal must be a function');

  async function fetchText(url, { referer, encoding = 'utf-8', ua } = {}, attempt = 0) {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': ua || userAgent,
        ...(referer ? { Referer: referer } : {}),
      },
      signal: timeoutSignal(timeoutMs),
    });
    if (res.status === 429 && attempt < maxRateLimitRetries) {
      await sleep(1500 * (attempt + 1));
      return fetchText(url, { referer, encoding, ua }, attempt + 1);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder(encoding).decode(buf);
  }

  return { fetchText };
}

module.exports = {
  DEFAULT_USER_AGENT,
  createHttpClient,
};
