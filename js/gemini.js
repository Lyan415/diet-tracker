/**
 * Gemini 分成兩個階段呼叫，對應規劃流程圖：
 *
 *   階段一 extractFromPhotos()  只「看圖說話」，不上網。
 *       讀出品名、品牌、有沒有營養標示、標示上的數字、每一份量、目測重量。
 *
 *   階段二 lookupNutrition()    才上網查。
 *       只有在「食物庫沒有 + 照片也沒有標示」時才會走到這裡。
 *
 * 中間夾著用戶端查本地食物庫，所以三種情況各走各的路：
 *   有品名＋有標示 → 先查食物庫，沒有才用標示的數字建檔
 *   只有品名       → 查食物庫，沒有才上網
 *   沒有文字       → 先辨識出食物是什麼，再照「只有品名」的路走
 *
 * 所有 AI 產出的數字都帶 source 與 confidence，且一律要使用者確認才計入。
 */

import { DEFAULT_GEMINI_MODEL, GEMINI_ENDPOINT } from './config.js';
import { getCredentials } from './gas.js';

// ============================================================
//  階段一：看圖
// ============================================================

const EXTRACT_RULES = `你是食品包裝與餐點判讀助理，服務對象在台灣。這一步**只看圖，不要上網查**，看不到的就誠實留 null。

請針對每一樣食物輸出一筆 item：

【辨識身分】
- name：食物或商品名稱。包裝食品請寫完整品名；沒有包裝的餐點就描述它是什麼（例：滷雞腿便當）。
- brand：品牌或廠商名稱，包裝上沒有就填 null。
- kind："packaged"（有包裝的商品）或 "dish"（現做餐點、散裝食物）。

【有沒有營養標示】
- hasLabel：圖中是否看得到營養標示表，true / false。
- 若 hasLabel 為 false，所有營養素欄位一律填 null，**不要用你的知識去猜**，那是下一階段的事。

【營養標示的數字】hasLabel 為 true 時才填：
- nutritionBasis："per100g"（每 100 公克／毫升）或 "perServing"（每一份量）。
- 營養素請一律換算成「每 100 公克」後再填 kcal / protein / fat / carb / sugar / fiber / sodium。
  若標示是以每一份量為基準，就用 servingGrams 換算（例：一份 85 克含 120 大卡 → kcal 填 141）。
  無法換算時維持原數值，並把 nutritionBasis 填 "perServing"。
- 個別欄位看不清楚就填 null，不要猜。

【份量】這幾格最常被忽略，請仔細找：
- servingGrams：包裝上「每一份量 ○○ 公克」的數字。只寫毫升而換算不了就填 null。
- servingsPerPack：「本包裝含 ○ 份」的數字。
- packGrams：淨重或內容量（公克）。沒寫但前兩者都有就相乘。
- estimatedGrams：kind 為 "dish" 時，目測這一份大約幾公克；沒把握填 null。
**絕對不要拿 100 當任何一格的預設值。**

【多張照片】
同一樣食物的多張照片（例如正面品名照＋背面營養標示照）要合併成同一筆 item，
品名取自品名照、營養數字取自標示照。只有真的是不同食物才拆成多筆。

只輸出 JSON，不要說明文字，不要 markdown 程式碼框：
{"items":[{"name":"","brand":null,"kind":"packaged","hasLabel":true,"nutritionBasis":"per100g","servingGrams":null,"servingsPerPack":null,"packGrams":null,"estimatedGrams":null,"kcal":null,"protein":null,"fat":null,"carb":null,"sugar":null,"fiber":null,"sodium":null,"note":""}],"notes":""}`;

// ============================================================
//  階段二：查資料
// ============================================================

