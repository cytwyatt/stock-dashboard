'use strict';

// ---------- 个股研究卡（复权日线 + 同市场价格指数基准） ----------
const RESEARCH_DAYS = 400;
const RESEARCH_HORIZONS = [1, 5, 20, 60, 120];
const RESEARCH_BENCHMARKS = {
  cn: { code: 'sh000300', name: '沪深300' },
  hk: { code: 'hkHSI', name: '恒生指数' },
  us: { code: '^GSPC', name: '标普500' },
};

const roundMetric = (value, digits = 2) => {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
};

function normalizeDailySeries(rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row && row.date || '');
    const close = Number(row && row.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) continue;
    const high = Number(row.high);
    const low = Number(row.low);
    const volume = Number(row.volume);
    byDate.set(date, {
      date,
      close,
      high: Number.isFinite(high) && high > 0 ? high : close,
      low: Number.isFinite(low) && low > 0 ? low : close,
      volume: Number.isFinite(volume) && volume >= 0 ? volume : null,
    });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function rowAtOrBefore(rows, date) {
  let lo = 0, hi = rows.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].date <= date) {
      found = rows[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

// 以基准指数的交易日历为准；股票停牌缺失的日期只向前取最近已知收盘，不使用未来数据。
function alignToBenchmarkCalendar(stockRows, benchmarkRows) {
  if (!stockRows.length || !benchmarkRows.length) return [];
  return benchmarkRows
    .map((benchmark) => {
      const stock = rowAtOrBefore(stockRows, benchmark.date);
      return stock ? {
        date: benchmark.date,
        stockDate: stock.date,
        stockClose: stock.close,
        benchmarkClose: benchmark.close,
      } : null;
    })
    .filter(Boolean);
}

function insufficientMetric(required, actual, extra = {}) {
  return { value: null, reason: 'insufficient_history', required, actual, ...extra };
}

function computeResearchReturns(aligned, stockRows, benchmarkAvailable) {
  const standalone = stockRows.map((row) => ({
    date: row.date,
    stockDate: row.date,
    stockClose: row.close,
  }));
  const out = {};
  for (const sessions of RESEARCH_HORIZONS) {
    const required = sessions + 1;
    const canCompare = benchmarkAvailable && aligned.length >= required;
    // 基准覆盖完整时按市场交易日历计算；基准短缺时，个股自身收益仍退回其有效交易日序列。
    const assetSeries = canCompare || aligned.length >= required ? aligned : standalone;
    if (assetSeries.length < required) {
      out[`${sessions}d`] = {
        assetPct: null, benchmarkPct: null, excessPct: null,
        reason: 'insufficient_history', required, actual: assetSeries.length,
        comparisonReason: benchmarkAvailable ? 'benchmark_insufficient_history' : 'benchmark_unavailable',
        benchmarkRequired: required,
        benchmarkActual: aligned.length,
      };
      continue;
    }
    const start = assetSeries[assetSeries.length - required];
    const end = assetSeries[assetSeries.length - 1];
    const assetPct = (end.stockClose / start.stockClose - 1) * 100;
    const comparisonStart = canCompare ? aligned[aligned.length - required] : null;
    const comparisonEnd = canCompare ? aligned[aligned.length - 1] : null;
    const hasBenchmarkPrices = canCompare
      && Number.isFinite(comparisonStart.benchmarkClose) && comparisonStart.benchmarkClose > 0
      && Number.isFinite(comparisonEnd.benchmarkClose) && comparisonEnd.benchmarkClose > 0;
    const benchmarkPct = hasBenchmarkPrices
      ? (comparisonEnd.benchmarkClose / comparisonStart.benchmarkClose - 1) * 100
      : null;
    out[`${sessions}d`] = {
      assetPct: roundMetric(assetPct),
      benchmarkPct: roundMetric(benchmarkPct),
      // “超额”是同区间简单收益率的百分点差，不表示风险调整后的 alpha。
      excessPct: hasBenchmarkPrices ? roundMetric(assetPct - benchmarkPct) : null,
      startDate: start.date,
      endDate: end.date,
      calendarBasis: canCompare ? 'benchmark_trading_calendar' : 'asset_trading_calendar',
      ...(hasBenchmarkPrices ? {} : {
        comparisonReason: benchmarkAvailable ? 'benchmark_insufficient_history' : 'benchmark_unavailable',
        benchmarkRequired: required,
        benchmarkActual: aligned.length,
      }),
    };
  }
  return out;
}

function computeAnnualizedVolatility(aligned, stockRows) {
  const required = 21; // 20个日收益需要21个收盘价
  const useAligned = aligned.length >= required;
  const points = useAligned
    ? aligned.map((row) => ({ date: row.date, close: row.stockClose }))
    : stockRows.map((row) => ({ date: row.date, close: row.close }));
  const closes = points.map((row) => row.close);
  if (closes.length < required) return insufficientMetric(required, closes.length, { annualizationDays: 252 });
  const sample = closes.slice(-required);
  const returns = sample.slice(1).map((close, i) => close / sample[i] - 1);
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
  return {
    value: roundMetric(Math.sqrt(variance) * Math.sqrt(252) * 100),
    observations: returns.length,
    annualizationDays: 252,
    asOf: points[points.length - 1].date,
    calendarBasis: useAligned ? 'benchmark_trading_calendar' : 'asset_trading_calendar',
  };
}

function computeMaxDrawdown(aligned, stockRows, sessions = 120) {
  const required = sessions + 1;
  const useAligned = aligned.length >= required;
  const points = useAligned
    ? aligned.map((row) => ({ date: row.date, close: row.stockClose }))
    : stockRows.map((row) => ({ date: row.date, close: row.close }));
  if (points.length < required) return insufficientMetric(required, points.length, { sessions });
  const sample = points.slice(-required);
  let peak = sample[0].close;
  let peakDate = sample[0].date;
  let worst = 0;
  let worstPeakDate = peakDate;
  let troughDate = peakDate;
  for (const point of sample) {
    if (point.close > peak) {
      peak = point.close;
      peakDate = point.date;
    }
    const drawdown = point.close / peak - 1;
    if (drawdown < worst) {
      worst = drawdown;
      worstPeakDate = peakDate;
      troughDate = point.date;
    }
  }
  return {
    value: roundMetric(worst * 100),
    sessions,
    peakDate: worstPeakDate,
    troughDate,
    currentPct: roundMetric((sample[sample.length - 1].close / peak - 1) * 100),
    asOf: sample[sample.length - 1].date,
    calendarBasis: useAligned ? 'benchmark_trading_calendar' : 'asset_trading_calendar',
  };
}

function compute52WeekRange(stockRows) {
  if (!stockRows.length) return insufficientMetric(365, 0, { window: '365_calendar_days' });
  const latest = stockRows[stockRows.length - 1];
  const latestMs = Date.parse(`${latest.date}T00:00:00Z`);
  const cutoffMs = latestMs - 365 * 86400000;
  const firstMs = Date.parse(`${stockRows[0].date}T00:00:00Z`);
  if (!Number.isFinite(latestMs) || !Number.isFinite(firstMs) || firstMs > cutoffMs) {
    return insufficientMetric(365, Math.max(0, Math.floor((latestMs - firstMs) / 86400000)), {
      window: '365_calendar_days',
    });
  }
  const sample = stockRows.filter((row) => Date.parse(`${row.date}T00:00:00Z`) >= cutoffMs);
  const high = Math.max(...sample.map((row) => row.high));
  const low = Math.min(...sample.map((row) => row.low));
  const hasRange = high > low;
  return {
    value: roundMetric((latest.close / high - 1) * 100),
    high: roundMetric(high, 4),
    low: roundMetric(low, 4),
    distanceToHighPct: roundMetric((latest.close / high - 1) * 100),
    distanceAboveLowPct: roundMetric((latest.close / low - 1) * 100),
    positionPct: hasRange ? roundMetric(((latest.close - low) / (high - low)) * 100) : null,
    sessions: sample.length,
    startDate: sample[0].date,
    endDate: latest.date,
    window: '365_calendar_days',
    ...(hasRange ? {} : { reason: 'flat_range' }),
  };
}

function computeRelativeVolume(stockRows, { latestBarComplete = true } = {}) {
  const endIndex = stockRows.length - (latestBarComplete ? 1 : 2);
  const required = 21;
  if (endIndex < 20) return insufficientMetric(required, Math.max(0, endIndex + 1), {
    basis: 'latest_complete_session_vs_prior_20_sessions',
  });
  const latest = stockRows[endIndex];
  const previous = stockRows.slice(endIndex - 20, endIndex)
    .map((row) => row.volume)
    .filter((value) => Number.isFinite(value) && value > 0);
  if (previous.length < 20 || !Number.isFinite(latest.volume) || latest.volume < 0) {
    return insufficientMetric(required, previous.length + (Number.isFinite(latest.volume) ? 1 : 0), {
      basis: 'latest_complete_session_vs_prior_20_sessions',
    });
  }
  const average = previous.reduce((sum, value) => sum + value, 0) / previous.length;
  if (average <= 0) return { value: null, reason: 'zero_average_volume' };
  return {
    value: roundMetric(latest.volume / average),
    latest: latest.volume,
    average20: roundMetric(average, 2),
    asOf: latest.date,
    excludedPartialSession: !latestBarComplete,
    basis: 'latest_complete_session_vs_prior_20_sessions',
  };
}

function buildResearchSignals(card) {
  const signals = [];
  const add = (code, severity, label, detail) => signals.push({ code, severity, label, detail });
  const volatility = card.risk.volatility20.value;
  const drawdown = card.risk.maxDrawdown120.value;
  const volume = card.volume20.value;
  const range = card.range52.value;
  const aboveLow = card.range52.distanceAboveLowPct;
  const excess20 = card.returns['20d'].excessPct;
  if (card.quality.stale) add('DATA_STALE', 'warning', '个股历史数据为旧缓存', '刷新失败，所有指标应结合数据日期谨慎使用');
  if (card.benchmark.stale) add('BENCHMARK_STALE', 'warning', '基准历史数据为旧缓存', '相对收益可能未反映最新基准行情');
  if (card.lastTradeDate < card.analysisAsOf) {
    add('NO_RECENT_TRADE', 'attention', '最近交易日早于分析日', `最近成交 ${card.lastTradeDate}，已按最后收盘延用至 ${card.analysisAsOf}`);
  }
  if (card.comparisonAsOf && card.comparisonAsOf < card.lastTradeDate) {
    add('BENCHMARK_LAGGING', 'attention', '基准截止日较早', `个股最近交易日 ${card.lastTradeDate}，相对收益统一截止 ${card.comparisonAsOf}`);
  }
  if (card.benchmark.available && card.historySessions >= 121 && card.alignedSessions < 121) {
    add('BENCHMARK_HISTORY_LIMITED', 'info', '基准历史覆盖较短', `仅对齐 ${card.alignedSessions} 个交易日，长期超额收益暂不展示`);
  }
  if (volatility != null && volatility >= 40) add('HIGH_VOLATILITY', 'warning', '短期波动偏高', `20日年化波动率 ${volatility}%`);
  if (drawdown != null && drawdown <= -30) add('DEEP_DRAWDOWN', 'warning', '阶段回撤较深', `近120日最大回撤 ${drawdown}%`);
  if (excess20 != null && excess20 <= -5) add('UNDERPERFORM_20D', 'attention', '近20日跑输基准', `超额收益 ${excess20}个百分点`);
  if (volume != null && volume >= 2) add('VOLUME_SURGE', 'info', '最近完整日量能放大', `为此前20日均量的 ${volume} 倍`);
  if (card.range52.positionPct != null && range != null && range >= -5) {
    add('NEAR_52W_HIGH', 'info', '接近52周高位', `距52周高点 ${range}%`);
  }
  if (card.range52.positionPct != null && aboveLow != null && aboveLow <= 5) {
    add('NEAR_52W_LOW', 'attention', '接近52周低位', `较52周低点 ${aboveLow}%`);
  }
  if (card.range52.reason === 'flat_range') add('FLAT_52W_RANGE', 'info', '52周价格区间无波动', '区间最高价与最低价相同');
  if (card.historySessions < 121 || card.range52.value == null) {
    add('INSUFFICIENT_HISTORY', 'info', '部分长期指标数据不足', `当前获得 ${card.historySessions} 个有效交易日`);
  }
  return signals;
}

function computeResearchCard(stockInput, benchmarkInput, options = {}) {
  const stockRows = normalizeDailySeries(stockInput);
  const benchmarkRows = normalizeDailySeries(benchmarkInput);
  if (!stockRows.length) throw new Error('no valid daily history');
  const latest = stockRows[stockRows.length - 1];
  // 个股缓存已 stale 时，不用更晚的基准日期把旧价格向前延展，避免伪装成当前估值。
  const comparableBenchmarkRows = options.stockStale
    ? benchmarkRows.filter((row) => row.date <= latest.date)
    : benchmarkRows;
  const aligned = alignToBenchmarkCalendar(stockRows, comparableBenchmarkRows);
  const benchmarkAvailable = benchmarkRows.length > 0 && aligned.length > 0;
  const latestBarComplete = options.latestBarComplete !== false;
  const completeStockRows = latestBarComplete ? stockRows : stockRows.slice(0, -1);
  const riskBenchmarkRows = latestBarComplete
    ? comparableBenchmarkRows
    : comparableBenchmarkRows.filter((row) => row.date < latest.date);
  const riskAligned = alignToBenchmarkCalendar(completeStockRows, riskBenchmarkRows);
  const comparisonAsOf = aligned.length ? aligned[aligned.length - 1].date : null;
  const analysisAsOf = [latest.date, comparisonAsOf].filter(Boolean).sort().at(-1);
  const card = {
    code: options.code || '',
    market: options.market || null,
    currency: options.currency || null,
    analysisAsOf,
    lastTradeDate: latest.date,
    comparisonAsOf,
    latestBarComplete,
    historySessions: stockRows.length,
    alignedSessions: aligned.length,
    latestClose: roundMetric(latest.close, 4),
    benchmark: {
      code: options.benchmarkCode || '',
      name: options.benchmarkName || '',
      type: 'price_index',
      available: benchmarkAvailable,
      asOf: comparisonAsOf,
      stale: !!options.benchmarkStale,
      adjustmentBasis: options.benchmarkAdjustmentBasis || null,
    },
    returns: computeResearchReturns(aligned, stockRows, benchmarkAvailable),
    range52: compute52WeekRange(stockRows),
    risk: {
      volatility20: computeAnnualizedVolatility(riskAligned, completeStockRows),
      maxDrawdown120: computeMaxDrawdown(riskAligned, completeStockRows, 120),
    },
    volume20: computeRelativeVolume(stockRows, { latestBarComplete }),
    quality: {
      adjustmentBasis: options.adjustmentBasis || 'none',
      degraded: ['raw_fallback', 'partial_adjusted'].includes(options.adjustmentBasis),
      stale: !!options.stockStale,
      comparison: {
        type: 'price_index',
        adjustmentBasis: options.benchmarkAdjustmentBasis || 'none',
        stale: !!options.benchmarkStale,
        // 固定基准均为价格指数，raw 指数点位本身不是公司行动复权降级。
        degraded: !!options.benchmarkStale,
        adjustmentRequired: false,
      },
    },
    methodology: {
      returns: 'provider_adjusted_close_on_benchmark_calendar_with_asset_calendar_fallback',
      suspendedDays: 'last_known_close_carried_forward_without_lookahead',
      excess: 'asset_return_minus_price_index_return_percentage_points',
      volatility: '20_simple_daily_returns_sample_stddev_annualized_252',
      maxDrawdown: '120_complete_sessions_adjusted_close',
      range52: '365_calendar_days_adjusted_ohlc',
      volume: 'latest_complete_session_volume_vs_prior_20_session_average',
      comparisonBasis: 'provider_adjusted_asset_vs_price_index',
      partialSessionRisk: 'unfinished_daily_bar_excluded_from_volatility_and_drawdown',
    },
  };
  card.signals = buildResearchSignals(card);
  if (card.quality.degraded) {
    card.signals.unshift({
      code: 'DEGRADED_ADJUSTMENT', severity: 'warning', label: '复权质量降级',
      detail: `当前价格口径为 ${card.quality.adjustmentBasis}`,
    });
  }
  if (!benchmarkAvailable) {
    card.signals.unshift({
      code: 'BENCHMARK_UNAVAILABLE', severity: 'warning', label: '基准暂不可用',
      detail: '个股收益仍可计算，超额收益暂不展示',
    });
  }
  return card;
}

module.exports = {
  RESEARCH_DAYS,
  RESEARCH_HORIZONS,
  RESEARCH_BENCHMARKS,
  roundMetric,
  normalizeDailySeries,
  rowAtOrBefore,
  alignToBenchmarkCalendar,
  insufficientMetric,
  computeResearchReturns,
  computeAnnualizedVolatility,
  computeMaxDrawdown,
  compute52WeekRange,
  computeRelativeVolume,
  buildResearchSignals,
  computeResearchCard,
};
