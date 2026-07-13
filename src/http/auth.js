'use strict';

const crypto = require('crypto');

const AUTH_MAXAGE = 60 * 60 * 24 * 30;

function createAuth({ password = '', cryptoImpl = crypto } = {}) {
  const token = password
    ? cryptoImpl.createHash('sha256').update(`market-auth:${password}`).digest('hex')
    : '';

  function parseCookies(req) {
    const out = {};
    for (const part of (req.headers.cookie || '').split(';')) {
      const index = part.indexOf('=');
      if (index > 0) out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
    return out;
  }

  function isAuthed(req) {
    if (!token) return true;
    return parseCookies(req).market_auth === token;
  }

  function safeEq(a, b) {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && cryptoImpl.timingSafeEqual(left, right);
  }

  function verify(passwordAttempt) {
    if (!token) return true;
    const attemptedToken = cryptoImpl.createHash('sha256')
      .update(`market-auth:${passwordAttempt}`)
      .digest('hex');
    return safeEq(attemptedToken, token);
  }

  function loginPage(error) {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>行情看板 · 登录</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0e1117;color:#e6e6e6;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  form{width:min(88vw,320px);padding:28px 24px;background:#171b22;border:1px solid #262c36;
    border-radius:14px;box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{margin:0 0 4px;font-size:20px}
  p{margin:0 0 18px;font-size:13px;color:#8b949e}
  input{width:100%;padding:11px 12px;font-size:16px;border-radius:8px;border:1px solid #30363d;
    background:#0d1117;color:#e6e6e6;outline:none}
  input:focus{border-color:#e5484d}
  button{width:100%;margin-top:14px;padding:11px;font-size:15px;font-weight:600;border:0;
    border-radius:8px;background:#e5484d;color:#fff;cursor:pointer}
  .err{color:#e5484d;font-size:13px;margin-top:10px;min-height:16px}
</style></head><body>
<form method="POST" action="/__login">
  <h1>📈 行情看板</h1>
  <p>请输入访问口令</p>
  <input type="password" name="password" placeholder="口令" autofocus autocomplete="current-password">
  <div class="err">${error || ''}</div>
  <button type="submit">进入</button>
</form></body></html>`;
  }

  return {
    enabled: !!token,
    token,
    maxAge: AUTH_MAXAGE,
    parseCookies,
    isAuthed,
    verify,
    loginPage,
  };
}

module.exports = { AUTH_MAXAGE, createAuth };
