'use strict';

const fmtCNTime = (value) => value && value.length >= 12
  ? `${value.slice(4, 6)}-${value.slice(6, 8)} ${value.slice(8, 10)}:${value.slice(10, 12)}`
  : value;

function fmtHKTime(value) {
  const match = /^\d{4}\/(\d{2})\/(\d{2}) (\d{2}:\d{2})/.exec(value || '');
  return match ? `${match[1]}-${match[2]} ${match[3]}` : value;
}

function isoTencentTime(value, market = 'cn') {
  const text = String(value || '');
  if (market === 'hk') {
    const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
    return match
      ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+08:00`
      : '';
  }
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/.exec(text);
  return match
    ? `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || '00'}+08:00`
    : '';
}

function isoMinuteTime(date, time) {
  const day = String(date || '');
  const minute = String(time || '');
  if (!/^\d{8}$/.test(day) || !/^\d{2}:\d{2}$/.test(minute)) return '';
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${minute}:00+08:00`;
}

function fmtTimeInTZ(epochSec, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochSec * 1000));
}

function dateInTimezone(timezone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function isMarketOpen(market, date = new Date()) {
  const timezone = market === 'us'
    ? 'America/New_York'
    : market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  if (get('weekday') === 'Sat' || get('weekday') === 'Sun') return false;
  const minutes = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  if (market === 'us') return minutes >= 565 && minutes <= 965;
  if (market === 'hk') return minutes >= 555 && minutes <= 975;
  return minutes >= 555 && minutes <= 905;
}

const isMarketOpenSrv = isMarketOpen;

module.exports = {
  fmtCNTime,
  fmtHKTime,
  isoTencentTime,
  isoMinuteTime,
  fmtTimeInTZ,
  dateInTimezone,
  isMarketOpen,
  isMarketOpenSrv,
};
