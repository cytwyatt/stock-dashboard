'use strict';

const path = require('node:path');

const isValidChatSessionId = (id) => typeof id === 'string' && /^[\w-]{1,80}$/.test(id);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const MAX_CHAT_TIMESTAMP_MS = 8.64e15;

function isValidChatTimestamp(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_CHAT_TIMESTAMP_MS;
}

function createChatStore({
  dataDir,
  fs,
  jsonFile,
  isCNCode,
  isKnownHKCode,
  now = () => Date.now(),
  random = () => Math.random(),
}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('dataDir is required');
  if (!fs || !jsonFile || typeof isCNCode !== 'function' || typeof isKnownHKCode !== 'function') {
    throw new TypeError('fs, jsonFile, isCNCode and isKnownHKCode are required');
  }

  const file = path.join(dataDir, 'chats.json');
  jsonFile.protectDataFile(file);

  function normalizeStockContext(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const rawCode = typeof raw.code === 'string' ? raw.code.trim() : '';
    if (!/^[A-Za-z0-9.^=-]{1,20}$/.test(rawCode)) return null;
    if (!['cn', 'hk', 'us'].includes(raw.market)) return null;
    let code;
    const market = raw.market;
    if (market === 'cn') {
      code = rawCode.toLowerCase();
      if (!isCNCode(code)) return null;
    } else if (market === 'hk') {
      if (!/^hk/i.test(rawCode)) return null;
      code = `hk${rawCode.slice(2).toUpperCase()}`;
      if (!isKnownHKCode(code)) return null;
    } else {
      code = rawCode.toUpperCase();
      const lower = rawCode.toLowerCase();
      const hkCode = /^hk/i.test(rawCode) ? `hk${rawCode.slice(2).toUpperCase()}` : '';
      if (isCNCode(lower) || isKnownHKCode(hkCode)) return null;
    }
    if (raw.name != null && (typeof raw.name !== 'string' || raw.name.length > 200)) return null;
    const name = String(raw.name || '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return { code, name, market };
  }

  function createChatSessionId(used = new Set()) {
    let id;
    do { id = `c${now()}${random().toString(36).slice(2, 6)}`; }
    while (used.has(id));
    return id;
  }

  function readChats() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      return data && Array.isArray(data.sessions) ? data : { sessions: [] };
    } catch {
      return { sessions: [] };
    }
  }

  function writeChats(data) {
    jsonFile.writeDataJSON(file, data);
  }

  // 旧版本允许任意 sessionId；保留有效会话内容，只修复非法/重复 ID 与不合法字段。
  function migrateChatSessionIds() {
    const store = readChats();
    const used = new Set();
    const sessions = [];
    let changed = false;
    for (const session of store.sessions) {
      if (!session || typeof session !== 'object' || Array.isArray(session)) {
        changed = true;
        continue;
      }
      if (!Array.isArray(session.messages)) {
        session.messages = [];
        changed = true;
      }
      for (const message of session.messages) {
        if (!message || typeof message !== 'object' || Array.isArray(message)
            || !hasOwn(message, 'createdAt')) continue;
        if (!isValidChatTimestamp(message.createdAt)) {
          delete message.createdAt;
          changed = true;
        }
      }
      if (hasOwn(session, 'stockContext')) {
        const normalized = normalizeStockContext(session.stockContext);
        if (!normalized) {
          delete session.stockContext;
          changed = true;
        } else if (JSON.stringify(normalized) !== JSON.stringify(session.stockContext)) {
          session.stockContext = normalized;
          changed = true;
        }
      }
      if (!isValidChatSessionId(session.id) || used.has(session.id)) {
        session.id = createChatSessionId(used);
        changed = true;
      }
      used.add(session.id);
      sessions.push(session);
    }
    store.sessions = sessions;
    if (changed) writeChats(store);
  }

  return {
    file,
    isValidChatSessionId,
    normalizeStockContext,
    createChatSessionId,
    readChats,
    writeChats,
    migrateChatSessionIds,
  };
}

module.exports = { createChatStore, isValidChatSessionId };
