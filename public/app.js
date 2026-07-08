/* 行情看板前端逻辑 */
const $ = (sel) => document.querySelector(sel);

const state = {
  market: 'cn',        // cn | us | watch
  indices: [],
  activeCode: null,    // 当前选中的指数
  chartType: 'minute', // minute | day | week | month
};

/* ---------- 自选股（存服务器，所有设备共享） ---------- */
const WATCH_KEY = 'watchlist'; // 旧版 localStorage key，仅用于一次性迁移
let watchList = []; // 服务器数据的内存镜像

const getWatch = () => watchList;
const isWatched = (code) => watchList.some((s) => s.code === code);

async function pushWatch() {
  await fetch('/api/watchlist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(watchList),
  });
}

function toggleWatch(item) {
  if (isWatched(item.code)) watchList = watchList.filter((s) => s.code !== item.code);
  else watchList.push({ code: item.code, name: item.name || '', market: item.market || 'cn' });
  pushWatch().catch(console.error);
  if (state.market === 'watch') loadWatch().catch(console.error);
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
window.addEventListener('resize', () => chart.resize());

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

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/* ---------- 交易时段判断（按市场时区，含少量缓冲） ---------- */
function isMarketOpen(market) {
  const tz = market === 'us' ? 'America/New_York' : 'Asia/Shanghai';
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
  // A股 09:15-15:05（北京时间）；美股 09:25-16:05（美东时间）
  return market === 'us' ? mins >= 565 && mins <= 965 : mins >= 555 && mins <= 905;
}

/* ---------- 指数卡片 ---------- */
async function loadIndices() {
  const list = await api(`/api/indices?market=${state.market}`);
  state.indices = list;
  if (!state.activeCode || !list.find((i) => i.code === state.activeCode)) {
    state.activeCode = list[0] && list[0].code;
  }
  const wrap = $('#indexCards');
  wrap.innerHTML = list
    .map(
      (i) => `
    <div class="index-card ${i.code === state.activeCode ? 'active' : ''}" data-code="${i.code}">
      <div class="idx-name">${i.name}</div>
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
  $('#updateTime').textContent = `${open ? '● 盘中' : '○ 已收盘'}${t ? ' · ' + t : ''}`;
}

/* ---------- 走势图 ---------- */
function activeIndex() {
  return state.indices.find((i) => i.code === state.activeCode) || {};
}

let chartReq = 0; // 请求序号，防止慢的旧请求覆盖新图
async function loadChart() {
  const idx = activeIndex();
  $('#chartTitle').textContent = idx.name || '';
  if (!state.activeCode) return;
  const req = ++chartReq;
  try {
    if (state.chartType === 'minute') {
      const d = await api(`/api/minute?code=${encodeURIComponent(state.activeCode)}`);
      if (req !== chartReq) return;
      if (!d.points || d.points.length < 5) {
        // 分时数据不全时自动退回日K
        setChartType('day');
        return;
      }
      renderMinute(chart, d);
    } else {
      const d = await api(
        `/api/kline?code=${encodeURIComponent(state.activeCode)}&days=120&period=${state.chartType}`
      );
      if (req !== chartReq) return;
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
async function loadOverview() {
  const d = await api(`/api/overview?market=${state.market}`);
  const el = $('#overviewContent');
  if (state.market === 'cn') {
    $('#overviewTitle').textContent = '市场概况 · 沪深两市';
    const upW = d.total ? ((d.up / d.total) * 100).toFixed(1) : 50;
    const yi = d.turnover / 1e4; // 万元 -> 亿
    const amount = yi >= 1e4 ? (yi / 1e4).toFixed(2) + ' 万亿' : yi.toFixed(0) + ' 亿';
    el.innerHTML = `
      <div class="breadth-stats">
        <span class="c-up">上涨 ${d.up} 家</span>
        <span class="c-down">下跌 ${d.down} 家</span>
      </div>
      <div class="breadth-bar">
        <div class="bb-up" style="width:${upW}%"></div>
        <div class="bb-down" style="width:${100 - upW}%"></div>
      </div>
      <div class="overview-chips">
        <span>涨停 <b class="c-up">${d.limitUp}</b> 家</span>
        <span>跌停 <b class="c-down">${d.limitDown}</b> 家</span>
        <span>两市成交 <b>${amount}</b></span>
      </div>`;
  } else {
    $('#overviewTitle').textContent = '市场概况 · 宏观情绪';
    el.innerHTML = `
      <div class="macro-grid">
        ${d
          .map(
            (q) => `
        <div class="macro-item" data-code="${q.code}" data-name="${q.name}">
          <div class="m-name">${q.name}</div>
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

const fmtInflow = (wan) => `${wan >= 0 ? '+' : '-'}${(Math.abs(wan) / 1e4).toFixed(1)}亿`;

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
          `<b>${d.name}</b>　<span style="color:${d.chg >= 0 ? UP : DOWN}">${fmtPct(d.chg)}</span>` +
          `<br/>主力净流入 <span style="color:${d.inflow >= 0 ? UP : DOWN}">${fmtInflow(d.inflow)}</span>` +
          `<br/>成交额 ${(d.value / 1e4).toFixed(0)}亿` +
          (d.leader ? `<br/>领涨 ${d.leader.name} ${fmtPct(d.leader.changePct)}` : '')
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
        <span class="sector-name">${s.name}</span>
        <span class="sector-pct ${colorCls(s.changePct)}">${fmtPct(s.changePct)}</span>
        ${s.leader ? `<span class="sector-leader" data-code="${s.leader.code}" data-name="${s.leader.name}">${s.leader.name} ${fmtPct(s.leader.changePct)}</span>` : ''}
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
  sectorList = await api('/api/sectors');
  renderSectors();
}

/* ---------- 涨跌榜 ---------- */
function renderRank(el, rows) {
  el.innerHTML =
    `<tr><th>名称</th><th>最新价</th><th>涨跌幅</th></tr>` +
    rows
      .map(
        (s) => `
      <tr data-code="${s.code}" data-name="${s.name}">
        <td><div class="stock-name">${s.name}</div><div class="stock-code">${s.code.toUpperCase()}</div></td>
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
  const [up, down] = await Promise.all([
    api(`/api/rank?market=${state.market}&dir=up`),
    api(`/api/rank?market=${state.market}&dir=down`),
  ]);
  renderRank($('#rankUp'), up.slice(0, 10));
  renderRank($('#rankDown'), down.slice(0, 10));
}

/* ---------- 自选股列表 ---------- */
async function loadWatch() {
  // 先从服务器拉最新（可能在其他设备上改过）
  try { watchList = await api('/api/watchlist'); } catch (e) { console.error(e); }
  const list = getWatch();
  const table = $('#watchTable');
  $('#watchEmpty').style.display = list.length ? 'none' : '';
  $('#updateTime').textContent = list.length ? `共 ${list.length} 只` : '';
  if (!list.length) { table.innerHTML = ''; return; }
  const quotes = await api(`/api/quotes?codes=${encodeURIComponent(list.map((s) => s.code).join(','))}`);
  const byCode = new Map(quotes.map((q) => [q.code, q]));
  table.innerHTML =
    `<tr><th>名称</th><th>最新价</th><th>涨跌幅</th><th></th></tr>` +
    list
      .map((s) => {
        const q = byCode.get(s.code);
        const name = (q && q.name) || s.name;
        return `
      <tr data-code="${s.code}" data-name="${name}">
        <td><div class="stock-name">${name}</div><div class="stock-code">${s.code.toUpperCase()}</div></td>
        <td>${q ? q.price.toFixed(2) : '--'}</td>
        <td class="${q ? colorCls(q.changePct) : ''}">${q ? fmtPct(q.changePct) : '--'}</td>
        <td><button class="del-btn" data-del="${s.code}" title="移除">✕</button></td>
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
}

/* ---------- 个股详情弹窗 ---------- */
const modal = { code: null, name: '', market: 'cn', chartType: 'minute', req: 0, chart: null };

function fmtBig(v) {
  if (v >= 1e12) return (v / 1e12).toFixed(2) + '万亿';
  if (v >= 1e8) return (v / 1e8).toFixed(2) + '亿';
  if (v >= 1e4) return (v / 1e4).toFixed(1) + '万';
  return String(Math.round(v));
}

function openStock(code, name = '') {
  modal.code = code;
  modal.name = name;
  modal.market = /^(sh|sz|bj)\d{6}$/.test(code) ? 'cn' : 'us';
  modal.chartType = 'minute';
  $('#mName').textContent = name || code;
  $('#mCode').textContent = code.toUpperCase();
  $('#mPrice').textContent = '--';
  $('#mPrice').className = 'modal-price';
  $('#mChg').textContent = '';
  $('#mTime').textContent = '';
  $('#mStats').innerHTML = '';
  $('#mBook').innerHTML = '';
  $('#mBook').style.display = 'none';
  document.querySelectorAll('#mChartSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === 'minute')
  );
  updateHeartBtn();
  $('#stockModal').style.display = '';
  if (!modal.chart) {
    modal.chart = echarts.init($('#mChart'));
    window.addEventListener('resize', () => modal.chart.resize());
  }
  modal.chart.clear();
  modal.chart.resize();
  loadModalQuote().catch(console.error);
  loadModalChart().catch(console.error);
}

function closeStock() {
  $('#stockModal').style.display = 'none';
  modal.code = null;
}

function updateHeartBtn() {
  const on = modal.code && isWatched(modal.code);
  const btn = $('#mHeart');
  btn.textContent = on ? '♥' : '♡';
  btn.classList.toggle('active', on);
  btn.title = on ? '移出自选' : '加入自选';
}

async function loadModalQuote() {
  const q = await api(`/api/quote?code=${encodeURIComponent(modal.code)}`);
  if (q.code !== modal.code) return;
  modal.name = q.name;
  modal.market = q.market;
  $('#mName').textContent = q.name;
  $('#mPrice').textContent = q.price.toFixed(2);
  $('#mPrice').className = `modal-price ${colorCls(q.change)}`;
  $('#mChg').textContent = `${sign(q.change)}${q.change.toFixed(2)} · ${fmtPct(q.changePct)}`;
  $('#mChg').className = `modal-chg ${colorCls(q.change)}`;
  $('#mTime').textContent = q.time || '';
  const rows =
    q.market === 'cn'
      ? [
          ['今开', q.open.toFixed(2)], ['昨收', q.prevClose.toFixed(2)],
          ['最高', q.high.toFixed(2)], ['最低', q.low.toFixed(2)],
          ['成交量', fmtBig(q.volume) + '股'], ['成交额', fmtBig(q.amount)],
          ['换手率', q.turnoverRate + '%'], ['振幅', q.amplitude + '%'],
          ['市盈率', q.pe || '--'], ['市净率', q.pb || '--'],
          ['总市值', fmtBig(q.mktcap)],
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
  el.style.display = '';
}

async function loadModalChart() {
  if (!modal.code) return;
  const req = ++modal.req;
  try {
    if (modal.chartType === 'minute') {
      const d = await api(`/api/minute?code=${encodeURIComponent(modal.code)}`);
      if (req !== modal.req) return;
      if (!d.points || d.points.length < 5) {
        setModalChartType('day');
        return;
      }
      renderMinute(modal.chart, d);
    } else {
      const d = await api(
        `/api/kline?code=${encodeURIComponent(modal.code)}&days=120&period=${modal.chartType}`
      );
      if (req !== modal.req) return;
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
function hideSearchResults() {
  $('#searchResults').style.display = 'none';
}
function renderSearchResults(list) {
  const box = $('#searchResults');
  if (!list.length) { hideSearchResults(); return; }
  box.innerHTML = list
    .map(
      (s) => `
    <div class="search-item" data-code="${s.code}" data-name="${s.name}">
      <span class="s-name">${s.name}</span>
      <span class="s-code">${s.code.toUpperCase()}</span>
      <span class="s-badge">${s.market === 'cn' ? 'A股' : '美股'}</span>
    </div>`
    )
    .join('');
  box.style.display = 'block';
  box.querySelectorAll('.search-item').forEach((el) =>
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
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
    <li><a href="${n.url}" target="_blank" rel="noopener">
      <span class="news-time">${fmtNewsTime(n.time)}</span>
      <span class="news-title">${n.title}</span>
      ${n.media ? `<span class="news-media">${n.media}</span>` : ''}
    </a></li>`
    )
    .join('');
}

/* ---------- 市场切换 ---------- */
function switchMarket(market) {
  state.market = market;
  state.activeCode = null;
  document.querySelectorAll('#marketTabs .tab').forEach((b) =>
    b.classList.toggle('active', b.dataset.market === market)
  );
  const isWatch = market === 'watch';
  $('#indexSection').style.display = isWatch ? 'none' : '';
  $('#chartSection').style.display = isWatch ? 'none' : '';
  $('#overviewSection').style.display = isWatch ? 'none' : '';
  $('#rankSection').style.display = isWatch ? 'none' : '';
  $('#watchSection').style.display = isWatch ? '' : 'none';
  // 行业板块仅A股有数据
  $('#sectorSection').style.display = market === 'cn' ? '' : 'none';
  state.chartType = 'minute';
  document.querySelectorAll('#chartSwitch .switch-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.type === state.chartType)
  );
  refreshAll();
}

let lastQuotesAt = 0;
async function refreshQuotes() {
  lastQuotesAt = Date.now();
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
  loadNews().catch(console.error);
}

/* ---------- 事件绑定 & 定时刷新 ---------- */
document.querySelectorAll('#marketTabs .tab').forEach((b) =>
  b.addEventListener('click', () => switchMarket(b.dataset.market))
);
document.querySelectorAll('#chartSwitch .switch-btn').forEach((b) =>
  b.addEventListener('click', () => setChartType(b.dataset.type))
);
document.querySelectorAll('#sectorSwitch .switch-btn').forEach((b) =>
  b.addEventListener('click', () => setSectorView(b.dataset.view))
);
document.querySelectorAll('#mChartSwitch .switch-btn').forEach((b) =>
  b.addEventListener('click', () => setModalChartType(b.dataset.type))
);
$('#mClose').addEventListener('click', closeStock);
$('#stockModal').addEventListener('click', (e) => {
  if (e.target === $('#stockModal')) closeStock();
});
$('#mHeart').addEventListener('click', () => {
  if (!modal.code) return;
  toggleWatch({ code: modal.code, name: modal.name, market: modal.market });
  updateHeartBtn();
});
$('#searchInput').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { hideSearchResults(); return; }
  searchTimer = setTimeout(async () => {
    try {
      renderSearchResults(await api(`/api/search?q=${encodeURIComponent(q)}`));
    } catch (err) { console.error(err); }
  }, 300);
});
$('#searchInput').addEventListener('blur', () => setTimeout(hideSearchResults, 200));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeStock();
});

initWatch().catch(console.error);
refreshAll();
// 盘中 30 秒刷新行情，收盘后降为 5 分钟，减少无效请求
setInterval(() => {
  const open =
    state.market === 'watch'
      ? isMarketOpen('cn') || isMarketOpen('us')
      : isMarketOpen(state.market);
  if (Date.now() - lastQuotesAt >= (open ? 30000 : 300000)) refreshQuotes();
}, 5000);
setInterval(() => loadNews().catch(console.error), 300000); // 新闻 5 分钟刷新
