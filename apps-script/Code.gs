/**
 * 飲控 App — Google Sheet 後端
 *
 * 部署方式：
 *   1. 新建一個 Google 試算表，工具列「擴充功能 > Apps Script」
 *   2. 把本檔全部貼進 Code.gs
 *   3. 修改下方 API_TOKEN 為你自己的隨機字串（32 字元以上）
 *   4. 部署 > 新增部署作業 > 類型「網頁應用程式」
 *      執行身分：我      有權存取的人：所有人
 *   5. 複製網址（結尾 /exec），連同 token 填進 App 的設定畫面
 *
 * ★ 改過程式碼之後，必須「部署 > 管理部署作業 > 編輯(鉛筆) > 版本：新版本 > 部署」
 *   只按儲存不會生效。用 <網址>?action=ping 確認 version 是否已更新。
 */

// ============================================================
//  設定
// ============================================================

const API_TOKEN = 'CHANGE-ME-TO-A-LONG-RANDOM-STRING';   // ← 一定要改
const SCRIPT_VERSION = 'diet-1.2.0';
const TIMEZONE = 'Asia/Taipei';
const PHOTO_FOLDER_NAME = '飲控App照片';

const SHEETS = {
  Foods: ['id', 'name', 'aliases', 'category', 'baseUnit', 'unitLabel', 'gramsPerUnit',
          'servingGrams', 'packGrams',
          'kcal', 'protein', 'fat', 'carb', 'sugar', 'fiber', 'sodium',
          'price', 'source', 'sourceNote', 'confidence', 'useCount', 'lastUsedAt',
          'imageUrl', 'createdAt', 'updatedAt'],
  Logs:  ['id', 'date', 'time', 'foodId', 'foodName', 'qty', 'qtyType', 'grams',
          'kcal', 'protein', 'fat', 'carb', 'sugar', 'fiber', 'sodium',
          'photoUrls', 'photoFileIds', 'entryMode', 'status', 'note',
          'createdAt', 'updatedAt'],
  Body:  ['id', 'date', 'weight', 'bodyFat', 'note', 'createdAt', 'updatedAt'],
  Meta:  ['key', 'value']
};

// 這些欄位一定要存成純文字，否則 Sheets 會把 "2026-09-17" 轉成 Date 物件，
// 讀回來變成 UTC ISO 字串，所有字串比較都會錯一天。
function textColsFor(headers) {
  const cols = [];
  headers.forEach(function (h, i) {
    if (/date|time|At$|aliases|^id$|^foodId$|photoFileIds/i.test(h)) cols.push(i + 1);
  });
  return cols;
}

// ============================================================
//  HTTP 入口
// ============================================================

