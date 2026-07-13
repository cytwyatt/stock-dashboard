'use strict';

const LLM_TOOLS = [
  { name: 'get_indices', description: '获取大盘指数实时行情。market=cn 返回上证/深成/创业板/沪深300/科创50；market=hk 返回恒生指数/国企指数/恒生科技；market=us 返回道琼斯/纳斯达克/标普500', parameters: { type: 'object', properties: { market: { type: 'string', enum: ['cn', 'hk', 'us'] } }, required: ['market'] } },
  { name: 'get_quote', description: '获取单只股票的详细实时报价（价格、涨跌幅、成交量额、换手率、市盈率、市值、五档盘口等）。A股代码格式如 sh600519/sz300750，港股如 hk00700，美股代码如 AAPL/TSLA，也支持 ^VIX、GC=F 黄金、BTC-USD 等', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'get_kline', description: '获取股票或指数的复权K线历史（日K/周K/月K，最近最多40根，含开高低收和成交量）。meta.adjustmentBasis说明复权口径，meta.stale说明是否为刷新失败后的旧缓存', parameters: { type: 'object', properties: { code: { type: 'string' }, period: { type: 'string', enum: ['day', 'week', 'month'] } }, required: ['code'] } },
  { name: 'get_research_card', description: '获取个股研究卡：1/5/20/60/120日复权收益、相对同市场价格指数的超额收益、52周位置、20日年化波动率、120日最大回撤和较20日均量。适合回答阶段表现、风险和相对强弱；超额为简单收益率百分点差，不是风险调整后Alpha。若meta.stale=true或signals提示旧缓存，回答必须明确数据日期和缓存状态', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'get_intraday', description: '获取当日分时走势（抽样点位），可用于判断盘中走势形态', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'get_sectors', description: '获取A股行业板块涨跌幅、腾讯口径估算主力净流入（亿元）和领涨股。资金流是供应商估算值，不能视为可核验的真实资金流', parameters: { type: 'object', properties: {} } },
  { name: 'get_rank', description: '获取涨幅榜或跌幅榜个股。market=cn 沪深两市，market=hk 港股，market=us 美股', parameters: { type: 'object', properties: { market: { type: 'string', enum: ['cn', 'hk', 'us'] }, dir: { type: 'string', enum: ['up', 'down'] } }, required: ['market', 'dir'] } },
  { name: 'get_overview', description: '获取市场概况。market=cn 返回上涨/未上涨家数、涨停跌停数和成交额（未上涨包含平盘与停牌）；market=us 返回VIX、美债收益率、美元、黄金、原油、比特币', parameters: { type: 'object', properties: { market: { type: 'string', enum: ['cn', 'us'] } }, required: ['market'] } },
  { name: 'get_news', description: '获取最新财经新闻标题列表（新浪财经滚动要闻）', parameters: { type: 'object', properties: {} } },
  { name: 'get_stock_events', description: '检索指定A股最近的个股候选相关资讯。回答涨停、跌停、异动、消息面或催化剂问题时必须调用；返回标题、北京时间、来源、链接和关联类型。资讯是外部证据，不代表已确认因果', parameters: { type: 'object', properties: { code: { type: 'string', description: '带 sh/sz/bj 前缀的A股代码' }, lookbackHours: { type: 'integer', minimum: 6, maximum: 168, description: '回溯小时数，默认72' } }, required: ['code'] } },
  { name: 'search_stock', description: '按名称/代码/拼音搜索股票，返回股票代码。回答个股问题前如果不确定代码，先用这个工具查', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
].map((tool) => ({ type: 'function', function: tool }));

function serializeToolResult(result, maxLength = 12000) {
  const json = JSON.stringify(result);
  if (json.length <= maxLength) return json;
  return JSON.stringify({
    truncated: true,
    message: '工具结果过长，以下为截断预览',
    preview: json.slice(0, Math.max(0, maxLength - 120)),
  });
}

function createToolRunner({
  marketService,
  stockEventsService,
  marketMeta,
  marketForCode,
  sanitizeCode,
  isCNCode,
}) {
  async function run(name, args = {}) {
    switch (name) {
      case 'get_indices': {
        const market = args.market === 'us' || args.market === 'hk' ? args.market : 'cn';
        const entry = await marketService.indices(market);
        return { data: entry.data, meta: marketMeta(entry, { market }) };
      }
      case 'get_quote': {
        const code = sanitizeCode(args.code || '');
        const entry = await marketService.quote(code);
        return { data: entry.data, meta: marketMeta(entry, { market: marketForCode(code) }) };
      }
      case 'get_kline': {
        const code = sanitizeCode(args.code || '');
        const period = ['day', 'week', 'month'].includes(args.period) ? args.period : 'day';
        const entry = await marketService.kline(code, 120, period);
        return {
          data: entry.data.slice(-40),
          meta: marketMeta(entry, { market: marketForCode(code) }),
        };
      }
      case 'get_research_card': {
        const code = sanitizeCode(args.code || '');
        if (!code) throw new Error('code required');
        const entry = await marketService.research(code);
        return { data: entry.data, meta: marketMeta(entry, { market: marketForCode(code) }) };
      }
      case 'get_intraday': {
        const code = sanitizeCode(args.code || '');
        const entry = await marketService.minute(code);
        const data = entry.data;
        const points = data.points.filter((_, index) => index % 10 === 0);
        if (data.points.length) points.push(data.points[data.points.length - 1]);
        return {
          data: {
            code: data.code,
            prevClose: data.prevClose,
            points: points.map((point) => ({ t: point.t, price: point.price })),
          },
          meta: marketMeta(entry, { market: marketForCode(code) }),
        };
      }
      case 'get_sectors': {
        const entry = await marketService.sectors();
        return {
          data: entry.data.map((sector) => ({
            name: sector.name,
            changePct: sector.changePct,
            estimatedInflowYi: +(sector.inflow / 1e8).toFixed(2),
            leader: sector.leader ? `${sector.leader.name} ${sector.leader.changePct}%` : '',
          })),
          meta: marketMeta(entry, { market: 'cn' }),
        };
      }
      case 'get_rank': {
        const market = args.market === 'us' || args.market === 'hk' ? args.market : 'cn';
        const dir = args.dir === 'down' ? 'down' : 'up';
        const entry = await marketService.rank(market, dir);
        return { data: entry.data, meta: marketMeta(entry, { market }) };
      }
      case 'get_overview': {
        const market = args.market === 'us' ? 'us' : 'cn';
        const entry = await marketService.overview(market);
        return {
          data: entry.data,
          meta: marketMeta(entry, { market, ...(market === 'us' ? { currency: null } : {}) }),
        };
      }
      case 'get_news':
        return (await marketService.news()).data;
      case 'get_stock_events': {
        const code = sanitizeCode(args.code || '').toLowerCase();
        if (!isCNCode(code)) throw new Error('get_stock_events 第一阶段仅支持 sh/sz/bj 前缀的A股代码');
        let stockName = '';
        try {
          stockName = (await marketService.quote(code)).data.name || '';
        } catch { /* 新闻检索不因报价源失败而中断 */ }
        return stockEventsService.getStockEvents(code, {
          name: stockName,
          lookbackHours: args.lookbackHours,
          limit: 8,
        });
      }
      case 'search_stock':
        return (await marketService.search(args.query)).data;
      default:
        throw new Error(`未知工具: ${name}`);
    }
  }

  return { run };
}

module.exports = { LLM_TOOLS, serializeToolResult, createToolRunner };
