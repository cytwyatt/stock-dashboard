# AGENTS.md

A股/港股/美股行情看板。零依赖 Node 服务端（`server.js`）+ 原生 JS 前端（`public/`），无构建步骤、无 npm 包。功能介绍见 README.md，本文件只写维护时容易踩坑的部分。

## 运行与部署

```bash
node server.js                    # 本地运行，http://localhost:3888（Node ≥18）
```

生产环境在用户的 Ubuntu 服务器（SSH 别名 `ubuntu-ts`，走 Tailscale 私网，IP 见本机记忆或 `~/.ssh/config`），代码在 `~/apps/market`，由 systemd 用户服务 `market.service` 托管（已 enable + linger）。

```bash
# 部署（在 Mac 上执行）。注意三点：
# 1. 必须 --exclude='data'：服务器的 data/ 存着用户的自选股、AI会话、LLM Key，覆盖即丢失
# 2. 不能用 rsync：macOS 的 openrsync 与服务器不兼容，报 io_read 错误
# 3. 首次 SSH 可能超时：Tailscale 打洞慢，先 tailscale ping <服务器IP> 再连
cd ~/Desktop/Personal/market
tar czf - --exclude='.Codex' --exclude='.DS_Store' --exclude='data' . \
  | ssh ubuntu-ts 'tar xzf - -C ~/apps/market && rm -f ~/apps/market/._* ~/apps/market/public/._* && systemctl --user restart market'

ssh ubuntu-ts 'journalctl --user -u market -f'   # 看服务日志
```

服务器 sudo 需要密码，所有运维用 `systemctl --user`，不要用系统级 systemd。

### 公网访问（Tailscale Funnel + 口令）

默认只在 Tailscale 私网可达。要给外人访问，用 Funnel 暴露到公网（自带 HTTPS，对方无需装客户端）。Funnel 只允许 `443/8443/10000` 三个端口，443 已被服务器上另一个 tailnet-only 应用（`127.0.0.1:18789`）占用，所以 **market 走 8443**。公网地址见 `ssh ubuntu-ts 'tailscale funnel status'` 或本机记忆（`.ts.net` 主机名不写进本文件）。

```bash
ssh ubuntu-ts 'tailscale funnel --bg --https=8443 3888'   # 开公网
ssh ubuntu-ts 'tailscale funnel --https=8443 off'         # 关公网（私网不受影响）
```
首次开若报 Funnel 未授权，需在 admin console → Access controls 给节点加 `funnel` 属性（`nodeAttrs`），只能网页操作。

**上公网前必须有鉴权**：`src/http/auth.js` 和路由层实现了零依赖口令鉴权，靠环境变量 `MARKET_PASSWORD` 开关——未设则完全不生效（私网直连行为不变），设置后未登录/API 返回 401，POST `/__login` 校验后下发 `market_auth` cookie（HttpOnly、SameSite=Lax、**无 Secure** 以兼容私网 http、30 天）。口令值存服务器 `~/.config/systemd/user/market.service.d/auth.conf`（systemd drop-in，chmod 600，**不进 git**，本文件也不写实际口令）。改口令：编辑该文件后 `systemctl --user daemon-reload && systemctl --user restart market`。

## 数据源的坑（都是实测踩出来的，别改回去）

