import { TZ } from './config.js';

// ---------- 日期：兩端都固定 Asia/Taipei，避免午夜後差一天 ----------

export function todayStr() { return dateStr(new Date()); }

export function dateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(d);
}

export function timeStr(d = new Date()) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).format(d);
}

export function nowStamp() { return dateStr(new Date()) + 'T' + timeStr(); }

/** 把任何可能跑掉的日期值（Date、ISO、民國怪格式）normalise 回 YYYY-MM-DD */
export function normalizeDate(val) {
  if (!val) return '';
  if (val instanceof Date) return dateStr(val);
  const s = String(val);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (s.includes('T') || s.endsWith('Z')) {
    const d = new Date(s);
    if (!isNaN(d)) return dateStr(d);
  }
  return s;
}

export function shiftDate(dStr, days) {
  const [y, m, d] = dStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
}

// ---------- 雜項 ----------

export function uid(prefix = 'x') {
  const rnd = (crypto.randomUUID ? crypto.randomUUID().slice(0, 8)
                                 : Math.random().toString(36).slice(2, 10));
  return `${prefix}_${Date.now().toString(36)}${rnd}`;
}

export const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

export function round(v, digits = 0) {
  const p = Math.pow(10, digits);
  return Math.round(num(v) * p) / p;
}

export function fmt(v, digits = 0) {
  const n = round(v, digits);
  return n.toLocaleString('zh-TW', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function debounce(fn, ms = 250) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- DOM ----------

export const $  = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function html(strings, ...values) {
  return strings.reduce((out, s, i) => out + s + (i < values.length ? values[i] : ''), '');
}

export function on(root, selector, event, handler) {
  root.addEventListener(event, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

// ---------- 提示 ----------

let toastTimer = null;
export function toast(message, kind = 'info') {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.className = `toast toast--${kind} is-visible`;
  box.textContent = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.remove('is-visible'), 3200);
}

export function confirmBox(message, confirmLabel = '確定') {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal__panel">
        <p class="modal__text">${esc(message)}</p>
        <div class="modal__actions">
          <button class="btn btn--ghost" data-act="cancel">取消</button>
          <button class="btn btn--danger" data-act="ok">${esc(confirmLabel)}</button>
        </div>
      </div>`;
    wrap.addEventListener('click', (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      wrap.remove();
      resolve(act === 'ok');
    });
    document.body.appendChild(wrap);
  });
}

// ---------- 圖表（不用外部函式庫，直接畫 SVG） ----------

export function lineChart(series, opts = {}) {
  const { width = 680, height = 220, pad = 34 } = opts;
  const points = series.filter(p => Number.isFinite(p.value));
  if (points.length === 0) return '<p class="empty">還沒有資料</p>';

  const xs = points.map((_, i) => i);
  const ys = points.map(p => p.value);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanY = (maxY - minY) || 1;
  const lo = minY - spanY * 0.15, hi = maxY + spanY * 0.15;

  const px = i => pad + (xs.length === 1 ? (width - pad * 2) / 2
                                         : (i / (xs.length - 1)) * (width - pad * 2));
  const py = v => height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2);

  const path = points.map((p, i) => `${i ? 'L' : 'M'}${px(i).toFixed(1)},${py(p.value).toFixed(1)}`).join(' ');
  const area = `${path} L${px(points.length - 1).toFixed(1)},${height - pad} L${px(0).toFixed(1)},${height - pad} Z`;
  const color = opts.color || 'var(--ps-triangle)';

  const dots = points.map((p, i) =>
    `<circle cx="${px(i).toFixed(1)}" cy="${py(p.value).toFixed(1)}" r="3.5" fill="${color}"><title>${esc(p.label)} ${p.value}</title></circle>`
  ).join('');

  const ticks = [lo, (lo + hi) / 2, hi].map(v =>
    `<text x="4" y="${(py(v) + 4).toFixed(1)}" class="chart__tick">${round(v, 1)}</text>
     <line x1="${pad}" y1="${py(v).toFixed(1)}" x2="${width - pad / 2}" y2="${py(v).toFixed(1)}" class="chart__grid"/>`
  ).join('');

  const first = points[0].label, last = points[points.length - 1].label;

  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img">
    ${ticks}
    <path d="${area}" fill="${color}" opacity="0.12"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${dots}
    <text x="${pad}" y="${height - 8}" class="chart__tick">${esc(first)}</text>
    <text x="${width - pad}" y="${height - 8}" class="chart__tick" text-anchor="end">${esc(last)}</text>
  </svg>`;
}
