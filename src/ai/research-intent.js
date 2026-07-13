'use strict';

const { sanitizeCode } = require('../core/symbols');
const { RESEARCH_BENCHMARKS } = require('../domain/research-card');

const STOCK_REASON_INTENT_RE = /为什么|为何|因为|原因|催化|消息面|驱动|因何|怎么回事|咋回事|发生了什么|涨停|跌停|一字板|异动|(?:有何|有什么|出了什么|什么)(?:消息|新闻|资讯)|最新(?:消息|新闻)|利好|利空/;
const STOCK_RESEARCH_METRIC_INTENT_RE = /(?:1|5|20|60|120)\s*(?:日|天)|阶段(?:表现|收益)|近期(?:表现|收益|涨跌|走势)|收益率?|回报|涨跌幅|相对强弱|跑[赢输]|超额|(?:相对|对比).{0,8}(?:基准|大盘|指数)|(?:相对|对比).{0,12}(?:表现|收益|强弱)|(?:和|与|跟).{0,16}(?:比|相比|比较).{0,8}(?:表现|收益|强弱)|波动(?:率)?|最大回撤|回撤|52\s*周|五十二周|距(?:离)?(?:52\s*周)?(?:高点|低点)|量能|均量|成交量|放量|缩量|股价(?:趋势|走势|表现)|(?:价格|当前|后续|短期|中期)趋势(?:如何|怎样|怎么|呢|吗)?|^(?:趋势|走势)(?:如何|怎样|怎么|呢|吗)?[？?。！!]*$|技术面|关键价位|支撑位?|压力位?/i;
const STOCK_RESEARCH_RISK_INTENT_RE = /(?:股价|投资|交易|持仓|仓位)?风险(?:更?(?:大|高|低)|如何|怎样|怎么|呢|吗|水平|收益|[？?。！!]*$)|风险收益/i;
const STOCK_RESEARCH_DECISION_INTENT_RE = /买入|卖出|持有|加仓|减仓|仓位|止损|止盈|操作建议|能买吗|能不能买|该不该买|值得买吗|适合买/i;
const STOCK_RESEARCH_GENERAL_INTENT_RE = /(?:综合|整体|全面)(?:分析|评价|评估)|(?:分析|评价|评估|研究)(?:一下|下)?(?:这只|该|这个)(?:股票|个股|标的|公司|股)|(?:这只|该|这个)(?:股票|个股|标的|公司|股)(?:怎么样|怎么看|如何看)|(?:分析|评价|评估|研究|看看)(?:一下|下)?\s*(?:股票|个股|代码)?\s*\$?(?:(?:sh|sz|bj)\d{6}|hk\d{5}|\^[A-Z]{1,8}|\d{3,6}|[A-Z]{1,8}(?:[-=][A-Z]{1,6})?)|(?:(?:sh|sz|bj)\d{6}|hk\d{5}|\^[A-Z]{1,8}|\d{3,6}|[A-Z]{1,8}(?:[-=][A-Z]{1,6})?)\s*(?:(?:这只|该|这个)(?:股票|个股|标的|公司|股))?\s*(?:怎么样|怎么看|如何看)|^(?:请|帮我)?(?:分析|评价|评估|研究)(?:一下|下)?(?:它|这只股票|该股)?[？?。！!]*$|^(?:怎么看|怎么样|如何看)(?:它|这只股票|该股)?[？?。！!]*$/i;
const NON_PRICE_RESEARCH_INTENT_RE = /经营风险|业务风险|法律风险|合规风险|财务风险|翻译|改写|润色|公司什么时候成立|成立时间|创始人|主营业务|管理层|董事长|最新公告|最新新闻|最新消息|财报|营收|净利润|盈利|估值|市盈率|市净率|分红|股息/i;
const STOCK_COMPARISON_INTENT_RE = /相对|对比|相比|比较|跑[赢输]|超额|基准|(?:和|与|跟).{0,20}(?:比|谁|差异|表现|收益|风险|波动|回撤|强弱)|\b(?:vs\.?|versus)\b/i;
const STOCK_RESEARCH_NAMED_MARKET_TARGETS = [
  { code: 'sh000001', aliases: ['上证指数', '上证综指', '上证'] },
  { code: 'sz399001', aliases: ['深证成指', '深证指数', '深证'] },
  { code: 'sz399006', aliases: ['创业板指数', '创业板指', '创业板'] },
  { code: 'sh000300', aliases: ['沪深300'] },
  { code: 'sh000688', aliases: ['科创50'] },
  { code: 'hkHSI', aliases: ['恒生指数', '恒指'] },
  { code: 'hkHSCEI', aliases: ['恒生国企指数', '国企指数'] },
  { code: 'hkHSTECH', aliases: ['恒生科技指数', '恒生科技', '恒科'] },
  { code: '^DJI', aliases: ['道琼斯指数', '道琼斯', '道指'] },
  { code: '^IXIC', aliases: ['纳斯达克指数', '纳斯达克', '纳指'] },
  { code: '^GSPC', aliases: ['标准普尔500', '标普500', '标普', 's&p500'] },
  { code: '^VIX', aliases: ['恐慌指数', 'vix'] },
  { code: '^TNX', aliases: ['美债10年期', '美国国债', '美债'] },
  { code: 'DX-Y.NYB', aliases: ['美元指数'] },
  { code: 'GC=F', aliases: ['黄金'] },
  { code: 'CL=F', aliases: ['原油', 'wti'] },
  { code: 'BTC-USD', aliases: ['比特币'] },
];

