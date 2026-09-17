/**
 * 同步模型（CRUD 版，和「只會累加」的進度型 App 完全相反）：
 *
 *   讀 = 雲端整包取代本機。不做 union merge —— union 無法表達「這筆被刪了」，
 *        A 裝置刪掉的東西會被 B 裝置的舊快取合併回來再上傳，刪除永遠不生效。
 *
 *   寫 = 逐列 upsert / delete，立刻送出。絕不把整包本機狀態覆蓋上去 ——
 *        快取若是舊的，整表覆寫會把雲端刪到只剩快取內容。
 *
 *   initialSyncDone 只在「拉取成功」時才設 true。放在 finally 裡會讓冷啟動逾時
 *        也開閘，那正是整表覆寫吃掉資料的前置條件。
 */

import { STORAGE } from './config.js';
import { gasGet, gasPost } from './gas.js';
import { nowStamp, normalizeDate, num, uid } from './util.js';

const EMPTY = { foods: [], logs: [], body: [], meta: {} };

export const state = {
  foods: [],
  logs: [],
  body: [],
  meta: {},
  initialSyncDone: false,
  syncing: false,
  lastSyncAt: null,
  lastError: null
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what = 'data') { listeners.forEach(fn => fn(what)); }

// ============================================================
//  本機快取
// ============================================================

export function loadLocal() {
  try {
    const cached = JSON.parse(localStorage.getItem(STORAGE.cache)) || EMPTY;
    state.foods = (cached.foods || []).map(normalizeFood);
    state.logs  = (cached.logs  || []).map(normalizeLog);
    state.body  = (cached.body  || []).map(normalizeBody);
    state.meta  = cached.meta || {};
  } catch {
    Object.assign(state, structuredClone(EMPTY));
  }
  emit('data');
}

function saveLocal() {
  localStorage.setItem(STORAGE.cache, JSON.stringify({
    foods: state.foods, logs: state.logs, body: state.body, meta: state.meta
  }));
}

// ============================================================
//  正規化（Sheets 存出來一律是字串，這裡轉回該有的型別）
// ============================================================

const NUM_FIELDS = ['gramsPerUnit', 'kcal', 'protein', 'fat', 'carb', 'sugar',
                    'fiber', 'sodium', 'price', 'useCount', 'qty', 'grams', 'weight', 'bodyFat'];

function normalizeNums(obj) {
  NUM_FIELDS.forEach(k => { if (k in obj) obj[k] = obj[k] === '' ? null : num(obj[k], null); });
  return obj;
}

function normalizeFood(f) {
  const o = normalizeNums({ ...f });
  o.aliases = parseList(o.aliases);
  o.useCount = num(o.useCount, 0);
  o.lastUsedAt = o.lastUsedAt || '';
  return o;
}

function normalizeLog(l) {
  const o = normalizeNums({ ...l });
  o.date = normalizeDate(o.date);
  o.photoUrls = parseList(o.photoUrls);
  o.photoFileIds = parseList(o.photoFileIds);
  o.status = o.status || 'confirmed';
  return o;
}

function normalizeBody(b) {
  const o = normalizeNums({ ...b });
  o.date = normalizeDate(o.date);
  return o;
}

function parseList(v) {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  const s = String(v).trim();
  if (s.startsWith('[')) { try { return JSON.parse(s); } catch { /* 往下 */ } }
  return s.split(/[|,，]/).map(x => x.trim()).filter(Boolean);
}

/** 送上雲端前把陣列壓成字串，Sheets 存不了陣列 */
function serialize(obj) {
  const out = { ...obj };
  Object.keys(out).forEach(k => {
    if (Array.isArray(out[k])) out[k] = JSON.stringify(out[k]);
    if (out[k] === null || out[k] === undefined) out[k] = '';
  });
  return out;
}

// ============================================================
//  雲端讀取
// ============================================================

