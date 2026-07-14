'use strict';

function finite(value) {
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

function summarizeIndexHistory(rows) {
  const clean = (Array.isArray(rows) ? rows : [])
    .filter((row) => row && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date || '')))
    .map((row) => ({
      date: String(row.date),
      open: finite(row.open),
      close: finite(row.close),
      high: finite(row.high),
      low: finite(row.low),
      volume: finite(row.volume),
    }))
    .filter((row) => row.close != null && row.close > 0)
    .sort((left, right) => left.date.localeCompare(right.date));
  if (!clean.length) return null;

  const latest = clean.at(-1);
  const window20 = clean.slice(-20);
  const highs = window20.map((row) => row.high).filter((value) => value != null);
  const lows = window20.map((row) => row.low).filter((value) => value != null);
  const high20 = highs.length ? Math.max(...highs) : null;
  const low20 = lows.length ? Math.min(...lows) : null;
  const previousVolumes = clean.slice(-21, -1)
    .map((row) => row.volume)
    .filter((value) => value != null && value >= 0);
  const averageVolume20 = previousVolumes.length === 20
    ? previousVolumes.reduce((sum, value) => sum + value, 0) / previousVolumes.length
    : null;

  return {
    latestDate: latest.date,
    close: latest.close,
    returns: {
      oneDayPct: periodReturn(clean, 1),
      fiveDayPct: periodReturn(clean, 5),
      twentyDayPct: periodReturn(clean, 20),
    },
    range20: {
      high: high20,
      low: low20,
      positionPct: high20 != null && low20 != null && high20 > low20
        ? round((latest.close - low20) / (high20 - low20) * 100)
        : null,
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
  };
}

module.exports = {
  round,
  summarizeIndexHistory,
};
