# CLAUDE.md

A股/美股行情看板。零依赖 Node 服务端（`server.js`）+ 原生 JS 前端（`public/`），无构建步骤、无 npm 包。功能介绍见 README.md，本文件只写维护时容易踩坑的部分。

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
tar czf - --exclude='.claude' --exclude='.DS_Store' --exclude='data' . \
  | ssh ubuntu-ts 'tar xzf - -C ~/apps/market && rm -f ~/apps/market/._* ~/apps/market/public/._* && systemctl --user restart market'

ssh ubuntu-ts 'journalctl --user -u market -f'   # 看服务日志
```

服务器 sudo 需要密码，所有运维用 `systemctl --user`，不要用系统级 systemd。

## 数据源的坑（都是实测踩出来的，别改回去）

| 事实 | 后果 |
|---|---|
| 东方财富 push2.eastmoney.com 在本环境返回 502 | 不可用，别尝试。A股用腾讯+新浪，美股用 Yahoo |
| 腾讯 qt.gtimg.cn 返回 GBK | 必须 `fetchText(url, {encoding:'gbk'})` |
| Yahoo 按「UA+IP」分桶限流，连发几个请求就 429，冷却约 1 分钟 | 所有 Yahoo 请求必须走 `yahooFetch()`（串行队列 + 独立简短 UA + 退避重试）。新增 Yahoo 调用绝不能直接 fetch |
| Yahoo spark 接口可一次批量取多个报价 | 指数/宏观报价用 `sparkQuotes()`，不要逐个调 chart |
| 新浪美股榜单 `num` 参数被截断为 20 | 已弃用，美股榜单走 Yahoo screener |
| 新浪 A股涨跌榜按涨幅排序时前排全是异动仙股 | 美股榜单同理——不要改回"按涨幅直接取前N" |
| 腾讯个股报价 f[9..28] 是五档盘口，f[30] 时间，f[31/32] 涨跌/幅 | 字段位置见 `getQuote()`，改前先 curl 验证 |
| 腾讯分时成交量是**累计值** | `getMinute()` 里做了差分，别删 |
| 腾讯板块接口的 `zgb`="上涨家数/总家数"、`zljlr`=主力净流入(万元) | 市场概况的涨跌家数、资金热力图靠它们 |
| 代码路由规则：`/^(sh|sz|bj)\d{6}$/` 走腾讯，其余（^DJI、AAPL、GC=F、BTC-USD）走 Yahoo | 见 `isCNCode()` |

## 架构约定

- **缓存**：`cached(key, ttl, fn)` 带过期兜底（上游挂了返回旧数据）和并发合并。**缓存 key 和 TTL 必须与 `warmCaches()` 里的预热项保持一致**，否则预热白做。
- **金额单位混乱是常态**：腾讯成交额是万元、市值是亿元、成交量是手；Yahoo 是原始值。每个函数的注释标了单位，新增字段时同样要标。
- **前端竞态守卫**：图表加载用递增请求序号（`chartReq`/`modal.req`），慢的旧响应直接丢弃。新增异步渲染要沿用这个模式。
- **显示元素的坑**：让元素可见要写 `style.display = 'block'`（或 flex），**不能写 `''`**——多个元素的 CSS 默认值就是 `display:none`，置空会回落到隐藏（搜索下拉曾因此完全失灵）。
- **移动端输入框字号 ≥16px**，否则 iOS Safari 聚焦时自动放大页面。
- **红涨绿跌**（A股习惯），常量 `UP`/`DOWN` 在 app.js 顶部。
- 服务端改动需重启才生效；唯一例外是 `data/llm.json`（每次请求实时读取）。

## AI 问答（LLM）

- OpenAI 兼容协议 + 原生 fetch，**不引入 SDK**（保持零依赖）。工具定义在 `LLM_TOOLS`，执行在 `runLLMTool()`——全部复用现有数据函数和缓存 key。
- 配置在服务器 `data/llm.json`（页面「⚙ 模型设置」可改，保存即生效）。**API Key 永不回传前端**（GET 只给掩码）、永不进 git。
- 会话存 `data/chats.json`。上下文只带最近 12 条 user/assistant 消息，不回传历史工具结果；每问最多 6 轮工具调用——这是成本护栏，放宽前先想清楚。
- 端到端测试不需要真实 Key：写一个 mock OpenAI 服务（首轮返回 `tool_calls`、带 tool 角色消息后返回答案），把 `data/llm.json` 指到 mock，测完恢复空 Key 模板。

## 测试

无测试框架。验证方式：
1. `node server.js` 起服务，`curl` 各 `/api/*` 接口看返回
2. 浏览器预览验证 UI（A股/美股/自选/AI 四个 tab + 手机视口 375px）
3. 上游接口字段有疑问时先 `curl` 原始接口确认（GBK 的管道过 `iconv -f gbk -t utf-8`）
4. 验证元素可见性要用 `getComputedStyle`，别只看内联 style

## 敏感信息

仓库是**公开的**（github.com/cytwyatt/stock-dashboard）。`data/` 已被 .gitignore 排除（自选股、会话、LLM Key 都在里面）。提交前扫一遍 staged diff：不能出现 `sk-` 开头的串、Tailscale IP、服务器主机名。本文件也会提交——往里加内容时保持同样标准（`ubuntu-ts` 是 SSH 别名，离开用户本机的 ssh config 无意义，可以出现）。
