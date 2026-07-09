# 行情看板（A股 / 美股）

本地运行的股票行情网站：大盘指数、分时/日K走势、行业板块、领涨领跌个股、财经要闻。深色主题，红涨绿跌，兼容手机端。

## 运行

需要 Node.js 18+（无需安装任何依赖）：

```bash
cd ~/Desktop/Personal/market
node server.js
```

打开 http://localhost:3888

手机访问：手机与电脑连同一 Wi-Fi，用电脑局域网 IP 访问，如 `http://192.168.x.x:3888`
（查看本机 IP：`ipconfig getifaddr en0`）

## 功能

- **A股**：上证指数、深证成指、创业板指、沪深300、科创50；行业板块领涨领跌（含领涨股）；沪深个股涨跌幅榜
- **美股**：道琼斯、纳斯达克、标普500；Yahoo 当日涨幅榜/跌幅榜（自带仙股过滤）
- **走势图**：分时（含成交量副图）/ 日K / 周K / 月K 切换；K线带 MA5/10/20 均线和成交量
- **市场概况**：A股显示涨跌家数/涨停跌停/两市成交额；美股显示 VIX、美债、美元、黄金、原油、比特币
- **个股详情**：点击涨跌榜/板块领涨股/搜索结果打开弹窗——完整报价（换手、PE、PB、市值等）+ 分时/日K/周K/月K
- **自选股**：独立 tab，详情弹窗点 ♡ 添加，A股美股混合展示；存服务器 `data/watchlist.json`，所有设备共享同一份（部署更新时勿覆盖 data/ 目录）
- **搜索**：顶栏搜索框，支持代码/中文/拼音/英文（腾讯 smartbox），覆盖 A股和美股
- **AI 问答**：独立 tab，多会话管理（新建/切换/删除，存服务器跨设备同步）。LLM 通过工具调用获取看板的实时数据（指数、个股、板块资金流、涨跌榜、市场概况、新闻、搜索）后作答。使用 OpenAI 兼容协议——在页面「⚙ 模型设置」里选服务商（DeepSeek/Kimi/通义/智谱/OpenAI/自定义）并填入 API Key 即可，保存立即生效；Key 存服务器 `data/llm.json`，接口只返回掩码（也可用环境变量 `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL` 覆盖）
- **新闻**：新浪财经滚动要闻，5 分钟自动刷新
- **智能刷新**：盘中 30 秒刷新行情，收盘后自动降为 5 分钟；顶栏显示盘中/已收盘状态
- ECharts 已自托管（public/vendor/），不依赖外部 CDN

## 数据来源

| 数据 | 来源 |
|---|---|
| A股指数 / 分时 / K线 | 腾讯行情 (qt.gtimg.cn / web.ifzq.gtimg.cn) |
| A股行业板块 | 腾讯 (proxy.finance.qq.com) |
| A股涨跌榜 | 新浪财经 |
| 美股指数 / 分时 / K线 / 涨跌榜 | Yahoo Finance (query1.finance.yahoo.com) |
| 财经新闻 | 新浪财经滚动 |

均为免费公开接口，服务端做了 15s~5min 的缓存以减少请求。数据可能有延迟，仅供参考，不构成投资建议。

## 结构

```
market/
├── server.js        # Node 服务：静态文件 + 行情接口代理（解决跨域/GBK编码）
└── public/
    ├── index.html
    ├── app.js       # 前端逻辑（ECharts 走势图）
    └── style.css    # 深色主题，≤768px 响应式
```

## 可修改的地方

- 端口：`PORT=8080 node server.js` 或改 server.js 顶部 `PORT`
- 指数列表：server.js 中 `CN_INDICES`（腾讯代码，如 `sh000905` 中证500）/ `US_INDICES`（Yahoo 代码，如 `^RUT` 罗素2000）
- 刷新频率：app.js 底部两个 `setInterval`