function unwrapStockChatQuestion(text) {
  const value = String(text || '').trim();
  const unwrapped = value.replace(/^分析股票\s+[^。]{1,300}。/, '').trim();
  return unwrapped || value;
}

function targetsDifferentStock(text, stockContext) {
  if (!stockContext) return false;
  const question = unwrapStockChatQuestion(text);
  // S&P500 是基准名称，不应被拆成美股代码 S 和 P500。
  const tickerQuestion = question.replace(/S\s*&\s*P\s*500/gi, '标普500');
  const codes = [];
  const normalizeBareNumber = (digits) => stockContext.market === 'hk' && digits.length <= 5
    ? digits.padStart(5, '0')
    : digits;
  for (const match of question.matchAll(/(?:sh|sz|bj)\d{6}|hk(?:\d{5}|HSI|HSCEI|HSTECH)|\^[A-Z0-9.=-]{1,12}/gi)) {
    codes.push(sanitizeCode(match[0]));
  }
  for (const match of tickerQuestion.matchAll(/\$([A-Z][A-Z0-9]*(?:[.=-][A-Z0-9]{1,8})?)/gi)) {
    codes.push(sanitizeCode(match[1]));
  }
  const acronymStoplist = new Set([
    'AI', 'PE', 'PB', 'ROE', 'ROA', 'EPS', 'ETF', 'CEO', 'CFO',
    'CPI', 'GDP', 'PMI', 'FOMC', 'RSI', 'MACD', 'KDJ', 'MA', 'BOLL',
    'USD', 'CNY', 'HKD', 'IPO', 'ALPHA', 'BETA', 'RISK', 'RETURN',
    'VOLATILITY', 'DRAWDOWN', 'PRICE', 'TREND', 'VOLUME', 'MARKET',
    'STOCK', 'BUY', 'SELL', 'HOLD', 'VS', 'AND', 'OR', 'S', 'P500',
  ]);
  // 非术语英文 token 在中文投研问句中通常就是 ticker；全句扫描避免被“目前/对于”等填充词绕过。
  for (const match of tickerQuestion.matchAll(/\b[A-Z][A-Z0-9]{0,19}(?:[.=-][A-Z0-9]{1,8})?\b/gi)) {
    if (tickerQuestion[match.index - 1] === '^' || tickerQuestion[match.index - 1] === '$') continue;
    if (!acronymStoplist.has(match[0].toUpperCase())) codes.push(sanitizeCode(match[0]));
  }
  // 明确的投研句式中大小写都可表示 ticker，且 MA/AI 等真实代码不能按普通缩写忽略。
  for (const match of tickerQuestion.matchAll(/(?:分析|研究|看看|查看|看|评价|评估)(?:一下|下)?\s*(?:这只|该|这个)?\s*(?:股票|个股|代码|标的)?\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)/gi)) {
    codes.push(sanitizeCode(match[1]));
  }
  for (const match of tickerQuestion.matchAll(/\b([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)\b(?=\s*(?:(?:这只|该|这个)(?:股票|个股|标的|公司))?\s*(?:的)?\s*(?:风险|能买吗|能不能买|值得买吗|该不该买|适合买|买入|卖出|持有|加仓|减仓|仓位|止损|止盈|波动|最大回撤|回撤|收益|表现|走势|趋势|怎么样|怎么看|52\s*周|量能|成交量))/gi)) {
    if (tickerQuestion[match.index - 1] === '^' || tickerQuestion[match.index - 1] === '$') continue;
    codes.push(sanitizeCode(match[1]));
  }
  for (const match of tickerQuestion.matchAll(/(?:相对|对比|相比|比较|跑赢|跑输|超额|基准(?:是|为)?)\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)/gi)) {
    codes.push(sanitizeCode(match[1]));
  }
  for (const match of tickerQuestion.matchAll(/(?:对于|关于|至于|跟|和|与)\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)/gi)) {
    codes.push(sanitizeCode(match[1]));
  }
  for (const match of tickerQuestion.matchAll(/(?:持有|持仓|关注|看好|买了|买入)\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)/gi)) {
    codes.push(sanitizeCode(match[1]));
  }
  // AI/MA/PB/PE 既可能是术语也可能是真实 ticker；交易/风险问句按潜在标的保守处理，
  // 但“用 AI 分析”是明确的工具语法，不应误伤当前股票。
  const ambiguousTickerQuestion = tickerQuestion.replace(/(?:用|让|请|叫)?\s*AI\s*(?:来)?分析/gi, '');
  if (STOCK_RESEARCH_DECISION_INTENT_RE.test(question)
    || STOCK_RESEARCH_RISK_INTENT_RE.test(question)
    || STOCK_RESEARCH_METRIC_INTENT_RE.test(question)) {
    for (const match of ambiguousTickerQuestion.matchAll(/\b(?:AI|MA|PB|PE)\b/gi)) {
      codes.push(sanitizeCode(match[0]));
    }
  }
  for (const match of tickerQuestion.matchAll(/\b([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)\b\s*(?:和|与|跟|vs\.?|versus)\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)\b/gi)) {
    codes.push(sanitizeCode(match[1]), sanitizeCode(match[2]));
  }
  const leadingTicker = tickerQuestion.match(/^\s*(?:请问|想问|我想问|我觉得|我想了解)?\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)\b/i);
  if (leadingTicker) codes.push(sanitizeCode(leadingTicker[1]));
  for (const match of tickerQuestion.matchAll(/[、,，/]\s*\$?([A-Z][A-Z0-9]{0,7}(?:[.=-][A-Z0-9]{1,8})?)\b/gi)) {
    codes.push(sanitizeCode(match[1]));
  }
  // 用户常省略 A/H 股市场前缀；不能因此把另一只股票的问题套到当前个股研究卡上。
  for (const match of question.matchAll(/(?<![A-Za-z0-9])(\d{5,6})(?!\d)/g)) {
    codes.push(match[1]);
  }
  for (const match of question.matchAll(/(?:分析|研究|看看|查看|评价|评估)(?:一下|下)?\s*(?:股票|个股|代码|标的)?\s*(\d{3,6})(?!\d)/g)) {
    codes.push(normalizeBareNumber(match[1]));
  }
  const leadingNumber = question.match(/^\s*(\d{3,6})(?=\s*(?:怎么样|怎么看|如何看|风险|能买吗|表现|走势|趋势))/);
  if (leadingNumber) codes.push(normalizeBareNumber(leadingNumber[1]));
  if (stockContext.market === 'hk') {
    for (const match of question.matchAll(/(?<![A-Za-z0-9])(\d{3,5})(?!\d)/g)) {
      codes.push(match[1].padStart(5, '0'));
    }
    for (const match of question.matchAll(/(?:港股|代码|股票)\s*[:：]?\s*(\d{1,2})(?!\d)/g)) {
      codes.push(match[1].padStart(5, '0'));
    }
  }
  const benchmark = RESEARCH_BENCHMARKS[stockContext.market];
  const comparisonIntent = STOCK_COMPARISON_INTENT_RE.test(question);
  const allowed = new Set();
  const allowCodeAliases = (rawCode) => {
    const code = sanitizeCode(rawCode).toLowerCase();
    if (!code) return;
    allowed.add(code);
    const local = code.match(/^(?:sh|sz|bj)(\d{6})$/) || code.match(/^hk(\d{5})$/);
    if (local) {
      allowed.add(local[1]);
      if (code.startsWith('hk')) allowed.add(local[1].replace(/^0+/, '') || '0');
    }
    if (code.startsWith('^')) allowed.add(code.slice(1));
    const hkIndex = code.match(/^hk([a-z]+)$/);
    if (hkIndex) allowed.add(hkIndex[1]);
  };
  allowCodeAliases(stockContext.code);
  for (const match of String(stockContext.name || '').matchAll(/[A-Z][A-Z0-9]{0,19}(?:[.=-][A-Z0-9]{1,8})?/gi)) {
    allowed.add(match[0].toLowerCase());
  }
  // 基准代码只有在明确比较语境中才属于当前个股问题；直接询问指数应跳过个股研究卡。
  if (benchmark && comparisonIntent) allowCodeAliases(benchmark.code);
  const contextCode = sanitizeCode(stockContext.code).toLowerCase();
  const compactQuestion = question.replace(/\s+/g, '').toLowerCase();
  for (const target of STOCK_RESEARCH_NAMED_MARKET_TARGETS) {
    if (!target.aliases.some((alias) => compactQuestion.includes(alias.toLowerCase()))) continue;
    const targetCode = target.code.toLowerCase();
    if (targetCode === contextCode) continue;
    if (benchmark && comparisonIntent && targetCode === benchmark.code.toLowerCase()) continue;
    return true;
  }
  return codes.some((code) => code && !allowed.has(code.toLowerCase()));
}

