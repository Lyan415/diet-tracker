import { state, logsOn, totalsOf, bodyHistory, latestBody, getMeta } from '../store.js';
import { effectiveTargets, leanMass } from '../nutrition.js';
import { NUTRIENTS } from '../config.js';
import { $, esc, fmt, round, todayStr, shiftDate, lineChart, num } from '../util.js';

let pickedDate = null;
let bodyMetric = 'weight';

export function renderStats() {
  const root = $('#screen-stats');
  const date = pickedDate || todayStr();
  const logs = logsOn(date);
  const totals = totalsOf(logs);
  const profile = getMeta('profile', {});
  const targets = effectiveTargets(state.meta, profile, latestBody());

  root.innerHTML = `
    <div class="screen__head">
      <div>
        <h1 class="screen__title">數據</h1>
        <p class="screen__sub">體位變化與每日營養素</p>
      </div>
    </div>

    ${bodyCard()}
    ${dayCard(date, logs, totals, targets)}
    ${trendCard()}
  `;

  root.onclick = (e) => {
    const m = e.target.closest('[data-metric]');
    if (m) { bodyMetric = m.dataset.metric; renderStats(); return; }
    const shift = e.target.closest('[data-shift]');
    if (shift) {
      pickedDate = shiftDate(pickedDate || todayStr(), Number(shift.dataset.shift));
      if (pickedDate > todayStr()) pickedDate = todayStr();
      renderStats();
    }
  };

  const picker = $('#datePicker');
  if (picker) picker.addEventListener('change', () => {
    pickedDate = picker.value || todayStr();
    renderStats();
  });
}

// ---------- 體位 ----------

function bodyCard() {
  const history = bodyHistory();
  const metrics = [
    { id: 'weight', label: '體重 (kg)', color: 'var(--ps-cross)' },
    { id: 'bodyFat', label: '體脂率 (%)', color: 'var(--ps-square)' },
    { id: 'lbm', label: '去脂體重 (kg)', color: 'var(--ps-triangle)' }
  ];
  const active = metrics.find(m => m.id === bodyMetric) || metrics[0];

  const series = history.map(b => ({
    label: b.date.slice(5),
    value: bodyMetric === 'lbm' ? leanMass(b.weight, b.bodyFat) : num(b[bodyMetric], null)
  })).filter(p => Number.isFinite(p.value));

  const first = series[0]?.value;
  const last = series[series.length - 1]?.value;
  const delta = (first !== undefined && last !== undefined) ? round(last - first, 1) : null;

  return `<div class="card">
    <h2 class="card__title">
      體位變化
      ${delta !== null ? `<span class="small muted">累計 ${delta > 0 ? '+' : ''}${fmt(delta, 1)}</span>` : ''}
    </h2>
    <div class="sortbar">
      ${metrics.map(m => `<button class="chip ${m.id === bodyMetric ? 'is-active' : ''}" data-metric="${m.id}">${esc(m.label)}</button>`).join('')}
    </div>
    ${series.length >= 2
      ? lineChart(series, { color: active.color })
      : '<p class="empty">至少要有兩筆體位紀錄才畫得出曲線。到「我的」頁記一筆。</p>'}
  </div>`;
}

// ---------- 單日營養素 ----------

function dayCard(date, logs, totals, targets) {
  const rows = NUTRIENTS.map(n => {
    const value = totals[n.key];
    const target = n.key === 'kcal' ? targets?.kcal : n.key === 'protein' ? targets?.protein : null;
    const gap = target ? round(target - value, 1) : null;
    const gapText = gap === null ? '—'
      : gap > 0 ? `<span style="color:var(--ps-triangle)">還差 ${fmt(gap, 1)}</span>`
                : `<span style="color:var(--over)">超出 ${fmt(Math.abs(gap), 1)}</span>`;
    return `<div class="entry">
      <div class="grow">${esc(n.label)}</div>
      <div class="entry__nums">
        <div class="entry__kcal">${fmt(value, n.key === 'kcal' || n.key === 'sodium' ? 0 : 1)} ${esc(n.unit)}</div>
        <div class="entry__protein">${gapText}</div>
      </div>
    </div>`;
  }).join('');

  return `<div class="card">
    <h2 class="card__title">單日攝取</h2>
    <div class="row" style="margin-bottom:12px">
      <button class="btn btn--ghost btn--sm" data-shift="-1">前一天</button>
      <input id="datePicker" class="grow" type="date" value="${esc(date)}" max="${esc(todayStr())}">
      <button class="btn btn--ghost btn--sm" data-shift="1" ${date >= todayStr() ? 'disabled' : ''}>後一天</button>
    </div>
    ${logs.length ? rows : '<p class="empty">這天沒有紀錄</p>'}
    ${logs.length && !targets ? '<p class="small muted" style="margin:10px 0 0">建好個人資料後，這裡會顯示與目標的差距。</p>' : ''}
  </div>`;
}

// ---------- 近期趨勢 ----------

function trendCard() {
  const days = 14;
  const today = todayStr();
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = shiftDate(today, -i);
    const t = totalsOf(logsOn(d));
    series.push({ label: d.slice(5), value: round(t.kcal), protein: round(t.protein, 1) });
  }
  const withData = series.filter(s => s.value > 0);

  if (withData.length < 2) {
    return `<div class="card">
      <h2 class="card__title">近兩週熱量</h2>
      <p class="empty">記錄滿兩天之後就會出現趨勢線</p>
    </div>`;
  }

  const avgKcal = round(withData.reduce((s, x) => s + x.value, 0) / withData.length);
  const avgProtein = round(withData.reduce((s, x) => s + x.protein, 0) / withData.length, 1);

  return `<div class="card">
    <h2 class="card__title">
      近兩週熱量
      <span class="small muted">有記錄的 ${withData.length} 天平均 ${fmt(avgKcal)} kcal・蛋白 ${fmt(avgProtein, 1)} g</span>
    </h2>
    ${lineChart(series.map(s => ({ label: s.label, value: s.value })), { color: 'var(--kcal)' })}
    <p class="small muted" style="margin:10px 0 0">沒有記錄的日子會以 0 呈現，判讀時請留意。</p>
  </div>`;
}
