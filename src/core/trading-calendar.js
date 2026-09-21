'use strict';

const CALENDAR_VERSION = 'exchange-calendars-2026-09-v1';
const MARKET_TIMEZONES = Object.freeze({ cn: 'Asia/Shanghai', us: 'America/New_York' });

function datesBetween(start, end) {
  const values = [];
  for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= new Date(`${end}T00:00:00Z`);
    cursor = new Date(cursor.getTime() + 86400000)) {
    values.push(cursor.toISOString().slice(0, 10));
  }
  return values;
}

const CN_CLOSED = new Set([
  ...datesBetween('2025-01-01', '2025-01-01'),
  ...datesBetween('2025-01-28', '2025-02-04'),
  ...datesBetween('2025-04-04', '2025-04-06'),
  ...datesBetween('2025-05-01', '2025-05-05'),
  ...datesBetween('2025-05-31', '2025-06-02'),
  ...datesBetween('2025-10-01', '2025-10-08'),
  ...datesBetween('2026-01-01', '2026-01-03'),
  ...datesBetween('2026-02-15', '2026-02-23'),
  ...datesBetween('2026-04-04', '2026-04-06'),
  ...datesBetween('2026-05-01', '2026-05-05'),
  ...datesBetween('2026-06-19', '2026-06-21'),
  ...datesBetween('2026-09-25', '2026-09-27'),
  ...datesBetween('2026-10-01', '2026-10-07'),
]);

const US_CLOSED = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29', '2028-06-19',
  '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

const US_EARLY_CLOSE = new Set([
  '2026-11-27', '2026-12-24',
  '2027-11-26',
  '2028-07-03', '2028-11-24',
]);

function validDate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function weekday(value) {
  return new Date(`${value}T00:00:00Z`).getUTCDay();
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function offsetFor(timezone, utcGuess) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(utcGuess));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const represented = Date.UTC(
    Number(values.year), Number(values.month) - 1, Number(values.day),
    Number(values.hour), Number(values.minute), Number(values.second),
  );
  return represented - utcGuess;
}

function localTimestamp(timezone, dateText, minutes) {
  const [year, month, day] = dateText.split('-').map(Number);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const wallClock = Date.UTC(year, month - 1, day, hour, minute, 0);
  let result = wallClock - offsetFor(timezone, wallClock);
  result = wallClock - offsetFor(timezone, result);
  return result;
}

function createTradingCalendar({ version = CALENDAR_VERSION } = {}) {
  function session(rawMarket, date) {
    const market = rawMarket === 'us' ? 'us' : rawMarket === 'cn' ? 'cn' : '';
    if (!market || !validDate(date)) {
      return { market, date, calendarStatus: 'unknown', isTradingDay: null,
        closeMinutes: null, cutoffAt: null, earlyClose: false, version };
    }
    const year = Number(date.slice(0, 4));
    const known = market === 'cn' ? year >= 2025 && year <= 2026 : year >= 2026 && year <= 2028;
    if (!known) {
      return { market, date, calendarStatus: 'unknown', isTradingDay: null,
        closeMinutes: null, cutoffAt: null, earlyClose: false, version };
    }
    const weekend = weekday(date) === 0 || weekday(date) === 6;
    const closed = weekend || (market === 'cn' ? CN_CLOSED.has(date) : US_CLOSED.has(date));
    const earlyClose = market === 'us' && !closed && US_EARLY_CLOSE.has(date);
    const closeMinutes = closed ? null : market === 'cn' ? 15 * 60 : earlyClose ? 13 * 60 : 16 * 60;
    return {
      market,
      date,
      calendarStatus: 'known',
      isTradingDay: !closed,
      closeMinutes,
      cutoffAt: closeMinutes == null ? null
        : new Date(localTimestamp(MARKET_TIMEZONES[market], date, closeMinutes)).toISOString(),
      earlyClose,
      version,
    };
  }

  function adjacentSession(market, date, direction) {
    if (!validDate(date)) return null;
    for (let step = 1; step <= 14; step++) {
      const candidate = shiftDate(date, direction * step);
      const info = session(market, candidate);
      if (info.calendarStatus === 'unknown') return null;
      if (info.isTradingDay) return candidate;
    }
    return null;
  }

  return {
    version,
    session,
    nextSession: (market, date) => adjacentSession(market, date, 1),
    previousSession: (market, date) => adjacentSession(market, date, -1),
  };
}

module.exports = {
  CALENDAR_VERSION,
  createTradingCalendar,
  localTimestamp,
};
