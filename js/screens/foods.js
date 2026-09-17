import { state, makeFood, saveFood, saveFoodsBulk, deleteFood, findFood } from '../store.js';
import { proteinPrice, proteinDensity } from '../nutrition.js';
import { SOURCE_LABEL } from '../gemini.js';
import { NUTRIENTS } from '../config.js';
import { $, esc, fmt, num, toast, confirmBox, debounce } from '../util.js';

let sortKey = 'recent';
let query = '';
let editingId = null;

const SORTS = [
  { id: 'recent',  label: '最近用過' },
  { id: 'used',    label: '使用次數' },
  { id: 'protein', label: '蛋白質高' },
  { id: 'density', label: '蛋白質密度' },
  { id: 'price',   label: '蛋白質單價低' },
  { id: 'kcal',    label: '熱量低' },
  { id: 'name',    label: '名稱' }
];

export function renderFoods() {
  const root = $('#screen-foods');
  const list = sorted(filtered());

  root.innerHTML = `
    <div class="screen__head">
      <div>
        <h1 class="screen__title">食物庫</h1>
        <p class="screen__sub">${state.foods.length} 項・每單位營養成分與單價</p>
      </div>
      <div class="row">
        <button class="btn btn--ghost btn--sm" data-act="seed">匯入參考</button>
        <button class="btn btn--primary btn--sm" data-act="new">新增</button>
      </div>
    </div>

    <div class="card">
      <div class="field" style="margin-bottom:12px">
        <input id="foodFilter" type="text" placeholder="搜尋名稱或別名…" autocomplete="off" value="${esc(query)}">
      </div>
      <div class="sortbar">
        ${SORTS.map(s => `<button class="chip ${s.id === sortKey ? 'is-active' : ''}" data-sort="${s.id}">${esc(s.label)}</button>`).join('')}
      </div>
      ${list.length ? list.map(rowMarkup).join('') : '<p class="empty">還沒有任何食物。記一筆或按右上角新增。</p>'}
    </div>

    <div id="foodEditor"></div>
  `;

  if (editingId) openEditor(editingId);
  wire(root);
}

function filtered() {
  const q = query.trim().toLowerCase();
  if (!q) return [...state.foods];
  return state.foods.filter(f =>
    f.name.toLowerCase().includes(q) ||
    (f.aliases || []).some(a => a.toLowerCase().includes(q)));
}

function sorted(list) {
  const byNum = (fn, dir = -1) => (a, b) => {
    const va = fn(a), vb = fn(b);
    if (va === null && vb === null) return 0;
    if (va === null) return 1;
    if (vb === null) return -1;
    return (va - vb) * dir;
  };
  switch (sortKey) {
    case 'used':    return list.sort(byNum(f => num(f.useCount, 0)));
    case 'protein': return list.sort(byNum(f => num(f.protein, null)));
    case 'density': return list.sort(byNum(proteinDensity));
    case 'price':   return list.sort(byNum(proteinPrice, 1));
    case 'kcal':    return list.sort(byNum(f => num(f.kcal, null), 1));
    case 'name':    return list.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    default:        return list.sort((a, b) =>
                      String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || '')));
  }
}

function rowMarkup(f) {
  const pp = proteinPrice(f);
  const pd = proteinDensity(f);
  return `<div class="food" data-act="edit" data-id="${esc(f.id)}">
    <div class="grow">
      <div class="food__name">${esc(f.name)}</div>
      <div class="food__meta">
        ${f.baseUnit === 'gram' ? `每 ${fmt(f.gramsPerUnit)} 克` : esc(f.unitLabel || '每份')}
        ・${fmt(f.kcal)} kcal・蛋白 ${fmt(f.protein, 1)} g
        ${pd !== null ? `・密度 ${fmt(pd, 1)}` : ''}
        ${pp !== null ? `・蛋白 $${fmt(pp, 2)}/g` : ''}
      </div>
    </div>
    <span class="tag tag--${f.confidence || 'high'}">${esc(SOURCE_LABEL[f.source] || f.source)}</span>
  </div>`;
}

function wire(root) {
  root.onclick = async (e) => {
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { sortKey = sortBtn.dataset.sort; renderFoods(); return; }

    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;

    if (act === 'seed')   await importSeed();
    if (act === 'new')    { editingId = 'new'; renderFoods(); }
    if (act === 'edit')   { editingId = id; renderFoods(); }
    if (act === 'cancel') { editingId = null; renderFoods(); }
    if (act === 'save')   await persist();
    if (act === 'remove') {
      const f = state.foods.find(x => x.id === editingId);
      if (f && await confirmBox(`要刪掉「${f.name}」嗎？已記錄的攝入紀錄不受影響。`, '刪除')) {
        await deleteFood(f.id);
        editingId = null;
        renderFoods();
        toast('已刪除');
      }
    }
  };

  const filter = $('#foodFilter');
  if (filter) {
    filter.addEventListener('input', debounce(() => {
      query = filter.value;
      const pos = filter.selectionStart;
      renderFoods();
      const again = $('#foodFilter');
      again?.focus();
      again?.setSelectionRange(pos, pos);
    }, 200));
  }
}

// ============================================================
//  匯入內建參考食物
// ============================================================

