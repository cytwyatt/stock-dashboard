'use strict';

const path = require('node:path');

function createWatchlistStore({ dataDir, fs, jsonFile, sanitizeCode }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !jsonFile || typeof sanitizeCode !== 'function') {
    throw new TypeError('fs, jsonFile and sanitizeCode are required');
  }

  const file = path.join(dataDir, 'watchlist.json');
  jsonFile.protectDataFile(file);

  function normalizeWatchlist(arr) {
    if (!Array.isArray(arr)) return [];
    return arr
      .slice(0, 200)
      .map((item) => ({
        code: sanitizeCode(item && item.code),
        name: String((item && item.name) || '').slice(0, 40),
        market: item && (item.market === 'us' || item.market === 'hk') ? item.market : 'cn',
      }))
      .filter((item) => item.code);
  }

  function readWatchlist() {
    try {
      return normalizeWatchlist(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return [];
    }
  }

  // 与原逻辑一致：write 不二次规范化，HTTP 入口在调用前已经 normalize。
  function writeWatchlist(list) {
    jsonFile.writeDataJSON(file, list);
  }

  return { file, normalizeWatchlist, readWatchlist, writeWatchlist };
}

module.exports = { createWatchlistStore };