| 事实 | 后果 |
|---|---|
| 东方财富 push2.eastmoney.com 在本环境返回 502 | 不可用，别尝试。A股用腾讯+新浪，美股用 Yahoo |
| 腾讯 qt.gtimg.cn 返回 GBK | 必须 `fetchText(url, {encoding:'gbk'})` |
| Yahoo 按「UA+IP」分桶限流，连发几个请求就 429，冷却约 1 分钟 | 所有 Yahoo 请求必须走 `yahooFetch()`（串行队列 + 独立简短 UA + 退避重试）。新增 Yahoo 调用绝不能直接 fetch |
| Yahoo spark 接口可一次批量取多个报价 | 指数/宏观报价用 `sparkQuotes()`，不要逐个调 chart |
| 新浪美股榜单 `num` 参数被截断为 20 | 已弃用，美股榜单走 Yahoo screener |
| 新浪 A股涨跌榜按涨幅排序时前排全是异动仙股 | `getRankCN()` 必须多取候选，过滤 N/C 新股、ST、退市、价<1元或成交额<2000万元后再取前N；别改回直接 `slice` |
| 新浪 A股个股资讯页是 GBK HTML、无正式 API/SLA，`sh/sz/bj` 完整代码均可用 | `getStockNewsCN()` 必须走 `fetchText(..., {encoding:'gbk'})`，只解析 `.datelist`，链接限制为新浪 http/https 域名；页面有链接却零条解析时要报结构异常，不能静默当作“无新闻” |
| 腾讯个股报价 f[9..28] 是五档盘口，f[30] 时间，f[31/32] 涨跌/幅 | 字段位置见 `getQuote()`，改前先 curl 验证 |
| 腾讯分时成交量是**累计值** | `getMinute()` 里做了差分，别删 |
| 腾讯 `day/query` 每分钟行是 `HHMM price cumulativeVolume cumulativeAmount`，第四列是基础币种累计成交额；A股不能批量传两个 code | A股成交额必须并行取 `sh000001`+`sz399001`，盘中与前一交易日同期比、收盘后与前一交易日收盘比；当前值和历史基准必须同源，沪深口径明确不含北交所。港股用 `hkHSI`，金额不要再乘单位 |
| 腾讯板块接口的 `zgb`="上涨家数/总家数"、`zljlr`=主力净流入(万元) | `zgb` 无法推出真实下跌数，概况只能显示“上涨/未上涨”；`getSectors()` 会把金额统一成元，资金流必须标为腾讯估算口径 |
| 代码路由规则：`/^(sh|sz|bj)\d{6}$/` 和 `hk` 前缀走腾讯，其余（^DJI、AAPL、GC=F、BTC-USD）走 Yahoo | 见 `isCNCode()`/`isHKCode()`/`isTXCode()` |
| 腾讯港股报价字段位置与A股相同，但**单位不同**：成交量是股（非手）、成交额是港元（非万元）；f[30] 时间是斜杠格式 `2026/07/09 16:08:11`（非14位数字）；f[38] 换手率恒为0、f[46] 是英文名（非市净率）、盘口量恒为0 | `getQuote()` 港股分支不返回换手率/市净率/盘口；时间用 `fmtHKTime()` 解析 |
| 港股K线要走 `hkfqkline/get`（`fqkline/get` 对 hk 代码只返回未复权）；分时接口与A股同一个 | 见 `getKline()` |
| Yahoo K线 raw OHLC 会被拆股/分红扭曲 | `getKlineUS()` 必须请求 adjusted close，并按 `adjClose/rawClose` 同比例调整整根 OHLC；缺失时标 `raw_fallback`，不能冒充复权 |
| 研究卡需要跨市场统一但交易日历不同 | 默认基准固定为沪深300/恒生指数/标普500；`getResearchCardEntry()` 请求 400 日日线，A/H 股沿用腾讯前复权，美股沿用 Yahoo 公司行动调整口径 |
| A股涨跌幅限制不是统一10% | `cnPriceLimitPct()` 按主板10%、创业/科创20%、北交所30%判断；涨停和跌停必须校验正负方向，不能只取绝对值 |
| 港股涨跌榜用新浪 `Market_Center.getHKStockData`（腾讯 rank 服务只有A股板块）；`num` 上限60、无质量筛选，前排全是仙股/无量异动；**单页就要 ~2.5s** | `getRankHK()` 3页并行抓（顺序翻页会拖到8s+）再按序过滤（价<1港元或成交额<2000万剔除），别改回直接取前N |

## 架构约定

