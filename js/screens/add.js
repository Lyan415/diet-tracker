import { state, rankedFoods, findFood, makeFood, saveFood, saveLog } from '../store.js';
import { scaleFood } from '../nutrition.js';
import { analyzeFood, SOURCE_LABEL } from '../gemini.js';
import { compressImage, uploadPhoto } from '../gas.js';
import { $, $$, esc, fmt, num, uid, todayStr, timeStr, nowStamp, toast, debounce } from '../util.js';
import { NUTRIENTS } from '../config.js';
import { go, refresh } from '../app.js';

let mode = 'frequent';
let shots = [];        // { dataUrl, base64, mimeType }
let candidates = [];   // 辨識或查詢後待審核的項目
let busy = false;
let search = '';

const MODES = [
  { id: 'frequent', name: '常食用食物', hint: '從已建檔的食物挑，依最近用過與使用次數排序' },
  { id: 'photo',    name: '拍照辨識',   hint: '可一次上傳多張，例如品名照加營養標示照' },
  { id: 'quick',    name: '快速加入',   hint: '只填熱量與蛋白質，其他營養素可留空' },
  { id: 'lookup',   name: '手動查食物', hint: '打食物名稱，先查食物庫，查不到再上網找' }
];

export function renderAdd() {
  const root = $('#screen-add');
  root.innerHTML = `
    <div class="screen__head">
      <div>
        <h1 class="screen__title">新增食物</h1>
        <p class="screen__sub">${esc(todayStr())} ${esc(timeStr())}</p>
      </div>
    </div>
    <div class="modes">
      ${MODES.map(m => `
        <button class="mode ${m.id === mode ? 'is-active' : ''}" data-mode="${m.id}">
          <span class="mode__name">${esc(m.name)}</span>
          <span class="mode__hint">${esc(m.hint)}</span>
        </button>`).join('')}
    </div>
    <div id="modePanel"></div>
    <div id="reviewPanel"></div>
  `;
  renderPanel();
  renderReview();
  wire(root);
}

function wire(root) {
  root.onclick = async (e) => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) { mode = modeBtn.dataset.mode; candidates = []; renderAdd(); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn || busy) return;
    const { act, id, idx } = btn.dataset;

    if (act === 'pick')        $('#shotInput').click();
    if (act === 'dropShot')    { shots.splice(Number(idx), 1); renderPanel(); }
    if (act === 'analyze')     await runAnalyze();
    if (act === 'lookup')      await runLookup();
    if (act === 'quickSave')   await saveQuick();
    if (act === 'useFood')     openQty(id);
    if (act === 'logFood')     await logFrequent(id);
    if (act === 'commit')      await commitCandidates(btn.dataset.status);
    if (act === 'dropCand')    { candidates.splice(Number(idx), 1); renderReview(); }
  };

  // 用 on* 屬性而不是 addEventListener：renderAdd 每次重繪都會再跑一次 wire，
  // 用 addEventListener 會讓監聽器一直疊加，一張照片被讀進來好幾次。
  root.onchange = async (e) => {
    if (e.target.id === 'shotInput') {
      const files = Array.from(e.target.files || []);
      for (const f of files) {
        try { shots.push(await compressImage(f)); }
        catch { toast('這張照片讀不進來', 'error'); }
      }
      e.target.value = '';
      renderPanel();
    }
  };

  const refilter = debounce(() => {
    const box = $('#foodSearch');
    if (!box) return;
    search = box.value;
    const list = $('#foodList');
    if (list) list.innerHTML = foodListMarkup();   // 只換清單，輸入框不重建就不會失焦
  }, 180);

  root.oninput = (e) => { if (e.target.id === 'foodSearch') refilter(); };
}

// ============================================================
//  各模式面板
// ============================================================

function renderPanel() {
  const panel = $('#modePanel');
  if (!panel) return;
  panel.innerHTML =
      mode === 'frequent' ? frequentPanel()
    : mode === 'photo'    ? photoPanel()
    : mode === 'quick'    ? quickPanel()
    :                       lookupPanel();
  const box = $('#foodSearch');
  if (box) { box.value = search; }
}

