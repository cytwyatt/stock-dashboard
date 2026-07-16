'use strict';

const PROFILE_TEXT_LIMIT = 1200;

function normalizeNasdaqText(value, limit = PROFILE_TEXT_LIMIT) {
  const text = value && typeof value === 'object' && !Array.isArray(value)
    ? value.value
    : value;
  return String(text == null ? '' : text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit) || null;
}

function parseNasdaqProfile(payload, code) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Nasdaq 公司资料响应格式异常');
  }
  const responseCode = payload.status && payload.status.rCode;
  if (responseCode != null && Number(responseCode) !== 200) {
    throw new Error(`Nasdaq 公司资料上游错误：${responseCode}`);
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'data')) {
    throw new Error('Nasdaq 公司资料响应格式异常：缺少 data');
  }
  if (payload.data != null && (typeof payload.data !== 'object' || Array.isArray(payload.data))) {
    throw new Error('Nasdaq 公司资料响应格式异常：data 非对象');
  }
  let rawUpstreamMessage = payload.message;
  if (rawUpstreamMessage == null && payload.error != null) {
    rawUpstreamMessage = payload.error && typeof payload.error === 'object'
      ? payload.error.message ?? payload.error.value ?? JSON.stringify(payload.error)
      : payload.error;
  }
  const upstreamMessage = normalizeNasdaqText(rawUpstreamMessage, 500);
  if (payload.data == null && upstreamMessage && Number(responseCode) !== 200) {
    throw new Error(`Nasdaq 公司资料上游错误：${upstreamMessage}`);
  }
  const data = payload.data || {};
  const sector = normalizeNasdaqText(data.Sector, 200);
  const industry = normalizeNasdaqText(data.Industry, 200);
  const businessSummary = normalizeNasdaqText(data.CompanyDescription) || '';
  return {
    code,
    market: 'us',
    available: !!(sector || industry || businessSummary),
    sector,
    industry,
    businessSummary,
    classificationBasis: 'Nasdaq Sector / Industry',
  };
}

function createNasdaqProvider({ fetchText, annotateMarketData } = {}) {
  if (typeof fetchText !== 'function') throw new TypeError('fetchText must be a function');
  if (typeof annotateMarketData !== 'function') {
    throw new TypeError('annotateMarketData must be a function');
  }

  async function getProfile(rawCode) {
    const code = String(rawCode || '').trim().toUpperCase();
    if (!code) throw new Error('美股公司资料缺少代码');
    const url = `https://api.nasdaq.com/api/company/${encodeURIComponent(code)}/company-profile`;
    const payload = JSON.parse(await fetchText(url, {
      referer: `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(code.toLowerCase())}`,
    }));
    return annotateMarketData(parseNasdaqProfile(payload, code), {
      market: 'us',
      source: 'Nasdaq 公司资料',
      currency: null,
      timezone: 'America/New_York',
      adjustmentBasis: 'none',
      amountUnit: null,
    });
  }

  return { getProfile };
}

module.exports = {
  normalizeNasdaqText,
  parseNasdaqProfile,
  createNasdaqProvider,
};