function hasStockResearchIntent(text, stockContext = null) {
  const question = unwrapStockChatQuestion(text);
  if (!question || targetsDifferentStock(question, stockContext)) return false;
  const comparisonIntent = STOCK_COMPARISON_INTENT_RE.test(question);
  const metricIntent = STOCK_RESEARCH_METRIC_INTENT_RE.test(question)
    || (comparisonIntent && /表现|收益|强弱|波动|回撤/.test(question));
  const riskIntent = STOCK_RESEARCH_RISK_INTENT_RE.test(question);
  const decisionIntent = STOCK_RESEARCH_DECISION_INTENT_RE.test(question);
  const marketOnlyIntent = /(?:大盘|指数|市场)/i.test(question)
    && !/(?:这只|该股|个股|股票)/i.test(question)
    && !comparisonIntent;
  if (marketOnlyIntent) return false;
  if (metricIntent || decisionIntent) return true;
  if (NON_PRICE_RESEARCH_INTENT_RE.test(question)) return false;
  if (riskIntent) return true;
  if (/(?:大盘|指数|市场).*(?:怎么样|怎么看|如何|分析|走势)/i.test(question)) return false;
  return STOCK_RESEARCH_GENERAL_INTENT_RE.test(question);
}

function isAbnormalQuote(quote) {
  return !!quote && Math.abs(Number(quote.changePct) || 0) >= 7;
}

