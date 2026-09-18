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

const NUM_FIELDS = ['gramsPerUnit', 'servingGrams', 'packGrams',
                    'kcal', 'protein', 'fat', 'carb', 'sugar',
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
    // 順序很重要：先把本機還沒上傳的送出去，再拉雲端。
    // 反過來的話，雲端整包取代會讓還沒上傳的那幾筆從畫面上消失。
    if (readOutbox().length) await flushOutbox();

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
  localStorage.setItem(STORAGE.outbox, JSON.stringify(items.slice(-500)));
}
export const outboxSize = () => readOutbox().length;

/** 待送佇列裡最後一筆的失敗原因，排查用 */
export function outboxLastError() {
  const box = readOutbox();
  const failed = box.filter(j => j.error);
  if (!failed.length) return null;
  const last = failed[failed.length - 1];
  return { action: last.action, at: last.at, error: last.error };
}

/** 清空待送佇列。送不出去又不想留著時用，本機資料不受影響。 */
export function clearOutbox() {
  writeOutbox([]);
  emit('sync');
}

// ---------- 同步模式 ----------

export function getSyncMode() {
  return localStorage.getItem(STORAGE.syncMode) || 'auto';
}

export function setSyncMode(mode) {
  localStorage.setItem(STORAGE.syncMode, mode === 'manual' ? 'manual' : 'auto');
  emit('sync');
  if (getSyncMode() === 'auto') scheduleFlush(0);
}

// ---------- 照片保留設定 ----------

/**
 * 預設不保留照片。上傳一張壓縮後的照片要獨立打一趟 Apps Script（1~3 秒），
 * 而照片對記帳本身沒有作用 —— 營養素判讀完就已經存進紀錄了。
 */
export const getKeepPhotos = () => localStorage.getItem(STORAGE.keepPhotos) === '1';

export function setKeepPhotos(on) {
  if (on) localStorage.setItem(STORAGE.keepPhotos, '1');
  else localStorage.removeItem(STORAGE.keepPhotos);
  emit('sync');
}

/** 已經存在 Drive 的照片，回傳所有 fileId */
export function allPhotoFileIds() {
  const ids = [];
  state.logs.forEach(l => (l.photoFileIds || []).forEach(id => { if (id) ids.push(id); }));
  return ids;
}

/** 把所有紀錄的照片丟進 Drive 垃圾桶並清掉連結，營養素數據不動 */
export async function purgePhotos() {
  const ids = allPhotoFileIds();
  const touched = state.logs.filter(l => (l.photoUrls || []).length || (l.photoFileIds || []).length);
  if (!touched.length) return { logs: 0, photos: 0 };

  touched.forEach(l => { l.photoUrls = []; l.photoFileIds = []; l.updatedAt = nowStamp(); });
  saveLocal();
  emit('data');

  if (ids.length) enqueue('deletePhotos', { fileIds: ids });
  touched.forEach(l => enqueue('upsertLog', { log: serialize(l) }));
  return { logs: touched.length, photos: ids.length };
}

// ---------- 寫入：本機先落地，上傳丟背景 ----------

/**
 * 以前每個寫入都 await 一次 POST，Apps Script 一趟 1~3 秒（冷啟動更久），
 * 存一筆照片判讀要等兩趟，操作起來就很鈍。
 *
 * 現在改成：更新本機狀態並立刻回傳，寫入排進佇列，由背景合併成一次請求送出。
 * 資料安全性沒有變差 —— 佇列存在 localStorage，沒送成功不會消失；
 * 而且送出的仍然是「逐列 upsert / delete」，不是整表覆寫。
 */
function enqueue(action, body) {
  const box = readOutbox();
  box.push({ id: uid('ob'), action, body, at: nowStamp() });
  writeOutbox(box);
  emit('sync');
  if (getSyncMode() === 'auto') scheduleFlush();
}

let flushTimer = null;
let flushing = false;

