import { state, rankedFoods, findFood, makeFood, saveFood, saveLog } from '../store.js';
import { portionOptions, portionGrams, scaleByPortion, portionReady } from '../nutrition.js';
import { extractFromPhotos, lookupNutrition, SOURCE_LABEL } from '../gemini.js';
import { compressImage, uploadPhoto } from '../gas.js';
import { $, $$, esc, fmt, num, uid, todayStr, timeStr, nowStamp, toast, debounce } from '../util.js';
import { NUTRIENTS } from '../config.js';
import { go, refresh } from '../app.js';

let mode = 'frequent';
let shots = [];        // { dataUrl, base64, mimeType }
let candidates = [];   // 判讀後待審核的項目
let busy = false;
let search = '';

const MODES = [
  { id: 'frequent', name: '常食用食物', hint: '從已建檔的食物挑，依最近用過與使用次數排序' },
  { id: 'photo',    name: '拍照辨識',   hint: '可拍照或從相簿選，一次多張會合併判讀' },
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

    if (act === 'camera')    $('#shotCamera').click();
    if (act === 'library')   $('#shotLibrary').click();
    if (act === 'dropShot')  { shots.splice(Number(idx), 1); renderPanel(); }
    if (act === 'analyze')   await runAnalyze();
    if (act === 'lookup')    await runLookup();
    if (act === 'quickSave') await saveQuick();
    if (act === 'useFood')   openQty(id);
    if (act === 'logFood')   await logFrequent(id);
    if (act === 'commit')    await commitCandidates(btn.dataset.status);
    if (act === 'dropCand')  { candidates.splice(Number(idx), 1); renderReview(); }
  };

  // 用 on* 屬性而不是 addEventListener：renderAdd 每次重繪都會再跑一次 wire，
  // 用 addEventListener 會讓監聽器一直疊加，一張照片被讀進來好幾次。
  root.onchange = async (e) => {
    if (e.target.id !== 'shotCamera' && e.target.id !== 'shotLibrary') return;
    const files = Array.from(e.target.files || []);
    for (const f of files) {
      try { shots.push(await compressImage(f)); }
      catch { toast('這張照片讀不進來', 'error'); }
    }
    e.target.value = '';
    renderPanel();
  };
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
  if (mode === 'frequent') wireSearchBox();
}

function frequentPanel() {
  return `<div class="card">
    <div class="field" style="margin-bottom:12px">
      <input id="foodSearch" type="text" placeholder="搜尋食物庫…" autocomplete="off" value="${esc(search)}">
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
          ${unitText(f)}${f.servingGrams ? `・一份 ${fmt(f.servingGrams)} 克` : ''}
          ・${fmt(f.kcal)} kcal・蛋白 ${fmt(f.protein, 1)} g
          ${f.useCount ? `・用過 ${fmt(f.useCount)} 次` : ''}
        </div>
      </div>
      <span class="tag tag--${f.confidence || 'high'}">${esc(SOURCE_LABEL[f.source] || f.source)}</span>
    </div>`).join('');
}

/**
 * 中文輸入法在組字期間會連續觸發 input 事件。
 * 如果這時候就重繪清單，注音還沒選字就被打斷，看起來就像「只能打一個字」。
 * 所以組字中完全不動，等 compositionend 才篩選；而且只換清單不動輸入框本身。
 */
function wireSearchBox() {
  const box = $('#foodSearch');
  if (!box) return;
  let composing = false;

  const apply = () => {
    search = box.value;
    const list = $('#foodList');
    if (list) list.innerHTML = foodListMarkup();
  };
  const applySoon = debounce(apply, 200);

  box.addEventListener('compositionstart', () => { composing = true; });
  box.addEventListener('compositionend', () => { composing = false; apply(); });
  box.addEventListener('input', () => { if (!composing) applySoon(); });
}

