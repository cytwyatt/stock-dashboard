'use strict';

const sanitizeCode = (value) => String(value ?? '')
  .replace(/[^a-zA-Z0-9.^=-]/g, '')
  .slice(0, 20);

function normalizeProfileCode(value) {
  const code = sanitizeCode(value);
  const cn = /^(sh|sz|bj)(\d{6})$/i.exec(code);
  if (cn) return `${cn[1].toLowerCase()}${cn[2]}`;
  const hk = /^hk(\d{5}|[a-z]+)$/i.exec(code);
  if (hk) return `hk${/^\d+$/.test(hk[1]) ? hk[1] : hk[1].toUpperCase()}`;
  return code.toUpperCase();
}

const isCNCode = (code) => /^(sh|sz|bj)\d{6}$/.test(code);
const isHKCode = (code) => /^hk(\d{5}|[A-Z]+)$/.test(code);
const isKnownHKCode = (code) => /^hk(\d{5}|HSI|HSCEI|HSTECH)$/.test(code);
const isTXCode = (code) => isCNCode(code) || isHKCode(code);

function marketForCode(code) {
  return isCNCode(code) ? 'cn' : isHKCode(code) ? 'hk' : 'us';
}

module.exports = {
  sanitizeCode,
  normalizeProfileCode,
  isCNCode,
  isHKCode,
  isKnownHKCode,
  isTXCode,
  marketForCode,
};
