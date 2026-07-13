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

function marketSession(market, date = new Date()) {
  const normalized = market === 'us' || market === 'hk' ? market : 'cn';
  const timezone = normalized === 'us'
    ? 'America/New_York'
    : normalized === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type).value;
  const basis = 'regular_hours_without_holiday_calendar';
  const result = (code, label, isOpen = false) => ({
    code,
    label,
    isOpen,
    basis,
    calendarAware: false,
  });
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return result('weekend', '周末休市');
  const minutes = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);

  if (normalized === 'cn') {
    if (minutes < 555) return result('pre', '盘前');
    if (minutes < 570) return result('auction', '集合竞价');
    if (minutes < 690) return result('regular', '常规交易时段', true);
    if (minutes < 780) return result('lunch', '午间休市');
    if (minutes < 900) return result('regular', '常规交易时段', true);
    return result('closed', '已收盘');
  }
  if (normalized === 'hk') {
    if (minutes < 570) return result('pre', '盘前');
    if (minutes < 720) return result('regular', '常规交易时段', true);
    if (minutes < 780) return result('lunch', '午间休市');
    if (minutes < 960) return result('regular', '常规交易时段', true);
    return result('closed', '已收盘');
  }
  if (minutes < 570) return result('pre', '盘前');
  if (minutes < 960) return result('regular', '常规交易时段', true);
  if (minutes < 1200) return result('post', '盘后');
  return result('closed', '已收盘');
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
  marketSession,
};
