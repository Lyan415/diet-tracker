import { state, logsOn, draftLogs, totalsOf, deleteLog, saveLog, latestBody, getMeta } from '../store.js';
import { effectiveTargets, suggestFoods } from '../nutrition.js';
import { $, esc, fmt, todayStr, round, toast, confirmBox, num } from '../util.js';
import { go } from '../app.js';

export function renderToday() {
  const root = $('#screen-today');
  const profile = getMeta('profile', {});
  const targets = effectiveTargets(state.meta, profile, latestBody());
  const today = todayStr();
  const logs = logsOn(today);
  const drafts = draftLogs();
  const eaten = totalsOf(logs);

  root.innerHTML = `
    <div class="screen__head">
      <div>
        <h1 class="screen__title">${greeting(profile)}</h1>
        <p class="screen__sub">${esc(today)}・已記錄 ${logs.length} 筆</p>
      </div>
    </div>
    ${targets ? gaugesMarkup(targets, eaten) : onboardMarkup()}
    ${drafts.length ? draftMarkup(drafts) : ''}
    ${targets ? suggestMarkup(targets, eaten) : ''}
    ${listMarkup(logs, eaten)}
  `;

  root.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;

    if (act === 'goProfile') go('profile');
    if (act === 'goAdd') go('add');

    if (act === 'del') {
      if (await confirmBox('要刪掉這筆紀錄嗎？照片也會一起移到 Drive 垃圾桶。', '刪除')) {
        await deleteLog(id);
        toast('已刪除');
      }
    }

    if (act === 'confirmDraft') {
      const log = state.logs.find(l => l.id === id);
      if (log) { await saveLog({ ...log, status: 'confirmed' }); toast('已計入今日', 'ok'); }
    }

    if (act === 'dropDraft') {
      await deleteLog(id);
      toast('已丟棄');
    }
  };
}

function greeting(profile) {
  const name = profile?.nickname?.trim();
  const h = new Date().getHours();
  const part = h < 11 ? '早安' : h < 17 ? '午安' : '晚安';
  return name ? `${part}，${esc(name)}` : '今日情況';
}

// ---------- HUD 能量條 ----------

function gauge({ label, left, unit, eaten, target, color, note }) {
  const notches = 20;
  const ratio = target > 0 ? eaten / target : 0;
  const on = Math.min(notches, Math.round(ratio * notches));
  const over = ratio > 1;

  const bar = Array.from({ length: notches }, (_, i) => {
    const cls = i < on ? (over ? 'is-on is-over' : 'is-on') : '';
    return `<span class="gauge__notch ${cls}"></span>`;
  }).join('');

  return `
    <div class="gauge" style="--gauge-color:${color}">
      <div class="gauge__head">
        <div>
          <div class="gauge__label">${esc(label)}</div>
          <div class="gauge__value" style="color:${over ? 'var(--over)' : color}">
            ${fmt(Math.abs(left))}<span class="gauge__unit">${esc(unit)}</span>
          </div>
        </div>
        <div class="gauge__meta">
          已攝取 ${fmt(eaten)} / ${fmt(target)}<br>${esc(note)}
        </div>
      </div>
      <div class="gauge__bar">${bar}</div>
    </div>`;
}

function gaugesMarkup(targets, eaten) {
  const kcalLeft = round(targets.kcal - eaten.kcal);
  const proteinLeft = round(targets.protein - eaten.protein, 1);

  return `<div class="card">
    ${gauge({
      label: kcalLeft >= 0 ? '今天還能吃' : '今天已超出',
      left: kcalLeft, unit: 'kcal', eaten: eaten.kcal, target: targets.kcal,
      color: 'var(--kcal)',
      note: kcalLeft >= 0 ? '剩餘額度' : '超出額度'
    })}
    ${gauge({
      label: proteinLeft > 0 ? '蛋白質還差' : '蛋白質已達標',
      left: proteinLeft, unit: 'g', eaten: eaten.protein, target: targets.protein,
      color: 'var(--protein)',
      note: proteinLeft > 0 ? '尚需補足' : '超過目標'
    })}
    <p class="small muted" style="margin:0">
      目標來源：${targets.mode === 'manual' ? '你手動設定的值' : '依身高體重體脂計算的建議值'}
      ・<button class="btn btn--ghost btn--sm" data-act="goProfile">調整</button>
    </p>
  </div>`;
}