async function importSeed() {
  try {
    const res = await fetch('data/seed-foods.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`讀不到參考檔（HTTP ${res.status}）`);
    const data = await res.json();

    const fresh = data.foods.filter(s => !findFood(s.name));
    if (!fresh.length) { toast('這些參考食物都已經在庫裡了'); return; }

    const ok = await confirmBox(
      `要匯入 ${fresh.length} 項常吃食物嗎？數值是常見參考值，信心標為「中」，之後可以用包裝標示校正。`,
      '匯入'
    );
    if (!ok) return;

    toast('匯入中…');
    await saveFoodsBulk(fresh.map(s => makeFood({
      ...s,
      aliases: s.aliases || [],
      unitLabel: s.unitLabel || (s.baseUnit === 'gram' ? `每 ${s.gramsPerUnit} 克` : '每份'),
      source: 'seed',
      confidence: 'medium',
      sourceNote: '內建常見參考值，建議以包裝標示或食藥署資料庫校正'
    })));

    renderFoods();
    toast(`已匯入 ${fresh.length} 項`, 'ok');
  } catch (err) {
    toast(err.message || '匯入失敗', 'error');
  }
}

// ============================================================
//  編輯表單
// ============================================================

function openEditor(id) {
  const f = id === 'new' ? makeFood() : state.foods.find(x => x.id === id);
  if (!f) { editingId = null; return; }

  $('#foodEditor').innerHTML = `<div class="card">
    <h2 class="card__title">${id === 'new' ? '新增食物' : '修改食物'}</h2>
    <div class="stack">
      <div class="field">
        <label for="fName">名稱</label>
        <input id="fName" type="text" value="${esc(f.name)}">
      </div>
      <div class="field">
        <label for="fAliases">別名（用逗號分隔，辨識時會一起比對）</label>
        <input id="fAliases" type="text" value="${esc((f.aliases || []).join(', '))}">
      </div>
      <div class="field--split">
        <div class="field">
          <label for="fBase">數值基準</label>
          <select id="fBase">
            <option value="gram" ${f.baseUnit === 'gram' ? 'selected' : ''}>每 N 克</option>
            <option value="serve" ${f.baseUnit === 'serve' ? 'selected' : ''}>每一份</option>
          </select>
        </div>
        <div class="field">
          <label for="fGrams">基準克數</label>
          <input id="fGrams" type="number" inputmode="decimal" min="0" value="${f.gramsPerUnit ?? ''}">
        </div>
      </div>
      <div class="field">
        <label for="fUnitLabel">單位說明（例：1 個、1 碗）</label>
        <input id="fUnitLabel" type="text" value="${esc(f.unitLabel || '')}">
      </div>
      <div class="grid-3">
        ${NUTRIENTS.map(n => `
          <div class="field">
            <label for="f_${n.key}">${esc(n.label)} (${n.unit})</label>
            <input id="f_${n.key}" type="number" inputmode="decimal" min="0" step="0.1" value="${f[n.key] ?? ''}">
          </div>`).join('')}
        <div class="field">
          <label for="fPrice">單價 (元)</label>
          <input id="fPrice" type="number" inputmode="decimal" min="0" step="0.1" value="${f.price ?? ''}">
        </div>
        <div class="field">
          <label for="fCategory">分類</label>
          <input id="fCategory" type="text" value="${esc(f.category || '')}">
        </div>
      </div>
      <div class="field">
        <label for="fSourceNote">資料來源備註</label>
        <input id="fSourceNote" type="text" value="${esc(f.sourceNote || '')}"
               placeholder="例：包裝營養標示 / 食藥署資料庫">
      </div>
      <div class="field">
        <label for="fConfidence">資料信心</label>
        <select id="fConfidence">
          ${['high', 'medium', 'low'].map(c =>
            `<option value="${c}" ${f.confidence === c ? 'selected' : ''}>${({ high: '高', medium: '中', low: '低' })[c]}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <button class="btn btn--ghost" data-act="cancel">取消</button>
        ${id === 'new' ? '' : '<button class="btn btn--danger" data-act="remove">刪除</button>'}
        <button class="btn btn--go grow" data-act="save">儲存</button>
      </div>
    </div>
  </div>`;

  $('#foodEditor').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function persist() {
  const base = editingId === 'new' ? makeFood() : state.foods.find(x => x.id === editingId);
  if (!base) return;

  const name = $('#fName').value.trim();
  if (!name) { toast('請填名稱', 'error'); return; }

  const patch = {
    ...base,
    name,
    aliases: $('#fAliases').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
    baseUnit: $('#fBase').value,
    gramsPerUnit: num($('#fGrams').value, null),
    unitLabel: $('#fUnitLabel').value.trim(),
    price: num($('#fPrice').value, null),
    category: $('#fCategory').value.trim(),
    sourceNote: $('#fSourceNote').value.trim(),
    confidence: $('#fConfidence').value
  };
  NUTRIENTS.forEach(n => { patch[n.key] = num($(`#f_${n.key}`).value, null); });
  if (editingId === 'new') patch.source = 'manual';

  await saveFood(patch);
  editingId = null;
  renderFoods();
  toast('已儲存', 'ok');
}
