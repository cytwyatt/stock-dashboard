'use strict';

const {
  STOCK_REASON_INTENT_RE,
  hasStockResearchIntent,
  isAbnormalQuote,
  compactQuoteForEvidence,
  compactResearchCardForEvidence,
} = require('./research-intent');

function createEvidenceBuilder({
  marketService,
  stockEventsService,
  marketMeta,
  marketForCode,
  isCNCode,
  logger = console,
  now = () => Date.now(),
}) {
  async function buildAutomaticStockResearch(stockContext, text, { onTool } = {}) {
    if (!stockContext || !hasStockResearchIntent(text, stockContext)) return null;
    if (onTool) onTool('get_research_card', { code: stockContext.code, auto: true });
    try {
      const entry = await marketService.research(stockContext.code);
      const result = {
        data: entry.data,
        meta: marketMeta(entry, { market: marketForCode(stockContext.code) }),
      };
      return compactResearchCardForEvidence(result);
    } catch (error) {
      logger.error(`[stock-research] ${stockContext.code}: ${error.message}`);
      return {
        data: { code: stockContext.code, market: stockContext.market },
        meta: null,
        error: '研究卡暂时不可用',
      };
    }
  }

  async function buildAutomaticStockEvidence(stockContext, text, { checkMove = false, onTool } = {}) {
    if (!stockContext) return null;
    const reasonIntent = STOCK_REASON_INTENT_RE.test(text);
    if (!reasonIntent && !checkMove) return null;

    let quote = null;
    try {
      if (onTool) onTool('get_quote', { code: stockContext.code, auto: true });
      quote = (await marketService.quote(stockContext.code)).data;
    } catch (error) {
      logger.error(`[stock-evidence] quote ${stockContext.code}: ${error.message}`);
    }
    const abnormalMove = isAbnormalQuote(quote);
    if (!reasonIntent && !abnormalMove) return null;

    if (onTool) {
      onTool('get_stock_events', {
        code: stockContext.code,
        lookbackHours: 72,
        auto: true,
      });
    }
    let stockEvents;
    try {
      stockEvents = await stockEventsService.getStockEvents(stockContext.code, {
        name: (quote && quote.name) || stockContext.name,
        lookbackHours: 72,
        limit: 8,
      });
    } catch (error) {
      logger.error(`[stock-evidence] news ${stockContext.code}: ${error.message}`);
      stockEvents = {
        asOf: new Date(now()).toISOString(),
        stock: stockContext,
        coverage: { supported: isCNCode(stockContext.code), error: '个股资讯源暂时不可用' },
        events: [],
      };
    }
    return {
      reasonIntent,
      abnormalMove,
      quote: compactQuoteForEvidence(quote),
      stockEvents,
    };
  }

  return {
    buildAutomaticStockResearch,
    buildAutomaticStockEvidence,
  };
}

module.exports = { createEvidenceBuilder };
