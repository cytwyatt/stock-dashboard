'use strict';

const path = require('node:path');

const MAX_SIGNAL_SNAPSHOTS_PER_MARKET = 500;
const MARKETS = new Set(['cn', 'us']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SENSITIVE_KEY_RE = /^(?:api[_-]?key|authorization|password|secret|token|access[_-]?token|refresh[_-]?token|credentials?)$/i;

function emptySnapshots() {
  return { version: 1, snapshots: { cn: [], us: [] } };
}

function emptyOutcomes() {
  return { version: 1, outcomes: [] };
}

function safeValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value
      .replace(/\bsk\x2d[a-z0-9_-]{4,}/gi, '[REDACTED]')
      .replace(/\bBearer\s+[a-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]');
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth > 40 || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => safeValue(item, seen, depth + 1))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) continue;
    const safe = safeValue(item, seen, depth + 1);
    if (safe !== undefined) out[key] = safe;
  }
  seen.delete(value);
  return out;
}

function validSnapshot(value, expectedMarket = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const market = expectedMarket || String(value.market || '').toLowerCase();
  const reviewDate = String(value.reviewDate || '');
  const rulesVersion = String(value.rulesVersion || '').slice(0, 100);
  const inputHash = String(value.inputHash || '').toLowerCase();
  const id = String(value.id || '').slice(0, 240);
  if (!MARKETS.has(market) || !DATE_RE.test(reviewDate) || !rulesVersion
      || !/^[a-f0-9]{64}$/.test(inputHash) || !id) return null;
  const safe = safeValue(value);
  return { ...safe, id, market, reviewDate, rulesVersion, inputHash };
}

function normalizeSnapshotStore(value) {
  const out = emptySnapshots();
  for (const market of MARKETS) {
    const source = value && value.snapshots && Array.isArray(value.snapshots[market])
      ? value.snapshots[market] : [];
    const seen = new Set();
    out.snapshots[market] = source.map((item) => validSnapshot(item, market)).filter((item) => {
      if (!item) return false;
      const key = `${item.reviewDate}:${item.rulesVersion}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((left, right) => right.reviewDate.localeCompare(left.reviewDate))
      .slice(0, MAX_SIGNAL_SNAPSHOTS_PER_MARKET);
  }
  return out;
}

function createMarketSignalStore({ dataDir, fs, jsonFile }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !jsonFile || typeof jsonFile.writeDataJSON !== 'function') {
    throw new TypeError('fs and jsonFile are required');
  }
  const file = path.join(dataDir, 'market-signal-snapshots.json');
  const outcomesFile = path.join(dataDir, 'market-signal-outcomes.json');
  jsonFile.protectDataFile(file);
  jsonFile.protectDataFile(outcomesFile);

  function readSnapshots() {
    try { return normalizeSnapshotStore(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch { return emptySnapshots(); }
  }

  function find(market, reviewDate, rulesVersion) {
    if (!MARKETS.has(market)) return null;
    return readSnapshots().snapshots[market]
      .find((item) => item.reviewDate === reviewDate && item.rulesVersion === rulesVersion) || null;
  }

  function saveImmutable(value) {
    const snapshot = validSnapshot(value);
    if (!snapshot) throw new TypeError('snapshot identity is invalid');
    const store = readSnapshots();
    const existing = store.snapshots[snapshot.market]
      .find((item) => item.reviewDate === snapshot.reviewDate
        && item.rulesVersion === snapshot.rulesVersion);
    if (existing) {
      if (existing.inputHash !== snapshot.inputHash) {
        throw new Error('signal snapshot is immutable and input hash changed');
      }
      return existing;
    }
    store.snapshots[snapshot.market] = [snapshot, ...store.snapshots[snapshot.market]]
      .sort((left, right) => right.reviewDate.localeCompare(left.reviewDate))
      .slice(0, MAX_SIGNAL_SNAPSHOTS_PER_MARKET);
    jsonFile.writeDataJSON(file, store);
    return snapshot;
  }

  function readOutcomes() {
    try {
      const value = JSON.parse(fs.readFileSync(outcomesFile, 'utf8'));
      return value && Array.isArray(value.outcomes)
        ? { version: 1, outcomes: value.outcomes.map((item) => safeValue(item)).filter(Boolean) }
        : emptyOutcomes();
    } catch { return emptyOutcomes(); }
  }

  function recordOutcome(value) {
    const safe = safeValue(value);
    if (!safe || !safe.snapshotId || !['next', 'third', 'fifth'].includes(safe.horizon)
        || !safe.observedAt || safe.value == null) {
      throw new TypeError('outcome requires snapshotId, horizon, observedAt and a non-null value');
    }
    const store = readOutcomes();
    const key = `${safe.snapshotId}:${safe.horizon}`;
    if (store.outcomes.some((item) => `${item.snapshotId}:${item.horizon}` === key)) {
      throw new Error('signal outcome is immutable');
    }
    store.outcomes.push(safe);
    jsonFile.writeDataJSON(outcomesFile, store);
    return safe;
  }

  return {
    file,
    outcomesFile,
    readSnapshots,
    find,
    saveImmutable,
    readOutcomes,
    recordOutcome,
  };
}

module.exports = {
  MAX_SIGNAL_SNAPSHOTS_PER_MARKET,
  createMarketSignalStore,
  normalizeSnapshotStore,
};
