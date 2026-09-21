'use strict';

const {
  finite,
  normalizeHistoryRows,
  round,
  summarizeIndexHistory,
} = require('./market-review');

const SIGNAL_RULES = Object.freeze({
  version: 'directional-signals-2026-09-v1',
  methodology: 'heuristic_unvalidated',
  trend: Object.freeze({ maFast: 20, maSlow: 50, slopeLookback: 5, breakoutWindow: 20 }),
  usSectorBreadth: Object.freeze({ required: 11, bullishMinUp: 8, bearishMaxUp: 3 }),
  relativeStrength: Object.freeze({ sessions: 5, neutralBandPct: 0.5 }),
  cnBreadth: Object.freeze({ bullishPct: 60, bearishPct: 40 }),
  cnTurnover: Object.freeze({ expansionPct: 5 }),
  macro: Object.freeze({ vixPct: 5, yieldBp: 5, dollarPct: 0.5 }),
  volume: Object.freeze({ ratio: 1.2 }),
});

function safeId(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function average(values) {
  return values.length && values.every(Number.isFinite)
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function movingAverageAt(rows, endIndex, window) {
  if (!Number.isInteger(endIndex) || endIndex < window - 1) return null;
  const values = rows.slice(endIndex - window + 1, endIndex + 1).map((row) => row.close);
  return values.length === window ? average(values) : null;
}

function metric({
  id, label, symbol = null, value = null, unit = null, comparison = null,
  window = null, asOf = null, source = null, sampleCount = null,
}) {
  return {
    id,
    label,
    symbol,
    value: finite(value),
    unit,
    comparison,
    window,
    asOf,
    source,
    sampleCount: Number.isInteger(sampleCount) ? sampleCount : null,
  };
}

function trendFacts(rows, { code = '', name = '', source = null } = {}) {
  const normalized = normalizeHistoryRows(rows);
  const clean = normalized.rows;
  const latest = clean.at(-1);
  const rules = SIGNAL_RULES.trend;
  if (!latest) {
    return {
      available: false,
      code,
      name,
      metrics: [],
      side: null,
      sampleCount: 0,
      quality: normalized.quality,
      reason: '缺少有效日线',
    };
  }
  const latestIndex = clean.length - 1;
  const ma20 = movingAverageAt(clean, latestIndex, rules.maFast);
  const ma50 = movingAverageAt(clean, latestIndex, rules.maSlow);
  const ma20FiveSessionsAgo = movingAverageAt(
    clean, latestIndex - rules.slopeLookback, rules.maFast,
  );
  const ma20ChangePct = ma20 != null && ma20FiveSessionsAgo > 0
    ? round((ma20 / ma20FiveSessionsAgo - 1) * 100, 4)
    : null;
  const priorRows = clean.slice(-(rules.breakoutWindow + 1), -1);
  const priorHighs = priorRows.map((row) => row.high).filter((value) => value != null);
  const priorLows = priorRows.map((row) => row.low).filter((value) => value != null);
  const prior20High = priorRows.length === rules.breakoutWindow
    && priorHighs.length === rules.breakoutWindow ? Math.max(...priorHighs) : null;
  const prior20Low = priorRows.length === rules.breakoutWindow
    && priorLows.length === rules.breakoutWindow ? Math.min(...priorLows) : null;
  const previousMa20 = movingAverageAt(clean, latestIndex - 1, rules.maFast);
  const previousClose = latestIndex > 0 ? clean[latestIndex - 1].close : null;
  const reclaimedMa20 = ma20 != null && previousMa20 != null
    && previousClose <= previousMa20 && latest.close > ma20;
  const lostMa20 = ma20 != null && previousMa20 != null
    && previousClose >= previousMa20 && latest.close < ma20;
  const complete = ma20 != null && ma50 != null && ma20ChangePct != null;
  let side = null;
  if (complete) {
    if (latest.close > ma20 && ma20 > ma50 && ma20ChangePct > 0) side = 'bullish';
    else if (latest.close < ma20 && ma20 < ma50 && ma20ChangePct < 0) side = 'bearish';
    else side = 'mixed';
  }
  const prefix = `trend:${safeId(code)}`;
  const summary = summarizeIndexHistory(clean);
  const metrics = [
    metric({ id: `${prefix}:close`, label: `${name || code}收盘`, symbol: code,
      value: latest.close, unit: 'index_points', asOf: latest.date, source, sampleCount: clean.length }),
    metric({ id: `${prefix}:ma20`, label: '20日均线', symbol: code,
      value: ma20, unit: 'index_points', window: '20_sessions', asOf: latest.date, source,
      sampleCount: Math.min(clean.length, rules.maFast) }),
    metric({ id: `${prefix}:ma50`, label: '50日均线', symbol: code,
      value: ma50, unit: 'index_points', window: '50_sessions', asOf: latest.date, source,
      sampleCount: Math.min(clean.length, rules.maSlow) }),
    metric({ id: `${prefix}:ma20-slope`, label: '20日均线五日变化', symbol: code,
      value: ma20ChangePct, unit: 'percent', comparison: 'ma20_5_sessions_ago',
      window: '5_sessions', asOf: latest.date, source,
      sampleCount: Math.min(clean.length, rules.maFast + rules.slopeLookback) }),
    metric({ id: `${prefix}:prior20-high`, label: '此前20日最高价', symbol: code,
      value: prior20High, unit: 'index_points', window: 'prior_20_sessions_excluding_current',
      asOf: latest.date, source, sampleCount: priorHighs.length }),
    metric({ id: `${prefix}:prior20-low`, label: '此前20日最低价', symbol: code,
      value: prior20Low, unit: 'index_points', window: 'prior_20_sessions_excluding_current',
      asOf: latest.date, source, sampleCount: priorLows.length }),
    metric({ id: `${prefix}:return1`, label: '1日收益', symbol: code,
      value: summary?.returns?.oneDayPct, unit: 'percent', window: '1_session',
      asOf: latest.date, source, sampleCount: Math.min(clean.length, 2) }),
    metric({ id: `${prefix}:return5`, label: '5日收益', symbol: code,
      value: summary?.returns?.fiveDayPct, unit: 'percent', window: '5_sessions',
      asOf: latest.date, source, sampleCount: Math.min(clean.length, 6) }),
    metric({ id: `${prefix}:return20`, label: '20日收益', symbol: code,
      value: summary?.returns?.twentyDayPct, unit: 'percent', window: '20_sessions',
      asOf: latest.date, source, sampleCount: Math.min(clean.length, 21) }),
  ];
  return {
    available: complete,
    code,
    name,
    latestDate: latest.date,
    metrics,
    side,
    sampleCount: clean.length,
    quality: normalized.quality,
    flags: {
      aboveMa20: ma20 == null ? null : latest.close > ma20,
      aboveMa50: ma50 == null ? null : latest.close > ma50,
      reclaimedMa20,
      lostMa20,
      breakoutPrior20: prior20High == null ? null : latest.close > prior20High,
      breakdownPrior20: prior20Low == null ? null : latest.close < prior20Low,
    },
    reason: complete ? null : `趋势规则至少需要${rules.maSlow}个有效交易日`,
  };
}

function alignedRelativeReturn(assetRows, benchmarkRows, intervals = 5) {
  const asset = new Map(normalizeHistoryRows(assetRows).rows.map((row) => [row.date, row.close]));
  const benchmark = new Map(normalizeHistoryRows(benchmarkRows).rows.map((row) => [row.date, row.close]));
  const dates = [...asset.keys()].filter((date) => benchmark.has(date)).sort();
  if (dates.length < intervals + 1) {
    return { valuePct: null, sampleCount: dates.length, startDate: null, endDate: null };
  }
  const endDate = dates.at(-1);
  const startDate = dates[dates.length - 1 - intervals];
  const assetEnd = asset.get(endDate);
  const assetStart = asset.get(startDate);
  const benchmarkEnd = benchmark.get(endDate);
  const benchmarkStart = benchmark.get(startDate);
  if (![assetEnd, assetStart, benchmarkEnd, benchmarkStart]
    .every((value) => Number.isFinite(value) && value > 0)) {
    return { valuePct: null, sampleCount: dates.length, startDate, endDate };
  }
  return {
    valuePct: round((((assetEnd / benchmarkEnd) / (assetStart / benchmarkStart)) - 1) * 100, 4),
    sampleCount: dates.length,
    startDate,
    endDate,
  };
}

function yieldChangeBp(previousYieldPct, currentYieldPct) {
  const previous = finite(previousYieldPct);
  const current = finite(currentYieldPct);
  return previous != null && previous > 0 && current != null && current > 0
    ? round((current - previous) * 100, 2)
    : null;
}

function makeSignal(value) {
  return {
    id: value.id,
    label: value.label,
    category: value.category,
    factorGroup: value.factorGroup,
    scope: value.scope,
    side: value.side == null ? null : value.side,
    state: value.state,
    ruleId: value.ruleId,
    metricRefs: [...new Set(value.metricRefs || [])],
    evidenceRefs: [...new Set(value.evidenceRefs || [])],
    source: value.source || null,
    asOf: value.asOf || null,
    sampleCount: Number.isInteger(value.sampleCount) ? value.sampleCount : null,
    coverage: value.coverage || null,
    rationale: value.rationale || '',
    features: value.features && typeof value.features === 'object' ? value.features : null,
  };
}

function sideFromBand(value, band) {
  if (!Number.isFinite(value)) return null;
  if (value > band) return 'bullish';
  if (value < -band) return 'bearish';
  return 'neutral';
}

function component(components, name) {
  return (Array.isArray(components) ? components : []).find((item) => item.name === name) || null;
}

function buildDirectionalSignals({
  market,
  reviewDate,
  indexHistories = [],
  relativeHistories = {},
  components = [],
  alignedEvidenceRefs = [],
}) {
  if (market !== 'cn' && market !== 'us') {
    return {
      status: 'unavailable', metrics: [], computedSignals: [], watchTriggers: [],
      availableGroups: [], missingGroups: ['unsupported_market'], qualityWarnings: [],
    };
  }
  const metrics = [];
  const computedSignals = [];
  const watchTriggers = [];
  const missingGroups = [];
  const qualityWarnings = [];
  const aligned = new Set(alignedEvidenceRefs);
  const addMetrics = (values) => metrics.push(...values);

  for (const history of indexHistories) {
    const trend = trendFacts(history.rows, history);
    addMetrics(trend.metrics);
    if (trend.quality.conflictingDuplicateDates.length) {
      qualityWarnings.push(`${history.code} 日线存在冲突重复日期，按最后一条记录确定`);
    }
    const signalId = `trend:${safeId(history.code)}`;
    computedSignals.push(makeSignal({
      id: signalId,
      label: `${history.name || history.code}趋势结构`,
      category: 'trend',
      factorGroup: 'index_trend',
      scope: `index:${history.code}`,
      side: trend.side,
      state: trend.available ? 'observed' : 'unavailable',
      ruleId: 'trend.ma20_ma50_slope.v1',
      metricRefs: trend.metrics.filter((item) => item.value != null).map((item) => item.id),
      evidenceRefs: ['indexHistory'],
      source: history.source,
      asOf: trend.latestDate,
      sampleCount: trend.sampleCount,
      coverage: trend.available ? '完整均线窗口' : trend.reason,
      rationale: trend.available
        ? '收盘价、20日均线、50日均线及20日均线五日变化共同判断结构'
        : trend.reason,
      features: trend.flags,
    }));
    if (trend.available) {
      const ma20Ref = `trend:${safeId(history.code)}:ma20`;
      watchTriggers.push({
        id: `watch:${safeId(history.code)}:ma20`,
        label: `${history.name || history.code}与20日均线关系`,
        scope: `index:${history.code}`,
        state: 'conditional',
        side: trend.side === 'bearish' ? 'bullish' : 'bearish',
        metricRef: `trend:${safeId(history.code)}:close`,
        operator: trend.side === 'bearish' ? 'crosses_above' : 'crosses_below',
        comparisonRef: ma20Ref,
        window: 'next_session',
        unit: 'index_points',
        source: history.source,
      });
    }
  }
  if (!indexHistories.length) missingGroups.push('index_trend');

  if (market === 'us') {
    const sectorComponent = component(components, 'usSectorProxies');
    const stats = sectorComponent?.data?.stats || {};
    const sectorTotal = finite(stats.total);
    const sectorUp = finite(stats.up);
    const sectorMetricBase = 'breadth:us-sector-etf';
    addMetrics([
      metric({ id: `${sectorMetricBase}:up`, label: '上涨行业ETF数量', value: sectorUp,
        unit: 'count', comparison: SIGNAL_RULES.usSectorBreadth.required,
        window: 'review_session', asOf: reviewDate, source: sectorComponent?.meta?.source,
        sampleCount: sectorTotal }),
      metric({ id: `${sectorMetricBase}:valid`, label: '有效行业ETF数量', value: sectorTotal,
        unit: 'count', comparison: SIGNAL_RULES.usSectorBreadth.required,
        window: 'review_session', asOf: reviewDate, source: sectorComponent?.meta?.source,
        sampleCount: sectorTotal }),
    ]);
    const sectorComplete = sectorTotal === SIGNAL_RULES.usSectorBreadth.required
      && sectorUp != null && aligned.has('usSectorProxies');
    let sectorSide = null;
    if (sectorComplete) {
      if (sectorUp >= SIGNAL_RULES.usSectorBreadth.bullishMinUp) sectorSide = 'bullish';
      else if (sectorUp <= SIGNAL_RULES.usSectorBreadth.bearishMaxUp) sectorSide = 'bearish';
      else sectorSide = 'mixed';
    }
    computedSignals.push(makeSignal({
      id: 'breadth:us-sector-etf',
      label: '美股行业ETF参与度代理',
      category: 'breadth', factorGroup: 'participation', scope: 'us_market_proxy',
      side: sectorSide, state: sectorComplete ? 'observed' : 'unavailable',
      ruleId: 'breadth.us_sector_etf_11.v1',
      metricRefs: [`${sectorMetricBase}:up`, `${sectorMetricBase}:valid`],
      evidenceRefs: ['usSectorProxies'], source: sectorComponent?.meta?.source,
      asOf: reviewDate, sampleCount: sectorTotal == null ? 0 : sectorTotal,
      coverage: sectorComplete ? '11只SPDR行业ETF完整' : `有效${sectorTotal || 0}/11只`,
      rationale: sectorComplete
        ? '完整11只行业ETF中至少8只上涨视为参与度偏强，至多3只上涨视为偏弱'
        : '分母不完整，仅保留事实，不套用强弱阈值',
    }));
    if (!sectorComplete) missingGroups.push('participation');

    const relativePairs = [
      ['SOXX', 'SPY', '半导体相对大盘', 'semiconductor_style'],
      ['QQQ', 'SPY', '成长风格相对大盘', 'growth_style'],
      ['RSP', 'SPY', '等权相对市值加权', 'concentration_proxy'],
    ];
    for (const [assetCode, benchmarkCode, label, category] of relativePairs) {
      const result = alignedRelativeReturn(
        relativeHistories[assetCode], relativeHistories[benchmarkCode],
        SIGNAL_RULES.relativeStrength.sessions,
      );
      const id = `relative:${safeId(assetCode)}-${safeId(benchmarkCode)}:5d`;
      addMetrics([metric({
        id, label: `${label}五日相对收益`, symbol: `${assetCode}/${benchmarkCode}`,
        value: result.valuePct, unit: 'percent', comparison: {
          neutralBandPct: SIGNAL_RULES.relativeStrength.neutralBandPct,
          benchmark: benchmarkCode,
        }, window: '5_common_sessions', asOf: result.endDate,
        source: 'Yahoo Finance（复权日线）', sampleCount: result.sampleCount,
      })]);
      computedSignals.push(makeSignal({
        id: `signal:${safeId(assetCode)}-${safeId(benchmarkCode)}:5d`,
        label, category, factorGroup: 'style_participation', scope: 'us_market_proxy',
        side: sideFromBand(result.valuePct, SIGNAL_RULES.relativeStrength.neutralBandPct),
        state: result.valuePct == null ? 'unavailable' : 'observed',
        ruleId: 'relative_return.common_sessions_5d.v1', metricRefs: [id],
        evidenceRefs: ['directionalSignalFacts'], source: 'Yahoo Finance（复权日线）',
        asOf: result.endDate, sampleCount: result.sampleCount,
        coverage: result.valuePct == null ? '共同交易日不足' : `${result.startDate} 至 ${result.endDate}`,
        rationale: `${assetCode}与${benchmarkCode}按共同交易日对齐，中性带为±${SIGNAL_RULES.relativeStrength.neutralBandPct}%`,
      }));
    }
    if (relativePairs.some(([assetCode, benchmarkCode]) => (
      !relativeHistories[assetCode] || !relativeHistories[benchmarkCode]
    ))) missingGroups.push('style_participation');

    const macroComponent = component(components, 'macroProxies');
    const macroRows = Array.isArray(macroComponent?.data) ? macroComponent.data : [];
    const macroAligned = aligned.has('macroProxies');
    for (const code of ['^VIX', '^TNX', 'DX-Y.NYB', 'CL=F']) {
      const row = macroRows.find((item) => item.code === code);
      const value = code === '^TNX' ? finite(row?.changeBp) : finite(row?.changePct);
      const threshold = code === '^VIX' ? SIGNAL_RULES.macro.vixPct
        : code === '^TNX' ? SIGNAL_RULES.macro.yieldBp
          : code === 'DX-Y.NYB' ? SIGNAL_RULES.macro.dollarPct : null;
      const unit = code === '^TNX' ? 'basis_points' : 'percent';
      const id = `macro:${safeId(code)}:change`;
      addMetrics([metric({ id, label: `${row?.name || code}当日变化`, symbol: code,
        value, unit, comparison: threshold, window: 'review_session', asOf: row?.asOf,
        source: macroComponent?.meta?.source, sampleCount: value == null ? 0 : 1 })]);
      let side = null;
      if (value != null && macroAligned) {
        if (threshold == null || Math.abs(value) < threshold) side = 'neutral';
        else side = value < 0 ? 'bullish' : 'bearish';
      }
      computedSignals.push(makeSignal({
        id: `signal:macro:${safeId(code)}`,
        label: `${row?.name || code}风险环境`, category: 'macro_environment',
        factorGroup: 'macro_environment', scope: 'us_market_environment', side,
        state: value != null && macroAligned ? 'observed' : 'unavailable',
        ruleId: threshold == null ? 'macro.context_only.v1' : 'macro.change_band.v1',
        metricRefs: [id], evidenceRefs: ['macroProxies'], source: macroComponent?.meta?.source,
        asOf: row?.asOf || null, sampleCount: value == null ? 0 : 1,
        coverage: macroAligned ? '收盘截止前同步代理' : '未满足收盘时点对齐',
        rationale: threshold == null
          ? '仅作环境观察，不机械映射股市方向'
          : '超过初始变化带时作为风险环境反证，不能单独决定大盘方向',
      }));
    }
    if (!macroAligned) missingGroups.push('macro_environment');

    const spyTrend = trendFacts(relativeHistories.SPY || [], {
      code: 'SPY', name: 'SPY', source: 'Yahoo Finance（复权日线）',
    });
    const volumeRatio = spyTrend.metrics.length
      ? summarizeIndexHistory(relativeHistories.SPY || [])?.volume?.ratioToAverage20
      : null;
    const spyReturn = summarizeIndexHistory(relativeHistories.SPY || [])?.returns?.oneDayPct;
    addMetrics([
      metric({ id: 'volume:spy:ratio20', label: 'SPY成交量/此前20日均量',
        symbol: 'SPY', value: volumeRatio, unit: 'ratio', comparison: SIGNAL_RULES.volume.ratio,
        window: 'previous_20_sessions', asOf: reviewDate, source: 'Yahoo Finance（ETF量能代理）',
        sampleCount: summarizeIndexHistory(relativeHistories.SPY || [])?.volume?.sampleCount || 0 }),
      spyTrend.metrics.find((item) => item.id === 'trend:spy:return1'),
    ].filter(Boolean));
    let volumeSide = null;
    if (volumeRatio != null && spyReturn != null) {
      if (volumeRatio >= SIGNAL_RULES.volume.ratio && spyReturn > 0) volumeSide = 'bullish';
      else if (volumeRatio >= SIGNAL_RULES.volume.ratio && spyReturn < 0) volumeSide = 'bearish';
      else volumeSide = 'neutral';
    }
    computedSignals.push(makeSignal({
      id: 'signal:volume:spy', label: 'SPY量价代理', category: 'volume',
      factorGroup: 'liquidity', scope: 'us_market_proxy', side: volumeSide,
      state: volumeRatio == null || spyReturn == null ? 'unavailable' : 'observed',
      ruleId: 'volume.spy_ratio20.v1', metricRefs: ['volume:spy:ratio20', 'trend:spy:return1'],
      evidenceRefs: ['directionalSignalFacts'], source: 'Yahoo Finance（ETF量能代理）',
      asOf: reviewDate, sampleCount: spyTrend.sampleCount,
      coverage: 'SPY ETF量能代理，不代表美股全市场成交额',
      rationale: '仅在成交量达到此前20日均量1.2倍且价格同向时作为量价确认',
    }));
  }

  if (market === 'cn') {
    const overviewComponent = component(components, 'overview');
    const overview = overviewComponent?.data || {};
    const upRatio = finite(overview.upRatioPct);
    const up = finite(overview.up);
    const nonUp = finite(overview.nonUp);
    const total = finite(overview.total);
    const breadthComplete = upRatio != null && up != null && nonUp != null && total > 0
      && up + nonUp === total && aligned.has('overview');
    addMetrics([
      metric({ id: 'breadth:cn:up-ratio', label: 'A股上涨占比', value: upRatio,
        unit: 'percent', comparison: {
          bullishPct: SIGNAL_RULES.cnBreadth.bullishPct,
          bearishPct: SIGNAL_RULES.cnBreadth.bearishPct,
        }, window: 'review_session', asOf: reviewDate, source: overviewComponent?.meta?.source,
        sampleCount: total }),
      metric({ id: 'breadth:cn:non-up', label: '未上涨数量（含下跌、平盘与停牌）', value: nonUp,
        unit: 'count', comparison: total, window: 'review_session', asOf: reviewDate,
        source: overviewComponent?.meta?.source, sampleCount: total }),
    ]);
    computedSignals.push(makeSignal({
      id: 'breadth:cn:market', label: 'A股市场参与度', category: 'breadth',
      factorGroup: 'participation', scope: 'cn_market',
      side: breadthComplete
        ? upRatio >= SIGNAL_RULES.cnBreadth.bullishPct ? 'bullish'
          : upRatio <= SIGNAL_RULES.cnBreadth.bearishPct ? 'bearish' : 'neutral'
        : null,
      state: breadthComplete ? 'observed' : 'unavailable', ruleId: 'breadth.cn_up_ratio.v1',
      metricRefs: ['breadth:cn:up-ratio', 'breadth:cn:non-up'], evidenceRefs: ['overview'],
      source: overviewComponent?.meta?.source, asOf: reviewDate,
      sampleCount: total == null ? 0 : total,
      coverage: breadthComplete ? overview.breadthBasis || '上涨/未上涨口径完整' : '上涨/未上涨分母不完整',
      rationale: '上涨占比至少60%视为参与度偏强，至多40%视为偏弱；未上涨不等于下跌',
    }));

    const sectorsComponent = component(components, 'sectors');
    const sectorStats = sectorsComponent?.data?.stats || {};
    const sectorRatio = finite(sectorStats.upRatioPct);
    const sectorCount = finite(sectorStats.totalCount);
    addMetrics([metric({ id: 'breadth:cn:sector-up-ratio', label: 'A股行业上涨占比',
      value: sectorRatio, unit: 'percent', comparison: {
        bullishPct: SIGNAL_RULES.cnBreadth.bullishPct,
        bearishPct: SIGNAL_RULES.cnBreadth.bearishPct,
      }, window: 'review_session', asOf: reviewDate, source: sectorsComponent?.meta?.source,
      sampleCount: sectorCount })]);
    const sectorsAligned = aligned.has('sectors');
    computedSignals.push(makeSignal({
      id: 'breadth:cn:sectors', label: 'A股行业扩散度', category: 'breadth',
      factorGroup: 'participation', scope: 'cn_sector_sample',
      side: sectorRatio == null || !sectorsAligned ? null
        : sectorRatio >= SIGNAL_RULES.cnBreadth.bullishPct ? 'bullish'
          : sectorRatio <= SIGNAL_RULES.cnBreadth.bearishPct ? 'bearish' : 'neutral',
      state: sectorRatio == null || !sectorsAligned ? 'unavailable' : 'observed',
      ruleId: 'breadth.cn_sector_ratio.v1', metricRefs: ['breadth:cn:sector-up-ratio'],
      evidenceRefs: ['sectors'], source: sectorsComponent?.meta?.source, asOf: reviewDate,
      sampleCount: sectorCount == null ? 0 : sectorCount,
      coverage: '腾讯行业分类样本，不等于全市场个股宽度',
      rationale: '行业上涨分布用于识别指数上涨是否过度集中',
    }));

    const comparison = overview.turnoverComparison || {};
    const primaryTrend = indexHistories[0] ? trendFacts(indexHistories[0].rows, indexHistories[0]) : null;
    const indexChange = primaryTrend
      ? summarizeIndexHistory(indexHistories[0].rows)?.returns?.oneDayPct : null;
    const turnoverChange = finite(comparison.changePct);
    const fullDayTurnover = comparison.available === true
      && comparison.mode === 'previous_trading_day_close'
      && comparison.basis === 'sh_sz_market_total'
      && comparison.currentDate === reviewDate;
    addMetrics([metric({ id: 'liquidity:cn:turnover-change', label: '沪深全日成交额较前日变化',
      value: turnoverChange, unit: 'percent', comparison: SIGNAL_RULES.cnTurnover.expansionPct,
      window: 'previous_trading_day_close', asOf: reviewDate, source: overviewComponent?.meta?.source,
      sampleCount: fullDayTurnover && turnoverChange != null ? 2 : 0 })]);
    let turnoverSide = null;
    if (fullDayTurnover && turnoverChange != null && indexChange != null) {
      if (turnoverChange >= SIGNAL_RULES.cnTurnover.expansionPct && indexChange > 0) turnoverSide = 'bullish';
      else if (turnoverChange >= SIGNAL_RULES.cnTurnover.expansionPct && indexChange < 0) turnoverSide = 'bearish';
      else turnoverSide = 'neutral';
    }
    computedSignals.push(makeSignal({
      id: 'liquidity:cn:price-volume', label: 'A股量价确认', category: 'liquidity',
      factorGroup: 'liquidity', scope: 'cn_sh_sz_market', side: turnoverSide,
      state: fullDayTurnover && turnoverChange != null && indexChange != null
        ? 'observed' : 'unavailable',
      ruleId: 'liquidity.cn_full_day_price_volume.v1',
      metricRefs: ['liquidity:cn:turnover-change', primaryTrend
        ? `trend:${safeId(indexHistories[0].code)}:return1` : ''].filter(Boolean),
      evidenceRefs: ['overview', 'indexHistory'], source: overviewComponent?.meta?.source,
      asOf: reviewDate, sampleCount: fullDayTurnover ? 2 : 0,
      coverage: fullDayTurnover
        ? '沪深市场全日同源成交额，不含北交所'
        : `未采用：${comparison.mode || comparison.basis || comparison.reason || '缺少完整全日同源比较'}`,
      rationale: '仅把指数同向且全日成交额较前日增加至少5%视为量价确认；缩量不自动反向',
    }));
    if (!breadthComplete) missingGroups.push('participation');
    if (!fullDayTurnover) missingGroups.push('liquidity');
  }

  const availableGroups = [...new Set(computedSignals
    .filter((signal) => signal.state === 'observed')
    .map((signal) => signal.factorGroup))];
  const status = availableGroups.length
    ? computedSignals.some((signal) => signal.state === 'unavailable') ? 'partial' : 'ready'
    : 'unavailable';
  return {
    status,
    metrics,
    computedSignals,
    watchTriggers,
    availableGroups,
    missingGroups: [...new Set(missingGroups)],
    qualityWarnings,
  };
}

module.exports = {
  SIGNAL_RULES,
  alignedRelativeReturn,
  buildDirectionalSignals,
  movingAverageAt,
  trendFacts,
  yieldChangeBp,
};