function photoPanel() {
  return `<div class="card">
    <input id="shotCamera" type="file" accept="image/*" capture="environment" multiple hidden>
    <input id="shotLibrary" type="file" accept="image/*" multiple hidden>
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
    <div class="row row--wrap" style="margin-top:14px">
      <button class="btn btn--ghost grow" data-act="camera">拍照</button>
      <button class="btn btn--ghost grow" data-act="library">從相簿選</button>
    </div>
    <button class="btn btn--primary btn--block" data-act="analyze" ${shots.length ? '' : 'disabled'}
            style="margin-top:10px">判讀${shots.length ? `（${shots.length} 張）` : ''}</button>
    <p class="small muted" style="margin:12px 0 0">
      同一樣食物的品名照與營養標示照請一起選，會合併成一筆。判讀順序是：先比對食物庫 →
      再讀營養標示 → 都沒有才上網查。照片會壓縮後存進你自己的 Google Drive。
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
      <p class="small muted" style="margin:0">上面填的是「一份」的量，份數會依此換算。</p>
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
  const opts = portionOptions(f);
  const def = opts[0];

  $('#qtyBox').innerHTML = `<div class="card">
    <h2 class="card__title">${esc(f.name)}</h2>
    <div class="field--split">
      <input id="useQty" type="number" inputmode="decimal" value="${def.grams === null && def.kind === 'grams' ? '' : 1}"
             min="0" step="0.1" aria-label="數量"
             placeholder="${def.kind === 'grams' && !def.grams ? '公克' : '數量'}">
      <select id="usePortion" aria-label="份量單位">
        ${opts.map(o => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <p class="small muted" id="usePreview" style="margin:8px 0 0"></p>
    <button class="btn btn--go btn--block" data-act="logFood" data-id="${esc(f.id)}" style="margin-top:12px">記錄</button>
  </div>`;

  const preview = () => {
    const pid = $('#usePortion').value;
    const qty = $('#useQty').value;
    $('#usePreview').textContent = previewText(f, pid, qty);
  };
  $('#useQty').addEventListener('input', preview);
  $('#usePortion').addEventListener('change', () => {
    const opt = opts.find(o => o.id === $('#usePortion').value);
    const needsGrams = opt?.kind === 'grams' && !opt.grams;
    $('#useQty').value = needsGrams ? '' : 1;
    $('#useQty').placeholder = needsGrams ? '公克' : '數量';
    preview();
  });
  preview();

  $('#qtyBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function previewText(food, portion, qty) {
  const scaled = scaleByPortion(food, portion, qty);
  if (!scaled) return '請填入數量或重量';
  const grams = portionGrams(food, portion, qty);
  const head = grams === null ? '' : `實際 ${fmt(grams, 1)} 克 → `;
  return `${head}${fmt(scaled.kcal, 0)} kcal・蛋白 ${fmt(scaled.protein, 1)} g`;
}

async function logFrequent(foodId) {
  const f = state.foods.find(x => x.id === foodId);
  if (!f) return;
  const portion = $('#usePortion')?.value;
  const qty = $('#useQty')?.value;
  const scaled = scaleByPortion(f, portion, qty);
  if (!scaled) { toast('請先填入數量或重量', 'error'); return; }

  const grams = portionGrams(f, portion, qty);
  const opt = portionOptions(f).find(o => o.id === portion);

  await withBusy(async () => {
    await saveLog(baseLog({
      foodId: f.id, foodName: f.name,
      ...logQuantity(grams, qty, opt),
      entryMode: 'frequent', status: 'confirmed',
      note: opt ? `${fmt(num(qty, 1), 1)} × ${opt.label}` : '',
      ...pickNutrients(scaled)
    }));
  });
  toast(`已記錄 ${f.name}`, 'ok');
  go('today');
}

/** 知道克數就記克數，不知道就記份數，兩者都不含糊 */
function logQuantity(grams, qty, opt) {
  if (grams !== null) return { qty: grams, qtyType: 'gram', grams };
  return { qty: num(qty, 1), qtyType: 'unit', grams: null };
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
        ? { ...existing, ...perServe, gramsPerUnit: grams ?? existing.gramsPerUnit,
            servingGrams: grams ?? existing.servingGrams }
        : makeFood({
            name, baseUnit: 'serve',
            unitLabel: grams ? `1 份（${grams} 克）` : '1 份',
            gramsPerUnit: grams, servingGrams: grams,
            ...perServe, source: 'manual', confidence: 'high', sourceNote: '手動輸入'
          });
      const saved = await saveFood(food);
      foodId = saved.id;
    }

    const scaled = {};
    NUTRIENTS.forEach(({ key }) => {
      scaled[key] = perServe[key] === null ? null : perServe[key] * qty;
    });

    await saveLog(baseLog({
      foodId, foodName: name,
      ...(grams === null
        ? { qty, qtyType: 'unit', grams: null }
        : { qty: grams * qty, qtyType: 'gram', grams: grams * qty }),
      entryMode: 'quick', status: 'confirmed',
      note: `${fmt(qty, 1)} 份`,
      ...scaled
    }));
  });

  toast(`已記錄 ${name}`, 'ok');
  go('today');
}

// ============================================================
//  照片判讀：依流程圖決定資料來源
// ============================================================

async function runAnalyze() {
  const hint = $('#photoHint')?.value.trim() || '';
  if (!shots.length) return runLookup();

  await withBusy(async () => {
    toast('判讀照片中…');
    const { items: extracted } = await extractFromPhotos({
      images: shots.map(s => ({ base64: s.base64, mimeType: s.mimeType })),
      textHint: hint
    });
    if (!extracted.length) throw new Error('照片裡沒有判讀出食物，請補上食物名稱再試');

    // 照片先上傳，拿到 Drive 連結
    const uploaded = [];
    for (const s of shots) {
      try { uploaded.push(await uploadPhoto(s.base64, s.mimeType)); }
      catch { toast('照片上傳失敗，數值仍會保留', 'error'); }
    }

    const built = [];
    for (const ex of extracted) built.push(await resolveItem(ex));

    candidates = built.map(b => toCandidate(b.item, {
      photoUrls: uploaded.map(u => u.url),
      photoFileIds: uploaded.map(u => u.fileId),
      entryMode: 'photo',
      sources: b.sources,
      route: b.route
    }));
    shots = [];
    renderPanel();
    renderReview();
  });
}

/**
 * 流程圖的三條路，順序不能顛倒：
 *   1. 食物庫已建檔  → 直接沿用（那是你校正過的，比任何判讀都可信）
 *   2. 照片有營養標示 → 用標示上的數字，並建檔
 *   3. 以上皆無      → 才上網查，查到的也一併建檔
 */
async function resolveItem(ex) {
  const local = findFood(ex.name)
             || (ex.brand ? findFood(`${ex.brand} ${ex.name}`) : null);

  if (local) {
    return {
      route: '食物庫既有', sources: [],
      item: {
        ...foodToItem(local),
        servingGrams: local.servingGrams ?? ex.servingGrams,
        packGrams: local.packGrams ?? ex.packGrams,
        estimatedGrams: ex.estimatedGrams,
        source: 'local',
        sourceNote: local.sourceNote || '沿用食物庫既有資料',
        confidence: local.confidence || 'high'
      }
    };
  }

  if (ex.hasLabel && (ex.kcal !== null || ex.protein !== null)) {
    const perServing = ex.nutritionBasis === 'perServing';
    return {
      route: '營養標示', sources: [],
      item: {
        name: fullName(ex), aliases: ex.brand ? [ex.name] : [], category: '',
        baseUnit: perServing ? 'serve' : 'gram',
        gramsPerUnit: perServing ? (ex.servingGrams ?? null) : 100,
        unitLabel: perServing ? '1 份' : '每 100 克',
        servingGrams: ex.servingGrams, packGrams: ex.packGrams,
        estimatedGrams: ex.estimatedGrams,
        kcal: ex.kcal, protein: ex.protein, fat: ex.fat, carb: ex.carb,
        sugar: ex.sugar, fiber: ex.fiber, sodium: ex.sodium,
        source: 'label', sourceNote: '取自包裝營養標示', confidence: 'high'
      }
    };
  }

  toast(`上網查「${ex.name}」…`);
  const { item, sources } = await lookupNutrition(ex.name, { brand: ex.brand, hint: ex.note });
  return {
    route: '網路查證', sources,
    item: {
      ...item,
      name: fullName(ex) || item.name,
      servingGrams: item.servingGrams ?? ex.servingGrams,
      packGrams: item.packGrams ?? ex.packGrams,
      estimatedGrams: ex.estimatedGrams
    }
  };
}

const fullName = (ex) => [ex.brand, ex.name].filter(Boolean).join(' ').trim();

function foodToItem(f) {
  const item = {
    name: f.name, aliases: f.aliases || [], category: f.category || '',
    baseUnit: f.baseUnit, gramsPerUnit: f.gramsPerUnit, unitLabel: f.unitLabel,
    servingGrams: f.servingGrams, packGrams: f.packGrams, estimatedGrams: null,
    source: f.source, sourceNote: f.sourceNote, confidence: f.confidence,
    existingId: f.id
  };
  NUTRIENTS.forEach(({ key }) => { item[key] = f[key] ?? null; });
  return item;
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
    toast('上網查詢中…');
    const { item, sources } = await lookupNutrition(name);
    candidates = [toCandidate(item, {
      photoUrls: [], photoFileIds: [], entryMode: 'lookup', sources, route: '網路查證'
    })];
    renderReview();
  });
}

// ============================================================
//  審核面板
// ============================================================

/** 把判讀結果攤成食物庫的形狀，好共用份量換算 */
function candidateFood(item) {
  return {
    baseUnit: item.baseUnit,
    gramsPerUnit: item.gramsPerUnit,
    servingGrams: item.servingGrams,
    packGrams: item.packGrams,
    unitLabel: item.unitLabel,
    ...pickNutrients(item)
  };
}

function toCandidate(item, extra) {
  // 預設份量的挑選順序：標示上的一份 → 整包 → 目測重量 → 以份為單位 → 留白要使用者填。
  // 絕不預設成「1 × 每 100 克」，那正是先前記錄失真的原因。
  const opts = portionOptions(candidateFood(item));
  const has = (id) => opts.some(o => o.id === id);
  let portion, qty;

  if (item.servingGrams && has('serving'))        { portion = 'serving'; qty = 1; }
  else if (item.packGrams && has('pack'))         { portion = 'pack';    qty = 1; }
  else if (item.estimatedGrams && has('gram'))    { portion = 'gram';    qty = item.estimatedGrams; }
  else if (has('serve'))                          { portion = 'serve';   qty = 1; }
  else                                            { portion = has('gram') ? 'gram' : opts[0].id; qty = null; }

  return { key: uid('c'), item, portion, qty, ...extra };
}

function renderReview() {
  const panel = $('#reviewPanel');
  if (!panel) return;
  if (!candidates.length) { panel.innerHTML = ''; return; }

  const incomplete = candidates.filter(c => !portionReady(candidateFood(c.item), c.portion, c.qty));

  panel.innerHTML = `<div class="card">
    <h2 class="card__title">確認判讀結果</h2>
    <p class="small muted" style="margin:0 0 12px">
      下面的數字還沒計入今日。核對無誤再收下，順手也會存進食物庫。
    </p>
    ${candidates.map((c, i) => candidateMarkup(c, i)).join('')}
    ${incomplete.length ? `<p class="small" style="margin:12px 0 0;color:var(--ps-circle)">
      有 ${incomplete.length} 筆還沒填數量或重量，補上才能記錄。
    </p>` : ''}
    <div class="row" style="margin-top:14px">
      <button class="btn btn--ghost grow" data-act="commit" data-status="draft"
              ${incomplete.length ? 'disabled' : ''}>先存待確認</button>
      <button class="btn btn--go grow" data-act="commit" data-status="confirmed"
              ${incomplete.length ? 'disabled' : ''}>確認記錄</button>
    </div>
  </div>`;

  panel.querySelectorAll('[data-qty]').forEach(inp => {
    inp.addEventListener('input', () => {
      const c = candidates[Number(inp.dataset.qty)];
      if (!c) return;
      c.qty = inp.value === '' ? null : num(inp.value, null);
      const line = panel.querySelector(`[data-preview="${inp.dataset.qty}"]`);
      if (line) line.textContent = previewText(candidateFood(c.item), c.portion, c.qty);
      syncCommitButtons(panel);
    });
  });

  panel.querySelectorAll('[data-portion]').forEach(sel => {
    sel.addEventListener('change', () => {
      const c = candidates[Number(sel.dataset.portion)];
      if (!c) return;
      c.portion = sel.value;
      const opt = portionOptions(candidateFood(c.item)).find(o => o.id === c.portion);
      c.qty = (opt?.kind === 'grams' && !opt.grams) ? null : 1;
      renderReview();
    });
  });

  panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/** 改數量時不要整塊重繪，否則數字鍵盤會被關掉 */
function syncCommitButtons(panel) {
  const blocked = candidates.some(c => !portionReady(candidateFood(c.item), c.portion, c.qty));
  panel.querySelectorAll('[data-act="commit"]').forEach(b => { b.disabled = blocked; });
}

function candidateMarkup(c, i) {
  const it = c.item;
  const food = candidateFood(it);
  const opts = portionOptions(food);
  const opt = opts.find(o => o.id === c.portion);
  const needsGrams = opt?.kind === 'grams' && !opt.grams;

  const per = it.baseUnit === 'gram' ? `每 ${fmt(it.gramsPerUnit)} 克` : (it.unitLabel || '每份');
  const nutri = NUTRIENTS
    .filter(n => it[n.key] !== null && it[n.key] !== undefined)
    .map(n => `${n.label} ${fmt(it[n.key], 1)}${n.unit}`)
    .join('・');

  const noPortionInfo = !it.servingGrams && !it.packGrams && it.baseUnit === 'gram';

  return `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
    <div class="row" style="align-items:flex-start">
      <div class="grow">
        <div class="entry__name">${esc(it.name)}</div>
        <div class="entry__meta">${esc(per)}：${esc(nutri || '沒有讀到營養素')}</div>
      </div>
      <button class="btn btn--ghost btn--sm" data-act="dropCand" data-idx="${i}" aria-label="移除">✕</button>
    </div>

    <div class="row row--wrap" style="margin-top:8px">
      ${c.route ? `<span class="tag tag--draft">${esc(c.route)}</span>` : ''}
      <span class="tag tag--${it.confidence}">${esc(SOURCE_LABEL[it.source] || it.source)}・信心 ${confidenceText(it.confidence)}</span>
      ${it.servingGrams ? `<span class="tag">標示一份 ${fmt(it.servingGrams)} 克</span>` : ''}
      ${it.packGrams ? `<span class="tag">整包 ${fmt(it.packGrams)} 克</span>` : ''}
      ${it.sourceNote ? `<span class="small muted">${esc(it.sourceNote)}</span>` : ''}
    </div>

    ${noPortionInfo ? `<p class="small" style="margin:8px 0 0;color:var(--ps-circle)">
      沒讀到「每一份量幾公克」，無法自動換算份數。請直接填你實際吃的重量。
    </p>` : ''}

    <div class="field--split" style="margin-top:10px">
      <input type="number" inputmode="decimal" value="${c.qty === null ? '' : fmt(c.qty, 1)}"
             min="0" step="0.1" data-qty="${i}" aria-label="數量"
             placeholder="${needsGrams ? '公克' : '數量'}">
      <select data-portion="${i}" aria-label="份量單位">
        ${opts.map(o => `<option value="${o.id}" ${c.portion === o.id ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>

    <p class="small muted" style="margin:6px 0 0" data-preview="${i}">${esc(previewText(food, c.portion, c.qty))}</p>
  </div>`;
}

const confidenceText = (c) => ({ high: '高', medium: '中', low: '低' }[c] || '低');

async function commitCandidates(status) {
  if (!candidates.length) return;
  await withBusy(async () => {
    for (const c of candidates) {
      const it = c.item;
      const existing = it.existingId
        ? state.foods.find(f => f.id === it.existingId)
        : findFood(it.name);

      const food = existing
        ? { ...existing,
            kcal: it.kcal ?? existing.kcal,
            protein: it.protein ?? existing.protein,
            fat: it.fat ?? existing.fat,
            carb: it.carb ?? existing.carb,
            sugar: it.sugar ?? existing.sugar,
            fiber: it.fiber ?? existing.fiber,
            sodium: it.sodium ?? existing.sodium,
            // 份量只補不蓋：既有的值通常是使用者親手校正過的
            servingGrams: existing.servingGrams ?? it.servingGrams,
            packGrams: existing.packGrams ?? it.packGrams,
            sourceNote: existing.sourceNote || it.sourceNote }
        : makeFood({
            name: it.name, aliases: it.aliases, category: it.category,
            baseUnit: it.baseUnit, unitLabel: it.unitLabel, gramsPerUnit: it.gramsPerUnit,
            servingGrams: it.servingGrams, packGrams: it.packGrams,
            kcal: it.kcal, protein: it.protein, fat: it.fat, carb: it.carb,
            sugar: it.sugar, fiber: it.fiber, sodium: it.sodium,
            source: it.source === 'local' ? 'manual' : it.source,
            sourceNote: it.sourceNote, confidence: it.confidence,
            imageUrl: c.photoUrls?.[0] || ''
          });
      const saved = await saveFood(food);

      const grams = portionGrams(saved, c.portion, c.qty);
      const scaled = scaleByPortion(saved, c.portion, c.qty) || {};
      const opt = portionOptions(saved).find(o => o.id === c.portion);

      await saveLog(baseLog({
        foodId: saved.id, foodName: saved.name,
        ...logQuantity(grams, c.qty, opt),
        photoUrls: c.photoUrls, photoFileIds: c.photoFileIds,
        entryMode: c.entryMode, status,
        note: [
          opt ? `${fmt(num(c.qty, 1), 1)} × ${opt.label}` : '',
          c.route ? `來源：${c.route}` : '',
          c.sources?.length ? `參考：${c.sources.join('、')}` : ''
        ].filter(Boolean).join('｜'),
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
    renderReview();
  }
}
