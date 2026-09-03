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

if (require.main === module) {
  startServer();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 5000);
    deadline.unref();
    application.stopServer().then(() => clearTimeout(deadline)).catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

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
