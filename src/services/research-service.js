'use strict';

const {
  RESEARCH_DAYS,
  RESEARCH_BENCHMARKS,
  normalizeDailySeries,
  computeResearchCard,
} = require('../domain/research-card');

function createResearchService({
  marketForCode,
  getMarketDataMeta,
  annotateMarketData,
  marketDefaults,
  isMarketOpen,
  dateInTimezone,
  now = () => new Date(),
  logger = console,
}) {
  async function getResearchCardEntry(code, loadKline) {
    const market = marketForCode(code);
    const benchmark = RESEARCH_BENCHMARKS[market];
    const stockPromise = loadKline(code, RESEARCH_DAYS, 'day');
    const benchmarkPromise = code === benchmark.code
      ? stockPromise
      : loadKline(benchmark.code, RESEARCH_DAYS, 'day');
    const [stockResult, benchmarkResult] = await Promise.allSettled([stockPromise, benchmarkPromise]);
    if (stockResult.status === 'rejected') throw stockResult.reason;

    const stockEntry = stockResult.value;
    const benchmarkEntry = benchmarkResult.status === 'fulfilled' ? benchmarkResult.value : null;
    if (!benchmarkEntry) {
      logger.error(`[research] ${benchmark.code}: ${benchmarkResult.reason?.message || 'benchmark unavailable'}`);
    }
    const stockMeta = getMarketDataMeta(stockEntry.data);
    const benchmarkMeta = benchmarkEntry ? getMarketDataMeta(benchmarkEntry.data) : {};
    const timezone = stockMeta.timezone || marketDefaults[market].timezone;
    const stockRows = normalizeDailySeries(stockEntry.data);
    const latestDate = stockRows.length ? stockRows[stockRows.length - 1].date : '';
    const current = now();
    const latestBarComplete = !(
      latestDate
      && latestDate === dateInTimezone(timezone, current)
      && isMarketOpen(market, current)
    );
    const data = computeResearchCard(stockEntry.data, benchmarkEntry ? benchmarkEntry.data : [], {
      code,
      market,
      currency: stockMeta.currency || marketDefaults[market].currency,
      benchmarkCode: benchmark.code,
      benchmarkName: benchmark.name,
      adjustmentBasis: stockMeta.adjustmentBasis,
      benchmarkAdjustmentBasis: benchmarkMeta.adjustmentBasis,
      stockStale: stockEntry.stale,
      benchmarkStale: benchmarkEntry && benchmarkEntry.stale,
      latestBarComplete,
    });
    if (!latestBarComplete) {
      data.signals.unshift({
        code: 'PARTIAL_SESSION', severity: 'info', label: '当前交易日尚未结束',
        detail: '量能、波动率和最大回撤已自动使用最近完整交易日；阶段收益可包含盘中日线',
      });
    }

    const entries = [stockEntry, benchmarkEntry].filter(Boolean);
    const staleEntries = entries.filter((entry) => entry.stale);
    const fetchedAt = Math.min(...entries.map((entry) => entry.fetchedAt));
    const staleSinceValues = staleEntries.map((entry) => entry.staleSince).filter(Number.isFinite);
    const source = [...new Set([stockMeta.source, benchmarkMeta.source].filter(Boolean))].join(' / ') || null;
    annotateMarketData(data, {
      market,
      source,
      currency: stockMeta.currency || marketDefaults[market].currency,
      timezone,
      asOf: data.analysisAsOf,
      adjustmentBasis: stockMeta.adjustmentBasis || 'none',
      ...(stockMeta.adjustmentCoverage == null ? {} : { adjustmentCoverage: stockMeta.adjustmentCoverage }),
      stale: staleEntries.length > 0,
      staleSince: staleSinceValues.length ? new Date(Math.min(...staleSinceValues)).toISOString() : null,
      coverage: {
        assetBars: data.historySessions,
        alignedSessions: data.alignedSessions,
        benchmark: data.benchmark.available ? 'price_index_calendar_aligned' : 'unavailable',
        components: {
          asset: {
            asOf: stockMeta.asOf || data.analysisAsOf,
            fetchedAt: new Date(stockEntry.fetchedAt).toISOString(),
            stale: !!stockEntry.stale,
            adjustmentBasis: stockMeta.adjustmentBasis || 'none',
          },
          benchmark: benchmarkEntry ? {
            code: benchmark.code,
            asOf: benchmarkMeta.asOf || data.benchmark.asOf,
            fetchedAt: new Date(benchmarkEntry.fetchedAt).toISOString(),
            stale: !!benchmarkEntry.stale,
            adjustmentBasis: benchmarkMeta.adjustmentBasis || 'none',
          } : { code: benchmark.code, unavailable: true },
        },
      },
    });
    return {
      data,
      fetchedAt,
      stale: staleEntries.length > 0,
      staleSince: staleSinceValues.length ? Math.min(...staleSinceValues) : null,
    };
  }

  return { getResearchCardEntry };
}

module.exports = { createResearchService };