function doGet(e) {
  const p = (e && e.parameter) || {};
  const action = p.action || 'ping';
  try {
    // ping 不帶 token 時只回版本，供部署驗證用；帶 token 則驗證正確與否。
    if (action === 'ping') {
      if (!p.token) return json({ success: true, version: SCRIPT_VERSION, authed: false });
      return json({ success: p.token === API_TOKEN, version: SCRIPT_VERSION, authed: p.token === API_TOKEN });
    }
    if (p.token !== API_TOKEN) return json({ success: false, error: 'BAD_TOKEN' });

    if (action === 'loadAll') return json(loadAll());
    return json({ success: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return json({ success: false, error: String(err && err.message || err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.token !== API_TOKEN) return json({ success: false, error: 'BAD_TOKEN' });

    switch (body.action) {
      case 'batch':        return runBatch(body.ops);
      case 'upsertFood':   return upsertRow('Foods', body.food);
      case 'upsertFoods':  return upsertMany('Foods', body.foods);
      case 'deleteFoods':  return deleteRowsByIds('Foods', body.ids);
      case 'upsertLog':    return upsertRow('Logs', body.log);
      case 'deleteLogs':   return deleteRowsByIds('Logs', body.ids);
      case 'upsertBody':   return upsertRow('Body', body.record);
      case 'deleteBody':   return deleteRowsByIds('Body', body.ids);
      case 'setMeta':      return setMeta(body.entries);
      case 'uploadPhoto':  return uploadPhoto(body);
      case 'deletePhotos': return deletePhotos(body.fileIds);
      case 'saveAll':      return saveAll(body.data);   // 僅供一次性匯入／還原
      default:             return json({ success: false, error: 'Unknown action: ' + body.action });
    }
  } catch (err) {
    return json({ success: false, error: String(err && err.message || err) });
  }
}

/**
 * 一次請求處理整批寫入。每一筆仍然是逐列 upsert / delete，
 * 不是整表覆寫，所以沒被提到的列完全不受影響。
 *
 * 會逐筆回報成敗，用戶端只把失敗的留在佇列裡，成功的不會重送造成重複。
 */
function runBatch(ops) {
  const list = ops || [];
  const results = [];
  for (let i = 0; i < list.length; i++) {
    const op = list[i] || {};
    try {
      applyWrite(op.action, op.body || {});
      results.push({ ok: true });
    } catch (err) {
      results.push({ ok: false, error: String(err && err.message || err) });
    }
  }
  const failed = results.filter(function (r) { return !r.ok; }).length;
  return json({ success: failed === 0, count: results.length, failed: failed, results: results });
}

/** 單一寫入動作的實作。doPost 和 runBatch 共用，避免兩邊行為不一致。 */
function applyWrite(action, body) {
  switch (action) {
    case 'upsertFood':   upsertRow('Foods', body.food);        return;
    case 'upsertFoods':  upsertMany('Foods', body.foods);      return;
    case 'deleteFoods':  deleteRowsByIds('Foods', body.ids);   return;
    case 'upsertLog':    upsertRow('Logs', body.log);          return;
    case 'deleteLogs':   deleteRowsByIds('Logs', body.ids);    return;
    case 'upsertBody':   upsertRow('Body', body.record);       return;
    case 'deleteBody':   deleteRowsByIds('Body', body.ids);    return;
    case 'setMeta':      setMeta(body.entries);                return;
    case 'deletePhotos': deletePhotos(body.fileIds);           return;
    default: throw new Error('Unknown action: ' + action);
  }
}

// ============================================================
//  讀取（雲端是唯一真相，整包回傳，用戶端直接取代本機快取）
// ============================================================

function loadAll() {
  return {
    success: true,
    version: SCRIPT_VERSION,
    foods: sheetToObjects('Foods'),
    logs:  sheetToObjects('Logs'),
    body:  sheetToObjects('Body'),
    meta:  readMeta(),
    serverTime: Utilities.formatDate(new Date(), TIMEZONE, "yyyy-MM-dd'T'HH:mm:ss")
  };
}

function sheetToObjects(name) {
  const sheet = getSheet(name);
  const headers = SHEETS[name];
  const col = headerIndex(sheet, headers);          // 依實際標題列定位
  const last = sheet.getLastRow();
  const width = Math.max(sheet.getLastColumn(), 1);
  if (last < 2) return [];
  const values = sheet.getRange(2, 1, last - 1, width).getValues();
  const out = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row[0] && row[0] !== 0) continue;
    const obj = {};
    for (let h = 0; h < headers.length; h++) {
      const c = col[headers[h]];
      obj[headers[h]] = c > 0 ? cellToStr(row[c - 1]) : '';
    }
    out.push(obj);
  }
  return out;
}

// 防禦：若有欄位在修正格式前就被寫成 Date，讀回來時強制轉字串
function cellToStr(val) {
  if (val === null || val === undefined) return '';
  if (Object.prototype.toString.call(val) === '[object Date]') {
    return Utilities.formatDate(val, TIMEZONE, 'yyyy-MM-dd');
  }
  return String(val);
}

function readMeta() {
  const sheet = getSheet('Meta');
  const last = sheet.getLastRow();
  const meta = {};
  if (last < 2) return meta;
  const values = sheet.getRange(2, 1, last - 1, 2).getValues();
  for (let i = 0; i < values.length; i++) {
    const key = values[i][0];
    if (!key) continue;
    try { meta[key] = values[i][1] ? JSON.parse(values[i][1]) : null; }
    catch (e) { meta[key] = cellToStr(values[i][1]); }
  }
  return meta;
}

// ============================================================
//  寫入（逐列，絕不整表覆寫）
// ============================================================

function upsertRow(sheetName, obj) {
  if (!obj || !obj.id) return json({ success: false, error: 'Missing id' });
  const headers = SHEETS[sheetName];
  const sheet = getSheet(sheetName);
  const col = headerIndex(sheet, headers);
  const width = Math.max(sheet.getLastColumn(), headers.length);

  // 依實際標題列排好一整列，沒對應到的欄位留空
  const row = new Array(width).fill('');
  headers.forEach(function (h) {
    const c = col[h];
    if (c <= 0) return;
    const v = obj[h];
    row[c - 1] = (v === null || v === undefined) ? '' : String(v);
  });

  let rowNum = findRowById(sheet, obj.id);
  if (rowNum === -1) {
    sheet.appendRow(row);
    rowNum = sheet.getLastRow();
  }
  // appendRow 可能已把日期字串轉成 Date，所以先強制該列的文字欄位格式，再重寫一次
  textColsFor(headers).forEach(function (i) {
    const c = col[headers[i - 1]];
    if (c > 0) sheet.getRange(rowNum, c).setNumberFormat('@');
  });
  sheet.getRange(rowNum, 1, 1, width).setValues([row]);

  return json({ success: true, id: obj.id, row: rowNum });
}

/**
 * 一次 upsert 多列。仍然是「逐列」語意 —— 只動送進來的那些 id，
 * 沒被提到的列完全不受影響，所以不會有整表覆寫那種誤刪風險。
 */
function upsertMany(sheetName, list) {
  if (!list || !list.length) return json({ success: true, count: 0 });
  let count = 0;
  for (let i = 0; i < list.length; i++) {
    if (!list[i] || !list[i].id) continue;
    upsertRow(sheetName, list[i]);
    count++;
  }
  return json({ success: true, count: count });
}

function deleteRowsByIds(sheetName, ids) {
  const wanted = {};
  (ids || []).forEach(function (id) { wanted[String(id)] = true; });
  if (!Object.keys(wanted).length) return json({ success: true, deleted: 0 });

  const sheet = getSheet(sheetName);
  const last = sheet.getLastRow();
  if (last < 2) return json({ success: true, deleted: 0 });

  const col = sheet.getRange(2, 1, last - 1, 1).getValues();
  let deleted = 0;
  // 由下往上刪，否則 deleteRow 會讓底下的列往上移、刪到錯的列
  for (let i = col.length - 1; i >= 0; i--) {
    if (wanted[String(col[i][0])]) { sheet.deleteRow(i + 2); deleted++; }
  }
  return json({ success: true, deleted: deleted });
}

function setMeta(entries) {
  if (!entries || !entries.length) return json({ success: true });
  const sheet = getSheet('Meta');
  for (let i = 0; i < entries.length; i++) {
    const key = String(entries[i].key);
    const val = JSON.stringify(entries[i].value === undefined ? null : entries[i].value);
    let rowNum = findRowById(sheet, key);
    if (rowNum === -1) { sheet.appendRow([key, '']); rowNum = sheet.getLastRow(); }
    sheet.getRange(rowNum, 1, 1, 2).setNumberFormat('@').setValues([[key, val]]);
  }
  return json({ success: true, count: entries.length });
}

function findRowById(sheet, id) {
  const last = sheet.getLastRow();
  if (last < 2) return -1;
  const ids = sheet.getRange(2, 1, last - 1, 1).getValues();
  const target = String(id);
  for (let i = 0; i < ids.length; i++) if (String(ids[i][0]) === target) return i + 2;
  return -1;
}

/** 一次性匯入／還原用。絕對不要接在一般編輯動作上。 */
function saveAll(data) {
  const report = {};
  ['Foods', 'Logs', 'Body'].forEach(function (name) {
    const key = name.toLowerCase();
    if (!data || !data[key]) return;
    const headers = SHEETS[name];
    const sheet = getSheet(name);
    const col = headerIndex(sheet, headers);
    const width = Math.max(sheet.getLastColumn(), headers.length);
    if (sheet.getLastRow() > 1) {
      sheet.getRange(2, 1, sheet.getLastRow() - 1, width).clearContent();
    }
    const list = data[key];
    if (!list.length) { report[key] = 0; return; }
    const rows = list.map(function (o) {
      const row = new Array(width).fill('');
      headers.forEach(function (h) {
        const c = col[h];
        if (c <= 0) return;
        row[c - 1] = (o[h] === null || o[h] === undefined) ? '' : String(o[h]);
      });
      return row;
    });
    textColsFor(headers).forEach(function (i) {
      const c = col[headers[i - 1]];
      if (c > 0) sheet.getRange(2, c, rows.length, 1).setNumberFormat('@');
    });
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
    report[key] = rows.length;
  });
  return json({ success: true, written: report });
}

// ============================================================
//  Drive 照片
// ============================================================

function uploadPhoto(body) {
  const folder = getPhotoFolder();
  const mime = body.mimeType || 'image/jpeg';
  const name = body.fileName || ('food_' + Date.now() + '.jpg');
  const blob = Utilities.newBlob(Utilities.base64Decode(body.base64), mime, name);
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const id = file.getId();
  return json({
    success: true,
    fileId: id,
    url: 'https://drive.google.com/thumbnail?id=' + id + '&sz=w1000'
  });
}

function deletePhotos(fileIds) {
  let n = 0;
  (fileIds || []).forEach(function (id) {
    if (!id) return;
    try { DriveApp.getFileById(String(id)).setTrashed(true); n++; } catch (e) { /* 已不存在 */ }
  });
  return json({ success: true, trashed: n });
}

function getPhotoFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* 重建 */ } }
  const folder = DriveApp.createFolder(PHOTO_FOLDER_NAME);
  props.setProperty('PHOTO_FOLDER_ID', folder.getId());
  return folder;
}

