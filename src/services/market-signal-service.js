'use strict';

const { SIGNAL_RULES, buildDirectionalSignals } = require('../domain/market-signals');

const US_RELATIVE_CODES = Object.freeze(['SPY', 'QQQ', 'SOXX', 'RSP']);
const SIGNAL_HISTORY_DAYS = 90;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function rowsThroughReviewDate(rows, reviewDate) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row && typeof row.date === 'string' && row.date <= reviewDate)
    .map((row) => ({
      date: row.date,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    }));
}

function createMarketSignalService({
  marketService,
  marketSignalStore,
  tradingCalendar,
  marketMeta,
  crypto,
  now = Date.now,
} = {}) {
  if (!marketService || !marketSignalStore || !tradingCalendar
      || typeof marketMeta !== 'function' || !crypto || typeof crypto.createHash !== 'function') {
    throw new TypeError('market signal service dependencies are required');
  }

  async function loadRelativeHistories(reviewDate) {
    const histories = {};
    const missing = [];
    const results = await Promise.allSettled(US_RELATIVE_CODES.map(async (code) => {
      const entry = await marketService.kline(code, SIGNAL_HISTORY_DAYS, 'day');
      const meta = marketMeta(entry, { market: 'us' });
      if (entry.stale || meta.stale) throw new Error('stale');
      const rows = rowsThroughReviewDate(entry.data, reviewDate);
      if (!rows.length || rows.at(-1).date !== reviewDate) throw new Error('date_mismatch');
      return { code, rows, meta };
    }));
    results.forEach((result, index) => {
      const code = US_RELATIVE_CODES[index];
      if (result.status === 'fulfilled') histories[code] = result.value.rows;
      else missing.push(code);
    });
    return { histories, missing };
  }

  function reportFromSnapshot(snapshot) {
    return snapshot && snapshot.report ? structuredClone(snapshot.report) : null;
  }

  async function buildSnapshot({
    market,
    reviewDate,
    components = [],
    indexHistories = [],
    associationEvidenceRefs = [],
  }) {
    if (market !== 'cn' && market !== 'us') return null;
    const existing = marketSignalStore.find(market, reviewDate, SIGNAL_RULES.version);
    if (existing) return reportFromSnapshot(existing);

    const capturedAt = new Date(now()).toISOString();
    const session = tradingCalendar.session(market, reviewDate);
    const relative = market === 'us'
      ? await loadRelativeHistories(reviewDate)
      : { histories: {}, missing: [] };
    const frozenIndexHistories = (Array.isArray(indexHistories) ? indexHistories : [])
      .map((history) => ({
        code: history.code,
        name: history.name,
        source: history.source || null,
        rows: rowsThroughReviewDate(history.rows, reviewDate),
      }))
      .filter((history) => history.rows.length && history.rows.at(-1).date === reviewDate);
    const frozenComponents = (Array.isArray(components) ? components : []).map((component) => ({
      name: component.name,
      data: component.name === 'news' && Array.isArray(component.data)
        ? component.data.map((item) => ({
            ...item,
            firstSeenAt: capturedAt,
            updatedAt: null,
            pointInTimeLimitation: '仅有发布时间；首次可见时间以本次抓取为准',
          }))
        : component.data,
      meta: {
        source: component.meta?.source || null,
        asOf: component.meta?.asOf || null,
        asOfBasis: component.meta?.asOfBasis || null,
        stale: component.meta?.stale === true,
      },
    }));
    const input = {
      market,
      reviewDate,
      cutoffAt: session.cutoffAt,
      capturedAt,
      calendarVersion: tradingCalendar.version,
      calendarStatus: session.calendarStatus,
      rules: SIGNAL_RULES,
      associationEvidenceRefs: [...associationEvidenceRefs],
      indexHistories: frozenIndexHistories,
      relativeHistories: relative.histories,
      components: frozenComponents,
      limitations: [
        ...(relative.missing.length ? [`美股补充日线缺失：${relative.missing.join('、')}`] : []),
        ...(session.calendarStatus === 'unknown' ? ['交易日历超出已知范围，下个交易日不作猜测'] : []),
      ],
    };
    const inputHash = crypto.createHash('sha256').update(stableStringify(input)).digest('hex');
    const id = `${market}:${reviewDate}:${SIGNAL_RULES.version}:${inputHash.slice(0, 12)}`;
    const facts = buildDirectionalSignals({
      market,
      reviewDate,
      indexHistories: frozenIndexHistories,
      relativeHistories: relative.histories,
      components: frozenComponents,
      alignedEvidenceRefs: associationEvidenceRefs,
    });
    const report = {
      status: facts.status,
      reviewDate,
      cutoffAt: session.cutoffAt,
      capturedAt,
      generatedAt: null,
      nextSessionDate: session.calendarStatus === 'known'
        ? tradingCalendar.nextSession(market, reviewDate) : null,
      calendarStatus: session.calendarStatus,
      calendarVersion: tradingCalendar.version,
      rulesVersion: SIGNAL_RULES.version,
      methodology: SIGNAL_RULES.methodology,
      isPredictionProbability: false,
      inputSnapshotId: id,
      inputHash,
      metrics: facts.metrics,
      computedSignals: facts.computedSignals,
      eventSignals: [],
      watchTriggers: facts.watchTriggers,
      interpretation: {
        alignment: '规则信号仅作可复算的证据整理，不按数量投票决定总体前瞻。',
        keyCounterEvidence: '最重要的反证由模型在白名单信号范围内补充；校验失败时保留此中性说明。',
        nextSessionFocus: '优先验证核心指数与20日均线关系，以及宽度或量能是否同步确认。',
        signalRefs: facts.computedSignals
          .filter((signal) => signal.state === 'observed')
          .slice(0, 4)
          .map((signal) => signal.id),
        evidenceRefs: ['directionalSignalFacts'],
      },
      availableGroups: facts.availableGroups,
      missingGroups: facts.missingGroups,
      qualityWarnings: [...facts.qualityWarnings, ...input.limitations],
      coverage: market === 'us'
        ? '指数、11只SPDR行业ETF、有限风格ETF与跨资产代理；不代表全市场宽度或资金流'
        : '指数、上涨/未上涨宽度、腾讯行业分类与沪深同源成交额；不含北交所成交额',
    };
    const snapshot = marketSignalStore.saveImmutable({
      id,
      market,
      reviewDate,
      rulesVersion: SIGNAL_RULES.version,
      inputHash,
      capturedAt,
      input,
      report,
    });
    return reportFromSnapshot(snapshot);
  }

  return { buildSnapshot };
}

module.exports = {
  SIGNAL_HISTORY_DAYS,
  US_RELATIVE_CODES,
  createMarketSignalService,
  rowsThroughReviewDate,
  stableStringify,
};
