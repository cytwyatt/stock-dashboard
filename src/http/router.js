'use strict';

const { readBody, sendJSON, sendMarketJSON, sseSend } = require('./response');

function maskKey(key) {
  if (!key) return '';
  return key.length > 8 ? `${key.slice(0, 4)}****${key.slice(-4)}` : '****';
}

function createHttpHandler({
  port,
  auth,
  staticServer,
  marketService,
  marketSummaryService,
  chatService,
  llmConfigStore,
  llmClient,
  watchlistStore,
  chatStore,
  marketMeta,
  sanitizeCode,
  marketForCode,
  env = process.env,
  logger = console,
}) {
  async function handler(req, res) {
    const url = new URL(req.url, `http://localhost:${port}`);
    const pathname = url.pathname;
    res.gzipOK = /\bgzip\b/.test(req.headers['accept-encoding'] || '');

    try {
      if (auth.enabled) {
        if (pathname === '/__login' && req.method === 'POST') {
          const password = new URLSearchParams(await readBody(req)).get('password') || '';
          if (auth.verify(password)) {
            res.writeHead(302, {
              'Set-Cookie': `market_auth=${auth.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${auth.maxAge}`,
              Location: '/',
            });
            return res.end();
          }
          res.writeHead(401, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return res.end(auth.loginPage('口令错误'));
        }
        if (!auth.isAuthed(req)) {
          if (pathname.startsWith('/api/')) return sendJSON(res, 401, { error: '未授权' });
          res.writeHead(401, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store',
          });
          return res.end(auth.loginPage(''));
        }
      }

      if (pathname === '/api/indices') {
        const queryMarket = url.searchParams.get('market');
        const market = queryMarket === 'us' || queryMarket === 'hk' ? queryMarket : 'cn';
        const entry = await marketService.indices(market);
        return sendMarketJSON(res, entry, { market }, marketMeta);
      }
      if (pathname === '/api/minute') {
        const code = sanitizeCode(url.searchParams.get('code') || 'sh000001');
        const entry = await marketService.minute(code);
        return sendMarketJSON(res, entry, { market: marketForCode(code) }, marketMeta);
      }
      if (pathname === '/api/kline') {
        const code = sanitizeCode(url.searchParams.get('code') || 'sh000001');
        const days = Math.min(365, parseInt(url.searchParams.get('days') || '90', 10) || 90);
        const queryPeriod = url.searchParams.get('period');
        const period = ['day', 'week', 'month'].includes(queryPeriod) ? queryPeriod : 'day';
        const entry = await marketService.kline(code, days, period);
        return sendMarketJSON(res, entry, { market: marketForCode(code) }, marketMeta);
      }
      if (pathname === '/api/research') {
        const code = sanitizeCode(url.searchParams.get('code') || '');
        if (!code) return sendJSON(res, 400, { error: 'code required' });
        const entry = await marketService.research(code);
        return sendMarketJSON(res, entry, { market: marketForCode(code) }, marketMeta);
      }
      if (pathname === '/api/sectors') {
        const entry = await marketService.sectors();
        return sendMarketJSON(res, entry, { market: 'cn' }, marketMeta);
      }
      if (pathname === '/api/rank') {
        const queryMarket = url.searchParams.get('market');
        const market = queryMarket === 'us' || queryMarket === 'hk' ? queryMarket : 'cn';
        const dir = url.searchParams.get('dir') === 'down' ? 'down' : 'up';
        const entry = await marketService.rank(market, dir);
        return sendMarketJSON(res, entry, { market }, marketMeta);
      }
      if (pathname === '/api/market-summary') {
        if (req.method !== 'GET' && req.method !== 'POST') {
          return sendJSON(res, 405, { error: 'method not allowed' });
        }
        let requestedMarket = url.searchParams.get('market');
        let force = false;
        if (req.method === 'POST') {
          let body;
          try { body = JSON.parse(await readBody(req)); }
          catch { return sendJSON(res, 400, { error: 'JSON 格式不正确' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return sendJSON(res, 400, { error: '请求体格式不正确' });
          }
          requestedMarket = body.market;
          force = true;
        }
        const market = requestedMarket === 'us' || requestedMarket === 'hk'
          ? requestedMarket
          : 'cn';
        const entry = await marketSummaryService.getSummary(market, { force });
        return sendMarketJSON(res, entry, { market, currency: null }, marketMeta);
      }

      if (pathname === '/api/llm-config') {
        if (req.method === 'GET') {
          const config = llmConfigStore.getLLMConfig();
          return sendJSON(res, 200, {
            baseUrl: config.baseUrl,
            model: config.model,
            configured: !!config.apiKey,
            keyMask: maskKey(config.apiKey),
          });
        }
        if (req.method === 'POST') {
          let body;
          try { body = JSON.parse(await readBody(req)); }
          catch { return sendJSON(res, 400, { error: 'JSON 格式不正确' }); }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            return sendJSON(res, 400, { error: '请求体格式不正确' });
          }
          const current = llmConfigStore.getLLMConfig();
          const stored = llmConfigStore.getStoredLLMConfig();
          const rawBaseUrl = String(body.baseUrl || '').trim().slice(0, 200);
          const model = String(body.model || '').trim().slice(0, 100);
          const enteredKey = String(body.apiKey || '').trim().slice(0, 300);
          let baseUrl;
          try { baseUrl = llmConfigStore.normalizeLLMBaseUrl(rawBaseUrl); }
          catch { return sendJSON(res, 400, { error: '接口地址格式不正确' }); }
          if (!model) return sendJSON(res, 400, { error: '模型名称不能为空' });
          if ((env.LLM_BASE_URL || env.LLM_API_KEY) && baseUrl !== current.baseUrl) {
            return sendJSON(res, 400, { error: '接口地址由环境变量约束，不能在页面中修改' });
          }
          if (env.LLM_MODEL && model !== current.model) {
            return sendJSON(res, 400, { error: '模型名称由环境变量配置，不能在页面中修改' });
          }
          if (env.LLM_API_KEY && enteredKey) {
            return sendJSON(res, 400, { error: 'API Key 由环境变量配置，不能在页面中修改' });
          }
          if (baseUrl !== current.baseUrl && current.apiKey && !enteredKey) {
            return sendJSON(res, 400, { error: '更换接口地址时请重新输入 API Key' });
          }
          const previousFileKey = String(stored.apiKey || '');
          const apiKey = env.LLM_API_KEY
            ? previousFileKey
            : enteredKey || (baseUrl === current.baseUrl ? current.apiKey : '');
          llmConfigStore.writeLLMConfig({ baseUrl, apiKey, model });
          const effective = llmConfigStore.getLLMConfig();
          return sendJSON(res, 200, {
            ok: true,
            configured: !!effective.apiKey,
            keyMask: maskKey(effective.apiKey),
          });
        }
        return sendJSON(res, 405, { error: 'method not allowed' });
      }
      if (pathname === '/api/llm-config/test' && req.method === 'POST') {
        return sendJSON(res, 200, await llmClient.testConfig(llmConfigStore.getLLMConfig()));
      }

      if (pathname === '/api/chat' && req.method === 'POST') {
        let body;
        try { body = JSON.parse(await readBody(req)); }
        catch { return sendJSON(res, 400, { error: 'JSON 格式不正确' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJSON(res, 400, { error: '请求体格式不正确' });
        }
        let prepared;
        try { prepared = chatService.prepare(body); }
        catch (error) {
          if (error.statusCode || error.status) {
            return sendJSON(res, error.statusCode || error.status, { error: error.message });
          }
          throw error;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        await chatService.run(prepared, (event) => sseSend(res, event));
        return res.end();
      }

      if (pathname === '/api/chat/sessions') {
        if (req.method === 'GET') {
          const store = chatStore.readChats();
          return sendJSON(res, 200, store.sessions.map((session) => ({
            id: session.id,
            title: session.title || '',
            updatedAt: session.updatedAt || session.createdAt,
            count: session.messages.length,
          })));
        }
        if (req.method === 'POST') {
          const store = chatStore.readChats();
          const session = {
            id: chatStore.createChatSessionId(new Set(store.sessions.map((item) => item.id))),
            title: '',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
          };
          store.sessions.unshift(session);
          chatStore.writeChats(store);
          return sendJSON(res, 200, { id: session.id });
        }
        return sendJSON(res, 405, { error: 'method not allowed' });
      }

      const sessionMatch = pathname.match(/^\/api\/chat\/sessions\/([\w-]+)$/);
      if (sessionMatch) {
        const store = chatStore.readChats();
        const session = store.sessions.find((item) => item.id === sessionMatch[1]);
        if (req.method === 'GET') {
          if (!session) return sendJSON(res, 404, { error: 'session not found' });
          return sendJSON(res, 200, {
            id: session.id,
            title: session.title,
            stockContext: chatStore.normalizeStockContext(session.stockContext),
            messages: session.messages,
          });
        }
        if (req.method === 'DELETE') {
          const result = await chatService.withSessionLock(sessionMatch[1], async () => {
            const latest = chatStore.readChats();
            latest.sessions = latest.sessions.filter((item) => item.id !== sessionMatch[1]);
            chatStore.writeChats(latest);
            return { ok: true };
          });
          return sendJSON(res, 200, result);
        }
        return sendJSON(res, 405, { error: 'method not allowed' });
      }

      if (pathname === '/api/watchlist') {
        if (req.method === 'GET') return sendJSON(res, 200, watchlistStore.readWatchlist());
        if (req.method === 'POST') {
          let body;
          try { body = JSON.parse(await readBody(req)); }
          catch (error) { return sendJSON(res, 400, { error: error.message }); }
          if (!Array.isArray(body)) return sendJSON(res, 400, { error: 'expect array' });
          const list = watchlistStore.normalizeWatchlist(body);
          watchlistStore.writeWatchlist(list);
          return sendJSON(res, 200, { ok: true, count: list.length });
        }
        return sendJSON(res, 405, { error: 'method not allowed' });
      }

      if (pathname === '/api/quote') {
        const code = sanitizeCode(url.searchParams.get('code') || '');
        if (!code) return sendJSON(res, 400, { error: 'code required' });
        const entry = await marketService.quote(code);
        return sendMarketJSON(res, entry, { market: marketForCode(code) }, marketMeta);
      }
      if (pathname === '/api/quotes') {
        const codes = (url.searchParams.get('codes') || '')
          .split(',')
          .map(sanitizeCode)
          .filter(Boolean)
          .slice(0, 50);
        const entry = await marketService.quotes(codes);
        return sendMarketJSON(res, entry, {
          market: null,
          currency: null,
          timezone: null,
        }, marketMeta);
      }
      if (pathname === '/api/search') {
        const query = (url.searchParams.get('q') || '').trim().slice(0, 20);
        return sendJSON(res, 200, (await marketService.search(query)).data);
      }
      if (pathname === '/api/overview') {
        const market = url.searchParams.get('market') === 'us' ? 'us' : 'cn';
        const entry = await marketService.overview(market);
        return sendMarketJSON(res, entry, {
          market,
          ...(market === 'us' ? { currency: null } : {}),
        }, marketMeta);
      }
      if (pathname === '/api/news') {
        return sendJSON(res, 200, (await marketService.news()).data);
      }

      const full = staticServer.resolvePath(pathname);
      if (!full) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found');
      }
      return staticServer.serve(req, res, full);
    } catch (error) {
      logger.error(`[ERR] ${pathname}:`, error.message);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      return sendJSON(res, 502, { error: error.message });
    }
  }

  return handler;
}

module.exports = { maskKey, createHttpHandler };
