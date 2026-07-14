'use strict';

/**
 * 股票行情看板组合根。
 * 业务实现位于 src/；本文件只创建唯一依赖实例、导出测试兼容接口并启动服务。
 */
const { createApplication } = require('./src/bootstrap');

const application = createApplication();
const {
  server,
  startServer,
  cache,
  cached,
  cachedEntry,
  marketData,
  marketService,
  marketReviewService,
  marketSummaryService,
  stockEventsService,
  chatService,
  stores,
  compatibility,
} = application;

if (require.main === module) startServer();

module.exports = {
  server,
  startServer,
  cache,
  cached,
  cachedEntry,
  marketData,
  marketService,
  marketReviewService,
  marketSummaryService,
  stockEventsService,
  chatService,
  stores,
  ...compatibility,
};
