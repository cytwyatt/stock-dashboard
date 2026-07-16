/* 行情看板前端逻辑 */
const $ = (sel) => document.querySelector(sel);
const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');
function safeHttpUrl(value) {
  try {
    const u = new URL(String(value), location.href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? escapeHtml(u.href) : '#';
  } catch { return '#'; }
}

const state = {
  market: 'cn',        // cn | hk | us | watch | llm
  indices: [],
  activeCode: null,    // 当前选中的指数
  chartType: 'minute', // minute | day | week | month
};

const MARKET_LABELS = { cn: 'A股', hk: '港股', us: '美股' };

/* ---------- 自选股（存服务器，所有设备共享） ---------- */
const WATCH_KEY = 'watchlist'; // 旧版 localStorage key，仅用于一次性迁移
let watchList = []; // 服务器数据的内存镜像
let watchSaveChain = Promise.resolve();
let watchMutation = 0;

const getWatch = () => watchList;
const isWatched = (code) => watchList.some((s) => s.code === code);

async function pushWatch() {
  // 捕获本次快照并串行保存，避免连续点击时较慢的旧 POST 最后到达、覆盖新状态。
  const body = JSON.stringify(watchList);
  const save = watchSaveChain.then(async () => {
    const res = await fetch('/api/watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) throw new Error(`/api/watchlist -> ${res.status}`);
  });
  watchSaveChain = save.catch(() => {});
  return save;
}

function toggleWatch(item) {
  if (isWatched(item.code)) watchList = watchList.filter((s) => s.code !== item.code);
  else watchList.push({ code: item.code, name: item.name || '', market: item.market || 'cn' });
  const mutation = ++watchMutation;
  pushWatch()
    .then(() => {
      // 只让最后一次修改重新拉取，避免旧保存完成后的 GET 短暂回滚内存镜像。
      if (mutation === watchMutation && state.market === 'watch') return loadWatch();
    })
    .catch(console.error);
}

// 启动时拉取服务器自选；如本地还有旧版 localStorage 数据则合并上传后清除
async function initWatch() {
  try { watchList = await api('/api/watchlist'); } catch (e) { console.error(e); }
  try {
    const old = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
    if (Array.isArray(old) && old.length) {
      const known = new Set(watchList.map((s) => s.code));
      const extra = old.filter((s) => s && s.code && !known.has(s.code));
      if (extra.length) {
        watchList = watchList.concat(extra);
        await pushWatch();
      }
      localStorage.removeItem(WATCH_KEY);
    }
  } catch { /* 旧数据损坏则忽略 */ }
}

const chart = echarts.init($('#chart'));
window.addEventListener('resize', () => {
  chart.resize();
  requestAnimationFrame(updateProfileToggle);
});

const UP = '#f0524f', DOWN = '#2ebd85', DIM = '#8b949e';
const MA_COLORS = { MA5: '#e6b91e', MA10: '#4a9eff', MA20: '#c678dd' };
const colorCls = (v) => (v > 0 ? 'c-up' : v < 0 ? 'c-down' : 'c-flat');
const sign = (v) => (v > 0 ? '+' : '');
const fmtPct = (v) => `${sign(v)}${v.toFixed(2)}%`;

function fmtVol(v) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const body = await res.json();
  if (body && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, 'data') && body.meta) {
    const data = body.data;
    if (data && typeof data === 'object') {
      Object.defineProperty(data, '_meta', { value: body.meta, configurable: true });
    }
    return data;
  }
  return body;
}

const ADJUSTMENT_LABELS = {
  provider_qfq: '前复权',
  split_dividend_adjusted: '公司行动调整',
  partial_adjusted: '部分复权',
  raw_fallback: '未复权（降级）',
};

function shortAsOf(value, timezone) {
  const s = String(value || '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(5);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    ...(timezone ? { timeZone: timezone } : {}),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(d);
}

function setDataMeta(el, meta, { showAdjustment = false, showCurrency = false } = {}) {
  if (!el) return;
  const parts = [];
  if (showAdjustment && meta && ADJUSTMENT_LABELS[meta.adjustmentBasis]) {
    parts.push(ADJUSTMENT_LABELS[meta.adjustmentBasis]);
  }
  if (showCurrency && meta && meta.currency) parts.push(`${meta.currency}计价`);
  const asOf = meta && shortAsOf(meta.asOf, meta.timezone);
  if (asOf) parts.push(`${meta.asOfBasis === 'fetch_time' ? '抓取' : '截至'} ${asOf}`);
  if (meta && meta.stale) parts.push('⚠ 缓存数据');
  el.textContent = parts.join(' · ');
  el.classList.toggle('stale', !!(meta && meta.stale));
  el.title = meta
    ? [`来源：${meta.source || '未知'}`, `抓取：${meta.fetchedAt || '未知'}`,
       meta.adjustmentCoverage != null ? `复权覆盖：${(meta.adjustmentCoverage * 100).toFixed(1)}%` : '']
      .filter(Boolean).join('\n')
    : '';
}

/* ---------- 交易时段判断（按市场时区，含少量缓冲） ---------- */
function isMarketOpen(market) {
  const tz = market === 'us' ? 'America/New_York' : market === 'hk' ? 'Asia/Hong_Kong' : 'Asia/Shanghai';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  const wd = get('weekday');
  if (wd === 'Sat' || wd === 'Sun') return false;
  const mins = parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10);
  // A股 09:15-15:05（北京时间）；港股 09:15-16:15；美股 09:25-16:05（美东时间）
  if (market === 'us') return mins >= 565 && mins <= 965;
  if (market === 'hk') return mins >= 555 && mins <= 975;
  return mins >= 555 && mins <= 905;
}

/* ---------- 指数卡片 ---------- */
async function loadIndices() {
  const market = state.market;
  const list = await api(`/api/indices?market=${market}`);
  if (market !== state.market) return; // 响应回来前切了 tab，丢弃（快速切换时旧市场请求可能后到）
  state.indices = list;
  if (!state.activeCode || !list.find((i) => i.code === state.activeCode)) {
    state.activeCode = list[0] && list[0].code;
  }
  const wrap = $('#indexCards');
  wrap.innerHTML = list
    .map(
      (i) => `
    <div class="index-card ${i.code === state.activeCode ? 'active' : ''}" data-code="${escapeHtml(i.code)}">
      <div class="idx-name">${escapeHtml(i.name)}</div>
      <div class="idx-price ${colorCls(i.change)}">${i.price.toFixed(2)}</div>
      <div class="idx-chg ${colorCls(i.change)}">${sign(i.change)}${i.change.toFixed(2)} · ${fmtPct(i.changePct)}</div>
    </div>`
    )
    .join('');
  wrap.querySelectorAll('.index-card').forEach((el) =>
    el.addEventListener('click', () => {
      state.activeCode = el.dataset.code;
      wrap.querySelectorAll('.index-card').forEach((c) => c.classList.toggle('active', c === el));
      loadChart();
    })
  );
  const t = list[0] && list[0].time ? String(list[0].time).replace(/\//g, '-') : '';
  const open = isMarketOpen(state.market);
  const stale = list._meta && list._meta.stale;
  $('#updateTime').textContent = `${open ? '● 盘中' : '○ 已收盘'}${t ? ' · ' + t : ''}${stale ? ' · ⚠ 缓存' : ''}`;
  $('#updateTime').title = list._meta ? `来源：${list._meta.source || '未知'}\n抓取：${list._meta.fetchedAt || '未知'}` : '';
}

/* ---------- 走势图 ---------- */
function activeIndex() {
  return state.indices.find((i) => i.code === state.activeCode) || {};
}

let chartReq = 0; // 请求序号，防止慢的旧请求覆盖新图
async function loadChart() {
  const idx = activeIndex();
  $('#chartTitle').textContent = idx.name || '';
  setDataMeta($('#chartDataMeta'), null);
  if (!state.activeCode) return;
  const req = ++chartReq;
  try {
    if (state.chartType === 'minute') {
      const d = await api(`/api/minute?code=${encodeURIComponent(state.activeCode)}`);
      if (req !== chartReq) return;
      if (!d.points || d.points.length < 2) {
        // 分时数据基本为空才退回日K；美股是5分钟一根，开盘早段点少属正常，别误退
        setChartType('day');
        return;
      }
      setDataMeta($('#chartDataMeta'), d._meta, { showCurrency: true });
      renderMinute(chart, d);
    } else {
      const d = await api(
        `/api/kline?code=${encodeURIComponent(state.activeCode)}&days=120&period=${state.chartType}`
      );
      if (req !== chartReq) return;
      setDataMeta($('#chartDataMeta'), d._meta, { showAdjustment: true, showCurrency: true });
      renderKline(chart, d);
    }
  } catch (e) {
    console.error('chart error', e);
  }
}

const AXIS_STYLE = {
  axisLine: { lineStyle: { color: '#2a3140' } },
  axisTick: { show: false },
};
const TOOLTIP_STYLE = {
  trigger: 'axis',
  backgroundColor: '#1c2330',
  borderColor: '#2a3140',
  textStyle: { color: '#e6edf3', fontSize: 12 },
};

function renderMinute(inst, d) {
  const base = d.prevClose;
  const times = d.points.map((p) => p.t);
  const prices = d.points.map((p) => p.price);
  const vols = d.points.map((p, i) => ({
    value: p.vol,
    itemStyle: {
      color: p.price >= (i > 0 ? d.points[i - 1].price : base) ? UP : DOWN,
    },
  }));
  const last = prices[prices.length - 1];
  const color = last >= base ? UP : DOWN;
  const pctMax = Math.max(...prices.map((p) => Math.abs(p / base - 1)), 0.002);

  inst.clear();
  inst.setOption({
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    grid: [
      { left: 64, right: 12, top: 16, height: '62%' },
      { left: 64, right: 12, top: '82%', bottom: 22 },
    ],
    tooltip: {
      ...TOOLTIP_STYLE,
      formatter(params) {
        const p = params.find((x) => x.seriesName === 'price');
        if (!p) return '';
        const v = params.find((x) => x.seriesName === 'vol');
        const pct = ((p.value / base - 1) * 100).toFixed(2);
        return `${p.axisValue}<br/>价格: ${p.value.toFixed(2)}　涨幅: ${pct}%${v ? `<br/>成交量: ${fmtVol(v.value.value ?? v.value)}` : ''}`;
      },
    },
    xAxis: [
      { type: 'category', data: times, gridIndex: 0, ...AXIS_STYLE, axisLabel: { show: false } },
      { type: 'category', data: times, gridIndex: 1, ...AXIS_STYLE, axisLabel: { color: DIM, fontSize: 10 } },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        min: base * (1 - pctMax * 1.1),
        max: base * (1 + pctMax * 1.1),
        splitLine: { lineStyle: { color: '#20262f' } },
        axisLabel: {
          color: (v) => (v >= base ? UP : DOWN),
          fontSize: 10,
          formatter: (v) => v.toFixed(0),
        },
      },
      {
        type: 'value',
        gridIndex: 1,
        splitLine: { show: false },
        axisLabel: { show: false },
      },
    ],
    series: [
      {
        name: 'price',
        type: 'line',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: prices,
        symbol: 'none',
        lineStyle: { color, width: 1.4 },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: color + '55' },
            { offset: 1, color: color + '05' },
          ]),
        },
        markLine: {
          symbol: 'none',
          silent: true,
          label: { show: false },
          lineStyle: { color: DIM, type: 'dashed', width: 1 },
          data: [{ yAxis: base }],
        },
      },
      { name: 'vol', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols },
    ],
  });
}

function calcMA(closes, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= n) sum -= closes[i - n];
    out.push(i >= n - 1 ? +(sum / n).toFixed(2) : null);
  }
  return out;
}

