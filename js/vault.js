/**
 * 連線設定（GAS 網址、token、Gemini key）的保存。三種模式：
 *
 *   none    不上鎖。設定以明文存在 localStorage。
 *   pattern 連連看圖形鎖。3×3 點陣一筆畫。
 *   symbol  手把符號密碼。
 *
 * 威脅模型講清楚：真正擋住「GitHub 上看到這個公開專案的人」的，是 token 不寫在
 * 程式碼裡、必須由本人手動輸入 —— 陌生人打開網址只會看到空殼，沒有任何資料。
 * 上鎖只多防一種情況：別人拿到你已經設定好的手機。不在意那種情況就可以選 none。
 *
 * 選 none 的代價：token 以明文存在該瀏覽器，拿到手機的人讀得到。
 */

import { PBKDF2_ITERATIONS, STORAGE, LOCK_SOFT_AT, LOCK_WIPE_AT } from './config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

export const LOCK_MODES = [
  { id: 'none',    label: '不上鎖',       hint: '開啟直接進入。最省事，適合只在自己手機上用' },
  { id: 'pattern', label: '連連看圖形鎖', hint: '3×3 點陣一筆畫，一個手勢完成，不會誤觸放大' },
  { id: 'symbol',  label: '手把符號密碼', hint: '△○✕□ 加方向鍵，強度最高但要按好幾下' }
];

// ============================================================
//  模式
// ============================================================

export function getLockMode() {
  const saved = localStorage.getItem(STORAGE.lockMode);
  if (saved) return saved;
  // 舊版沒有這個設定，但存在加密金庫，就是符號密碼模式
  return localStorage.getItem(STORAGE.vault) ? 'symbol' : 'none';
}

export const needsCode = (mode = getLockMode()) => mode !== 'none';

export const hasCreds = () =>
  !!localStorage.getItem(STORAGE.vault) || !!localStorage.getItem(STORAGE.plain);

// ============================================================
//  加解密
// ============================================================

async function deriveKey(code, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** 依模式保存連線設定 */
export async function saveCreds(mode, code, payload) {
  if (mode === 'none') {
    localStorage.setItem(STORAGE.plain, JSON.stringify(payload));
    localStorage.removeItem(STORAGE.vault);
  } else {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(code, salt);
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
    localStorage.setItem(STORAGE.vault, JSON.stringify({
      v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct)
    }));
    localStorage.removeItem(STORAGE.plain);
  }
  localStorage.setItem(STORAGE.lockMode, mode);
  resetLock();
}

/** 取出連線設定。上鎖模式下解不開就 throw，呼叫端負責記錄失敗次數 */
export async function loadCreds(code) {
  const mode = getLockMode();
  if (mode === 'none') {
    const raw = localStorage.getItem(STORAGE.plain);
    if (!raw) throw new Error('NO_CREDS');
    return JSON.parse(raw);
  }
  const raw = localStorage.getItem(STORAGE.vault);
  if (!raw) throw new Error('NO_CREDS');
  const blob = JSON.parse(raw);
  const key = await deriveKey(code, fromB64(blob.salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct)
  );
  return JSON.parse(dec.decode(plain));
}

export function wipeCreds() {
  localStorage.removeItem(STORAGE.vault);
  localStorage.removeItem(STORAGE.plain);
  localStorage.removeItem(STORAGE.lockMode);
  localStorage.removeItem(STORAGE.cache);
  localStorage.removeItem(STORAGE.outbox);
}

// ============================================================
//  錯誤次數與鎖定（只有上鎖模式才會用到）
// ============================================================

export function readLock() {
  try { return JSON.parse(localStorage.getItem(STORAGE.lock)) || { fails: 0, until: 0 }; }
  catch { return { fails: 0, until: 0 }; }
}

export function resetLock() {
  localStorage.removeItem(STORAGE.lock);
}

/** 回傳 { fails, waitMs, wiped } */
export function recordFailure() {
  const lock = readLock();
  lock.fails += 1;

  if (lock.fails >= LOCK_WIPE_AT) {
    wipeCreds();
    resetLock();
    return { fails: lock.fails, waitMs: 0, wiped: true };
  }

  let waitMs = 0;
  if (lock.fails >= LOCK_SOFT_AT) {
    waitMs = Math.min(5 * 60000, 15000 * Math.pow(2, lock.fails - LOCK_SOFT_AT));
    lock.until = Date.now() + waitMs;
  }
  localStorage.setItem(STORAGE.lock, JSON.stringify(lock));
  return { fails: lock.fails, waitMs, wiped: false };
}

export function lockRemaining() {
  const lock = readLock();
  return Math.max(0, (lock.until || 0) - Date.now());
}