export async function syncFromCloud({ silent = false } = {}) {
  state.syncing = true;
  state.lastError = null;
  emit('sync');
  try {
    const result = await gasGet('loadAll');
    if (!result || !result.success) throw new Error(result?.error || '讀取失敗');

    // 雲端整包取代。不合併。
    state.foods = (result.foods || []).map(normalizeFood);
    state.logs  = (result.logs  || []).map(normalizeLog);
    state.body  = (result.body  || []).map(normalizeBody);
    state.meta  = result.meta || {};
    state.initialSyncDone = true;          // ★ 只有成功才設，不要移到 finally
    state.lastSyncAt = nowStamp();
    saveLocal();
    emit('data');
    await flushOutbox();
    return true;
  } catch (err) {
    state.lastError = err.message;
    if (!silent) throw err;
    return false;
  } finally {
    state.syncing = false;
    emit('sync');
  }
}

// ============================================================
//  逐列寫入 + 失敗重送佇列
// ============================================================

function readOutbox() {
  try { return JSON.parse(localStorage.getItem(STORAGE.outbox)) || []; } catch { return []; }
}
function writeOutbox(items) {
  localStorage.setItem(STORAGE.outbox, JSON.stringify(items.slice(-200)));
}
export const outboxSize = () => readOutbox().length;

/**
 * 寫入一律立刻送出，不受 syncing 影響。
 * （用 isSyncing 當互斥鎖是經典地雷：Apps Script 冷啟動 5~10 秒，
 *   使用者開 App 後最容易操作的那段時間，寫入會被靜默丟掉。）
 */
async function push(action, body) {
  try {
    await gasPost(action, body);
    return true;
  } catch (err) {
    const box = readOutbox();
    box.push({ id: uid('ob'), action, body, at: nowStamp(), error: err.message });
    writeOutbox(box);
    state.lastError = err.message;
    emit('sync');
    return false;
  }
}

export async function flushOutbox() {
  let box = readOutbox();
  if (!box.length) return { sent: 0, failed: 0 };
  const remain = [];
  let sent = 0;
  for (const job of box) {
    try { await gasPost(job.action, job.body); sent++; }
    catch { remain.push(job); }
  }
  writeOutbox(remain);
  emit('sync');
  return { sent, failed: remain.length };
}

// ============================================================
//  食物庫
// ============================================================

export function makeFood(patch = {}) {
  return normalizeFood({
    id: uid('f'), name: '', aliases: [], category: '', baseUnit: 'gram',
    unitLabel: '100 克', gramsPerUnit: 100,
    kcal: 0, protein: 0, fat: null, carb: null, sugar: null, fiber: null, sodium: null,
    price: null, source: 'manual', sourceNote: '', confidence: 'high',
    useCount: 0, lastUsedAt: '', imageUrl: '',
    createdAt: nowStamp(), updatedAt: nowStamp(),
    ...patch
  });
}

export async function saveFood(food) {
  const item = normalizeFood({ ...food, updatedAt: nowStamp() });
  const idx = state.foods.findIndex(f => f.id === item.id);
  if (idx === -1) state.foods.push(item); else state.foods[idx] = item;
  saveLocal();
  emit('data');
  await push('upsertFood', { food: serialize(item) });
  return item;
}

/** 一次寫入多筆食物（匯入用）。仍是逐列語意，不會動到沒送出的那些列。 */
export async function saveFoodsBulk(foods) {
  const items = foods.map(f => normalizeFood({ ...f, updatedAt: nowStamp() }));
  items.forEach(item => {
    const idx = state.foods.findIndex(f => f.id === item.id);
    if (idx === -1) state.foods.push(item); else state.foods[idx] = item;
  });
  saveLocal();
  emit('data');
  await push('upsertFoods', { foods: items.map(serialize) });
  return items;
}

export async function deleteFood(id) {
  state.foods = state.foods.filter(f => f.id !== id);
  saveLocal();
  emit('data');
  await push('deleteFoods', { ids: [id] });
}

