/**
 * 和 Apps Script 溝通的唯一入口。
 * 所有 fetch 都必須走 endpoint() 取網址，不可以直接讀設定值 —— 瀏覽器或密碼管理員的
 * 自動填入很愛把 email 塞進 url 欄位，直接讀會打到一個不存在的網址還查不出原因。
 */

import { GAS_URL_RE } from './config.js';

let creds = { gasUrl: '', token: '', geminiKey: '', geminiModel: '' };

export function setCredentials(next) {
  creds = { ...creds, ...next };
}

export function getCredentials() {
  return { ...creds };
}

export function endpoint() {
  const url = String(creds.gasUrl || '').trim();
  if (!GAS_URL_RE.test(url)) {
    throw new Error('GAS 網址格式不正確，應為 https://script.google.com/macros/s/.../exec');
  }
  return url;
}

export function validGasUrl(url) {
  return GAS_URL_RE.test(String(url || '').trim());
}

// ---------- 讀 ----------

export async function gasGet(action, params = {}) {
  const url = new URL(endpoint());
  url.searchParams.set('action', action);
  url.searchParams.set('token', creds.token || '');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data && data.error === 'BAD_TOKEN') throw new Error('Token 不正確，請到「我的 > 連線設定」重新輸入');
  return data;
}

// ---------- 寫（逐列，redirect:'follow' 讓我們讀得到成功與否） ----------

export async function gasPost(action, body = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },   // 用 text/plain 避開 CORS 預檢
    body: JSON.stringify({ action, token: creds.token, ...body }),
    redirect: 'follow'
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data.success) throw new Error(data.error || '寫入失敗');
  return data;
}

/** 部署驗證用。不帶 token 只回版本，帶 token 才告訴你對不對。 */
export async function ping(url, token) {
  const target = new URL(String(url).trim());
  target.searchParams.set('action', 'ping');
  if (token) target.searchParams.set('token', token);
  const res = await fetch(target.toString(), { method: 'GET', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- 照片 ----------

/** 先壓縮再轉 base64。手機直出照片動輒好幾 MB，base64 還會再膨脹三成。 */
export async function compressImage(file, maxEdge = 1600, quality = 0.82) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', quality));
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return { base64: dataUrl.split(',')[1], dataUrl, mimeType: 'image/jpeg' };
}

export async function uploadPhoto(base64, mimeType = 'image/jpeg') {
  return gasPost('uploadPhoto', {
    base64,
    mimeType,
    fileName: `food_${Date.now()}_${Math.random().toString(36).slice(2, 7)}.jpg`
  });
}

export async function trashPhotos(fileIds) {
  const ids = (fileIds || []).filter(Boolean);
  if (!ids.length) return { success: true };
  return gasPost('deletePhotos', { fileIds: ids });
}