function renderKline(inst, data) {
  const dates = data.map((k) => k.date);
  const values = data.map((k) => [k.open, k.close, k.low, k.high]);
  const closes = data.map((k) => k.close);
  const vols = data.map((k) => ({
    value: k.volume,
    itemStyle: { color: k.close >= k.open ? UP : DOWN },
  }));
  const mas = Object.keys(MA_COLORS).map((name) => ({
    name,
    type: 'line',
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: calcMA(closes, parseInt(name.slice(2), 10)),
    symbol: 'none',
    connectNulls: false,
    lineStyle: { color: MA_COLORS[name], width: 1 },
  }));

  inst.clear();
  inst.setOption({
    animation: false,
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: {
      data: Object.keys(MA_COLORS),
      top: 0,
      right: 12,
      itemWidth: 14,
      itemHeight: 2,
      textStyle: { color: DIM, fontSize: 11 },
      selectedMode: false,
    },
    grid: [
      { left: 64, right: 12, top: 26, height: '54%' },
      { left: 64, right: 12, top: '72%', height: '12%' },
    ],
    tooltip: {
      ...TOOLTIP_STYLE,
      formatter(params) {
        const c = params.find((x) => x.seriesType === 'candlestick');
        if (!c) return '';
        const [o, cl, l, h] = c.value.slice(1);
        const i = c.dataIndex;
        const prev = i > 0 ? closes[i - 1] : o;
        const pct = ((cl / prev - 1) * 100).toFixed(2);
        const maLine = Object.keys(MA_COLORS)
          .map((name) => {
            const s = params.find((x) => x.seriesName === name);
            return s && s.value != null ? `${name} ${s.value}` : '';
          })
          .filter(Boolean)
          .join('　');
        const v = params.find((x) => x.seriesName === 'vol');
        return (
          `${c.axisValue}<br/>开 ${o}　收 ${cl}（${sign(+pct)}${pct}%）<br/>高 ${h}　低 ${l}` +
          (maLine ? `<br/>${maLine}` : '') +
          (v ? `<br/>成交量 ${fmtVol(v.value.value ?? v.value)}` : '')
        );
      },
    },
    xAxis: [
      { type: 'category', data: dates, gridIndex: 0, ...AXIS_STYLE, axisLabel: { show: false } },
      { type: 'category', data: dates, gridIndex: 1, ...AXIS_STYLE, axisLabel: { color: DIM, fontSize: 10 } },
    ],
    yAxis: [
      {
        type: 'value',
        gridIndex: 0,
        scale: true,
        splitLine: { lineStyle: { color: '#20262f' } },
        axisLabel: { color: DIM, fontSize: 10 },
      },
      {
        type: 'value',
        gridIndex: 1,
        splitLine: { show: false },
        axisLabel: { show: false },
      },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 40, end: 100 },
      {
        type: 'slider',
        xAxisIndex: [0, 1],
        start: 40,
        end: 100,
        height: 16,
        bottom: 4,
        borderColor: '#2a3140',
        backgroundColor: '#161b22',
        fillerColor: 'rgba(74,158,255,0.15)',
        textStyle: { color: DIM, fontSize: 9 },
      },
    ],
    series: [
      {
        name: 'k',
        type: 'candlestick',
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: values,
        itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN },
      },
      ...mas,
      { name: 'vol', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: vols },
    ],
  });
}