function frequentPanel() {
  return `<div class="card">
    <div class="field" style="margin-bottom:12px">
      <input id="foodSearch" type="text" placeholder="搜尋食物庫…" autocomplete="off">
    </div>
    <div id="foodList">${foodListMarkup()}</div>
  </div>
  <div id="qtyBox"></div>`;
}

function foodListMarkup() {
  const list = rankedFoods(search).slice(0, 40);
  if (!list.length) {
    return `<p class="empty">食物庫裡還沒有${search ? '符合的' : ''}東西。用「拍照辨識」或「快速加入」記第一筆吧。</p>`;
  }
  return list.map(f => `
    <div class="food" data-act="useFood" data-id="${esc(f.id)}">
      <div class="grow">
        <div class="food__name">${esc(f.name)}</div>
        <div class="food__meta">
          ${unitText(f)}・${fmt(f.kcal)} kcal・蛋白 ${fmt(f.protein, 1)} g
          ${f.useCount ? `・用過 ${fmt(f.useCount)} 次` : ''}
        </div>
      </div>
      <span class="tag tag--${f.confidence || 'high'}">${esc(SOURCE_LABEL[f.source] || f.source)}</span>
    </div>`).join('');
}

function photoPanel() {
  return `<div class="card">
    <input id="shotInput" type="file" accept="image/*" capture="environment" multiple hidden>
    <div class="field">
      <label for="photoHint">食物名稱（可留空，有填會查得比較準）</label>
      <input id="photoHint" type="text" placeholder="例：舒肥雞胸 原味">
    </div>
    <div class="shots">
      ${shots.map((s, i) => `
        <div class="shot">
          <img src="${s.dataUrl}" alt="">
          <button class="shot__x" data-act="dropShot" data-idx="${i}" aria-label="移除">✕</button>
        </div>`).join('')}
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn btn--ghost grow" data-act="pick">加照片</button>
      <button class="btn btn--primary grow" data-act="analyze" ${shots.length ? '' : 'disabled'}>辨識</button>
    </div>
    <p class="small muted" style="margin:12px 0 0">
      照片會壓縮後上傳到你自己的 Google Drive，表格裡只存連結。刪紀錄時照片會一起丟進垃圾桶。
    </p>
  </div>`;
}

function quickPanel() {
  return `<div class="card">
    <div class="stack">
      <div class="field">
        <label for="qName">食物名稱</label>
        <input id="qName" type="text" placeholder="例：超商茶葉蛋">
      </div>
      <div class="field--split">
        <div class="field">
          <label for="qKcal">熱量 (kcal) ・必填</label>
          <input id="qKcal" type="number" inputmode="decimal" min="0">
        </div>
        <div class="field">
          <label for="qProtein">蛋白質 (g) ・必填</label>
          <input id="qProtein" type="number" inputmode="decimal" min="0" step="0.1">
        </div>
      </div>
      <div class="grid-3">
        ${['fat', 'carb', 'sugar', 'fiber', 'sodium'].map(k => {
          const n = NUTRIENTS.find(x => x.key === k);
          return `<div class="field">
            <label for="q_${k}">${esc(n.label)} (${n.unit})</label>
            <input id="q_${k}" type="number" inputmode="decimal" min="0" step="0.1">
          </div>`;
        }).join('')}
      </div>
      <div class="field--split">
        <div class="field">
          <label for="qQty">份數</label>
          <input id="qQty" type="number" inputmode="decimal" value="1" min="0" step="0.1">
        </div>
        <div class="field">
          <label for="qGrams">一份幾克（可留空）</label>
          <input id="qGrams" type="number" inputmode="decimal" min="0">
        </div>
      </div>
      <label class="row small">
        <input id="qStore" type="checkbox" checked style="width:auto"> 同時存進食物庫
      </label>
      <button class="btn btn--go btn--block" data-act="quickSave">記錄</button>
      <p class="small muted" style="margin:0">
        上面填的是「一份」的量，份數會依此換算。
      </p>
    </div>
  </div>`;
}