/** 短暫延遲再送，讓連續幾個寫入合併成同一批 */
function scheduleFlush(delay = 800) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { flushOutbox().catch(() => {}); }, delay);
}

export const isPushing = () => flushing;

export async function flushOutbox() {
  if (flushing) return { sent: 0, failed: readOutbox().length, busy: true };
  const box = readOutbox();
  if (!box.length) return { sent: 0, failed: 0 };

  flushing = true;
  emit('sync');
  try {
    // 整批一次送出，省掉 N 趟往返
    const ops = box.map(j => ({ action: j.action, body: j.body }));
    let result;
    try {
      result = await gasPost('batch', { ops });
    } catch (err) {
      // 後端還是舊版沒有 batch，退回逐筆送
      if (/Unknown action/i.test(err.message)) return await flushOneByOne(box);
      markFailure(box, err.message);
      state.lastError = err.message;
      return { sent: 0, failed: box.length };
    }

    // 後端會回每一筆的成敗，只留下失敗的那些，成功的不會重送造成重複
    const results = Array.isArray(result.results) ? result.results : [];
    const remain = [];
    let sent = 0;
    box.forEach((job, i) => {
      const r = results[i];
      if (!r || r.ok) { sent++; return; }
      remain.push({ ...job, error: r.error || '寫入失敗' });
    });
    writeOutbox(remain);
    state.lastError = remain.length ? remain[remain.length - 1].error : null;
    return { sent, failed: remain.length };
  } finally {
    flushing = false;
    emit('sync');
  }
}

async function flushOneByOne(box) {
  const remain = [];
  let sent = 0;
  for (const job of box) {
    try { await gasPost(job.action, job.body); sent++; }
    catch (err) { remain.push({ ...job, error: err.message }); }
  }
  writeOutbox(remain);
  state.lastError = remain.length ? remain[remain.length - 1].error : null;
  return { sent, failed: remain.length };
}

function markFailure(box, message) {
  writeOutbox(box.map(j => ({ ...j, error: message })));
}

// ============================================================
//  食物庫
// ============================================================

export function makeFood(patch = {}) {
  return normalizeFood({
    id: uid('f'), name: '', aliases: [], category: '', baseUnit: 'gram',
    unitLabel: '100 克', gramsPerUnit: 100,
    servingGrams: null, packGrams: null,
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
  enqueue('upsertFood', { food: serialize(item) });
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
  enqueue('upsertFoods', { foods: items.map(serialize) });
  return items;
}

export async function deleteFood(id) {
  state.foods = state.foods.filter(f => f.id !== id);
  saveLocal();
  emit('data');
  enqueue('deleteFoods', { ids: [id] });
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
  enqueue('upsertFood', { food: serialize(f) });
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
  enqueue('upsertLog', { log: serialize(item) });
  if (isNew && item.foodId && item.status === 'confirmed') await touchFood(item.foodId);
  return item;
}

export async function deleteLog(id, { trashPhotos: alsoTrash = true } = {}) {
  const log = state.logs.find(l => l.id === id);
  state.logs = state.logs.filter(l => l.id !== id);
  saveLocal();
  emit('data');
  enqueue('deleteLogs', { ids: [id] });
  // 刪掉紀錄不會自動清掉 Drive 檔案，所以這裡明確連帶丟進垃圾桶，
  // 避免每天拍照累積出大量孤兒檔。
  if (alsoTrash && log?.photoFileIds?.length) {
    enqueue('deletePhotos', { fileIds: log.photoFileIds });
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
  enqueue('upsertBody', { record: serialize(item) });
  return item;
}

export async function deleteBody(id) {
  state.body = state.body.filter(b => b.id !== id);
  saveLocal();
  emit('data');
  enqueue('deleteBody', { ids: [id] });
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
  enqueue('setMeta', { entries: [{ key, value }] });
}

export const getMeta = (key, fallback = null) =>
  (state.meta && key in state.meta && state.meta[key] !== null) ? state.meta[key] : fallback;
