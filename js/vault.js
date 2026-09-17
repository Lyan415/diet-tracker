/**
 * 金庫：用符號密碼把 GAS 網址、API token、Gemini key 加密後才存進 localStorage。
 *
 * 為什麼不是「比對密碼正確就放行」：那種做法密碼只是畫面鎖，資料還是明文躺在
 * localStorage 裡。改成加密之後，密碼錯就解不出 token，App 根本連不上資料。
 *
 * 誠實說明強度：8 種符號 × 8 位 = 1,677 萬種組合（約 24 bits）。這擋得住「別人拿到
 * 你解鎖的手機隨手打開」，也擋得住線上猜（有錯誤次數上限會清掉密文），但擋不住
 * 把 localStorage 整個拷走離線暴力破解。真正保護資料的是 token 不外流。
 */

import { PBKDF2_ITERATIONS, STORAGE, LOCK_SOFT_AT, LOCK_WIPE_AT } from './config.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(passcode, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passcode), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealVault(passcode, payload) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passcode, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  const blob = { v: 1, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
  localStorage.setItem(STORAGE.vault, JSON.stringify(blob));
  resetLock();
  return blob;
}

/** 解不開就 throw，呼叫端負責記錄失敗次數 */
export async function openVault(passcode) {
  const raw = localStorage.getItem(STORAGE.vault);
  if (!raw) throw new Error('NO_VAULT');
  const blob = JSON.parse(raw);
  const key = await deriveKey(passcode, fromB64(blob.salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(blob.iv) }, key, fromB64(blob.ct)
  );
  return JSON.parse(dec.decode(plain));
}

export const hasVault = () => !!localStorage.getItem(STORAGE.vault);

export function wipeVault() {
  localStorage.removeItem(STORAGE.vault);
  localStorage.removeItem(STORAGE.cache);
  localStorage.removeItem(STORAGE.outbox);
}

// ---------- 錯誤次數與鎖定 ----------

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
    wipeVault();
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

/** 還要等幾毫秒才能再試，0 表示可以試 */
export function lockRemaining() {
  const lock = readLock();
  return Math.max(0, (lock.until || 0) - Date.now());
}
