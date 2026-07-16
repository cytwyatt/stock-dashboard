'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  createCacheRuntime,
  defaultCacheRuntime,
} = require('./core/cache');
const {
  MARKET_DEFAULTS,
  annotateMarketData,
  getMarketDataMeta,
  marketMeta,
} = require('./core/market-meta');
const {
  sanitizeCode,
  normalizeProfileCode,
  isCNCode,
  isHKCode,
  isKnownHKCode,
  isTXCode,
  marketForCode,
} = require('./core/symbols');
const {
  fmtCNTime,
  fmtHKTime,
  isoTencentTime,
  isoMinuteTime,
  fmtTimeInTZ,
  dateInTimezone,
  isMarketOpen,
} = require('./core/time');
const researchDomain = require('./domain/research-card');

const { createHttpClient } = require('./providers/http-client');
const {
  createYahooProvider,
  createYahooScheduler,
  defaultYahooScheduler,
  parseYahooKline: parseYahooKlineWithDeps,
} = require('./providers/yahoo');
const { createTencentProvider } = require('./providers/tencent');
const {
  createSinaProvider,
  cnPriceLimitPct,
  isCNPriceLimit,
} = require('./providers/sina');
const { createNasdaqProvider } = require('./providers/nasdaq');

const { createMarketData, summarizeSectorBreadth } = require('./services/market-data');
const { createMarketService } = require('./services/market-service');
const { createResearchService } = require('./services/research-service');
const { createStockEventsService } = require('./services/stock-events-service');
const {
  CACHE_WARM_INTERVAL_MS,
  createCacheWarmer,
} = require('./services/cache-warmer');

const { createJsonFileStorage } = require('./storage/json-file');
const { createWatchlistStore } = require('./storage/watchlist-store');
const { createLLMConfigStore } = require('./storage/llm-config-store');
const { createChatStore } = require('./storage/chat-store');
const { createMarketReviewStore } = require('./storage/market-review-store');

const { createLLMClient } = require('./ai/llm-client');
const { createMarketReviewService } = require('./ai/market-review-service');
const { LLM_TOOLS, serializeToolResult, createToolRunner } = require('./ai/tools');
const prompts = require('./ai/prompts');
const {
  hasStockResearchIntent,
  compactResearchCardForEvidence,
} = require('./ai/research-intent');
const { createEvidenceBuilder } = require('./ai/evidence');
const { createChatService } = require('./ai/chat-service');

const { createAuth } = require('./http/auth');
const { createStaticServer } = require('./http/static');
const { createHttpHandler } = require('./http/router');

const defaultRuntime = Object.freeze({
  cache: defaultCacheRuntime,
  yahooScheduler: defaultYahooScheduler,
});

function createRuntime() {
  return {
    cache: createCacheRuntime(),
    yahooScheduler: createYahooScheduler(),
  };
}