const LOOKUP_RULES = `你是營養成分查詢助理，服務對象在台灣。請用 Google 搜尋查證，不要憑印象作答。

來源優先順序：
1. 衛生福利部食品藥物管理署「食品營養成分資料庫」
2. 食品製造商或連鎖餐飲業者的官方營養資訊
3. 其他可信的營養資料網站

規則：
- 營養素一律換算成「每 100 公克」，baseUnit 填 "gram"、gramsPerUnit 填 100。
- 若查到的資料只有「每份」而查不到一份幾克，則 baseUnit 填 "serve"、gramsPerUnit 填 null、unitLabel 寫出那一份是什麼（例：一個便當）。
- kcal 與 protein 是必要欄位，盡最大努力給值。其餘查不到就填 null，不要用 0 代替不知道。
- sourceNote 要寫出實際採用的來源名稱，不可空白。
- 查到可靠來源 source 填 "web"；查不到只能推估就填 "model"、confidence 填 "low"，並在 sourceNote 註明是推估值。
- servingGrams 若查得到（常見包裝規格）就填，查不到填 null，不要猜 100。

只輸出 JSON，不要說明文字，不要 markdown 程式碼框：
{"name":"","aliases":[],"category":"","baseUnit":"gram","gramsPerUnit":100,"unitLabel":"","servingGrams":null,"packGrams":null,"kcal":0,"protein":0,"fat":null,"carb":null,"sugar":null,"fiber":null,"sodium":null,"source":"web","sourceNote":"","confidence":"high"}`;

// ============================================================
//  呼叫
// ============================================================

function stripFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function extractJson(text) {
  const cleaned = stripFences(text);
  try { return JSON.parse(cleaned); } catch { /* 往下試 */ }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { /* 放棄 */ }
  }
  return null;
}

async function request(payload) {
  const { geminiKey, geminiModel } = getCredentials();
  if (!geminiKey) throw new Error('還沒有填 Gemini API key，請到「我的 → 連線設定」補上');
  const model = geminiModel || DEFAULT_GEMINI_MODEL;
  const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

/**
 * 多張照片時回應會變長，2.5 系列預設開啟的思考會吃掉輸出額度，
 * 導致 JSON 被截斷、解析失敗 —— 這正是「一次傳兩張就出錯」的主因。
 * 所以預設關閉思考並把上限拉高，被模型拒收時再逐步退回。
 */
async function callGemini(systemText, parts, { useSearch }) {
  const base = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{ role: 'user', parts }]
  };
  const tools = useSearch ? { tools: [{ google_search: {} }] } : {};
  const attempts = [
    { ...base, ...tools, generationConfig: { temperature: 0.2, maxOutputTokens: 8192, thinkingConfig: { thinkingBudget: 0 } } },
    { ...base, ...tools, generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } },
    { ...base, generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } }
  ];

  let lastErr = null;
  for (const payload of attempts) {
    try {
      const data = await request(payload);
      const cand = data?.candidates?.[0];
      if (cand?.finishReason === 'MAX_TOKENS') {
        throw new Error('Gemini 回應被截斷（照片太多或內容太長），請減少照片張數再試');
      }
      if (cand?.finishReason === 'SAFETY') {
        throw new Error('Gemini 因安全性設定拒絕回應這張圖');
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (err.status === 400) continue;     // 這個模型不支援某個參數，換下一組再試
      throw err;
    }
  }
  const hint = String(lastErr?.detail || '').slice(0, 200);
  throw new Error(`Gemini 呼叫失敗${hint ? `：${hint}` : ''}`);
}

function readText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

function readSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks.map(c => c.web?.title || c.web?.uri).filter(Boolean).slice(0, 5);
}

const numOrNull = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

// ============================================================
//  對外：階段一
// ============================================================

export async function extractFromPhotos({ images = [], textHint = '' }) {
  const parts = [];
  if (textHint) {
    parts.push({ text: `使用者輸入的食物名稱：「${textHint}」。以下照片可能是同一樣食物的品名照與營養標示照。` });
  } else {
    parts.push({ text: '請判讀以下照片。若是同一樣食物的多個角度，請合併成一筆。' });
  }
  images.forEach(img => {
    parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.base64 } });
  });

  const data = await callGemini(EXTRACT_RULES, parts, { useSearch: false });
  const text = readText(data);
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error(`照片判讀結果無法解析${text ? `（回應開頭：${text.slice(0, 80)}）` : ''}`);
  }

  const items = parsed.items.map(cleanExtract).filter(i => i.name);
  if (!items.length && textHint) {
    items.push(cleanExtract({ name: textHint, kind: 'dish', hasLabel: false }));
  }
  return { items, notes: parsed.notes || '' };
}

