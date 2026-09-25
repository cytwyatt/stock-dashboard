'use strict';

// Price/volume characteristics of one security, compared with its own past.
// No peer universe, fitted factor portfolio, composite score or expected return.
const FACTOR_VERSION = 'stock-price-factors-v1';
const REFERENCE_SESSIONS = 120;
const MIN_REFERENCE_OBSERVATIONS = 60;
const HISTORY_SESSIONS = 60;

const DEFINITIONS = [
  { id: 'momentum', label: '中期动量', group: 'momentum', unit: 'percent', required: 127,
    definition: '第126个交易区间之前至第21个交易区间之前的复权收盘收益，跳过最近21个区间。',
    highMeaning: '数值越高，中期价格动量越强；这是126→21日窗口，不等同于学术12→2月动量组合。' },
  { id: 'relativeStrength', label: '相对强弱', group: 'momentum', unit: 'percentage_points', required: 61,
    definition: '最近60个共同完整交易区间的个股简单收益减同市场价格指数收益。',
    highMeaning: '正值表示跑赢基准；这是收益百分点差，不是风险调整后的 Alpha。' },
  { id: 'volatility', label: '波动率', group: 'risk', unit: 'percent', required: 61,
    definition: '最近60个完整日简单收益的样本标准差 × √252，换算为百分比。',
    highMeaning: '数值越高，历史价格波动越大；高分位不表示更优。' },
  { id: 'beta', label: '市场 Beta', group: 'risk', unit: 'beta', required: 61,
    definition: '最近60个共同完整日收益与基准收益的协方差 ÷ 基准收益方差。',
    highMeaning: '描述对基准的历史线性敏感度；接近1表示敏感度接近基准，负值表示历史反向关系，不代表未来表现。' },
  { id: 'drawdown', label: '回撤幅度', group: 'risk', unit: 'percent', required: 121,
    definition: '最近120个完整交易区间内，复权收盘价从峰值到后续谷值的最大跌幅绝对值。',
    highMeaning: '以正数表示回撤幅度，数值越高表示历史跌幅越深。' },
  { id: 'volume', label: '相对量能', group: 'activity', unit: 'multiple', required: 21,
    definition: '最近完整交易日成交量 ÷ 此前20个完整交易日平均成交量。',
    highMeaning: '数值越高表示相对自身近期更活跃；不等同于流动性、真实资金流或盘中量比。' },
];

