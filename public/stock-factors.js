/* Individual stock factors: pure rendering of the shared research response. */
(() => {
  'use strict';
  const byId = (id) => document.getElementById(id);
  const panel = byId('mFactors');
  const list = byId('factorList');
  const chartNode = byId('factorChart');
  let analysis = null;
  let selected = 'momentum';
  let chart = null;
  const reasons = {
    insufficient_history: '完整日线不足', benchmark_unavailable: '基准不可用',
    benchmark_insufficient_history: '基准历史不足', benchmark_date_mismatch: '基准日期未对齐',
    missing_joint_sessions: '共同交易日有缺失或停牌', zero_benchmark_variance: '基准波动不足以计算 Beta',
    missing_volume: '成交量数据缺失', zero_average_volume: '历史平均成交量为零',
  };

  function format(value, unit) {
    if (!Number.isFinite(value)) return '--';
    const suffix = { percent: '%', percentage_points: '个百分点', multiple: '倍', beta: '' }[unit] || '';
    return `${value.toFixed(2)}${suffix}`;
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function draw() {
    if (panel.hidden || chartNode.hidden || !analysis || chartNode.clientWidth === 0) return;
    const factor = analysis.factors.find((item) => item.id === selected);
    if (!factor) return;
    chart ||= echarts.init(chartNode);
    const styles = getComputedStyle(document.documentElement);
    const color = (name) => styles.getPropertyValue(name).trim();
    const history = Array.isArray(factor.history) ? factor.history : [];
    const unit = { percent: '%', percentage_points: '百分点', multiple: '倍', beta: 'Beta' }[factor.unit];
    chart.setOption({
      animation: false,
      grid: { left: 12, right: 12, top: 30, bottom: 12, containLabel: true },
      tooltip: { trigger: 'axis', renderMode: 'richText',
        valueFormatter: (value) => format(value, factor.unit) },
      xAxis: { type: 'category', data: history.map((row) => row.date), boundaryGap: false,
        axisLabel: { color: color('--text-dim'), hideOverlap: true, formatter: (date) => date.slice(5) },
        axisLine: { lineStyle: { color: color('--border') } }, axisTick: { show: false } },
      yAxis: { type: 'value', scale: true, name: unit,
        nameTextStyle: { color: color('--text-dim') },
        axisLabel: { color: color('--text-dim') },
        splitLine: { lineStyle: { color: color('--border'), opacity: 0.6 } } },
      series: [{ name: factor.label, type: 'line', data: history.map((row) => row.value),
        showSymbol: history.filter((row) => row.value != null).length < 3, symbolSize: 6,
        connectNulls: false, lineStyle: { width: 2, color: color('--accent') },
        itemStyle: { color: color('--accent') } }],
    }, true);
    chart.resize();
  }

  function select(id) {
    const factor = analysis?.factors.find((item) => item.id === id);
    if (!factor) return;
    selected = id;
    for (const button of list.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.factor === id));
    }
    byId('factorDetail').hidden = false;
    byId('factorChartValue').textContent = format(factor.value, factor.unit);
    const history = factor.history || [];
    const hasHistory = history.some((row) => Number.isFinite(row.value));
    byId('factorChartTitle').textContent = `${factor.label} · ${hasHistory ? `最近${history.length}期` : '历史走势'}`;
    chartNode.hidden = !hasHistory;
    byId('factorChartEmpty').hidden = hasHistory;
    chartNode.setAttribute('aria-label', `${factor.label}历史走势，${history[0]?.date || '--'}至${factor.asOf || '--'}，最新${format(factor.value, factor.unit)}。缺失值保留断点。`);
    byId('factorDescription').textContent = `${factor.definition} ${factor.highMeaning}`;
    const reference = factor.reference;
    byId('factorReference').textContent = factor.value == null
      ? `${reasons[factor.reason] || '数据不可用'}（计算需${factor.required}个收盘观察）。`
      : `截至 ${factor.asOf}；${factor.percentile == null
        ? `分位样本不足：已有${reference.count}期，需${reference.required}期。`
        : `自身历史分位 ${factor.percentile.toFixed(1)}%，比较 ${reference.startDate} 至 ${reference.endDate} 的${reference.count}个有效观察。`}`;
    draw();
  }

  function switchView(factors) {
    panel.hidden = !factors;
    byId('mResearchBody').hidden = factors;
    byId('researchFactorsTab').setAttribute('aria-selected', String(factors));
    byId('researchPerformanceTab').setAttribute('aria-selected', String(!factors));
    if (factors) requestAnimationFrame(draw);
  }
  byId('researchPerformanceTab').addEventListener('click', () => switchView(false));
  byId('researchFactorsTab').addEventListener('click', () => switchView(true));
  for (const tab of [byId('researchPerformanceTab'), byId('researchFactorsTab')]) {
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const factors = event.key === 'End' || event.key !== 'Home' && tab.id === 'researchPerformanceTab';
      switchView(factors);
      byId(factors ? 'researchFactorsTab' : 'researchPerformanceTab').focus();
    });
  }
  new ResizeObserver(() => { if (!panel.hidden && chartNode.clientWidth) chart?.resize(); }).observe(chartNode);

  function clear(message) {
    analysis = null;
    chart?.dispose();
    chart = null;
    list.replaceChildren();
    byId('factorDetail').hidden = true;
    byId('factorIntro').textContent = message;
    byId('factorWarnings').textContent = '';
    byId('factorCoverage').textContent = '';
    byId('factorMethodology').textContent = '';
  }

  window.StockFactors = {
    loading: () => clear('正在计算完整交易日的个股因子…'),
    error: () => clear('因子数据暂不可用，可在“阶段表现”中重试。'),
    close: () => { chart?.dispose(); chart = null; },
    render(value) {
      if (!value || !Array.isArray(value.factors)) {
        clear('当前研究数据尚无因子分析。');
        return;
      }
      analysis = value;
      list.replaceChildren();
      byId('factorIntro').textContent = `价格与风险因子 ${value.availableCount}/${value.factors.length}项可用 · 完整日 ${value.asOf || '--'}。横条为自身历史分位，越高仅表示数值越高；财务因子与同行排名未覆盖。`;
      for (const factor of value.factors) {
        const button = element('button', 'factor-row');
        button.type = 'button';
        button.dataset.factor = factor.id;
        button.setAttribute('aria-controls', 'factorDetail');
        const head = element('span', 'factor-row-head');
        head.append(element('span', 'factor-label', factor.label), element('span', 'factor-value', format(factor.value, factor.unit)));
        const track = element('span', 'factor-track');
        track.setAttribute('aria-hidden', 'true');
        if (Number.isFinite(factor.percentile)) {
          const marker = element('span', 'factor-marker');
          marker.style.left = `${Math.max(0, Math.min(100, factor.percentile))}%`;
          track.append(marker);
        }
        button.append(head, track, element('span', 'factor-rank', factor.value == null
          ? reasons[factor.reason] || '数据不可用'
          : factor.percentile == null ? `历史分位待积累 · ${factor.reference.count}/${factor.reference.required}期`
            : `自身历史分位 ${factor.percentile.toFixed(1)}% · ${factor.reference.count}期`));
        button.addEventListener('click', () => select(factor.id));
        list.append(button);
      }
      byId('factorWarnings').textContent = (value.warnings || []).join(' ');
      byId('factorCoverage').textContent = value.coverageNote;
      byId('factorMethodology').textContent = `${value.methodology} 相对强弱与 Beta 使用${value.benchmark.name || '同市场价格指数'}；其余窗口按个股有效完整日线计算。`;
      select(value.factors.some((item) => item.id === selected) ? selected : value.factors[0]?.id);
    },
  };
})();