function cleanExtract(raw) {
  const hasLabel = raw.hasLabel === true;
  const servingGrams = numOrNull(raw.servingGrams);
  const servingsPerPack = numOrNull(raw.servingsPerPack);
  let packGrams = numOrNull(raw.packGrams);
  if (packGrams === null && servingGrams !== null && servingsPerPack !== null) {
    packGrams = Math.round(servingGrams * servingsPerPack * 10) / 10;
  }

  const nutrition = hasLabel ? {
    kcal: numOrNull(raw.kcal), protein: numOrNull(raw.protein), fat: numOrNull(raw.fat),
    carb: numOrNull(raw.carb), sugar: numOrNull(raw.sugar),
    fiber: numOrNull(raw.fiber), sodium: numOrNull(raw.sodium)
  } : { kcal: null, protein: null, fat: null, carb: null, sugar: null, fiber: null, sodium: null };

  return {
    name: String(raw.name || '').trim(),
    brand: raw.brand ? String(raw.brand).trim() : null,
    kind: raw.kind === 'dish' ? 'dish' : 'packaged',
    hasLabel,
    nutritionBasis: raw.nutritionBasis === 'perServing' ? 'perServing' : 'per100g',
    servingGrams, servingsPerPack, packGrams,
    estimatedGrams: numOrNull(raw.estimatedGrams),
    note: String(raw.note || '').trim(),
    ...nutrition
  };
}

// ============================================================
//  對外：階段二
// ============================================================

export async function lookupNutrition(name, { brand = null, hint = '' } = {}) {
  const who = [brand, name].filter(Boolean).join(' ');
  const parts = [{ text: `請查出這項食物的營養成分：「${who}」。${hint ? `補充說明：${hint}` : ''}` }];

  const data = await callGemini(LOOKUP_RULES, parts, { useSearch: true });
  const text = readText(data);
  const parsed = extractJson(text);
  if (!parsed || !parsed.name) {
    throw new Error(`查詢「${who}」的結果無法解析，請改用手動輸入`);
  }
  return { item: cleanLookup(parsed, name), sources: readSources(data) };
}

function cleanLookup(raw, fallbackName) {
  const baseUnit = raw.baseUnit === 'serve' ? 'serve' : 'gram';
  const grams = numOrNull(raw.gramsPerUnit);
  return {
    name: String(raw.name || fallbackName).trim(),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(Boolean) : [],
    category: String(raw.category || '').trim(),
    baseUnit,
    gramsPerUnit: grams ?? (baseUnit === 'gram' ? 100 : null),
    unitLabel: String(raw.unitLabel || (baseUnit === 'gram' ? '每 100 克' : '每份')).trim(),
    servingGrams: numOrNull(raw.servingGrams),
    packGrams: numOrNull(raw.packGrams),
    estimatedGrams: null,
    kcal: numOrNull(raw.kcal),
    protein: numOrNull(raw.protein),
    fat: numOrNull(raw.fat),
    carb: numOrNull(raw.carb),
    sugar: numOrNull(raw.sugar),
    fiber: numOrNull(raw.fiber),
    sodium: numOrNull(raw.sodium),
    source: ['web', 'model'].includes(raw.source) ? raw.source : 'model',
    sourceNote: String(raw.sourceNote || '').trim(),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low'
  };
}

export const SOURCE_LABEL = {
  label: '營養標示',
  web: '網路查證',
  model: 'AI 推估',
  local: '食物庫既有',
  manual: '手動輸入',
  seed: '內建參考值'
};