function rounded(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function dailyReturns(rows) {
  return rows.slice(1).map((row, i) => row.close / rows[i].close - 1);
}

function evaluate(def, stock, benchmark, stockByDate, end) {
  if (end + 1 < def.required) return { value: null, reason: 'insufficient_history' };
  const sample = stock.slice(end + 1 - def.required, end + 1);
  const latest = sample.at(-1);
  if (def.id === 'momentum') {
    return { value: (stock[end - 21].close / sample[0].close - 1) * 100 };
  }
  if (def.id === 'volume') {
    if (sample.some((row) => !Number.isFinite(row.volume) || row.volume < 0)) {
      return { value: null, reason: 'missing_volume' };
    }
    const average = mean(sample.slice(0, -1).map((row) => row.volume));
    return average > 0 ? { value: latest.volume / average }
      : { value: null, reason: 'zero_average_volume' };
  }
  if (def.id === 'drawdown') {
    let peak = sample[0].close;
    let worst = 0;
    for (const row of sample) {
      peak = Math.max(peak, row.close);
      worst = Math.max(worst, 1 - row.close / peak);
    }
    return { value: worst * 100 };
  }
  if (def.id === 'volatility') {
    const returns = dailyReturns(sample);
    const average = mean(returns);
    return { value: Math.sqrt(returns.reduce((sum, r) => sum + (r - average) ** 2, 0)
      / (returns.length - 1) * 252) * 100 };
  }

  // Require consecutive benchmark observations and an actual stock close on each
  // date. A suspension/missing row must not be silently bridged or filled for beta.
  if (!benchmark.length) return { value: null, reason: 'benchmark_unavailable' };
  const market = benchmark.filter((row) => row.date <= latest.date).slice(-def.required);
  if (market.at(-1)?.date !== latest.date) return { value: null, reason: 'benchmark_date_mismatch' };
  if (market.length < def.required) return { value: null, reason: 'benchmark_insufficient_history' };
  const asset = market.map((row) => stockByDate.get(row.date));
  if (asset.some((row) => !row)) return { value: null, reason: 'missing_joint_sessions' };
  if (def.id === 'relativeStrength') {
    return { value: (asset.at(-1).close / asset[0].close - market.at(-1).close / market[0].close) * 100 };
  }
  const xs = dailyReturns(market);
  const ys = dailyReturns(asset);
  const mx = mean(xs), my = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  if (denominator <= 1e-12) return { value: null, reason: 'zero_benchmark_variance' };
  return { value: xs.reduce((sum, x, i) => sum + (x - mx) * (ys[i] - my), 0) / denominator };
}

function buildFactor(def, stock, benchmark, stockByDate) {
  const start = Math.max(0, stock.length - REFERENCE_SESSIONS - 1);
  const series = stock.slice(start).map((row, offset) => {
    const result = evaluate(def, stock, benchmark, stockByDate, start + offset);
    return { date: row.date, value: rounded(result.value, 8), ...(result.reason ? { reason: result.reason } : {}) };
  });
  const current = series.at(-1) || { value: null, reason: 'insufficient_history' };
  const reference = series.slice(0, -1).filter((row) => row.value != null);
  let percentile = null;
  if (current.value != null && reference.length >= MIN_REFERENCE_OBSERVATIONS) {
    const below = reference.filter((row) => row.value < current.value).length;
    const tied = reference.filter((row) => row.value === current.value).length;
    percentile = rounded((below + tied / 2) / reference.length * 100, 1);
  }
  return {
    ...def,
    value: rounded(current.value),
    asOf: current.date || null,
    reason: current.reason || null,
    observations: Math.min(stock.length, def.required),
    calendarBasis: ['relativeStrength', 'beta'].includes(def.id)
      ? 'consecutive_benchmark_sessions_with_observed_stock_closes' : 'observed_stock_sessions',
    percentile,
    percentileReason: percentile != null ? null
      : current.value == null ? 'factor_unavailable' : 'insufficient_reference',
    reference: {
      basis: 'own_prior_observations', count: reference.length,
      required: MIN_REFERENCE_OBSERVATIONS, windowSessions: REFERENCE_SESSIONS,
      startDate: reference[0]?.date || null, endDate: reference.at(-1)?.date || null,
    },
    history: series.slice(-HISTORY_SESSIONS).map(({ date, value }) => ({ date, value: rounded(value) })),
  };
}

// Inputs are the research card's sorted, deduplicated, valid daily series.
function computeStockFactors(stockRows, benchmarkRows, options = {}) {
  const stock = options.latestBarComplete === false ? stockRows.slice(0, -1) : stockRows;
  const asOf = stock.at(-1)?.date || null;
  const benchmark = benchmarkRows.filter((row) => asOf && row.date <= asOf);
  const stockByDate = new Map(stock.map((row) => [row.date, row]));
  const factors = DEFINITIONS.map((def) => buildFactor(def, stock, benchmark, stockByDate));
  const warnings = [];
  if (options.latestBarComplete === false) warnings.push('已排除尚未完成的当日日线。');
  if (options.stockStale) warnings.push('个股日线为旧缓存，所有因子请结合截止日期查看。');
  if (options.benchmarkStale) warnings.push('基准日线为旧缓存，相对强弱与 Beta 可能滞后。');
  if (['raw_fallback', 'partial_adjusted'].includes(options.adjustmentBasis)) {
    warnings.push('复权质量降级，拆股或分红可能影响价格因子。');
  }
  if (benchmarkRows.at(-1)?.date > stockRows.at(-1)?.date) {
    warnings.push('个股最近成交早于基准日期；因子截止于实际个股收盘，没有前填成交。');
  }
  return {
    version: FACTOR_VERSION,
    scope: 'price_volume_characteristics',
    asOf,
    excludedPartialSession: options.latestBarComplete === false,
    benchmark: { code: options.benchmarkCode || '', name: options.benchmarkName || '' },
    availableCount: factors.filter((factor) => factor.value != null).length,
    comparisonBasis: 'own_prior_observations',
    factors,
    warnings,
    uncovered: ['价值', '盈利质量', '成长', '规模', '同行业分位'],
    coverageNote: '当前覆盖价格与风险特征；财报、可比股票样本尚未接入，未计算价值、质量、成长、规模与同行业排名。',
    methodology: '分位仅比较该股此前最多120期同口径数值（至少60个有效观察），排除当前观察，并列取中位秩。各因子可能相关；分位不是评分、涨跌概率或未来收益。',
  };
}

module.exports = { FACTOR_VERSION, computeStockFactors };