// ============================================================
//  工具
// ============================================================

function getSheet(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const headers = SHEETS[name];
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.getRange(1, 1, 1, headers.length).setValues([headers])
         .setFontWeight('bold').setBackground('#1b1e29').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    textColsFor(headers).forEach(function (col) {
      sheet.getRange(2, col, sheet.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  } else {
    reconcileHeaders(sheet, headers);
  }
  return sheet;
}

/**
 * 版本升級時補欄位用。
 * 只在既有標題列之後「插入」缺少的欄位，絕不刪除或重排已存在的欄位，
 * 所以舊資料不會跑掉。新欄位在舊的資料列上是空白，用戶端會當成 null。
 */
function reconcileHeaders(sheet, headers) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, width).getValues()[0]
                        .map(function (h) { return String(h).trim(); });

  const missing = [];
  for (let i = 0; i < headers.length; i++) {
    if (existing.indexOf(headers[i]) === -1) missing.push(headers[i]);
  }
  if (!missing.length) return;

  // 新欄位一律接在最後面，位置由 headerIndex() 動態查，不靠固定順序
  const start = existing.length + 1;
  if (sheet.getMaxColumns() < start + missing.length - 1) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(),
                             start + missing.length - 1 - sheet.getMaxColumns());
  }
  sheet.getRange(1, start, 1, missing.length).setValues([missing])
       .setFontWeight('bold').setBackground('#1b1e29').setFontColor('#ffffff');
}

/** 依標題名稱查欄位位置（1-based），找不到回 -1 */
function headerIndex(sheet, headers) {
  const width = Math.max(sheet.getLastColumn(), 1);
  const row = sheet.getRange(1, 1, 1, width).getValues()[0]
                   .map(function (h) { return String(h).trim(); });
  const map = {};
  headers.forEach(function (h) { map[h] = row.indexOf(h) + 1; });
  return map;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
                       .setMimeType(ContentService.MimeType.JSON);
}

/** 在編輯器裡手動執行一次，可先把四張工作表和標題列建好 */
function setupSheets() {
  Object.keys(SHEETS).forEach(getSheet);
  Logger.log('工作表已建立：' + Object.keys(SHEETS).join(', '));
}