function lookupPanel() {
  return `<div class="card">
    <div class="field">
      <label for="lookupName">食物名稱</label>
      <input id="lookupName" type="text" placeholder="例：滷雞腿便當">
    </div>
    <button class="btn btn--primary btn--block" data-act="lookup" style="margin-top:12px">查詢</button>
    <p class="small muted" style="margin:12px 0 0">
      先比對食物庫，沒有才交給 Gemini 上網找。查到的數字一律標示來源，要你確認才會計入。
    </p>
  </div>`;
}

const unitText = (f) => f.baseUnit === 'gram'
  ? `每 ${fmt(f.gramsPerUnit)} 克`
  : (f.unitLabel || '每份');

// ============================================================
//  常食用：選份量
// ============================================================

function openQty(foodId) {
  const f = state.foods.find(x => x.id === foodId);
  if (!f) return;
  const canGram = !!num(f.gramsPerUnit, 0);
  $('#qtyBox').innerHTML = `<div class="card">
    <h2 class="card__title">${esc(f.name)}</h2>
    <div class="field--split">
      <div class="field">
        <label for="useQty">數量</label>
        <input id="useQty" type="number" inputmode="decimal" value="1" min="0" step="0.1">
      </div>
      <div class="field">
        <label for="useType">單位</label>
        <select id="useType">
          <option value="unit">${esc(unitText(f))}（幾份）</option>
          ${canGram ? '<option value="gram">公克</option>' : ''}
        </select>
      </div>
    </div>
    <button class="btn btn--go btn--block" data-act="logFood" data-id="${esc(f.id)}" style="margin-top:12px">記錄</button>
  </div>`;
  $('#qtyBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function logFrequent(foodId) {
  const f = state.foods.find(x => x.id === foodId);
  if (!f) return;
  const qty = num($('#useQty')?.value, 1);
  const qtyType = $('#useType')?.value || 'unit';
  const scaled = scaleFood(f, qty, qtyType);
  if (!scaled) { toast('這項食物沒有基準克數，無法用公克計算', 'error'); return; }

  await withBusy(async () => {
    await saveLog(baseLog({
      foodId: f.id, foodName: f.name, qty, qtyType,
      grams: scaled.grams, entryMode: 'frequent', status: 'confirmed', ...pickNutrients(scaled)
    }));
  });
  toast(`已記錄 ${f.name}`, 'ok');
  go('today');
}

// ============================================================
//  快速加入
// ============================================================

async function saveQuick() {
  const name = $('#qName').value.trim();
  const kcal = num($('#qKcal').value, null);
  const protein = num($('#qProtein').value, null);
  if (!name) { toast('請填食物名稱', 'error'); return; }
  if (kcal === null || protein === null) { toast('熱量與蛋白質是必填', 'error'); return; }

  const grams = num($('#qGrams').value, null);
  const perServe = {
    kcal, protein,
    fat: num($('#q_fat').value, null),
    carb: num($('#q_carb').value, null),
    sugar: num($('#q_sugar').value, null),
    fiber: num($('#q_fiber').value, null),
    sodium: num($('#q_sodium').value, null)
  };
  const qty = num($('#qQty').value, 1);

  await withBusy(async () => {
    let foodId = '';
    if ($('#qStore').checked) {
      const existing = findFood(name);
      const food = existing
        ? { ...existing, ...perServe, gramsPerUnit: grams ?? existing.gramsPerUnit }
        : makeFood({
            name, baseUnit: 'serve', unitLabel: '每份', gramsPerUnit: grams,
            ...perServe, source: 'manual', confidence: 'high',
            sourceNote: '手動輸入'
          });
      const saved = await saveFood(food);
      foodId = saved.id;
    }

    const scaled = {};
    NUTRIENTS.forEach(({ key }) => {
      scaled[key] = perServe[key] === null ? null : perServe[key] * qty;
    });

    await saveLog(baseLog({
      foodId, foodName: name, qty, qtyType: 'unit',
      grams: grams === null ? null : grams * qty,
      entryMode: 'quick', status: 'confirmed', ...scaled
    }));
  });

  toast(`已記錄 ${name}`, 'ok');
  go('today');
}

// ============================================================
//  照片辨識 / 名稱查詢
// ============================================================

async function runAnalyze() {
  const hint = $('#photoHint')?.value.trim() || '';

  // 只有名稱、食物庫已有，就不必動用 AI
  if (hint && !shots.length) return runLookup();

  await withBusy(async () => {
    toast('辨識中，第一次呼叫可能要等幾秒…');
    const result = await analyzeFood({
      images: shots.map(s => ({ base64: s.base64, mimeType: s.mimeType })),
      textHint: hint
    });

    // 照片先上傳，拿到 Drive 連結
    const uploaded = [];
    for (const s of shots) {
      try {
        const r = await uploadPhoto(s.base64, s.mimeType);
        uploaded.push({ url: r.url, fileId: r.fileId });
      } catch {
        toast('照片上傳失敗，數值仍會保留', 'error');
      }
    }

    candidates = result.items.map(item => toCandidate(item, {
      photoUrls: uploaded.map(u => u.url),
      photoFileIds: uploaded.map(u => u.fileId),
      entryMode: 'photo',
      sources: result.sources
    }));
    shots = [];
    renderPanel();
    renderReview();
  });
}

async function runLookup() {
  const name = ($('#lookupName')?.value || $('#photoHint')?.value || '').trim();
  if (!name) { toast('請先輸入食物名稱', 'error'); return; }

  const known = findFood(name);
  if (known) {
    toast('食物庫裡已經有這項，直接帶出來');
    mode = 'frequent';
    search = name;
    renderAdd();
    openQty(known.id);
    return;
  }

  await withBusy(async () => {
    toast('查詢中…');
    const result = await analyzeFood({ images: [], textHint: name });
    candidates = result.items.map(item => toCandidate(item, {
      photoUrls: [], photoFileIds: [], entryMode: 'lookup', sources: result.sources
    }));
    renderReview();
  });
}

function toCandidate(item, extra) {
  return {
    key: uid('c'),
    item,
    qty: item.estimatedQty || 1,
    qtyType: item.estimatedQtyType || 'unit',
    ...extra
  };
}

// ============================================================
//  審核面板
// ============================================================

function renderReview() {
  const panel = $('#reviewPanel');
  if (!panel) return;
  if (!candidates.length) { panel.innerHTML = ''; return; }

  panel.innerHTML = `<div class="card">
    <h2 class="card__title">確認判讀結果</h2>
    <p class="small muted" style="margin:0 0 12px">
      下面的數字還沒計入今日。核對無誤再收下，順手也會存進食物庫。
    </p>
    ${candidates.map((c, i) => candidateMarkup(c, i)).join('')}
    <div class="row" style="margin-top:14px">
      <button class="btn btn--ghost grow" data-act="commit" data-status="draft">先存待確認</button>
      <button class="btn btn--go grow" data-act="commit" data-status="confirmed">確認記錄</button>
    </div>
  </div>`;

  panel.querySelectorAll('[data-qty]').forEach(inp => {
    inp.addEventListener('input', () => {
      const c = candidates[Number(inp.dataset.qty)];
      if (c) c.qty = num(inp.value, 1);
    });
  });
  panel.querySelectorAll('[data-qtytype]').forEach(sel => {
    sel.addEventListener('change', () => {
      const c = candidates[Number(sel.dataset.qtytype)];
      if (c) c.qtyType = sel.value;
    });
  });
  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function candidateMarkup(c, i) {
  const it = c.item;
  const per = it.baseUnit === 'gram' ? `每 ${fmt(it.gramsPerUnit)} 克` : (it.unitLabel || '每份');
  const nutri = NUTRIENTS
    .filter(n => it[n.key] !== null && it[n.key] !== undefined)
    .map(n => `${n.label} ${fmt(it[n.key], 1)}${n.unit}`)
    .join('・');

  return `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
    <div class="row" style="align-items:flex-start">
      <div class="grow">
        <div class="entry__name">${esc(it.name)}</div>
        <div class="entry__meta">${esc(per)}：${esc(nutri)}</div>
      </div>
      <button class="btn btn--ghost btn--sm" data-act="dropCand" data-idx="${i}" aria-label="移除">✕</button>
    </div>
    <div class="row row--wrap" style="margin-top:8px">
      <span class="tag tag--${it.confidence}">${esc(SOURCE_LABEL[it.source] || it.source)}・信心 ${confidenceText(it.confidence)}</span>
      ${it.sourceNote ? `<span class="small muted">${esc(it.sourceNote)}</span>` : ''}
    </div>
    <div class="field--split" style="margin-top:10px">
      <input type="number" inputmode="decimal" value="${fmt(c.qty, 1)}" min="0" step="0.1" data-qty="${i}" aria-label="數量">
      <select data-qtytype="${i}" aria-label="單位">
        <option value="unit" ${c.qtyType === 'unit' ? 'selected' : ''}>${esc(per)}（幾份）</option>
        ${it.gramsPerUnit ? `<option value="gram" ${c.qtyType === 'gram' ? 'selected' : ''}>公克</option>` : ''}
      </select>
    </div>
  </div>`;
}

const confidenceText = (c) => ({ high: '高', medium: '中', low: '低' }[c] || '低');

async function commitCandidates(status) {
  if (!candidates.length) return;
  await withBusy(async () => {
    for (const c of candidates) {
      const it = c.item;
      const existing = findFood(it.name);
      const food = existing
        ? { ...existing,
            kcal: it.kcal ?? existing.kcal,
            protein: it.protein ?? existing.protein,
            fat: it.fat ?? existing.fat,
            carb: it.carb ?? existing.carb,
            sugar: it.sugar ?? existing.sugar,
            fiber: it.fiber ?? existing.fiber,
            sodium: it.sodium ?? existing.sodium,
            sourceNote: it.sourceNote || existing.sourceNote }
        : makeFood({
            name: it.name, aliases: it.aliases, category: it.category,
            baseUnit: it.baseUnit, unitLabel: it.unitLabel, gramsPerUnit: it.gramsPerUnit,
            kcal: it.kcal, protein: it.protein, fat: it.fat, carb: it.carb,
            sugar: it.sugar, fiber: it.fiber, sodium: it.sodium,
            source: it.source, sourceNote: it.sourceNote, confidence: it.confidence,
            imageUrl: c.photoUrls?.[0] || ''
          });
      const saved = await saveFood(food);

      const scaled = scaleFood(saved, c.qty, c.qtyType) || {};
      await saveLog(baseLog({
        foodId: saved.id, foodName: saved.name, qty: c.qty, qtyType: c.qtyType,
        grams: scaled.grams ?? null,
        photoUrls: c.photoUrls, photoFileIds: c.photoFileIds,
        entryMode: c.entryMode, status,
        note: c.sources?.length ? `參考來源：${c.sources.join('、')}` : '',
        ...pickNutrients(scaled)
      }));
    }
  });

  const n = candidates.length;
  candidates = [];
  renderReview();
  toast(status === 'draft' ? `${n} 筆已存進待確認` : `已記錄 ${n} 筆`, 'ok');
  if (status !== 'draft') go('today'); else refresh(true);
}

// ============================================================
//  共用
// ============================================================

function pickNutrients(src) {
  const out = {};
  NUTRIENTS.forEach(({ key }) => { out[key] = src?.[key] ?? null; });
  return out;
}

function baseLog(patch) {
  return {
    id: uid('l'),
    date: todayStr(),
    time: timeStr(),
    foodId: '', foodName: '', qty: 1, qtyType: 'unit', grams: null,
    photoUrls: [], photoFileIds: [], entryMode: 'manual', status: 'confirmed',
    note: '', createdAt: nowStamp(),
    ...patch
  };
}

async function withBusy(fn) {
  busy = true;
  $$('#screen-add button').forEach(b => { b.disabled = true; });
  try {
    await fn();
  } catch (err) {
    toast(err.message || '操作失敗', 'error');
  } finally {
    busy = false;
    $$('#screen-add button').forEach(b => { b.disabled = false; });
  }
}
