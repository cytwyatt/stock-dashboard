'use strict';

const path = require('node:path');

const MAX_REVIEWS_PER_MARKET = 30;
const MARKETS = Object.freeze(['cn', 'hk', 'us']);
const MARKET_SET = new Set(MARKETS);
const REVIEW_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SANITIZE_DEPTH = 30;
const MAX_ATTEMPT_ERROR_LENGTH = 2000;

const SENSITIVE_KEYS = new Set([
  'apikey',
  'authorization',
  'password',
  'secret',
  'clientsecret',
  'token',
  'accesstoken',
  'refreshtoken',
  'bearertoken',
  'credential',
  'credentials',
]);

function emptyStore() {
  return {
    version: 1,
    reviews: { cn: [], hk: [], us: [] },
    attempts: {},
  };
}

function normalizeMarket(value) {
  const market = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return MARKET_SET.has(market) ? market : '';
}

function normalizeReviewDate(value) {
  const reviewDate = typeof value === 'string' ? value.trim() : '';
  if (!REVIEW_DATE_RE.test(reviewDate)) return '';
  const [year, month, day] = reviewDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year
      || date.getUTCMonth() !== month - 1
      || date.getUTCDate() !== day) return '';
  return reviewDate;
}

function isSensitiveKey(key) {
  const normalized = String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_KEYS.has(normalized);
}

function redactCredentialText(value) {
  return String(value)
    .replace(/\bsk\x2d[a-z0-9_-]{4,}/gi, '[REDACTED]')
    .replace(/\bBearer\s+[a-z0-9._~+/=-]{4,}/gi, 'Bearer [REDACTED]');
}

function sanitizeJSONValue(value, seen = new WeakSet(), depth = 0) {
  if (value == null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return redactCredentialText(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'object' || depth >= MAX_SANITIZE_DEPTH) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const sanitized = sanitizeJSONValue(item, seen, depth + 1);
      if (sanitized !== undefined) out.push(sanitized);
    }
    seen.delete(value);
    return out;
  }

  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key) || key === '__proto__' || key === 'prototype' || key === 'constructor') {
      continue;
    }
    const sanitized = sanitizeJSONValue(item, seen, depth + 1);
    if (sanitized !== undefined) out[key] = sanitized;
  }
  seen.delete(value);
  return out;
}

function sanitizeReview(value, expectedMarket = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const market = expectedMarket || normalizeMarket(value.market);
  const reviewDate = normalizeReviewDate(value.reviewDate);
  if (!market || !reviewDate) return null;
  const sanitized = sanitizeJSONValue(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) return null;
  return { ...sanitized, market, reviewDate };
}

function normalizeReviews(value, market) {
  if (!Array.isArray(value)) return [];
  const byDate = new Map();
  for (const item of value) {
    const review = sanitizeReview(item, market);
    if (review) byDate.set(review.reviewDate, review);
  }
  return [...byDate.values()]
    .sort((left, right) => right.reviewDate.localeCompare(left.reviewDate))
    .slice(0, MAX_REVIEWS_PER_MARKET);
}

function attemptKey(market, reviewDate) {
  return `${market}:${reviewDate}`;
}

function normalizeAttemptAt(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, 80);
  return text && Number.isFinite(Date.parse(text)) ? text : null;
}

function sanitizeAttempt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    at: normalizeAttemptAt(value.at),
    error: redactCredentialText(value.error == null ? '' : value.error)
      .trim()
      .slice(0, MAX_ATTEMPT_ERROR_LENGTH),
  };
}

function normalizeAttempts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const attempts = {};
  for (const [key, rawAttempt] of Object.entries(value)) {
    const match = /^(cn|hk|us):(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match || !normalizeReviewDate(match[2])) continue;
    const attempt = sanitizeAttempt(rawAttempt);
    if (attempt) attempts[attemptKey(match[1], match[2])] = attempt;
  }
  return attempts;
}

function normalizeStore(value) {
  const store = emptyStore();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return store;
  for (const market of MARKETS) {
    store.reviews[market] = normalizeReviews(value.reviews && value.reviews[market], market);
  }
  store.attempts = normalizeAttempts(value.attempts);
  return store;
}

function createMarketReviewStore({ dataDir, fs, jsonFile }) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !jsonFile || typeof jsonFile.writeDataJSON !== 'function'
      || typeof jsonFile.protectDataFile !== 'function') {
    throw new TypeError('fs and jsonFile are required');
  }

  const file = path.join(dataDir, 'market-reviews.json');
  jsonFile.protectDataFile(file);

  function readMarketReviews() {
    try {
      return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      return emptyStore();
    }
  }

  function writeMarketReviews(store) {
    jsonFile.writeDataJSON(file, normalizeStore(store));
  }

  function latest(rawMarket) {
    const market = normalizeMarket(rawMarket);
    if (!market) return null;
    return readMarketReviews().reviews[market][0] || null;
  }

  function find(rawMarket, rawReviewDate) {
    const market = normalizeMarket(rawMarket);
    const reviewDate = normalizeReviewDate(rawReviewDate);
    if (!market || !reviewDate) return null;
    return readMarketReviews().reviews[market]
      .find((review) => review.reviewDate === reviewDate) || null;
  }

  function upsert(value) {
    const review = sanitizeReview(value);
    if (!review) throw new TypeError('review must contain a valid market and reviewDate');
    const store = readMarketReviews();
    const existing = store.reviews[review.market]
      .filter((item) => item.reviewDate !== review.reviewDate);
    store.reviews[review.market] = [review, ...existing]
      .sort((left, right) => right.reviewDate.localeCompare(left.reviewDate))
      .slice(0, MAX_REVIEWS_PER_MARKET);
    writeMarketReviews(store);
    return review;
  }

  function getAttempt(rawMarket, rawReviewDate) {
    const market = normalizeMarket(rawMarket);
    const reviewDate = normalizeReviewDate(rawReviewDate);
    if (!market || !reviewDate) return null;
    return readMarketReviews().attempts[attemptKey(market, reviewDate)] || null;
  }

  function recordAttempt(rawMarket, rawReviewDate, value) {
    const market = normalizeMarket(rawMarket);
    const reviewDate = normalizeReviewDate(rawReviewDate);
    const attempt = sanitizeAttempt(value);
    if (!market || !reviewDate || !attempt) {
      throw new TypeError('attempt must contain a valid market, reviewDate and value');
    }
    const store = readMarketReviews();
    store.attempts[attemptKey(market, reviewDate)] = attempt;
    writeMarketReviews(store);
    return attempt;
  }

  function clearAttempt(rawMarket, rawReviewDate) {
    const market = normalizeMarket(rawMarket);
    const reviewDate = normalizeReviewDate(rawReviewDate);
    if (!market || !reviewDate) return false;
    const store = readMarketReviews();
    const key = attemptKey(market, reviewDate);
    if (!Object.prototype.hasOwnProperty.call(store.attempts, key)) return false;
    delete store.attempts[key];
    writeMarketReviews(store);
    return true;
  }

  return {
    file,
    readMarketReviews,
    latest,
    find,
    upsert,
    getAttempt,
    recordAttempt,
    clearAttempt,
  };
}

module.exports = { createMarketReviewStore, MAX_REVIEWS_PER_MARKET };