function compactQuoteForEvidence(quote) {
  if (!quote) return null;
  return {
    code: quote.code,
    name: quote.name,
    market: quote.market,
    price: quote.price,
    prevClose: quote.prevClose,
    open: quote.open,
    high: quote.high,
    low: quote.low,
    change: quote.change,
    changePct: quote.changePct,
    time: quote.time,
  };
}

function compactResearchCardForEvidence(result) {
  const data = result && result.data || {};
  const meta = result && result.meta || {};
  return {
    data: {
      code: data.code,
      market: data.market,
      currency: data.currency,
      analysisAsOf: data.analysisAsOf,
      lastTradeDate: data.lastTradeDate,
      comparisonAsOf: data.comparisonAsOf,
      latestBarComplete: data.latestBarComplete,
      historySessions: data.historySessions,
      alignedSessions: data.alignedSessions,
      latestClose: data.latestClose,
      benchmark: data.benchmark,
      returns: data.returns,
      range52: data.range52,
      risk: data.risk,
      volume20: data.volume20,
      quality: data.quality,
      signals: data.signals,
    },
    meta: {
      source: meta.source,
      currency: meta.currency,
      timezone: meta.timezone,
      asOf: meta.asOf,
      fetchedAt: meta.fetchedAt,
      stale: meta.stale,
      staleSince: meta.staleSince,
      adjustmentBasis: meta.adjustmentBasis,
      adjustmentCoverage: meta.adjustmentCoverage,
      coverage: meta.coverage,
    },
  };
}

module.exports = {
  STOCK_REASON_INTENT_RE,
  STOCK_RESEARCH_METRIC_INTENT_RE,
  STOCK_RESEARCH_RISK_INTENT_RE,
  STOCK_RESEARCH_DECISION_INTENT_RE,
  STOCK_RESEARCH_GENERAL_INTENT_RE,
  NON_PRICE_RESEARCH_INTENT_RE,
  STOCK_COMPARISON_INTENT_RE,
  STOCK_RESEARCH_NAMED_MARKET_TARGETS,
  unwrapStockChatQuestion,
  targetsDifferentStock,
  hasStockResearchIntent,
  isAbnormalQuote,
  compactQuoteForEvidence,
  compactResearchCardForEvidence,
};