/** 依名稱或別名找已建檔的食物 */
export function findFood(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return state.foods.find(f =>
    f.name.trim().toLowerCase() === key ||
    (f.aliases || []).some(a => a.trim().toLowerCase() === key)
  ) || null;
}

/** 常吃排序：最近用過的優先，其次用得多的 */
export function rankedFoods(query = '') {
  const q = query.trim().toLowerCase();
  const list = q
    ? state.foods.filter(f =>
        f.name.toLowerCase().includes(q) ||
        (f.aliases || []).some(a => a.toLowerCase().includes(q)))
    : [...state.foods];
  return list.sort((a, b) => {
    const t = String(b.lastUsedAt || '').localeCompare(String(a.lastUsedAt || ''));
    if (t !== 0) return t;
    return num(b.useCount) - num(a.useCount);
  });
}

async function touchFood(id) {
  const f = state.foods.find(x => x.id === id);
  if (!f) return;
  f.useCount = num(f.useCount) + 1;
  f.lastUsedAt = nowStamp();
  f.updatedAt = f.lastUsedAt;
  saveLocal();
  await push('upsertFood', { food: serialize(f) });
}

// ============================================================
//  攝入紀錄
// ============================================================

export async function saveLog(log) {
  const item = normalizeLog({ ...log, updatedAt: nowStamp() });
  const idx = state.logs.findIndex(l => l.id === item.id);
  const isNew = idx === -1;
  if (isNew) state.logs.push(item); else state.logs[idx] = item;
  saveLocal();
  emit('data');
  await push('upsertLog', { log: serialize(item) });
  if (isNew && item.foodId && item.status === 'confirmed') await touchFood(item.foodId);
  return item;
}

export async function deleteLog(id, { trashPhotos: alsoTrash = true } = {}) {
  const log = state.logs.find(l => l.id === id);
  state.logs = state.logs.filter(l => l.id !== id);
  saveLocal();
  emit('data');
  await push('deleteLogs', { ids: [id] });
  // 刪掉紀錄不會自動清掉 Drive 檔案，所以這裡明確連帶丟進垃圾桶，
  // 避免每天拍照累積出大量孤兒檔。
  if (alsoTrash && log?.photoFileIds?.length) {
    await push('deletePhotos', { fileIds: log.photoFileIds });
  }
}

export function logsOn(date) {
  return state.logs.filter(l => l.date === date && l.status !== 'draft');
}

export function draftLogs() {
  return state.logs.filter(l => l.status === 'draft');
}

export function totalsOf(logs) {
  const t = { kcal: 0, protein: 0, fat: 0, carb: 0, sugar: 0, fiber: 0, sodium: 0 };
  logs.forEach(l => Object.keys(t).forEach(k => { t[k] += num(l[k]); }));
  return t;
}

// ============================================================
//  體位紀錄
// ============================================================

export async function saveBody(record) {
  const item = normalizeBody({
    id: record.id || uid('b'),
    createdAt: record.createdAt || nowStamp(),
    ...record,
    updatedAt: nowStamp()
  });
  const idx = state.body.findIndex(b => b.id === item.id);
  if (idx === -1) state.body.push(item); else state.body[idx] = item;
  saveLocal();
  emit('data');
  await push('upsertBody', { record: serialize(item) });
  return item;
}

export async function deleteBody(id) {
  state.body = state.body.filter(b => b.id !== id);
  saveLocal();
  emit('data');
  await push('deleteBody', { ids: [id] });
}

export function bodyHistory() {
  return [...state.body].sort((a, b) => a.date.localeCompare(b.date));
}

export function latestBody() {
  const h = bodyHistory();
  return h.length ? h[h.length - 1] : null;
}

// ============================================================
//  設定（Meta）
// ============================================================

export async function setMeta(key, value) {
  state.meta[key] = value;
  saveLocal();
  emit('data');
  await push('setMeta', { entries: [{ key, value }] });
}

export const getMeta = (key, fallback = null) =>
  (state.meta && key in state.meta && state.meta[key] !== null) ? state.meta[key] : fallback;