function setChartType(type) {
  state.chartType = type;
  document.querySelectorAll('#chartSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  loadChart();
}

/* ---------- 市场概况 ---------- */
function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value == null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function fmtSignedMoney(value, currency) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${number > 0 ? '+' : number < 0 ? '−' : ''}${fmtMoney(Math.abs(number), currency)}`;
}

function renderTurnoverComparison(comparison, currency) {
  if (!comparison || comparison.available === false) {
    return '<span class="overview-turnover-unavailable">较前一交易日：基准暂不可用</span>';
  }
  const changePct = firstFiniteNumber(
    comparison.changePct,
    comparison.deltaPct,
    comparison.percentChange,
    comparison.pct
  );
  const change = firstFiniteNumber(comparison.change, comparison.delta, comparison.changeAmount);
  const previous = firstFiniteNumber(
    comparison.previous,
    comparison.previousTurnover,
    comparison.previousAmount
  );
  const direction = changePct != null && (changePct !== 0 || !change) ? changePct : change;
  if (direction == null) {
    return '<span class="overview-turnover-unavailable">较前一交易日：基准暂不可用</span>';
  }

  const mode = summaryText(comparison.mode || comparison.basis).toLowerCase();
  const sameTime = mode.includes('same_time');
  const label = sameTime ? '较前一交易日同期' : '较前一交易日';
  const arrow = direction > 0 ? '↑' : direction < 0 ? '↓' : '→';
  const pctText = changePct == null
    ? ''
    : `${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`;
  const amountText = change == null ? '' : fmtSignedMoney(change, currency);
  const comparisonText = [pctText, amountText].filter(Boolean).join(' · ');
  const previousDate = summaryText(
    comparison.previousDate || comparison.baseDate || comparison.date
  );
  const currentDate = summaryText(comparison.currentDate);
  const asOfTime = summaryText(comparison.asOfTime);
  const basisLabels = {
    sh_sz_market_total: '沪深市场合计',
    tencent_hsi_market_turnover: '腾讯恒生指数大市口径',
    sector_sum_fallback: '行业汇总降级口径',
  };
  const basis = summaryText(comparison.basis).toLowerCase();
  const basisDetail = [
    sameTime ? '同一时点口径' : '全日口径',
    basisLabels[basis] || '',
  ].filter(Boolean).join(' · ');
  const details = [
    currentDate ? `本期 ${currentDate}${asOfTime ? ` ${asOfTime}` : ''}` : '',
    previousDate ? `基准 ${previousDate}` : '',
    basisDetail,
    previous == null ? '' : `前值 ${fmtMoney(previous, currency)}`,
  ].filter(Boolean);
  return `<span class="overview-turnover-comparison" title="${escapeHtml(details.join(' · '))}">
    <span class="overview-turnover-change ${colorCls(direction)}">${arrow} ${escapeHtml(label)}${comparisonText ? ` ${escapeHtml(comparisonText)}` : ''}</span>
    <span class="overview-turnover-detail">${escapeHtml(details.join(' · '))}</span>
  </span>`;
}

function renderTurnoverOverview(label, turnover, currency, comparison, standalone = false) {
  const amount = turnover == null || turnover === '' ? '--' : fmtMoney(turnover, currency);
  return `<div class="overview-turnover${standalone ? ' overview-turnover-standalone' : ''}">
    <span class="overview-turnover-current">
      <span class="overview-turnover-label">${escapeHtml(label)}</span>
      <b>${amount}</b>
    </span>
    ${renderTurnoverComparison(comparison, currency)}
  </div>`;
}

async function loadOverview() {
  const market = state.market;
  if (market !== 'cn' && market !== 'hk' && market !== 'us') return;
  const d = await api(`/api/overview?market=${market}`);
  if (market !== state.market) return; // 响应回来前切了 tab，丢弃
  const el = $('#overviewContent');
  setDataMeta($('#overviewDataMeta'), d._meta, { showCurrency: market !== 'us' });
  if (market === 'cn') {
    $('#overviewTitle').textContent = '市场概况 · A股';
    const upW = d.total ? Math.max(0, Math.min(100, (d.up / d.total) * 100)) : 0;
    const nonUpW = Math.max(0, 100 - upW);
    const limitUp = `${d.limitUp}${d.limitCountComplete === false ? '+' : ''}`;
    const limitDown = `${d.limitDown}${d.limitCountComplete === false ? '+' : ''}`;
    const turnoverComparison = d.turnoverComparison || d.comparison;
    const turnoverLabel = turnoverComparison && turnoverComparison.basis === 'sector_sum_fallback'
      ? '行业成交汇总'
      : '沪深成交额';
    el.innerHTML = `
      <div class="breadth-stats">
        <span class="c-up">上涨 ${d.up} 家</span>
        <span class="c-flat">未上涨 ${d.nonUp} 家</span>
      </div>
      <div class="breadth-bar">
        <div class="bb-up" style="width:${upW.toFixed(1)}%"></div>
        <div class="bb-non-up" style="width:${nonUpW.toFixed(1)}%"></div>
      </div>
      <div class="overview-chips">
        <span>涨停 <b class="c-up">${limitUp}</b> 家</span>
        <span>跌停 <b class="c-down">${limitDown}</b> 家</span>
        ${renderTurnoverOverview(turnoverLabel, d.turnover, 'CNY', turnoverComparison)}
      </div>`;
  } else if (market === 'hk') {
    $('#overviewTitle').textContent = '港股大市成交额';
    el.innerHTML = renderTurnoverOverview(
      '大市成交额',
      d && d.turnover,
      (d && d._meta && d._meta.currency) || 'HKD',
      d && (d.turnoverComparison || d.comparison),
      true
    );
  } else {
    $('#overviewTitle').textContent = '市场概况 · 宏观情绪';
    const macro = Array.isArray(d) ? d : [];
    el.innerHTML = `
      <div class="macro-grid">
        ${macro
          .map(
            (q) => `
        <div class="macro-item" data-code="${escapeHtml(q.code)}" data-name="${escapeHtml(q.name)}">
          <div class="m-name">${escapeHtml(q.name)}</div>
          <div class="m-price">${q.price >= 1000 ? q.price.toFixed(0) : q.price.toFixed(2)}${q.unit || ''}</div>
          <div class="m-chg ${colorCls(q.changePct)}">${fmtPct(q.changePct)}</div>
        </div>`
          )
          .join('')}
      </div>`;
    el.querySelectorAll('.macro-item').forEach((item) =>
      item.addEventListener('click', () => openStock(item.dataset.code, item.dataset.name))
    );
  }
}

/* ---------- 板块 ---------- */
let sectorView = 'map'; // map(涨跌热力) | flow(资金热力) | list
let sectorMapChart = null;
let sectorList = [];

// 强度 t(0~1) + 方向 -> 颜色：中性色到红/绿插值
function heatColor(t, positive) {
  const neutral = [43, 50, 65];
  const target = positive ? [217, 58, 54] : [24, 158, 108];
  const c = neutral.map((n, i) => Math.round(n + (target[i] - n) * Math.min(1, t)));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const fmtInflow = (yuan) => `${yuan >= 0 ? '+' : '-'}${(Math.abs(yuan) / 1e8).toFixed(1)}亿`;

function renderSectorMap(mode) {
  if (!sectorMapChart) {
    sectorMapChart = echarts.init($('#sectorMap'));
    window.addEventListener('resize', () => sectorMapChart.resize());
  }
  // 资金模式用开方压缩比例，避免个别板块巨额流入把其他板块全压成中性色
  const maxInflow = Math.max(...sectorList.map((s) => Math.abs(s.inflow || 0)), 1);
  const items = sectorList.map((s) => ({
    name: s.name,
    value: s.turnover, // 面积 = 成交额
    chg: s.changePct,
    inflow: s.inflow || 0,
    leader: s.leader,
    itemStyle: {
      color:
        mode === 'flow'
          ? heatColor(Math.sqrt(Math.abs(s.inflow || 0) / maxInflow), (s.inflow || 0) >= 0)
          : heatColor(Math.abs(s.changePct) / 3, s.changePct >= 0),
    },
  }));
  sectorMapChart.setOption({
    animation: false,
    tooltip: {
      backgroundColor: '#1c2330',
      borderColor: '#2a3140',
      textStyle: { color: '#e6edf3', fontSize: 12 },
      formatter(p) {
        const d = p.data;
        return (
          `<b>${escapeHtml(d.name)}</b>　<span style="color:${d.chg >= 0 ? UP : DOWN}">${fmtPct(d.chg)}</span>` +
          `<br/>估算主力净流入（腾讯口径） <span style="color:${d.inflow >= 0 ? UP : DOWN}">${fmtInflow(d.inflow)}</span>` +
          `<br/>成交额 ${(d.value / 1e8).toFixed(0)}亿` +
          (d.leader ? `<br/>领涨 ${escapeHtml(d.leader.name)} ${fmtPct(d.leader.changePct)}` : '')
        );
      },
    },
    series: [
      {
        type: 'treemap',
        width: '100%',
        height: '100%',
        breadcrumb: { show: false },
        roam: false,
        nodeClick: false,
        itemStyle: { borderColor: '#161b22', borderWidth: 2, gapWidth: 2 },
        label: {
          formatter: (p) =>
            `${p.data.name}\n${mode === 'flow' ? fmtInflow(p.data.inflow) : fmtPct(p.data.chg)}`,
          fontSize: 12,
          lineHeight: 16,
          color: '#fff',
        },
        data: items,
      },
    ],
  });
}

function renderSectorList() {
  const render = (items) =>
    items
      .map(
        (s) => `
      <li>
        <span class="sector-name">${escapeHtml(s.name)}</span>
        <span class="sector-pct ${colorCls(s.changePct)}">${fmtPct(s.changePct)}</span>
        ${s.leader ? `<span class="sector-leader" data-code="${escapeHtml(s.leader.code)}" data-name="${escapeHtml(s.leader.name)}">${escapeHtml(s.leader.name)} ${fmtPct(s.leader.changePct)}</span>` : ''}
      </li>`
      )
      .join('');
  $('#sectorUp').innerHTML = render(sectorList.slice(0, 8));
  $('#sectorDown').innerHTML = render(sectorList.slice(-8).reverse());
  document.querySelectorAll('.sector-leader[data-code]').forEach((el) =>
    el.addEventListener('click', () => openStock(el.dataset.code, el.dataset.name))
  );
}

function renderSectors() {
  if (!sectorList.length) return;
  if (sectorView === 'list') renderSectorList();
  else renderSectorMap(sectorView === 'flow' ? 'flow' : 'pct');
}

function setSectorView(view) {
  sectorView = view;
  document.querySelectorAll('#sectorSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view)
  );
  $('#sectorMap').style.display = view === 'list' ? 'none' : '';
  $('.sector-wrap').style.display = view === 'list' ? '' : 'none';
  renderSectors();
  if (view !== 'list' && sectorMapChart) sectorMapChart.resize();
}

async function loadSectors() {
  if (state.market !== 'cn') return;
  const list = await api('/api/sectors');
  if (state.market !== 'cn') return; // 响应回来前切了 tab，丢弃
  sectorList = list;
  setDataMeta($('#sectorDataMeta'), list._meta, { showCurrency: true });
  renderSectors();
}

/* ---------- 涨跌榜 ---------- */
function renderRank(el, rows) {
  const currencies = [...new Set(rows.map((s) => s.currency).filter(Boolean))];
  const priceHead = currencies.length === 1 ? `最新价 · ${escapeHtml(currencies[0])}` : '最新价';
  el.innerHTML =
    `<tr><th>名称</th><th>${priceHead}</th><th>涨跌幅</th></tr>` +
    rows
      .map(
        (s) => `
      <tr data-code="${escapeHtml(s.code)}" data-name="${escapeHtml(s.name)}">
        <td><div class="stock-name">${escapeHtml(s.name)}</div><div class="stock-code">${escapeHtml(s.code.toUpperCase())}</div></td>
        <td>${s.price.toFixed(2)}</td>
        <td class="${colorCls(s.changePct)}">${fmtPct(s.changePct)}</td>
      </tr>`
      )
      .join('');
  el.querySelectorAll('tr[data-code]').forEach((tr) =>
    tr.addEventListener('click', () => openStock(tr.dataset.code, tr.dataset.name))
  );
}

async function loadRanks() {
  const market = state.market;
  const [up, down] = await Promise.all([
    api(`/api/rank?market=${market}&dir=up`),
    api(`/api/rank?market=${market}&dir=down`),
  ]);
  if (market !== state.market) return; // 响应回来前切了 tab，丢弃
  renderRank($('#rankUp'), up.slice(0, 10));
  renderRank($('#rankDown'), down.slice(0, 10));
}

/* ---------- 自选股列表 ---------- */
async function loadWatch() {
  // 先等本窗口的保存队列落盘，再拉其他设备可能更新过的版本。
  // GET 前后都校验 mutation，防止慢响应覆盖用户刚刚修改的内存状态。
  const mutation = watchMutation;
  await watchSaveChain;
  if (mutation !== watchMutation) return;
  try {
    const latest = await api('/api/watchlist');
    if (mutation !== watchMutation) return;
    watchList = latest;
  } catch (e) { console.error(e); }
  if (mutation !== watchMutation || state.market !== 'watch') return;
  const list = getWatch();
  const table = $('#watchTable');
  $('#watchEmpty').style.display = list.length ? 'none' : 'block';
  $('#updateTime').textContent = list.length ? `共 ${list.length} 只` : '';
  if (!list.length) { table.innerHTML = ''; setDataMeta($('#watchDataMeta'), null); return; }
  let quotes = [];
  try {
    quotes = await api(`/api/quotes?codes=${encodeURIComponent(list.map((s) => s.code).join(','))}`);
  } catch (e) { console.error(e); }
  if (mutation !== watchMutation || state.market !== 'watch') return;
  setDataMeta($('#watchDataMeta'), quotes._meta);
  const byCode = new Map(quotes.map((q) => [q.code, q]));
  table.innerHTML =
    `<tr><th>名称</th><th>最新价</th><th>涨跌幅</th><th>操作</th></tr>` +
    list
      .map((s) => {
        const q = byCode.get(s.code);
        const name = (q && q.name) || s.name || s.code.toUpperCase();
        const market = (q && q.market) || (/^(sh|sz|bj)\d{6}$/.test(s.code) ? 'cn' : /^hk/.test(s.code) ? 'hk' : 'us');
        return `
      <tr data-code="${escapeHtml(s.code)}" data-name="${escapeHtml(name)}">
        <td><div class="stock-name">${escapeHtml(name)}</div><div class="stock-code">${escapeHtml(s.code.toUpperCase())}</div></td>
        <td>${q ? `${q.price.toFixed(2)}<div class="stock-code">${escapeHtml(q.currency || '')}</div>` : '--'}</td>
        <td class="${q ? colorCls(q.changePct) : ''}">${q ? fmtPct(q.changePct) : '--'}</td>
        <td><div class="watch-actions">
          <button type="button" class="ask-ai-btn"
            data-ai-code="${escapeHtml(s.code)}"
            data-ai-name="${escapeHtml((q && q.name) || '')}"
            data-ai-display-name="${escapeHtml(name)}"
            data-ai-market="${escapeHtml(market)}"
            title="向 AI 询问 ${escapeHtml(name)}"
            aria-label="向 AI 询问 ${escapeHtml(name)}">
            <span class="ask-ai-icon" aria-hidden="true">✨</span>
            <span class="ask-ai-label">问 AI</span><span class="ask-ai-label-mobile">AI</span>
          </button>
          <button type="button" class="del-btn" data-del="${escapeHtml(s.code)}" title="移除" aria-label="从自选移除 ${escapeHtml(name)}">✕</button>
        </div></td>
      </tr>`;
      })
      .join('');
  table.querySelectorAll('tr[data-code]').forEach((tr) =>
    tr.addEventListener('click', () => openStock(tr.dataset.code, tr.dataset.name))
  );
  table.querySelectorAll('.del-btn').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatch({ code: btn.dataset.del });
    })
  );
  table.querySelectorAll('.ask-ai-btn').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openChatWithStock({
        code: btn.dataset.aiCode,
        name: btn.dataset.aiName,
        displayName: btn.dataset.aiDisplayName,
        market: btn.dataset.aiMarket,
      }).catch(console.error);
    })
  );
}

/* ---------- 个股详情弹窗 ---------- */
const modal = {
  code: null,
  name: '',
  market: 'cn',
  chartType: 'minute',
  req: 0,
  profileReq: 0,
  profileExpanded: false,
  researchReq: 0,
  researchTimer: null,
  chart: null,
};

function fmtBig(v) {
  if (v >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

function fmtMoney(v, currency) {
  if (!Number.isFinite(Number(v))) return '--';
  const symbol = { CNY: '¥', HKD: 'HK$', USD: '$' }[currency] || '';
  return `${symbol}${fmtBig(Number(v))}${currency ? ` ${currency}` : ''}`;
}

function fmtResearchPct(value) {
  if (value == null || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  const digits = Math.abs(n) >= 100 ? 1 : 2;
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function fmtResearchPoints(value) {
  if (value == null || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  const digits = Math.abs(n) >= 100 ? 1 : 2;
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}个百分点`;
}

function researchMetric({ label, value, valueClass = '', sub = '', subClass = '', title = '' }) {
  const aria = [label, value, sub, title].filter(Boolean).join('，');
  return `
    <div class="research-metric" aria-label="${escapeHtml(aria)}"${title ? ` title="${escapeHtml(title)}"` : ''}>
      <span class="research-label">${escapeHtml(label)}</span>
      <span class="research-value ${valueClass}">${escapeHtml(value)}</span>
      <span class="research-sub ${subClass}">${escapeHtml(sub)}</span>
    </div>`;
}

function researchInsufficient(metric) {
  if (!metric || metric.reason !== 'insufficient_history') return '';
  return `需${metric.required || '--'}，现${metric.actual || 0}`;
}

function profileText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function renderProfileLoading() {
  const card = $('#mProfile');
  card.style.display = 'block';
  card.setAttribute('aria-busy', 'true');
  setDataMeta($('#mProfileMeta'), null);
  $('#mProfileBody').innerHTML = '<div class="profile-loading">正在加载行业与主营业务…</div>';
}

function updateProfileToggle() {
  const summary = $('#mProfileBusiness');
  const button = $('#mProfileToggle');
  if (!summary || !button) return;
  if (modal.profileExpanded) {
    button.hidden = false;
    return;
  }
  button.hidden = summary.scrollHeight <= summary.clientHeight + 1;
}

function toggleProfileBusiness() {
  const summary = $('#mProfileBusiness');
  const button = $('#mProfileToggle');
  if (!summary || !button) return;
  modal.profileExpanded = !modal.profileExpanded;
  summary.classList.toggle('expanded', modal.profileExpanded);
  button.textContent = modal.profileExpanded ? '收起' : '展开';
  button.setAttribute('aria-expanded', String(modal.profileExpanded));
  button.hidden = false;
}

function renderProfileUnavailable({ retry = false, meta = null } = {}) {
  const card = $('#mProfile');
  card.setAttribute('aria-busy', 'false');
  setDataMeta($('#mProfileMeta'), meta);
  $('#mProfileBody').innerHTML = `
    <div class="profile-error">行业与主营业务资料暂不可用
      ${retry ? '<button type="button" class="profile-retry" data-retry-profile>重试</button>' : ''}
    </div>`;
}

function renderProfileCard(data) {
  const industry = profileText(data && data.industry);
  const sector = profileText(data && data.sector);
  const business = profileText(data && data.businessSummary);
  const classificationBasis = profileText(data && data.classificationBasis);
  const coverage = data && data._meta && data._meta.coverage;
  const degraded = !!(coverage && coverage.complete === false);
  const classifications = [];
  if (industry) classifications.push(['行业', industry]);
  if (sector && sector !== industry) classifications.push(['板块', sector]);

  if (!classifications.length && !business) {
    renderProfileUnavailable({ meta: data && data._meta });
    return;
  }

  const basisAttrs = classificationBasis
    ? ` role="group" aria-label="分类口径：${escapeHtml(classificationBasis)}" title="分类口径：${escapeHtml(classificationBasis)}"`
    : '';
  const tags = classifications.length
    ? `<div class="profile-tags"${basisAttrs}>${classifications.map(([label, value]) => `
        <span class="profile-tag"><span class="profile-tag-label">${label}</span>${escapeHtml(value)}</span>`).join('')}
      </div>`
    : '<div class="profile-missing">行业分类暂缺</div>';
  const businessContent = business
    ? `<div class="profile-business-row">
        <span class="profile-business-label">主营业务</span>
        <p class="profile-business" id="mProfileBusiness">${escapeHtml(business)}</p>
        <button type="button" class="profile-toggle" id="mProfileToggle" data-toggle-profile
          aria-controls="mProfileBusiness" aria-expanded="false">展开</button>
      </div>`
    : '<div class="profile-missing">主营业务资料暂缺</div>';
  const degradedNotice = degraded
    ? '<div class="profile-degraded" role="status">部分资料暂缺，稍后重新打开时将重试</div>'
    : '';

  modal.profileExpanded = false;
  $('#mProfileBody').innerHTML = degradedNotice + tags + businessContent;
  setDataMeta($('#mProfileMeta'), data._meta);
  $('#mProfile').setAttribute('aria-busy', 'false');
  requestAnimationFrame(updateProfileToggle);
}

async function loadModalProfile() {
  if (!modal.code) return;
  const code = modal.code;
  const req = ++modal.profileReq;
  renderProfileLoading();
  try {
    const data = await api(`/api/profile?code=${encodeURIComponent(code)}`);
    if (req !== modal.profileReq || modal.code !== code) return;
    renderProfileCard(data || {});
  } catch (error) {
    if (req !== modal.profileReq || modal.code !== code) return;
    console.error('company profile error', error);
    renderProfileUnavailable({ retry: true });
  }
}

function renderResearchLoading() {
  const card = $('#mResearch');
  card.style.display = 'block';
  card.setAttribute('aria-busy', 'true');
  $('#mResearchBenchmark').textContent = '';
  setDataMeta($('#mResearchMeta'), null);
  $('#mResearchBody').innerHTML = '<div class="research-loading">正在计算复权收益与风险指标…</div>';
}

function renderResearchCard(data) {
  const card = $('#mResearch');
  const benchmarkLabel = data.benchmark && data.benchmark.name
    ? `相对 ${data.benchmark.name}${data.benchmark.available ? '' : '（暂不可用）'}`
    : '';
  $('#mResearchBenchmark').textContent = benchmarkLabel;
  setDataMeta($('#mResearchMeta'), data._meta, { showAdjustment: true, showCurrency: true });

  const horizonLabels = [['1d', '1日'], ['5d', '5日'], ['20d', '20日'], ['60d', '60日'], ['120d', '120日']];
  const returns = horizonLabels.map(([key, label]) => {
    const metric = data.returns && data.returns[key] || {};
    const assetPct = metric.assetPct;
    const sub = metric.excessPct == null
      ? researchInsufficient(metric) || '超额 --'
      : `超额 ${fmtResearchPoints(metric.excessPct)}`;
    return researchMetric({
      label,
      value: fmtResearchPct(assetPct),
      valueClass: Number.isFinite(assetPct) ? colorCls(assetPct) : '',
      sub,
      subClass: Number.isFinite(metric.excessPct) ? colorCls(metric.excessPct) : '',
      title: metric.startDate && metric.endDate ? `${metric.startDate} 至 ${metric.endDate}` : sub,
    });
  }).join('');

  const range = data.range52 || {};
  const volatility = data.risk && data.risk.volatility20 || {};
  const drawdown = data.risk && data.risk.maxDrawdown120 || {};
  const volume = data.volume20 || {};
  const drawdownDates = typeof drawdown.peakDate === 'string' && typeof drawdown.troughDate === 'string'
    ? `${drawdown.peakDate.slice(5)} → ${drawdown.troughDate.slice(5)}`
    : '峰谷日期 --';
  const volumeDate = typeof volume.asOf === 'string' ? `完整日 ${volume.asOf.slice(5)}` : '完整日日期 --';
  const risk = [
    researchMetric({
      label: '52周位置',
      value: range.reason === 'flat_range' ? '持平' : range.positionPct == null ? '--' : `${Number(range.positionPct).toFixed(0)}%`,
      sub: range.distanceToHighPct == null ? researchInsufficient(range) || '距高 --' : `距高 ${fmtResearchPct(range.distanceToHighPct)}`,
      subClass: Number.isFinite(range.distanceToHighPct) ? colorCls(range.distanceToHighPct) : '',
      title: range.high == null ? '历史不足365自然日时不冒充52周区间' : `高 ${range.high} · 低 ${range.low}`,
    }),
    researchMetric({
      label: '20日年化波动',
      value: volatility.value == null ? '--' : `${Number(volatility.value).toFixed(2)}%`,
      sub: volatility.value == null ? researchInsufficient(volatility) : `${volatility.observations}个日收益`,
      title: '20个简单日收益的样本标准差，按252个交易日年化',
    }),
    researchMetric({
      label: '120日最大回撤',
      value: fmtResearchPct(drawdown.value),
      valueClass: Number.isFinite(drawdown.value) ? colorCls(drawdown.value) : '',
      sub: drawdown.value == null ? researchInsufficient(drawdown) : drawdownDates,
      title: '近120个市场交易区间内，复权收盘价从峰值到谷值的最大跌幅',
    }),
    researchMetric({
      label: '较20日均量',
      value: volume.value == null ? '--' : `${Number(volume.value).toFixed(2)}倍`,
      sub: volume.value == null ? researchInsufficient(volume) : volumeDate,
      title: '最近完整交易日成交量 ÷ 此前20个交易日平均成交量',
    }),
    researchMetric({
      label: '历史覆盖',
      value: `${data.historySessions || 0}日`,
      sub: `基准对齐 ${data.alignedSessions || 0}日`,
      title: '有效复权日线数量，以及按同市场基准交易日历对齐后的数量',
    }),
  ].join('');

  const signals = Array.isArray(data.signals) && data.signals.length
    ? data.signals.map((signal) => `
      <span class="research-signal ${escapeHtml(signal.severity || 'info')}"
        aria-label="${escapeHtml([signal.label, signal.detail].filter(Boolean).join('：'))}"
        title="${escapeHtml(signal.detail || '')}">${escapeHtml(signal.label || '')}</span>`).join('')
    : '<span class="research-signal info">未触发预设观察项</span>';
  const degraded = data.quality && data.quality.degraded
    ? ' 当前复权数据已降级，价格类指标仅供参考。'
    : '';
  $('#mResearchBody').innerHTML = `
    <div class="research-returns">${returns}</div>
    <div class="research-risk">${risk}</div>
    <div class="research-signals">${signals}</div>
    <div class="research-note">超额收益为个股收益减价格指数收益的百分点差，不代表风险调整后 Alpha；量能使用最近完整交易日。${escapeHtml(degraded)}</div>`;
  card.setAttribute('aria-busy', 'false');
}

function renderResearchError() {
  const card = $('#mResearch');
  card.setAttribute('aria-busy', 'false');
  $('#mResearchBenchmark').textContent = '';
  setDataMeta($('#mResearchMeta'), null);
  $('#mResearchBody').innerHTML = `
    <div class="research-error">研究数据暂时不可用
      <button type="button" class="research-retry" data-retry-research>重试</button>
    </div>`;
}

function loadModalResearch({ delay = 0 } = {}) {
  if (!modal.code) return;
  const code = modal.code;
  const req = ++modal.researchReq;
  clearTimeout(modal.researchTimer);
  modal.researchTimer = null;
  renderResearchLoading();
  const run = async () => {
    modal.researchTimer = null;
    try {
      const data = await api(`/api/research?code=${encodeURIComponent(code)}`);
      if (req !== modal.researchReq || modal.code !== code) return;
      renderResearchCard(data);
    } catch (error) {
      if (req !== modal.researchReq || modal.code !== code) return;
      console.error('research card error', error);
      renderResearchError();
    }
  };
  if (delay > 0) {
    modal.researchTimer = setTimeout(run, delay);
    return;
  }
  return run();
}

function openStock(code, name = '') {
  modal.code = code;
  modal.name = name;
  modal.market = /^(sh|sz|bj)\d{6}$/.test(code) ? 'cn' : /^hk/.test(code) ? 'hk' : 'us';
  modal.chartType = 'minute';
  $('#mName').textContent = name || code;
  $('#mCode').textContent = code.toUpperCase();
  $('#mPrice').textContent = '--';
  $('#mPrice').className = 'modal-price';
  $('#mChg').textContent = '';
  $('#mTime').textContent = '';
  $('#mStats').innerHTML = '';
  modal.profileExpanded = false;
  renderProfileLoading();
  $('#mBook').innerHTML = '';
  $('#mBook').style.display = 'none';
  $('#mResearch').style.display = 'block';
  setDataMeta($('#mChartMeta'), null);
  document.querySelectorAll('#mChartSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === 'minute')
  );
  updateHeartBtn();
  updateModalAskAIButton();
  $('#stockModal').style.display = 'flex';
  if (!modal.chart) {
    modal.chart = echarts.init($('#mChart'));
    window.addEventListener('resize', () => modal.chart.resize());
  }
  modal.chart.clear();
  modal.chart.resize();
  loadModalQuote().catch(console.error);
  loadModalChart().catch(console.error);
  loadModalProfile();
  loadModalResearch({ delay: 200 });
}

function closeStock() {
  $('#stockModal').style.display = 'none';
  modal.code = null;
  modal.req++;
  modal.profileReq++;
  modal.researchReq++;
  clearTimeout(modal.researchTimer);
  modal.researchTimer = null;
}

function updateHeartBtn() {
  const on = modal.code && isWatched(modal.code);
  const btn = $('#mHeart');
  btn.textContent = on ? '♥' : '♡';
  btn.classList.toggle('active', on);
  btn.title = on ? '移出自选' : '加入自选';
}

function updateModalAskAIButton() {
  const target = modal.name || (modal.code && modal.code.toUpperCase()) || '这只股票';
  const label = `向 AI 询问 ${target}`;
  const btn = $('#mAskAI');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

async function loadModalQuote() {
  const q = await api(`/api/quote?code=${encodeURIComponent(modal.code)}`);
  if (q.code !== modal.code) return;
  modal.name = q.name;
  modal.market = q.market;
  $('#mName').textContent = q.name;
  updateModalAskAIButton();
  $('#mPrice').textContent = q.price.toFixed(2);
  $('#mPrice').className = `modal-price ${colorCls(q.change)}`;
  $('#mChg').textContent = `${sign(q.change)}${q.change.toFixed(2)} · ${fmtPct(q.changePct)}`;
  $('#mChg').className = `modal-chg ${colorCls(q.change)}`;
  $('#mTime').textContent = [q.time || '', q.currency || '', q._meta && q._meta.stale ? '⚠ 缓存数据' : '']
    .filter(Boolean).join(' · ');
  $('#mTime').title = q._meta ? `来源：${q._meta.source || '未知'}\n抓取：${q._meta.fetchedAt || '未知'}` : '';
  const rows =
    q.market === 'cn'
      ? [
          ['今开', q.open.toFixed(2)], ['昨收', q.prevClose.toFixed(2)],
          ['最高', q.high.toFixed(2)], ['最低', q.low.toFixed(2)],
          ['成交量', fmtBig(q.volume) + '股'], ['成交额', fmtMoney(q.amount, q.currency)],
          ['换手率', q.turnoverRate + '%'], ['振幅', q.amplitude + '%'],
          ['市盈率', q.pe || '--'], ['市净率', q.pb || '--'],
          ['总市值', fmtMoney(q.mktcap, q.currency)],
        ]
      : q.market === 'hk'
      ? [
          ['今开', q.open.toFixed(2)], ['昨收', q.prevClose.toFixed(2)],
          ['最高', q.high.toFixed(2)], ['最低', q.low.toFixed(2)],
          ['成交量', fmtBig(q.volume) + '股'], ['成交额', fmtMoney(q.amount, q.currency)],
          ['市盈率', q.pe || '--'], ['振幅', q.amplitude + '%'],
          ['总市值', q.mktcap ? fmtMoney(q.mktcap, q.currency) : '--'],
          ['52周最高', q.week52High ? q.week52High.toFixed(2) : '--'],
          ['52周最低', q.week52Low ? q.week52Low.toFixed(2) : '--'],
        ]
      : [
          ['昨收', q.prevClose.toFixed(2)],
          ['最高', q.high ? q.high.toFixed(2) : '--'], ['最低', q.low ? q.low.toFixed(2) : '--'],
          ['成交量', fmtBig(q.volume)],
          ['52周最高', q.week52High ? q.week52High.toFixed(2) : '--'],
          ['52周最低', q.week52Low ? q.week52Low.toFixed(2) : '--'],
        ];
  $('#mStats').innerHTML = rows
    .map(
      ([label, value]) => `
    <div class="ms-item"><span class="ms-label">${label}</span><span class="ms-value">${value}</span></div>`
    )
    .join('');
  renderBook(q);
}

// 五档盘口（仅A股个股，停牌/无数据时隐藏）
function renderBook(q) {
  const el = $('#mBook');
  if (q.market !== 'cn' || !q.asks || !q.asks.some((a) => a[0] > 0)) {
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  const cn = '一二三四五';
  const row = (label, [p, v]) => `
    <div class="ob-row">
      <span class="ob-label">${label}</span>
      <span class="ob-price ${p ? colorCls(p - q.prevClose) : ''}">${p ? p.toFixed(2) : '--'}</span>
      <span class="ob-vol">${fmtVol(v)}</span>
    </div>`;
  el.innerHTML = `
    <div class="ob-col">
      <div class="ob-head">买盘（手）</div>
      ${q.bids.map((b, i) => row('买' + cn[i], b)).join('')}
    </div>
    <div class="ob-col">
      <div class="ob-head">卖盘（手）</div>
      ${q.asks.map((a, i) => row('卖' + cn[i], a)).join('')}
    </div>`;
  el.style.display = 'grid';
}

async function loadModalChart() {
  if (!modal.code) return;
  const req = ++modal.req;
  try {
    if (modal.chartType === 'minute') {
      const d = await api(`/api/minute?code=${encodeURIComponent(modal.code)}`);
      if (req !== modal.req) return;
      if (!d.points || d.points.length < 2) {
        setModalChartType('day');
        return;
      }
      setDataMeta($('#mChartMeta'), d._meta, { showCurrency: true });
      renderMinute(modal.chart, d);
    } else {
      const d = await api(
        `/api/kline?code=${encodeURIComponent(modal.code)}&days=120&period=${modal.chartType}`
      );
      if (req !== modal.req) return;
      setDataMeta($('#mChartMeta'), d._meta, { showAdjustment: true, showCurrency: true });
      renderKline(modal.chart, d);
    }
  } catch (e) {
    console.error('modal chart error', e);
  }
}

function setModalChartType(type) {
  modal.chartType = type;
  document.querySelectorAll('#mChartSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === type)
  );
  loadModalChart().catch(console.error);
}

/* ---------- 个股搜索 ---------- */
let searchTimer = null;
let searchReq = 0;
function hideSearchResults() {
  $('#searchResults').style.display = 'none';
}
function renderSearchResults(list) {
  const box = $('#searchResults');
  if (!list.length) { hideSearchResults(); return; }
  box.innerHTML = list
    .map(
      (s) => `
    <div class="search-item" data-code="${escapeHtml(s.code)}" data-name="${escapeHtml(s.name)}">
      <span class="s-name">${escapeHtml(s.name)}</span>
      <span class="s-code">${escapeHtml(s.code.toUpperCase())}</span>
      <span class="s-badge">${MARKET_LABELS[s.market] || '美股'}</span>
    </div>`
    )
    .join('');
  box.style.display = 'block';
  box.querySelectorAll('.search-item').forEach((el) =>
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      searchReq++;
      clearTimeout(searchTimer);
      openStock(el.dataset.code, el.dataset.name);
      $('#searchInput').value = '';
      hideSearchResults();
    })
  );
}

/* ---------- 新闻 ---------- */
function fmtNewsTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${hm}`;
}

async function loadNews() {
  const list = await api('/api/news');
  $('#newsList').innerHTML = list
    .map(
      (n) => `
    <li><a href="${safeHttpUrl(n.url)}" target="_blank" rel="noopener">
      <span class="news-time">${fmtNewsTime(n.time)}</span>
      <span class="news-title">${escapeHtml(n.title)}</span>
      ${n.media ? `<span class="news-media">${escapeHtml(n.media)}</span>` : ''}
    </a></li>`
    )
    .join('');
}

/* ---------- AI 盘后复盘 ---------- */
let summaryReq = 0;
let activeMarketReview = null;
let marketReviewReturnFocus = null;
let marketReviewNeedsPolling = false;
let lastMarketReviewAt = 0;

const summaryText = (value) =>
  typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';

function summaryStanceClass(stance) {
  const value = summaryText(stance).toLowerCase();
  if (/(偏强|强势|上涨|bull|positive|strong)/.test(value)) return 'positive';
  if (/(偏弱|弱势|下跌|bear|negative|weak)/.test(value)) return 'negative';
  return 'neutral';
}

const SUMMARY_CLAIM_LABELS = {
  observation: '事实',
  association: '关联',
  causal: '事件归因',
  reported_cause: '报道归因',
};

const SUMMARY_EVIDENCE_LABELS = {
  indices: '主要指数',
  overview: '市场概况',
  indexHistory: '多周期指数',
  sectors: '行业板块',
  usSectorProxies: '美股行业 ETF 代理',
  turnover: '成交额',
  news: '财经资讯',
  marketNews: '市场资讯',
  representativeGainers: '代表性领涨样本',
  representativeLosers: '代表性领跌样本',
  macroProxies: '跨资产信号',
};

const SUMMARY_CONFIDENCE_LABELS = { high: '高', medium: '中', low: '低' };

function summaryEvidenceLabel(value) {
  const text = summaryText(value);
  const separator = text.indexOf(':');
  const key = separator >= 0 ? text.slice(0, separator) : text;
  const detail = separator >= 0 ? text.slice(separator + 1) : '';
  const label = SUMMARY_EVIDENCE_LABELS[key] || key;
  return detail ? `${label} · ${detail}` : label;
}

function renderSummaryEvidenceRefs(refs) {
  const values = Array.isArray(refs) ? refs.map(summaryText).filter(Boolean) : [];
  if (!values.length) return '';
  const visible = values.slice(0, 3);
  const remaining = values.length - visible.length;
  return `<span class="market-summary-evidence" title="${escapeHtml(values.map(summaryEvidenceLabel).join(' · '))}">依据：${visible
    .map((ref) => escapeHtml(summaryEvidenceLabel(ref))).join(' · ')}${remaining > 0 ? ` · +${remaining}` : ''}</span>`;
}

function normalizeSummaryItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { text: summaryText(item), evidenceRefs: [], citationRefs: [], claimType: '' };
    }
    const refs = Array.isArray(item.evidenceRefs)
      ? item.evidenceRefs.map(summaryText).filter(Boolean)
      : [];
    const citationRefs = Array.isArray(item.citationRefs)
      ? item.citationRefs.map(summaryText).filter(Boolean)
      : [];
    return {
      text: summaryText(item.text) || summaryText(item.message) || summaryText(item.label),
      evidenceRefs: refs,
      citationRefs,
      claimType: summaryText(item.claimType),
    };
  }).filter((item) => item.text);
}

function renderReviewCitationRefs(refs, citationsById) {
  const values = Array.isArray(refs) ? refs.map(summaryText).filter(Boolean) : [];
  if (!values.length) return '';
  return `<span class="market-review-source-refs">${values.map((ref) => {
    const citation = citationsById && citationsById.get(ref);
    const label = citation
      ? summaryText(citation.source) || summaryText(citation.title) || `来源 ${ref}`
      : `来源 ${ref}`;
    const url = citation ? safeHttpUrl(citation.url) : '#';
    return url === '#'
      ? `<span>${escapeHtml(label)}</span>`
      : `<a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }).join(' · ')}</span>`;
}

function renderSummaryItems(items, emptyText, citationsById = null) {
  const values = normalizeSummaryItems(items);
  return values.length
    ? `<ul class="market-summary-list">${values.map((item) => {
        const claimLabel = SUMMARY_CLAIM_LABELS[item.claimType] || item.claimType;
        const evidence = renderSummaryEvidenceRefs(item.evidenceRefs);
        const citations = renderReviewCitationRefs(item.citationRefs, citationsById);
        const claim = claimLabel
          ? `<span class="market-summary-claim">${escapeHtml(claimLabel)}</span>`
          : '';
        return `<li><span class="market-summary-item-text">${escapeHtml(item.text)}</span>${claim || evidence || citations
          ? `<span class="market-summary-item-meta">${claim}${evidence}${citations}</span>`
          : ''}</li>`;
      }).join('')}</ul>`
    : `<p class="market-summary-empty">${escapeHtml(emptyText)}</p>`;
}

function renderSummaryWarnings(items, citationsById = null) {
  const warnings = normalizeSummaryItems(items);
  if (!warnings.length) return '';
  return `<aside class="market-summary-data-warnings">
    <h3>数据提示</h3>
    ${renderSummaryItems(warnings, '', citationsById)}
  </aside>`;
}

function renderSummaryConfidence(value) {
  if (value == null || value === '') return '';
  const object = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawScore = Object.prototype.hasOwnProperty.call(object, 'score') ? object.score : value;
  const score = Number(rawScore);
  const scoreText = Number.isFinite(score) && score >= 0 && score <= 100
    ? `${Number.isInteger(score) ? score : score.toFixed(1)}/100`
    : '';
  const level = summaryText(object.level).toLowerCase();
  const label = SUMMARY_CONFIDENCE_LABELS[level] || summaryText(object.label) || summaryText(object.level)
    || (!scoreText ? summaryText(value) : '');
  const detail = [scoreText, label].filter(Boolean).join(' · ');
  const reasons = Array.isArray(object.reasons)
    ? object.reasons.map(summaryText).filter(Boolean)
    : [];
  const title = reasons.length ? ` title="${escapeHtml(reasons.join('；'))}"` : '';
  return detail
    ? `<span class="market-summary-confidence"${title}>证据质量 ${escapeHtml(detail)}</span>`
    : '';
}

function setSummaryNotice(text, type = 'warning') {
  const el = $('#marketSummaryNotice');
  el.textContent = text || '';
  el.classList.toggle('error', type === 'error');
  el.style.display = text ? 'block' : 'none';
}

function setSummaryBusy(busy) {
  const card = $('#marketSummarySection');
  const content = $('#marketSummaryContent');
  card.classList.toggle('is-loading', busy);
  content.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function renderSummaryLoading(market) {
  const content = $('#marketSummaryContent');
  content.dataset.hasReview = 'false';
  content.innerHTML = `<div class="market-summary-state market-summary-loading"><span aria-hidden="true">●</span> 正在读取${escapeHtml(MARKET_LABELS[market] || '')}盘后复盘…</div>`;
}

function renderReviewUnavailable(data) {
  const marketLabel = summaryText(data.marketLabel) || MARKET_LABELS[state.market] || '当前市场';
  const status = summaryText(data.status).toLowerCase();
  marketReviewNeedsPolling = status === 'scheduled' || status === 'retry_pending';
  const defaults = {
    scheduled: {
      title: `${marketLabel}复盘将在收盘后生成`,
      message: '当前尚未到复盘生成时间，收盘数据完整后会自动生成。',
    },
    retry_pending: {
      title: `${marketLabel}复盘正在等待重试`,
      message: '本次生成暂未完成，系统稍后会自动重试。',
    },
    unconfigured: {
      title: '尚未配置 AI 模型',
      message: `完成模型和 API Key 设置后，即可生成${marketLabel}盘后复盘。`,
    },
  };
  const copy = defaults[status] || {
    title: `${marketLabel}盘后复盘暂未就绪`,
    message: '完整收盘数据就绪后会自动生成，请稍后查看。',
  };
  const content = $('#marketSummaryContent');
  content.dataset.hasReview = 'false';
  content.innerHTML = `
    <div class="market-summary-state">
      <div class="market-summary-state-copy">
        <strong>${escapeHtml(copy.title)}</strong>
        <span>${escapeHtml(summaryText(data.message) || copy.message)}</span>
        ${status === 'unconfigured'
          ? '<button type="button" class="market-summary-config" data-summary-config>前往模型设置</button>'
          : ''}
      </div>
    </div>`;
}

function renderSummaryError() {
  const content = $('#marketSummaryContent');
  content.dataset.hasReview = 'false';
  content.innerHTML = `
    <div class="market-summary-state">
      <div class="market-summary-state-copy">
        <strong>AI 盘后复盘暂时不可用</strong>
        <span>系统稍后会自动重试，其他行情区块不受影响。</span>
      </div>
    </div>`;
}

function marketReviewMeta(data) {
  return {
    ...(data._meta || {}),
    asOf: data.reviewDate || (data._meta && data._meta.asOf),
    fetchedAt: data.generatedAt || (data._meta && data._meta.fetchedAt),
  };
}

function renderReviewMetrics(metrics) {
  const values = Array.isArray(metrics)
    ? metrics.filter((item) => item && typeof item === 'object').slice(0, 4)
    : [];
  if (!values.length) return '';
  return `<div class="market-review-metrics">${values.map((item) => {
    const tone = ['positive', 'negative'].includes(summaryText(item.tone).toLowerCase())
      ? summaryText(item.tone).toLowerCase()
      : 'neutral';
    return `<div class="market-review-metric ${tone}">
      <span class="market-review-metric-label">${escapeHtml(summaryText(item.label) || '指标')}</span>
      <strong>${escapeHtml(summaryText(item.value) || '--')}</strong>
      ${summaryText(item.detail) ? `<span class="market-review-metric-detail">${escapeHtml(summaryText(item.detail))}</span>` : ''}
    </div>`;
  }).join('')}</div>`;
}

function citationsById(citations) {
  const map = new Map();
  (Array.isArray(citations) ? citations : []).forEach((citation, index) => {
    if (!citation || typeof citation !== 'object') return;
    const id = summaryText(citation.id) || String(index + 1);
    map.set(id, citation);
  });
  return map;
}

function renderReviewCitations(citations, timezone) {
  const values = (Array.isArray(citations) ? citations : [])
    .filter((citation) => citation && typeof citation === 'object');
  if (!values.length) return '';
  return `<section class="market-review-citations" aria-labelledby="marketReviewCitationsTitle">
    <h3 id="marketReviewCitationsTitle">资料与来源</h3>
    <ol>${values.map((citation) => {
      const title = summaryText(citation.title) || summaryText(citation.source) || '未命名来源';
      const source = summaryText(citation.source);
      const publishedAt = shortAsOf(citation.publishedAt, timezone);
      const url = safeHttpUrl(citation.url);
      const titleHtml = url === '#'
        ? `<span class="market-review-citation-title">${escapeHtml(title)}</span>`
        : `<a class="market-review-citation-title" href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`;
      return `<li>${titleHtml}${source || publishedAt
        ? `<span class="market-review-citation-meta">${[source, publishedAt].filter(Boolean).map(escapeHtml).join(' · ')}</span>`
        : ''}</li>`;
    }).join('')}</ol>
  </section>`;
}

function renderMarketReviewDetail(data) {
  const card = data.card && typeof data.card === 'object' ? data.card : {};
  const detail = data.detail && typeof data.detail === 'object' ? data.detail : {};
  const marketLabel = summaryText(data.marketLabel) || MARKET_LABELS[data.market] || '';
  const stance = summaryText(card.stance) || '中性';
  const executiveSummary = summaryText(detail.executiveSummary)
    || summaryText(card.summary)
    || summaryText(card.headline)
    || '本次复盘暂无执行摘要。';
  const executiveEvidence = detail.evidenceRefs && detail.evidenceRefs.executiveSummary;
  const citations = Array.isArray(data.citations) ? data.citations : [];
  const citationMap = citationsById(citations);
  const sections = (Array.isArray(detail.sections) ? detail.sections : [])
    .filter((section) => section && typeof section === 'object');
  const timezone = data._meta && data._meta.timezone;
  const generatedAt = shortAsOf(data.generatedAt, timezone);
  const model = summaryText(data.model);
  const disclaimer = summaryText(data.disclaimer) || 'AI 自动生成，仅供参考，不构成投资建议。';

  $('#marketReviewDialogTitle').textContent = `${marketLabel ? `${marketLabel} · ` : ''}${summaryText(data.reviewDate) || '最近交易日'}盘后复盘`;
  setDataMeta($('#marketReviewDialogMeta'), marketReviewMeta(data));
  $('#marketReviewDialogContent').innerHTML = `
    <div class="market-review-detail-lead">
      <span class="market-summary-stance ${summaryStanceClass(stance)}">${escapeHtml(stance)}</span>
      ${renderSummaryConfidence(data.confidence)}
    </div>
    <section class="market-review-executive">
      <h3>执行摘要</h3>
      <p>${escapeHtml(executiveSummary)}</p>
      ${renderSummaryEvidenceRefs(executiveEvidence)}
    </section>
    ${renderSummaryWarnings(data.dataWarnings, citationMap)}
    <div class="market-review-sections">${sections.length
      ? sections.map((section) => `<section class="market-review-section">
          <h3>${escapeHtml(summaryText(section.title) || summaryText(section.key) || '复盘要点')}</h3>
          ${renderSummaryItems(section.items, '本节暂无可用信息。', citationMap)}
        </section>`).join('')
      : '<p class="market-summary-empty">暂无更多分项复盘内容。</p>'}
    </div>
    ${renderReviewCitations(citations, timezone)}
    <div class="market-summary-foot market-review-detail-foot">
      ${generatedAt ? `<span>生成：${escapeHtml(generatedAt)}</span>` : ''}
      ${model ? `<span>模型：${escapeHtml(model)}</span>` : ''}
      <span class="market-summary-disclaimer">${escapeHtml(disclaimer)}</span>
    </div>`;
}

function openMarketReview() {
  if (!activeMarketReview || activeMarketReview.available !== true) return;
  const dialog = $('#marketReviewDialog');
  renderMarketReviewDetail(activeMarketReview);
  marketReviewReturnFocus = document.activeElement;
  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => $('#marketReviewDialogClose').focus({ preventScroll: true }));
}

function restoreMarketReviewFocus() {
  const target = marketReviewReturnFocus;
  marketReviewReturnFocus = null;
  if (target && target.isConnected && target.offsetParent !== null) target.focus({ preventScroll: true });
}

function closeMarketReview({ restoreFocus = true } = {}) {
  const dialog = $('#marketReviewDialog');
  if (!restoreFocus) marketReviewReturnFocus = null;
  if (dialog.open) dialog.close();
  else if (restoreFocus) restoreMarketReviewFocus();
}

function renderMarketSummary(data) {
  const card = data.card && typeof data.card === 'object' ? data.card : {};
  const marketLabel = summaryText(data.marketLabel) || MARKET_LABELS[data.market] || MARKET_LABELS[state.market] || '';
  const reviewDate = summaryText(data.reviewDate) || '最近交易日';
  const stance = summaryText(card.stance) || '中性';
  const headline = summaryText(card.headline) || '本次盘后复盘暂无标题。';
  const summary = summaryText(card.summary);
  const prominentRefs = card.evidenceRefs && typeof card.evidenceRefs === 'object'
    ? [...new Set([
        ...(Array.isArray(card.evidenceRefs.headline) ? card.evidenceRefs.headline : []),
        ...(Array.isArray(card.evidenceRefs.summary) ? card.evidenceRefs.summary : []),
      ])]
    : [];
  const themes = Array.isArray(card.themes)
    ? card.themes.map(summaryText).filter(Boolean).slice(0, 5)
    : [];
  const keyRisk = summaryText(card.keyRisk);
  const generatedAt = shortAsOf(data.generatedAt, data._meta && data._meta.timezone);
  const warnings = normalizeSummaryItems(data.dataWarnings);
  const nextReviewStatus = summaryText(data.nextReviewStatus).toLowerCase();
  const status = summaryText(data.status).toLowerCase();
  marketReviewNeedsPolling = status === 'retry_pending'
    || nextReviewStatus === 'scheduled'
    || nextReviewStatus === 'retry_pending';

  activeMarketReview = data;
  $('#marketSummaryTitle').textContent = `✨ AI 盘后复盘${marketLabel ? ` · ${marketLabel}` : ''}`;
  setDataMeta($('#marketSummaryDataMeta'), marketReviewMeta(data));
  const content = $('#marketSummaryContent');
  content.dataset.hasReview = 'true';
  content.innerHTML = `
    <article class="market-review-preview">
      <div class="market-review-kicker">
        <span>${escapeHtml(reviewDate)} 收盘复盘</span>
        ${generatedAt ? `<span>生成于 ${escapeHtml(generatedAt)}</span>` : ''}
      </div>
      <div class="market-review-lead">
        <span class="market-review-badges">
          <span class="market-summary-stance ${summaryStanceClass(stance)}">${escapeHtml(stance)}</span>
          ${renderSummaryConfidence(data.confidence)}
        </span>
        <div class="market-review-copy">
          <h3>${escapeHtml(headline)}</h3>
          ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
          ${renderSummaryEvidenceRefs(prominentRefs)}
        </div>
      </div>
      ${renderReviewMetrics(card.metrics)}
      ${themes.length ? `<div class="market-review-themes" aria-label="复盘主题">${themes
        .map((theme) => `<span>${escapeHtml(theme)}</span>`).join('')}</div>` : ''}
      ${keyRisk ? `<div class="market-review-risk"><strong>关键风险</strong><span>${escapeHtml(keyRisk)}</span>${renderSummaryEvidenceRefs(card.evidenceRefs && card.evidenceRefs.keyRisk)}</div>` : ''}
      ${nextReviewStatus === 'unconfigured' ? `<div class="market-review-config-alert">
        <span>当前模型未配置；这份历史复盘仍可查看，后续每日复盘已暂停。</span>
        <button type="button" class="market-summary-config" data-summary-config>模型设置</button>
      </div>` : ''}
      <button type="button" class="market-review-open" data-review-open aria-haspopup="dialog" aria-controls="marketReviewDialog">
        查看完整复盘 <span aria-hidden="true">→</span>
      </button>
    </article>`;

  if (status === 'retry_pending') {
    setSummaryNotice(summaryText(data.message) || '最新复盘正在等待重试，当前展示最近一份已完成内容。');
  } else if (data._meta && data._meta.stale) {
    setSummaryNotice('⚠ 当前展示缓存复盘，请留意复盘日期和数据截止时间。');
  } else if (warnings.length) {
    setSummaryNotice(`本次复盘有 ${warnings.length} 条数据提示，详情中可查看。`);
  } else {
    setSummaryNotice('');
  }
  if ($('#marketReviewDialog').open) renderMarketReviewDetail(data);
}

async function loadMarketReview() {
  const market = state.market;
  if (market !== 'cn' && market !== 'hk' && market !== 'us') return;
  lastMarketReviewAt = Date.now();
  const req = ++summaryReq;
  const content = $('#marketSummaryContent');
  const hadReview = content.dataset.hasReview === 'true'
    && activeMarketReview
    && summaryText(activeMarketReview.market).toLowerCase() === market;
  $('#marketSummaryTitle').textContent = `✨ AI 盘后复盘 · ${MARKET_LABELS[market]}`;
  setSummaryNotice('');
  setSummaryBusy(true);
  if (!hadReview) {
    activeMarketReview = null;
    renderSummaryLoading(market);
  }

  try {
    const data = await api(`/api/market-review?market=${encodeURIComponent(market)}`);
    if (req !== summaryReq || market !== state.market) return;
    if (!data || typeof data !== 'object') throw new Error('market review response is invalid');
    const responseMarket = summaryText(data.market).toLowerCase();
    if (responseMarket && responseMarket !== market) throw new Error('market review response market mismatch');
    if (data.available === true) {
      if (!data.card || typeof data.card !== 'object') throw new Error('market review card is missing');
      renderMarketSummary(data);
    } else {
      activeMarketReview = null;
      setDataMeta($('#marketSummaryDataMeta'), data._meta);
      renderReviewUnavailable(data);
    }
  } catch (error) {
    if (req !== summaryReq || market !== state.market) return;
    console.error('market review error', error);
    marketReviewNeedsPolling = true;
    if (hadReview) setSummaryNotice('复盘检查失败，仍保留上一次内容。', 'error');
    else {
      activeMarketReview = null;
      setSummaryNotice('AI 盘后复盘加载失败，请稍后重试。', 'error');
      setDataMeta($('#marketSummaryDataMeta'), null);
      renderSummaryError();
    }
  } finally {
    if (req === summaryReq && market === state.market) setSummaryBusy(false);
  }
}

/* ---------- 市场切换 ---------- */
async function switchMarket(market) {
  summaryReq++; // 使上一市场或同市场的旧复盘请求立即失效
  closeMarketReview({ restoreFocus: false });
  activeMarketReview = null;
  marketReviewNeedsPolling = false;
  state.market = market;
  state.activeCode = null;
  document.querySelectorAll('#marketTabs .tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.market === market)
  );
  const isQuote = market === 'cn' || market === 'hk' || market === 'us';
  $('#indexSection').style.display = isQuote ? 'block' : 'none';
  $('#marketSummarySection').style.display = isQuote ? 'block' : 'none';
  $('#chartSection').style.display = isQuote ? 'block' : 'none';
  $('#overviewSection').style.display = isQuote ? 'block' : 'none';
  $('#rankSection').style.display = isQuote ? 'block' : 'none';
  $('#watchSection').style.display = market === 'watch' ? 'block' : 'none';
  $('#chatSection').style.display = market === 'llm' ? 'block' : 'none';
  $('#newsSection').style.display = market === 'llm' ? 'none' : 'block';
  // 行业板块仅A股有数据
  $('#sectorSection').style.display = market === 'cn' ? 'block' : 'none';
  state.chartType = 'minute';
  document.querySelectorAll('#chartSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === state.chartType)
  );
  // 复盘请求可能仍在进行；切换任何 tab 都立即清空，防止残留上一市场内容。
  $('#marketSummaryContent').innerHTML = '';
  $('#marketSummaryContent').dataset.hasReview = 'false';
  setSummaryBusy(false);
  setSummaryNotice('');
  setDataMeta($('#marketSummaryDataMeta'), null);
  if (market === 'llm') {
    $('#updateTime').textContent = '';
    await initChat();
    return;
  }
  // 立即清掉上一市场的榜单/概况——新数据可能要等上游几秒（冷缓存时），期间不能残留旧市场内容
  $('#rankUp').innerHTML = '';
  $('#rankDown').innerHTML = '';
  $('#overviewContent').innerHTML = '';
  setDataMeta($('#chartDataMeta'), null);
  setDataMeta($('#overviewDataMeta'), null);
  setDataMeta($('#sectorDataMeta'), null);
  if (market !== 'watch') setDataMeta($('#watchDataMeta'), null);
  refreshAll();
}

let lastQuotesAt = 0;
async function refreshQuotes() {
  lastQuotesAt = Date.now();
  if (state.market === 'llm') return;
  if (state.market === 'watch') {
    try { await loadWatch(); } catch (e) { console.error(e); }
    return;
  }
  // 各区块互相独立，并行加载；仅走势图依赖指数列表
  const results = await Promise.allSettled([
    loadIndices().then(loadChart),
    loadRanks(),
    loadSectors(),
    loadOverview(),
  ]);
  results.forEach((r) => r.status === 'rejected' && console.error(r.reason));
}

function refreshAll() {
  refreshQuotes();
  loadMarketReview(); // 仅读取服务端每日复盘；不跟随 30 秒行情轮询
  loadNews().catch(console.error);
}

/* ---------- AI 问答 ---------- */
const STOCK_AI_QUESTION = '请结合实时报价、分时走势、近期日 K 和最新个股/板块资讯分析。若当日涨跌显著，请先核实相关新闻并区分事实与推断；再判断当前趋势，说明关键价位、主要风险和后续观察点。';
const chat = {
  sessions: [],
  activeId: null,
  busy: false,
  selectReq: 0,
  initPromise: null,
  stockOpenReq: 0,
  stockOpenChain: Promise.resolve(),
  draftStock: null,
  drafts: new Map(),
};

function resizeChatInput(input = $('#chatInput')) {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
}

function renderChatContext() {
  const el = $('#chatContext');
  const stock = chat.draftStock;
  if (!stock) {
    el.style.display = 'none';
    $('#chatContextName').textContent = '';
    $('#chatContextMeta').textContent = '';
    return;
  }
  const market = MARKET_LABELS[stock.market] || '股票';
  $('#chatContextName').textContent = stock.displayName || stock.name || stock.code.toUpperCase();
  $('#chatContextMeta').textContent = `${stock.code.toUpperCase()} · ${market} · 发送时获取最新行情`;
  el.style.display = 'flex';
}

function saveChatDraft() {
  if (!chat.activeId) return;
  const text = $('#chatInput').value;
  if (!text && !chat.draftStock) {
    chat.drafts.delete(chat.activeId);
    return;
  }
  chat.drafts.set(chat.activeId, {
    text,
    stock: chat.draftStock ? { ...chat.draftStock } : null,
  });
}

function restoreChatDraft(id) {
  const draft = chat.drafts.get(id);
  $('#chatInput').value = draft ? draft.text : '';
  chat.draftStock = draft && draft.stock ? { ...draft.stock } : null;
  resizeChatInput();
  renderChatContext();
}

function removeChatStockContext() {
  const input = $('#chatInput');
  if (chat.draftStock && input.value === chat.draftStock.initialText) input.value = '';
  chat.draftStock = null;
  resizeChatInput(input);
  renderChatContext();
  saveChatDraft();
}

function buildStockChatMessage(stock, question) {
  const market = MARKET_LABELS[stock.market] || '股票';
  const identity = stock.name
    ? `${stock.name}（代码：${stock.code}，市场：${market}）`
    : `代码：${stock.code}，市场：${market}`;
  return `分析股票 ${identity}。${question}`;
}

function openChatWithStock(stock) {
  const req = ++chat.stockOpenReq;
  chat.stockOpenChain = chat.stockOpenChain
    .catch((e) => console.error(e))
    .then(async () => {
      if (req !== chat.stockOpenReq) return;
      await switchMarket('llm');
      if (req !== chat.stockOpenReq || state.market !== 'llm') return;

      const input = $('#chatInput');
      const active = chat.sessions.find((s) => s.id === chat.activeId);
      const generatedDraftUntouched = chat.draftStock && input.value === chat.draftStock.initialText;
      const hasCustomDraft = !!input.value.trim() && !generatedDraftUntouched;
      // 无 Key/网络失败时消息只存在当前 DOM、不一定已落盘，也必须视为已使用会话。
      const activeHasMessages = Number(active && active.count || 0) > 0 || !!$('#chatMsgs .chat-msg');
      if (!active || activeHasMessages || chat.busy || hasCustomDraft) await newChatSession();
      if (req !== chat.stockOpenReq || state.market !== 'llm') return;

      const market = stock.market === 'us' || stock.market === 'hk' ? stock.market : 'cn';
      chat.draftStock = {
        code: stock.code,
        name: stock.name || '',
        displayName: stock.displayName || stock.name || stock.code.toUpperCase(),
        market,
        initialText: STOCK_AI_QUESTION,
      };
      input.value = STOCK_AI_QUESTION;
      resizeChatInput(input);
      renderChatContext();
      saveChatDraft();
      if (!window.matchMedia('(max-width: 768px)').matches) input.focus();
    });
  return chat.stockOpenChain;
}

// 极简 Markdown 渲染（加粗/代码/列表/标题/段落）
function mdToHtml(src) {
  const esc = escapeHtml(src);
  let h = esc
    .replace(/```[\w]*\n?([\s\S]*?)```/g, (_, c) => `\x01pre${btoa(unescape(encodeURIComponent(c)))}\x01`)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]\n]{1,200})\]\((https?:\/\/[^\s<>()]{1,800})\)/g, (_, label, url) => {
      const href = safeHttpUrl(url.replace(/&amp;/g, '&'));
      return href === '#'
        ? `${label} (${url})`
        : `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{2,4} (.*)$/gm, '<h4>$1</h4>')
    .replace(/^\s*[-•*] (.*)$/gm, '<li>$1</li>')
    .replace(/^\s*(\d+)\. (.*)$/gm, '<li>$1. $2</li>');
  h = h
    .split(/\n{2,}/)
    .map((par) => {
      if (par.includes('<li>')) {
        return `<ul>${par.replace(/\n(?!<li>)/g, '<br>').replace(/\n/g, '')}</ul>`;
      }
      if (par.startsWith('<h4>') || par.startsWith('\x01pre')) return par;
      return `<p>${par.replace(/\n/g, '<br>')}</p>`;
    })
    .join('');
  return h.replace(/\x01pre([A-Za-z0-9+/=]*)\x01/g, (_, b) => `<pre>${decodeURIComponent(escape(atob(b)))}</pre>`);
}

function formatChatTimestamp(value, referenceTime = Date.now()) {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  const date = new Date(value);
  const reference = new Date(referenceTime);
  if (!Number.isFinite(date.getTime()) || !Number.isFinite(reference.getTime())) return null;
  const pad = (part) => String(part).padStart(2, '0');
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameYear = date.getFullYear() === reference.getFullYear();
  const sameDay = sameYear
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
  const datePart = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return {
    label: sameDay ? time : `${sameYear ? '' : `${date.getFullYear()}-`}${datePart} ${time}`,
    dateTime: date.toISOString(),
    title: `${date.getFullYear()}-${datePart} ${time}:${pad(date.getSeconds())}`,
  };
}

function appendChatMsg(role, html, createdAt) {
  const wrap = $('#chatMsgs');
  const div = document.createElement('div');
  div.className = `chat-msg ${role}`;
  div.innerHTML = `<div class="chat-bubble">${html}</div>`;
  const timestamp = formatChatTimestamp(createdAt);
  if (timestamp) {
    const time = document.createElement('time');
    time.className = 'chat-msg-time';
    time.dateTime = timestamp.dateTime;
    time.title = timestamp.title;
    time.setAttribute('aria-label', `发送时间 ${timestamp.title}`);
    time.textContent = timestamp.label;
    div.appendChild(time);
  } else {
    const legacy = document.createElement('span');
    legacy.className = 'chat-msg-time';
    legacy.title = '该消息保存时尚未记录发送时间';
    legacy.textContent = '历史消息';
    div.appendChild(legacy);
  }
  wrap.appendChild(div);
  wrap.scrollTop = wrap.scrollHeight;
  return div;
}

function setChatStatus(text) {
  let el = $('#chatStatusLine');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'chatStatusLine';
    el.className = 'chat-status';
    $('#chatMsgs').appendChild(el);
  }
  el.innerHTML = '<span class="dot">●</span> ';
  el.appendChild(document.createTextNode(text));
  $('#chatMsgs').scrollTop = $('#chatMsgs').scrollHeight;
}

function renderChatSessions() {
  const list = $('#chatSessList');
  list.innerHTML = chat.sessions
    .map(
      (s) => `
    <li class="${s.id === chat.activeId ? 'active' : ''}" data-id="${escapeHtml(s.id)}">
      <span class="cs-title">${escapeHtml(s.title || '新对话')}</span>
      <button class="del-btn" data-del="${escapeHtml(s.id)}" title="删除">✕</button>
    </li>`
    )
    .join('');
  list.querySelectorAll('li').forEach((li) =>
    li.addEventListener('click', () => selectChatSession(li.dataset.id))
  );
  list.querySelectorAll('.del-btn').forEach((btn) =>
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteChatSession(btn.dataset.del);
    })
  );
  const sel = $('#chatSessSelect');
  sel.innerHTML = chat.sessions
    .map((s) => `<option value="${escapeHtml(s.id)}" ${s.id === chat.activeId ? 'selected' : ''}>${escapeHtml(s.title || '新对话')}</option>`)
    .join('');
}

async function selectChatSession(id) {
  if (chat.activeId && chat.activeId !== id) saveChatDraft();
  const req = ++chat.selectReq;
  const changed = chat.activeId !== id;
  chat.activeId = id;
  if (changed) restoreChatDraft(id);
  renderChatSessions();
  const wrap = $('#chatMsgs');
  wrap.innerHTML = '';
  try {
    const d = await api(`/api/chat/sessions/${encodeURIComponent(id)}`);
    if (req !== chat.selectReq || id !== chat.activeId) return;
    const session = chat.sessions.find((s) => s.id === id);
    if (session) session.count = d.messages.length;
    if (!d.messages.length) {
      wrap.innerHTML = '<div class="chat-empty">问我任何股票问题：大盘走势、板块资金、个股分析、市场情绪……<br>回答基于看板的实时数据。</div>';
      return;
    }
    for (const m of d.messages) {
      appendChatMsg(m.role, mdToHtml(m.content), m.createdAt);
    }
  } catch (e) { console.error(e); }
}

async function newChatSession() {
  const res = await fetch('/api/chat/sessions', { method: 'POST' });
  if (!res.ok) throw new Error(`/api/chat/sessions -> ${res.status}`);
  const d = await res.json();
  chat.sessions.unshift({ id: d.id, title: '', updatedAt: Date.now(), count: 0 });
  await selectChatSession(d.id);
  return d.id;
}

async function deleteChatSession(id) {
  await fetch(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  chat.sessions = chat.sessions.filter((s) => s.id !== id);
  chat.drafts.delete(id);
  if (chat.activeId === id) {
    chat.activeId = null;
    chat.draftStock = null;
    $('#chatInput').value = '';
    resizeChatInput();
    renderChatContext();
    if (chat.sessions.length) await selectChatSession(chat.sessions[0].id);
    else await newChatSession();
  } else {
    renderChatSessions();
  }
}

async function initChat() {
  // 合并并发初始化，避免“问 AI”快速连点时重复创建空会话或选错会话。
  if (chat.initPromise) return chat.initPromise;
  const run = (async () => {
    // 每次进入都刷新列表（可能在其他设备上新建过会话）
    try {
      chat.sessions = await api('/api/chat/sessions');
    } catch (e) { chat.sessions = chat.sessions || []; }
    if (!chat.sessions.length) return newChatSession();
    if (!chat.activeId || !chat.sessions.find((s) => s.id === chat.activeId)) {
      await selectChatSession(chat.sessions[0].id);
    } else {
      renderChatSessions();
    }
  })();
  chat.initPromise = run;
  try {
    return await run;
  } finally {
    if (chat.initPromise === run) chat.initPromise = null;
  }
}

const TOOL_LABELS = {
  get_indices: '查询大盘指数',
  get_quote: '查询个股报价',
  get_kline: '查询K线历史',
  get_research_card: '读取个股研究卡',
  get_intraday: '查询分时走势',
  get_sectors: '查询板块资金流',
  get_rank: '查询涨跌榜',
  get_overview: '查询市场概况',
  get_news: '翻阅财经新闻',
  get_stock_events: '检索个股资讯',
  search_stock: '搜索股票',
};

async function sendChat() {
  const input = $('#chatInput');
  const question = input.value.trim();
  if (!question || chat.busy || !chat.activeId) return;
  const draftStock = chat.draftStock ? { ...chat.draftStock } : null;
  const stockContext = draftStock ? {
    code: draftStock.code,
    name: draftStock.name || draftStock.displayName || '',
    market: draftStock.market,
  } : null;
  const text = draftStock ? buildStockChatMessage(draftStock, question) : question;
  const sessionId = chat.activeId;
  const viewReq = chat.selectReq;
  chat.busy = true;
  $('#chatSend').disabled = true;
  input.value = '';
  resizeChatInput(input);
  chat.draftStock = null;
  chat.drafts.delete(sessionId);
  renderChatContext();
  const session = chat.sessions.find((s) => s.id === sessionId);
  if (session) session.count = Math.max(1, Number(session.count || 0));
  const empty = $('#chatMsgs .chat-empty');
  if (empty) empty.remove();
  appendChatMsg('user', mdToHtml(text), Date.now());
  setChatStatus('思考中…');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        message: text,
        ...(stockContext ? { stockContext } : {}),
      }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `/api/chat -> ${res.status}`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (!chunk.startsWith('data: ')) continue;
        const ev = JSON.parse(chunk.slice(6));
        if (ev.type === 'tool') {
          const label = TOOL_LABELS[ev.name] || ev.name;
          const target = ev.args && (ev.args.code || ev.args.query || ev.args.market) || '';
          if (chat.activeId === sessionId) setChatStatus(`${label} ${target}…`);
        } else if (ev.type === 'answer') {
          if (chat.activeId === sessionId) {
            setChatStatus(null);
            if (chat.selectReq === viewReq) appendChatMsg('assistant', mdToHtml(ev.content), ev.createdAt);
            else await selectChatSession(sessionId); // 中途切走又切回时，从服务端重载，避免重复/漏消息
          }
          // 用服务端返回的标题同步侧边栏（首问后自动命名）
          if (ev.title) {
            const s = chat.sessions.find((x) => x.id === sessionId);
            if (s && s.title !== ev.title) { s.title = ev.title; renderChatSessions(); }
          }
        } else if (ev.type === 'error') {
          if (chat.activeId === sessionId) {
            setChatStatus(null);
            appendChatMsg('assistant', `<p>⚠️ ${escapeHtml(ev.message)}</p>`, Date.now());
          }
        }
      }
    }
  } catch (e) {
    if (chat.activeId === sessionId) {
      setChatStatus(null);
      appendChatMsg('assistant', `<p>⚠️ 请求失败：${escapeHtml(e.message)}</p>`, Date.now());
    }
  }
  if (chat.activeId === sessionId) setChatStatus(null);
  chat.busy = false;
  $('#chatSend').disabled = false;
}

/* ---------- 模型设置 ---------- */
const LLM_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek（深度求索）', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-flash', 'deepseek-v4-pro'], defaultReviewModel: 'deepseek-v4-pro', keyUrl: 'platform.deepseek.com' },
  { id: 'kimi', name: 'Kimi（月之暗面）', baseUrl: 'https://api.moonshot.cn/v1', models: ['kimi-k2-turbo-preview', 'kimi-k2-thinking'], keyUrl: 'platform.moonshot.cn' },
  { id: 'qwen', name: '通义千问（阿里云百炼）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen-plus', 'qwen-max', 'qwen-turbo'], keyUrl: 'bailian.console.aliyun.com' },
  { id: 'glm', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: ['glm-4.6', 'glm-4.5-air'], keyUrl: 'open.bigmodel.cn' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', models: ['gpt-4o-mini', 'gpt-4o'], keyUrl: 'platform.openai.com' },
  { id: 'custom', name: '自定义（OpenAI 兼容协议）', baseUrl: '', models: [], keyUrl: '' },
];

function llmProviderById(id) {
  return LLM_PROVIDERS.find((p) => p.id === id) || LLM_PROVIDERS[LLM_PROVIDERS.length - 1];
}

function fillLLMProvider(id, keepModel) {
  const p = llmProviderById(id);
  $('#llmProvider').value = p.id;
  if (p.baseUrl || !keepModel) $('#llmBaseUrl').value = p.baseUrl;
  $('#llmModelList').innerHTML = p.models.map((m) => `<option value="${m}">`).join('');
  if (!keepModel) {
    $('#llmModel').value = p.models[0] || '';
    if (!$('#llmReviewModel').disabled) {
      $('#llmReviewModel').value = p.defaultReviewModel || '';
    }
  }
  const fallbackReviewModel = p.models[0] || 'AI 问答模型';
  $('#llmReviewModel').placeholder = `留空使用 ${fallbackReviewModel}`;
  $('#llmReviewModelHint').textContent = p.defaultReviewModel
    ? `推荐使用 ${p.defaultReviewModel}；清空后沿用 AI 问答模型。`
    : '留空时沿用 AI 问答模型；已生成的当日复盘不会因换模型而重复生成。';
  $('#llmHint').textContent = p.keyUrl
    ? `API Key 在 ${p.keyUrl} 注册获取。Key 只保存在你自己的服务器上。`
    : '填写任意 OpenAI 兼容服务的接口地址（以 /v1 结尾）。';
}

function setLLMStatus(text, ok) {
  const el = $('#llmStatus');
  el.textContent = text || '';
  el.className = `llm-status ${ok === true ? 'ok' : ok === false ? 'err' : ''}`;
}

async function openLLMConfig() {
  $('#llmProvider').innerHTML = LLM_PROVIDERS.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  setLLMStatus('');
  $('#llmKey').value = '';
  try {
    const cfg = await api('/api/llm-config');
    const match = LLM_PROVIDERS.find((p) => p.baseUrl && cfg.baseUrl.startsWith(p.baseUrl.replace(/\/v1$/, '')));
    fillLLMProvider(match ? match.id : 'custom', true);
    $('#llmBaseUrl').value = cfg.baseUrl;
    $('#llmModel').value = cfg.model;
    const reviewModelValue = cfg.marketReviewModel || cfg.suggestedMarketReviewModel || '';
    const fallbackReviewModel = cfg.fallbackMarketReviewModel || cfg.model;
    $('#llmReviewModel').value = reviewModelValue;
    $('#llmReviewModel').disabled = cfg.marketReviewModelManaged === true;
    $('#llmReviewModel').placeholder = `留空使用 ${fallbackReviewModel}`;
    $('#llmReviewModelHint').textContent = cfg.marketReviewModelManaged
      ? `盘后复盘模型由环境变量管理，当前使用 ${cfg.effectiveMarketReviewModel || cfg.model}。`
      : reviewModelValue
        ? `下一份复盘单独使用 ${reviewModelValue}；清空后使用 ${fallbackReviewModel}。`
        : `留空时使用 ${fallbackReviewModel}；只影响下一份尚未生成的复盘。`;
    $('#llmKey').placeholder = cfg.configured ? `已保存 ${cfg.keyMask}（留空表示不修改）` : '请输入 API Key';
    if (!cfg.configured) setLLMStatus('尚未配置 API Key', false);
    else if (match?.id === 'deepseek' && ['deepseek-chat', 'deepseek-reasoner'].includes(cfg.model)) {
      setLLMStatus('当前使用即将停用的 DeepSeek 旧模型名称，请改为 V4 Flash 或 V4 Pro。', false);
    }
  } catch (e) {
    fillLLMProvider('deepseek');
    $('#llmReviewModel').disabled = false;
  }
  $('#llmModal').style.display = 'flex';
}

async function saveLLMConfig() {
  const body = {
    baseUrl: $('#llmBaseUrl').value.trim(),
    model: $('#llmModel').value.trim(),
    apiKey: $('#llmKey').value.trim(),
  };
  if (!$('#llmReviewModel').disabled) {
    body.marketReviewModel = $('#llmReviewModel').value.trim();
  }
  const res = await fetch('/api/llm-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || '保存失败');
  $('#llmKey').value = '';
  $('#llmKey').placeholder = j.configured
    ? `已保存 ${j.keyMask}（留空表示不修改）`
    : '请输入 API Key';
  if (j.fallbackMarketReviewModel) {
    $('#llmReviewModel').placeholder = `留空使用 ${j.fallbackMarketReviewModel}`;
  }
  return j;
}

/* ---------- 事件绑定 & 定时刷新 ---------- */
document.querySelectorAll('#marketTabs .tab').forEach((b) =>
  b.addEventListener('click', () => switchMarket(b.dataset.market).catch(console.error))
);
document.querySelectorAll('#chartSwitch .switch-btn').forEach((b) =>
  b.addEventListener('click', () => setChartType(b.dataset.type))
);
document.querySelectorAll('#sectorSwitch .switch-btn').forEach((b) =>
  b.addEventListener('click', () => setSectorView(b.dataset.view))
);
$('#marketSummaryContent').addEventListener('click', (e) => {
  if (e.target.closest('[data-summary-config]')) openLLMConfig().catch(console.error);
  if (e.target.closest('[data-review-open]')) openMarketReview();
});
$('#marketReviewDialogClose').addEventListener('click', () => closeMarketReview());
$('#marketReviewDialog').addEventListener('close', restoreMarketReviewFocus);
$('#marketReviewDialog').addEventListener('click', (e) => {
  const dialog = $('#marketReviewDialog');
  if (e.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  const outside = e.clientX < rect.left || e.clientX > rect.right
    || e.clientY < rect.top || e.clientY > rect.bottom;
  if (outside) closeMarketReview();
});
document.querySelectorAll('#mChartSwitch .switch-btn').forEach((b) =>
  b.addEventListener('click', () => setModalChartType(b.dataset.type))
);
$('#mResearch').addEventListener('click', (e) => {
  if (e.target.closest('[data-retry-research]')) loadModalResearch();
});
$('#mProfile').addEventListener('click', (e) => {
  if (e.target.closest('[data-retry-profile]')) loadModalProfile();
  if (e.target.closest('[data-toggle-profile]')) toggleProfileBusiness();
});
$('#mClose').addEventListener('click', closeStock);
$('#stockModal').addEventListener('click', (e) => {
  if (e.target === $('#stockModal')) closeStock();
});
$('#mHeart').addEventListener('click', () => {
  if (!modal.code) return;
  toggleWatch({ code: modal.code, name: modal.name, market: modal.market });
  updateHeartBtn();
});
$('#mAskAI').addEventListener('click', () => {
  if (!modal.code) return;
  // 先快照再关弹窗：报价尚未返回时也能使用入口，迟到响应不会改写 AI 上下文。
  const stock = {
    code: modal.code,
    name: modal.name,
    displayName: modal.name || modal.code.toUpperCase(),
    market: modal.market,
  };
  closeStock();
  openChatWithStock(stock).catch(console.error);
});
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const req = ++searchReq;
  const q = e.target.value.trim();
  if (!q) { hideSearchResults(); return; }
  searchTimer = setTimeout(async () => {
    try {
      const list = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (req !== searchReq) return;
      renderSearchResults(list);
    } catch (err) { console.error(err); }
  }, 300);
});
$('#searchInput').addEventListener('blur', () => {
  searchReq++;
  clearTimeout(searchTimer);
  setTimeout(hideSearchResults, 200);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeStock();
});
$('#chatNew').addEventListener('click', async () => {
  try {
    if (chat.initPromise) await chat.initPromise;
    await newChatSession();
  } catch (e) { console.error(e); }
});
$('#chatNewMobile').addEventListener('click', async () => {
  try {
    if (chat.initPromise) await chat.initPromise;
    await newChatSession();
  } catch (e) { console.error(e); }
});
$('#chatSessSelect').addEventListener('change', (e) => selectChatSession(e.target.value));
$('#chatSend').addEventListener('click', sendChat);
$('#chatContextRemove').addEventListener('click', removeChatStockContext);
$('#chatInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});
$('#chatInput').addEventListener('input', (e) => {
  resizeChatInput(e.target);
  saveChatDraft();
});
$('#llmConfigBtn').addEventListener('click', () => openLLMConfig().catch(console.error));
$('#llmConfigBtnM').addEventListener('click', () => openLLMConfig().catch(console.error));
$('#llmClose').addEventListener('click', () => { $('#llmModal').style.display = 'none'; });
$('#llmModal').addEventListener('click', (e) => {
  if (e.target === $('#llmModal')) $('#llmModal').style.display = 'none';
});
$('#llmProvider').addEventListener('change', (e) => fillLLMProvider(e.target.value));
$('#llmSave').addEventListener('click', async () => {
  try {
    const j = await saveLLMConfig();
    setLLMStatus(j.configured
      ? '✓ 已保存；AI 问答立即生效，复盘模型用于下一份复盘'
      : '已保存，但还没有 API Key', j.configured);
    if (j.configured && ['cn', 'hk', 'us'].includes(state.market)) {
      loadMarketReview();
    }
  } catch (e) { setLLMStatus(e.message, false); }
});
$('#llmTest').addEventListener('click', async () => {
  const btn = $('#llmTest');
  btn.disabled = true;
  try {
    await saveLLMConfig();
    setLLMStatus('正在测试连接…');
    const r = await fetch('/api/llm-config/test', { method: 'POST' }).then((x) => x.json());
    setLLMStatus(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`, r.ok);
    if (r.ok && ['cn', 'hk', 'us'].includes(state.market)) {
      loadMarketReview();
    }
  } catch (e) { setLLMStatus(e.message, false); }
  btn.disabled = false;
});

initWatch().catch(console.error);
refreshAll();
// 盘中 30 秒刷新行情，收盘后降为 5 分钟，减少无效请求
setInterval(() => {
  const open =
    state.market === 'watch'
      ? isMarketOpen('cn') || isMarketOpen('hk') || isMarketOpen('us')
      : isMarketOpen(state.market);
  if (Date.now() - lastQuotesAt >= (open ? 30000 : 300000)) refreshQuotes();
}, 5000);
setInterval(() => loadNews().catch(console.error), 300000); // 新闻 5 分钟刷新
// 对“等待收盘/等待重试”状态低频轮询；成功复盘仍由服务端保证每市场每交易日只生成一次。
setInterval(() => {
  if (marketReviewNeedsPolling
    && ['cn', 'hk', 'us'].includes(state.market)
    && Date.now() - lastMarketReviewAt >= 300000) {
    loadMarketReview();
  }
}, 30000);