- **模块边界与依赖方向**：`server.js` 只做薄启动和兼容导出；`src/bootstrap.js` 是唯一组合根，负责创建单例并注入依赖。`core/` 放共享基础规则，`domain/` 只放无 I/O 的金融计算，`providers/` 只接上游并解析原始数据，`storage/` 只管理 `data/`，`services/` 负责缓存和业务编排，`ai/` 通过 service/store 取数，`http/` 只处理协议、校验与响应。`src/` 内不得反向依赖 `server.js` 或 `bootstrap.js`，provider 不得自行引入缓存、存储或 HTTP 路由。
- **运行时单例**：生产入口使用 `src/bootstrap.js` 的 `defaultRuntime`，把同一个 cache runtime 和 Yahoo 串行调度器成对注入整棵依赖树；不要在路由、工具或 service 内重复创建缓存/provider。测试若需同进程多实例，必须用 `createIsolatedApplication()`（或显式传入完整 runtime），让缓存与 Yahoo 队列一起隔离，禁止出现“共享缓存、独立队列”的半隔离状态。
- **行情查询与缓存**：`src/services/market-service.js` 是共享行情查询、研究卡依赖、滚动新闻的唯一缓存 key 和 TTL 定义层。HTTP 路由、LLM 工具、自动研究/报价证据和 `cache-warmer` 都必须调用 `marketService`，不得自行拼 key/TTL 或绕过它直接调用 `cached()`/`cachedEntry()`。榜单 key 的 `open/closed` 后缀用于隔离开闭市 TTL 和在途请求，不能合并；预热周期必须短于最短行情 TTL。个股事件证据包因需保留独立抓取时间来判断 stale，继续由 `stockEventsService` 管理专用缓存。缓存底层仍需保留过期兜底、并发合并和统一 `{data,meta}`；过期兜底不能更新成功抓取时间。
- **金额单位**：上游单位混乱，但服务端输出的金额字段统一为对应币种基础单位（元/港元/美元），`meta.amountUnit='base_currency'`；前端再换算万/亿。腾讯原始A股成交额是万元、市值是亿元、成交量是手；港股成交额是港元、成交量是股（市值仍是亿）。
- **行情元数据**：市场 API 统一返回 `{data,meta}`；`meta` 至少包含 source/currency/timezone/asOf/fetchedAt/stale/adjustmentBasis。前端 `api()` 自动解包并把元数据挂到 `_meta`，新增市场接口必须沿用。
- **研究卡领域层与口径**：纯金融计算位于 `src/domain/research-card.js`，必须保持无 fetch/缓存/HTTP I/O；400 日日线查询和 5 分钟缓存策略由 `marketService` 统一负责。计算以基准交易日历对齐，股票停牌日仅向前延用最近收盘，严禁未来填充，并用 `lastTradeDate/analysisAsOf` 显式区分。阶段收益严格需要 N+1 个点；基准历史短缺时个股指标仍用自身交易日序列，仅基准/超额降级。超额是简单收益率百分点差；52周必须覆盖365自然日；波动率、回撤和量能排除盘中未完成日。历史不足时返回 `null + reason`，不能补零。
- **盘后复盘的一日一次语义**：`marketReviewService` 只能通过 `marketService` 采集行情，成功结果由 `marketReviewStore` 按“市场 + 核心指数完整交易日”写入 `data/market-reviews.json`，同日刷新、重启或更换模型都不得重算。A/H/美股分别在当地收盘后保留 10/15/15 分钟缓冲；指数报价与日线日期不一致、核心指数旧缓存或交易日尚未完整时不得落盘。并发请求要合并，失败记录 30 分钟退避，上一份成功复盘可继续展示但状态必须明确。定时检查独立于 5 秒行情预热，隔离测试用 `MARKET_DISABLE_REVIEW=1` 关闭。
- **前端竞态守卫**：图表加载用递增请求序号（`chartReq`/`modal.req`），慢的旧响应直接丢弃；按市场加载的区块（指数/榜单/概况/板块）在 await 前捕获 `state.market`、响应回来后比对不一致就丢弃——快速切 tab 时旧市场的慢响应会后到（曾导致港股 tab 显示A股榜单）。`switchMarket` 还会立即清空榜单/概况，避免新数据到达前残留旧市场内容。新增异步渲染要沿用这两个模式。
- **显示元素的坑**：让元素可见要写 `style.display = 'block'`（或 flex），**不能写 `''`**——多个元素的 CSS 默认值就是 `display:none`，置空会回落到隐藏（搜索下拉曾因此完全失灵）。
- **移动端输入框字号 ≥16px**，否则 iOS Safari 聚焦时自动放大页面。
- **红涨绿跌**（A股习惯），常量 `UP`/`DOWN` 在 app.js 顶部。
- 服务端改动需重启才生效；唯一例外是 `data/llm.json`（每次请求实时读取）。

## AI 复盘与问答（LLM）