function createApplication({
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  runtime = defaultRuntime,
} = {}) {
  if (!runtime || !runtime.cache || !runtime.yahooScheduler) {
    throw new TypeError('runtime must provide cache and yahooScheduler');
  }
  const { cache, cached, cachedEntry } = runtime.cache;
  const port = env.PORT || 3888;
  const projectDir = path.join(__dirname, '..');
  const publicDir = path.join(projectDir, 'public');
  const dataDir = env.MARKET_DATA_DIR || path.join(projectDir, 'data');

  const httpClient = createHttpClient({ fetchImpl });
  const yahoo = createYahooProvider({
    fetchText: httpClient.fetchText,
    annotateMarketData,
    formatTime: fmtTimeInTZ,
    scheduler: runtime.yahooScheduler,
  });
  const tencent = createTencentProvider({
    fetchText: httpClient.fetchText,
    annotateMarketData,
    isHKCode,
    fmtCNTime,
    fmtHKTime,
    isoTencentTime,
    isoMinuteTime,
  });
  const sina = createSinaProvider({
    fetchText: httpClient.fetchText,
    annotateMarketData,
    isCNCode,
  });
  const nasdaq = createNasdaqProvider({
    fetchText: httpClient.fetchText,
    annotateMarketData,
  });
  const marketData = createMarketData({
    yahoo,
    tencent,
    sina,
    nasdaq,
    annotateMarketData,
    isCNCode,
    isHKCode,
    isTXCode,
  });

  const researchService = createResearchService({
    marketForCode,
    getMarketDataMeta,
    annotateMarketData,
    marketDefaults: MARKET_DEFAULTS,
    isMarketOpen,
    dateInTimezone,
    logger,
  });
  const marketService = createMarketService({
    cachedEntry,
    getIndices: marketData.getIndices,
    getMinute: marketData.getMinute,
    getKline: marketData.getKline,
    getResearchCardEntry: researchService.getResearchCardEntry,
    getSectors: marketData.getSectors,
    getRankCN: marketData.getRankCN,
    getRankHK: marketData.getRankHK,
    getRankUS: marketData.getRankUS,
    getOverviewCN: marketData.getOverviewCN,
    getOverviewHK: marketData.getOverviewHK,
    getOverviewUS: marketData.getOverviewUS,
    getQuote: marketData.getQuote,
    getQuotes: marketData.getQuotes,
    getProfile: marketData.getProfile,
    searchStocks: marketData.searchStocks,
    getNews: marketData.getNews,
    getMarketDataMeta,
    annotateMarketData,
    isTXCode,
    isMarketOpen,
  });
  const stockEventsService = createStockEventsService({
    cached,
    getStockNewsCN: marketData.getStockNewsCN,
    isCNCode,
    isHKCode,
    isKnownHKCode,
  });

  const jsonFile = createJsonFileStorage({ dataDir, fs, crypto, logger });
  const watchlistStore = createWatchlistStore({
    dataDir,
    fs,
    jsonFile,
    sanitizeCode,
  });
  const llmConfigStore = createLLMConfigStore({
    dataDir,
    fs,
    jsonFile,
    env,
  });
  const chatStore = createChatStore({
    dataDir,
    fs,
    jsonFile,
    isCNCode,
    isKnownHKCode,
  });
  const marketReviewStore = createMarketReviewStore({
    dataDir,
    fs,
    jsonFile,
  });

  const llmClient = createLLMClient({ fetchImpl });
  const marketReviewService = createMarketReviewService({
    marketService,
    marketReviewStore,
    llmConfigStore,
    llmClient,
    marketMeta,
    annotateMarketData,
    marketReviewSystemPrompt: prompts.marketReviewSystemPrompt,
    logger,
  });
  const toolRunner = createToolRunner({
    marketService,
    stockEventsService,
    marketMeta,
    marketForCode,
    sanitizeCode,
    isCNCode,
  });
  const evidenceBuilder = createEvidenceBuilder({
    marketService,
    stockEventsService,
    marketMeta,
    marketForCode,
    isCNCode,
    logger,
  });
  const chatService = createChatService({
    chatStore,
    llmConfigStore,
    llmClient,
    toolRunner,
    LLM_TOOLS,
    automaticEvidence: evidenceBuilder.buildAutomaticStockEvidence,
    automaticResearch: evidenceBuilder.buildAutomaticStockResearch,
    adaptiveThinkingIntent: hasStockResearchIntent,
    prompts,
    serializeToolResult,
    logger,
  });

  const auth = createAuth({ password: env.MARKET_PASSWORD || '' });
  const staticServer = createStaticServer({ publicDir });
  const handler = createHttpHandler({
    port,
    auth,
    staticServer,
    marketService,
    marketReviewService,
    chatService,
    llmConfigStore,
    llmClient,
    watchlistStore,
    chatStore,
    marketMeta,
    sanitizeCode,
    normalizeProfileCode,
    marketForCode,
    env,
    logger,
  });
  const server = http.createServer(handler);
  const cacheWarmer = createCacheWarmer({
    marketService,
    isMarketOpen,
    logger,
  });
  let warmTimer = null;
  let reviewTimer = null;
  const reviewOnce = () => marketReviewService.ensureDueReviews()
    .catch((error) => logger.error(`[market-review] scheduler: ${error.message}`));

  function startTimers() {
    if (env.MARKET_DISABLE_WARM !== '1' && !warmTimer) {
      warmTimer = setInterval(cacheWarmer.warmOnce, CACHE_WARM_INTERVAL_MS);
    }
    if (env.MARKET_DISABLE_REVIEW !== '1' && !reviewTimer) {
      reviewTimer = setInterval(reviewOnce, 5 * 60 * 1000);
    }
  }

  function startServer() {
    chatStore.migrateChatSessionIds();
    return server.listen(port, () => {
      startTimers();
      logger.log(`行情看板已启动: http://localhost:${port}`);
      if (env.MARKET_DISABLE_WARM !== '1') cacheWarmer.warmOnce();
      if (env.MARKET_DISABLE_REVIEW !== '1') reviewOnce();
    });
  }

  server.on('close', () => {
    if (warmTimer) clearInterval(warmTimer);
    if (reviewTimer) clearInterval(reviewTimer);
    warmTimer = null;
    reviewTimer = null;
  });

  const parseYahooKline = (result) => parseYahooKlineWithDeps(result, { annotateMarketData });

  return {
    runtime,
    port,
    dataDir,
    server,
    startServer,
    cache,
    cached,
    cachedEntry,
    marketData,
    marketService,
    marketReviewService,
    marketSummaryService: marketReviewService,
    stockEventsService,
    chatService,
    stores: { watchlistStore, llmConfigStore, chatStore, marketReviewStore },
    compatibility: {
      ...researchDomain,
      hasStockResearchIntent,
      compactResearchCardForEvidence,
      stockResearchSystemMessage: prompts.stockResearchSystemMessage,
      cnPriceLimitPct,
      isCNPriceLimit,
      summarizeSectorBreadth,
      parseYahooKline,
      getMarketDataMeta,
      marketMeta,
      isoTencentTime,
    },
  };
}

function createIsolatedApplication(options = {}) {
  return createApplication({ ...options, runtime: createRuntime() });
}

module.exports = {
  createApplication,
  createIsolatedApplication,
  createRuntime,
  defaultRuntime,
};
