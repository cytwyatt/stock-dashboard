'use strict';

const sanitizeCode = (value) => String(value ?? '')
  .replace(/[^a-zA-Z0-9.^=-]/g, '')
  .slice(0, 20);

const isCNCode = (code) => /^(sh|sz|bj)\d{6}$/.test(code);
const isHKCode = (code) => /^hk(\d{5}|[A-Z]+)$/.test(code);
const isKnownHKCode = (code) => /^hk(\d{5}|HSI|HSCEI|HSTECH)$/.test(code);
const isTXCode = (code) => isCNCode(code) || isHKCode(code);

function marketForCode(code) {
  return isCNCode(code) ? 'cn' : isHKCode(code) ? 'hk' : 'us';
}

module.exports = {
  sanitizeCode,
  isCNCode,
  isHKCode,
  isKnownHKCode,
  isTXCode,
  marketForCode,
};
