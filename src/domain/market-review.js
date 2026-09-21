'use strict';

function finite(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 2) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

function periodReturn(rows, intervals) {
  if (rows.length < intervals + 1) return null;
  const latest = finite(rows.at(-1).close);
  const base = finite(rows[rows.length - 1 - intervals].close);
  return latest != null && base != null && base > 0
    ? round((latest / base - 1) * 100)
    : null;
}

function isCalendarDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function normalizeHistoryRows(rows) {
  const byDate = new Map();
  const duplicateDates = new Set();
  const conflictingDuplicateDates = new Set();
  for (const raw of Array.isArray(rows) ? rows : []) {
    if (!raw || !isCalendarDate(raw.date)) continue;
    const row = {
      date: String(raw.date),
      open: finite(raw.open),
      close: finite(raw.close),
      high: finite(raw.high),
      low: finite(raw.low),
      volume: finite(raw.volume),
    };
    if (row.close == null || row.close <= 0) continue;
    const previous = byDate.get(row.date);
    if (previous) {
      duplicateDates.add(row.date);
      if (['open', 'close', 'high', 'low', 'volume']
        .some((key) => previous[key] !== row[key])) {
        conflictingDuplicateDates.add(row.date);
      }
    }
    // The last provider row wins. This is deterministic and matches the usual
    // provider convention that a later row is the most recently revised bar.
    byDate.set(row.date, row);
  }
  return {
    rows: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date)),
    quality: {
      duplicateDates: [...duplicateDates].sort(),
      conflictingDuplicateDates: [...conflictingDuplicateDates].sort(),
      duplicateResolution: 'last_row_wins',
    },
  };
}

function summarizeIndexHistory(rows) {
  const normalized = normalizeHistoryRows(rows);
  const clean = normalized.rows;
  if (!clean.length) return null;

  const latest = clean.at(-1);
  const previous = clean.length > 1 ? clean.at(-2) : null;
  const change = previous && previous.close > 0
    ? round(latest.close - previous.close, 4)
    : null;
  const changePct = periodReturn(clean, 1);
  const window20 = clean.slice(-20);
  const highs = window20.map((row) => row.high).filter((value) => value != null);
  const lows = window20.map((row) => row.low).filter((value) => value != null);
  const completeWindow20 = window20.length === 20;
  const high20 = completeWindow20 && highs.length === 20 ? Math.max(...highs) : null;
  const low20 = completeWindow20 && lows.length === 20 ? Math.min(...lows) : null;
  const previousVolumes = clean.slice(-21, -1)
    .map((row) => row.volume)
    .filter((value) => value != null && value >= 0);
  const averageVolume20 = previousVolumes.length === 20
    ? previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length
    : null;

  return {
    latestDate: latest.date,
    close: latest.close,
    latestBar: {
      date: latest.date,
      open: latest.open,
      high: latest.high,
      low: latest.low,
      close: latest.close,
      volume: latest.volume,
      previousClose: previous ? previous.close : null,
      change,
      changePct,
    },
    returns: {
      oneDayPct: changePct,
      fiveDayPct: periodReturn(clean, 5),
      twentyDayPct: periodReturn(clean, 20),
    },
    range20: {
      high: high20,
      low: low20,
      positionPct: high20 != null && low20 != null && high20 > low20
        ? round((latest.close - low20) / (high20 - low20) * 100)
        : null,
      highSampleCount: highs.length,
      lowSampleCount: lows.length,
      requiredSamples: 20,
    },
    volume: {
      latest: latest.volume,
      average20: averageVolume20 == null ? null : round(averageVolume20, 2),
      ratioToAverage20: latest.volume != null && averageVolume20 > 0
        ? round(latest.volume / averageVolume20, 2)
        : null,
      sampleCount: previousVolumes.length,
    },
    observations: clean.length,
    quality: normalized.quality,
  };
}

module.exports = {
  finite,
  normalizeHistoryRows,
  round,
  summarizeIndexHistory,
};