- OpenAI 兼容协议 + 原生 fetch，**不引入 SDK**（保持零依赖）。工具定义和执行器位于 `src/ai/tools.js`——共享行情、研究卡和滚动新闻调用 `marketService`；个股事件调用 `stockEventsService` 的专用证据缓存，不得在工具分支自行定义 key/TTL。
- 盘后复盘只允许一次模型请求返回严格 JSON：卡片概要与详情分节同时生成，模型输出永远不能作为 HTML/Markdown 直出。每条详情必须引用实际存在的行情组件；`reported_cause` 只能出现在事件线索且必须同时引用 `news` 与白名单新闻 ID。所有证据必须冻结到 `reviewDate`，晚于该交易日的新闻或跨资产快照必须排除；次要指数旧缓存或日期不齐时只能降级，不能混入当日结论。指数/ETF/宏观代理/涨跌榜的覆盖边界必须显式保留，不能把代理或样本冒充全市场统计。
- `get_research_card` 必须复用 `getResearchCardEntry()`，不要让 AI 自行用少量 K 线另算收益、波动或回撤；`meta.stale=true` 时回答必须说明数据日期和缓存状态。
- 个股综合分析、阶段表现、相对强弱、波动/回撤、52周位置、量能和操作倾向由 `hasStockResearchIntent()` 确定性触发 `buildAutomaticStockResearch()`，在第一次 LLM 请求前注入紧凑研究卡；现价、基本面、估值、公告、纯大盘或明确指定其他标的的问题不能误触发。研究卡只说明价格表现/风险，绝不能作为涨跌原因证据；与自动资讯证据用 `Promise.allSettled` 并行，任一失败不能阻断聊天。
- 配置在服务器 `data/llm.json`（页面「⚙ 模型设置」可改，保存即生效）。**API Key 永不回传前端**（GET 只给掩码）、永不进 git。
- 会话存 `data/chats.json`。上下文只带最近 12 条 user/assistant 消息，不回传历史工具结果；每问最多 6 轮工具调用——这是成本护栏，放宽前先想清楚。
- 个股入口首问把规范化 `{code,name,market}` 存在 session 根级 `stockContext`，后续短追问由服务端沿用；字段缺失表示沿用，不能让无效新值覆盖旧上下文。原因意图或首问报价绝对涨跌幅≥7% 时，服务端确定性注入 `get_stock_events` 证据，不能只靠模型自行决定是否查新闻。
- 个股资讯是外部不可信数据：标题限长、数量限 8 条、链接白名单、工具结果保持合法 JSON；缓存结果须携带抓取时间和 stale 状态，刷新失败不能伪装成最新数据；具体催化必须附时间和来源，板块相关只能标为关联推断，无证据时必须承认未找到，禁止用通用滚动新闻拼因果。
- 端到端测试不需要真实 Key，也不要改真实 `data/`：用 `MARKET_DATA_DIR=/tmp/market-test-data MARKET_DISABLE_WARM=1 MARKET_DISABLE_REVIEW=1 node server.js` 启动隔离服务，再写一个 mock OpenAI 服务（首轮返回 `tool_calls`、带 tool 角色消息后返回答案），把隔离目录里的 `llm.json` 指到 mock。
- 自动研究卡测试必须让 mock LLM 首轮直接返回答案，并断言第一次请求的 `messages` 已含研究卡 system 消息；不能只检查 tools 定义或让 mock 先返回 `tool_calls`，否则无法证明是服务端预注入。

## 测试

使用 Node 内置 `node:test`，不引入 npm 包。验证方式：
1. `node --test tests/*.test.js` 跑金融口径、复权、缓存 stale 和 API 契约回归测试
2. `node server.js` 起服务，`curl` 各 `/api/*` 接口看返回
3. 浏览器预览验证 UI（A股/港股/美股/自选/AI 五个 tab + 手机视口 375px）
4. 上游接口字段有疑问时先 `curl` 原始接口确认（GBK 的管道过 `iconv -f gbk -t utf-8`）
5. 验证元素可见性要用 `getComputedStyle`，别只看内联 style

## 文档同步

CLAUDE.md 和 AGENTS.md 内容保持一致（仅标题和部署命令的排除目录不同），由 `.claude/settings.json` 的 PostToolUse hook 在 Claude Code 编辑任一文件后自动同步另一个。用其他工具改动后需手动同步：`sed -e '1s/^# CLAUDE\.md$/# AGENTS.md/' -e "s/--exclude='\.claude'/--exclude='.Codex'/" CLAUDE.md > AGENTS.md`。

## 敏感信息

仓库是**公开的**（github.com/cytwyatt/stock-dashboard）。`data/` 已被 .gitignore 排除（自选股、会话、LLM Key 都在里面）。提交前扫一遍 staged diff：不能出现 `sk-` 开头的串、Tailscale IP、服务器主机名。本文件也会提交——往里加内容时保持同样标准（`ubuntu-ts` 是 SSH 别名，离开用户本机的 ssh config 无意义，可以出现）。
