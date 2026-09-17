/**
 * 把食藥署「食品營養成分資料集」轉成本 App 的食物庫格式。
 *
 * 資料來源：政府資料開放平臺 dataset 8543（衛福部食藥署，免費、每 3 個月更新、ZIP 壓縮）
 *           https://data.gov.tw/dataset/8543
 *
 * 用法：
 *   1. 先看原始檔的欄位名稱長怎樣
 *        node tools/convert-tfnd.mjs --headers 原始檔.csv
 *   2. 依上一步的結果調整下面的 COLUMN_MAP，然後轉檔
 *        node tools/convert-tfnd.mjs 原始檔.csv > data/tfnd-foods.json
 *   3. 把產出的檔案接到食物庫的匯入功能（或直接改名蓋掉 data/seed-foods.json 的 foods 陣列）
 *
 * ★ 誠實說明：食藥署的欄位名稱在不同年度版本之間有過差異，這裡列的對應是常見寫法，
 *   不保證與你下載到的那一版完全一致。所以請務必先跑 --headers 確認再轉。
 */

import fs from 'node:fs';

// 左邊是本 App 的欄位，右邊是可能出現的原始欄位名（依序比對，取第一個找得到的）
const COLUMN_MAP = {
  name:    ['樣品名稱', '食品名稱', '俗名'],
  category:['食品分類', '類別'],
  kcal:    ['修正熱量(kcal)', '熱量(kcal)', '熱量'],
  protein: ['粗蛋白(g)', '粗蛋白', '蛋白質(g)', '蛋白質'],
  fat:     ['粗脂肪(g)', '粗脂肪', '脂肪(g)', '脂肪'],
  carb:    ['總碳水化合物(g)', '總碳水化合物', '碳水化合物(g)'],
  sugar:   ['糖質總量(g)', '糖質總量', '糖(g)'],
  fiber:   ['膳食纖維(g)', '膳食纖維'],
  sodium:  ['鈉(mg)', '鈉']
};

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const args = process.argv.slice(2);
const headersOnly = args.includes('--headers');
const file = args.find(a => !a.startsWith('--'));

if (!file) {
  console.error('請指定 CSV 檔：node tools/convert-tfnd.mjs 原始檔.csv');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const headers = rows[0].map(h => h.trim());

if (headersOnly) {
  console.error(`共 ${headers.length} 欄：`);
  headers.forEach((h, i) => console.error(`  [${i}] ${h}`));
  process.exit(0);
}

const index = {};
const missing = [];
for (const [key, candidates] of Object.entries(COLUMN_MAP)) {
  const hit = candidates.map(c => headers.indexOf(c)).find(i => i !== -1);
  if (hit === undefined) missing.push(`${key}（找過：${candidates.join('、')}）`);
  else index[key] = hit;
}
if (missing.length) {
  console.error('以下欄位對不上，請先跑 --headers 再調整 COLUMN_MAP：\n  ' + missing.join('\n  '));
  process.exit(1);
}

const numOrNull = (v) => {
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const seen = new Set();
const foods = [];
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  const name = (row[index.name] || '').trim();
  if (!name || seen.has(name)) continue;
  const kcal = numOrNull(row[index.kcal]);
  const protein = numOrNull(row[index.protein]);
  if (kcal === null && protein === null) continue;
  seen.add(name);

  foods.push({
    name,
    category: (row[index.category] || '').trim(),
    baseUnit: 'gram',
    gramsPerUnit: 100,
    unitLabel: '每 100 克',
    kcal, protein,
    fat: numOrNull(row[index.fat]),
    carb: numOrNull(row[index.carb]),
    sugar: numOrNull(row[index.sugar]),
    fiber: numOrNull(row[index.fiber]),
    sodium: numOrNull(row[index.sodium])
  });
}

console.error(`轉出 ${foods.length} 筆`);
console.log(JSON.stringify({
  note: '轉自衛福部食藥署食品營養成分資料集（data.gov.tw dataset 8543），數值為每 100 公克可食部分。',
  unit: '每 100 公克',
  foods
}, null, 1));