function onboardMarkup() {
  return `<div class="card">
    <h2 class="card__title">先建立個人資料</h2>
    <p class="small muted" style="margin:0 0 14px">
      填入出生年月、身高、目標體重與活動量，再記一筆體重體脂，就能算出你的每日熱量與蛋白質目標。
    </p>
    <button class="btn btn--go btn--block" data-act="goProfile">去建檔</button>
  </div>`;
}

// ---------- 待確認 ----------

function draftMarkup(drafts) {
  return `<div class="card">
    <h2 class="card__title">
      待確認 <span class="tag tag--draft">${drafts.length} 筆</span>
    </h2>
    <p class="small muted" style="margin:0 0 10px">
      AI 判讀的結果還沒計入今日。確認數字沒問題再收進紀錄。
    </p>
    ${drafts.map(d => `
      <div class="entry">
        ${d.photoUrls?.[0] ? `<img class="entry__thumb" src="${esc(d.photoUrls[0])}" alt="">` : ''}
        <div class="grow">
          <div class="entry__name">${esc(d.foodName)}</div>
          <div class="entry__meta">${fmt(d.kcal)} kcal・蛋白 ${fmt(d.protein, 1)} g</div>
        </div>
        <div class="row">
          <button class="btn btn--go btn--sm" data-act="confirmDraft" data-id="${esc(d.id)}">收下</button>
          <button class="btn btn--ghost btn--sm" data-act="dropDraft" data-id="${esc(d.id)}">丟棄</button>
        </div>
      </div>`).join('')}
  </div>`;
}

// ---------- 補給建議 ----------

function suggestMarkup(targets, eaten) {
  const remainKcal = targets.kcal - eaten.kcal;
  const remainProtein = targets.protein - eaten.protein;
  if (remainProtein <= 0) return '';

  const picks = suggestFoods(state.foods, remainKcal, remainProtein, 3);
  if (!picks.length) {
    return `<div class="card">
      <h2 class="card__title">補給建議</h2>
      <p class="small muted" style="margin:0">
        食物庫裡還沒有夠多資料可以推薦。記幾筆常吃的東西之後，這裡會依蛋白質密度幫你挑。
      </p>
    </div>`;
  }

  return `<div class="card">
    <h2 class="card__title">補給建議</h2>
    <p class="small muted" style="margin:0 0 10px">
      還差 ${fmt(remainProtein, 1)} g 蛋白質，剩 ${fmt(remainKcal)} kcal 可用。以下依每 100 kcal 的蛋白質含量排序。
    </p>
    ${picks.map(p => `
      <div class="entry">
        <div class="grow">
          <div class="entry__name">${esc(p.food.name)}</div>
          <div class="entry__meta">
            每 100 kcal 含 ${fmt(p.density, 1)} g 蛋白・吃 ${fmt(p.serves, 1)} ${p.food.baseUnit === 'gram' ? `× ${fmt(p.food.gramsPerUnit)} g` : '份'}
            可補 ${fmt(num(p.food.protein) * p.serves, 1)} g
          </div>
        </div>
      </div>`).join('')}
  </div>`;
}

// ---------- 今日清單 ----------

function listMarkup(logs, eaten) {
  return `<div class="card">
    <h2 class="card__title">
      今天吃了什麼
      <button class="btn btn--primary btn--sm" data-act="goAdd">新增</button>
    </h2>
    ${logs.length ? logs.map(entryMarkup).join('') : '<p class="empty">還沒有紀錄</p>'}
    ${logs.length ? `<div class="entry" style="border-top:1px solid var(--line);margin-top:6px">
      <div class="grow small muted">合計</div>
      <div class="entry__nums">
        <div class="entry__kcal">${fmt(eaten.kcal)} kcal</div>
        <div class="entry__protein">蛋白 ${fmt(eaten.protein, 1)} g</div>
      </div>
    </div>` : ''}
  </div>`;
}

function entryMarkup(l) {
  const qty = l.qtyType === 'gram' ? `${fmt(l.qty)} g` : `${fmt(l.qty, 1)} 份`;
  return `<div class="entry">
    ${l.photoUrls?.[0] ? `<img class="entry__thumb" src="${esc(l.photoUrls[0])}" alt="" loading="lazy">` : ''}
    <div class="grow">
      <div class="entry__name">${esc(l.foodName)}</div>
      <div class="entry__meta">${esc(l.time || '')}・${qty}</div>
    </div>
    <div class="entry__nums">
      <div class="entry__kcal">${fmt(l.kcal)}</div>
      <div class="entry__protein">P ${fmt(l.protein, 1)}</div>
    </div>
    <button class="btn btn--ghost btn--sm" data-act="del" data-id="${esc(l.id)}" aria-label="刪除">✕</button>
  </div>`;
}
