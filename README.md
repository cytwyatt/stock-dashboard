# Stock Dashboard · A股 / 港股 / 美股行情看板

一个可自托管、零 npm 依赖的多市场行情看板，集成行情、个股研究、每日 AI 盘后复盘和带实时数据的 AI 问答。

![Node.js 18+](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)
![Zero npm dependencies](https://img.shields.io/badge/npm_dependencies-0-2ea44f)
![Vanilla JavaScript](https://img.shields.io/badge/frontend-Vanilla_JS-F7DF1E?logo=javascript&logoColor=000)
![Markets](https://img.shields.io/badge/markets-A_%7C_HK_%7C_US-0969da)

<p align="center">
  <img src="docs/screenshots/dashboard-cn.jpg" alt="A股行情看板" width="100%">
</p>

## 主要功能

| 能力 | 说明 |
|---|---|
| 多市场行情 | A股、港股、美股指数、成交额对比、带行业涨跌榜、分时与复权 K 线，支持跨市场搜索和自选 |
| 个股研究 | 行业、主营业务、多周期收益、基准超额、52 周位置、波动率、回撤和量能 |
| AI 盘后复盘 | 每个市场每个交易日生成一次，包含跨数据综合研判、风险与未来一至五个交易日的条件式情景 |
| AI 行情问答 | 模型可按需调用行情、K 线、研究卡和资讯工具；明显异动会自动补充带来源的事件线索 |
| 市场洞察 | A股行业与资金热力图，美股行业 ETF、VIX、美债、美元、黄金、原油和比特币代理指标 |
| 轻量自托管 | Node.js 原生 HTTP / fetch + Vanilla JavaScript，ECharts 本地托管，无构建步骤 |

<details>
<summary>更多界面截图</summary>

<table>
  <tr>
    <td><img src="docs/screenshots/stock-detail-ai.jpg" alt="个股详情与问 AI 入口"></td>
    <td><img src="docs/screenshots/ai-assistant.jpg" alt="AI 个股分析"></td>
  </tr>
</table>

<p align="center">
  <img src="docs/screenshots/mobile-ai.jpg" alt="移动端 AI 分析" width="320">
</p>

</details>

## 快速开始

需要 Node.js 18 或更高版本，不需要 `npm install`。

```bash
git clone https://github.com/cytwyatt/stock-dashboard.git
cd stock-dashboard
node server.js
```

打开 [http://localhost:3888](http://localhost:3888)。修改端口：

```bash
PORT=8080 node server.js
```

## AI 模型配置

在页面中打开 **AI → 模型设置**，填写 API Key 即可。支持 DeepSeek、Kimi、通义、智谱、OpenAI 及其他 OpenAI 兼容接口。

问答与盘后复盘可使用不同模型。DeepSeek 用户推荐：

- `deepseek-v4-flash`：日常问答和工具调用
- `deepseek-v4-pro`：盘后深度复盘

也可使用环境变量：

```bash
LLM_BASE_URL=https://api.example.com/v1 \
LLM_API_KEY=your-api-key \
LLM_MODEL=your-model \
LLM_MARKET_REVIEW_MODEL=your-review-model \
node server.js
```

盘后复盘按“市场 + 交易日”持久化，刷新、重启或当日更换模型都不会重复调用。AI 输出只作为条件式情景参考，不提供目标价、涨跌概率、买卖或仓位建议。

## 常用配置

| 环境变量 | 默认值 | 用途 |
|---|---|---|
| `PORT` | `3888` | HTTP 服务端口 |
| `MARKET_DATA_DIR` | `./data` | 运行时数据目录 |
| `MARKET_PASSWORD` | 未设置 | 可选的整站访问口令 |
| `LLM_BASE_URL` | DeepSeek 兼容地址 | LLM 接口地址 |
| `LLM_API_KEY` | 未设置 | LLM API Key |
| `LLM_MODEL` | `deepseek-v4-flash` | AI 问答模型 |
| `LLM_MARKET_REVIEW_MODEL` | 沿用问答模型 | 单独指定盘后复盘模型 |

## 数据来源

| 数据 | 来源 |
|---|---|
| A股 / 港股指数、报价、分时与 K 线 | 腾讯行情 |
| A股行业、A股 / 港股涨跌榜与公司资料 | 腾讯行情 / 新浪财经 |
| 美股行情、复权 K 线与涨跌榜 | Yahoo Finance |
| 美股行业与公司简介 | Nasdaq |
| 财经新闻 | 新浪财经 |

所有行情 API 都附带数据来源、时间、币种、复权口径和缓存状态。上游失败时会尽量返回明确标记的旧缓存；免费公开数据源仍可能限流、延迟或调整格式。

## 数据与安全

> [!WARNING]
> 服务默认不启用鉴权。暴露到公网前，请设置 `MARKET_PASSWORD` 并通过 HTTPS 访问。

- `data/` 保存自选股、AI 会话、每日复盘和模型配置，已被 Git 忽略；部署和备份时请单独处理。
- API Key 只保存在服务端，配置接口仅返回掩码。
- 自选股和会话由当前实例的所有访问者共享，项目定位是个人或可信用户的单租户部署。
- AI 问题及相关行情上下文会发送给你配置的第三方 LLM 服务商。

## 技术结构

```text
server.js       启动入口
src/http/       HTTP、静态资源与鉴权
src/services/   行情缓存与业务编排
src/providers/  腾讯、新浪、Yahoo、Nasdaq 适配
src/ai/         LLM、工具调用与盘后复盘
src/storage/    JSON 持久化
public/         Vanilla JavaScript + ECharts 前端
tests/          Node.js 内置测试
```

## 测试

```bash
node --test tests/*.test.js
```

## 免责声明

本项目仅用于信息展示与技术研究。行情数据和 AI 输出可能存在延迟或误差，所有内容均不构成投资建议。
