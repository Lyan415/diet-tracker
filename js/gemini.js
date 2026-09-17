/**
 * Gemini 只負責「辨識」和「查資料」，不負責決定要不要記帳。
 * 所有 AI 產出的營養素一律標記 source 與 confidence，並且先進入待確認狀態，
 * 要使用者按下確認才會計入當日攝取。這是整個 App 最容易出錯的一環，
 * 寧可多按一下也不要讓沒查證的數字混進紀錄。
 */

import { DEFAULT_GEMINI_MODEL, GEMINI_ENDPOINT } from './config.js';
import { getCredentials } from './gas.js';

const SYSTEM_RULES = `你是營養成分判讀助理，服務對象在台灣。請嚴格遵守：

1. 若圖片中有營養標示表，以標示表的數字為準，source 填 "label"。看不清楚的欄位留 null，不要猜。

2. 【最重要】營養標示的數值基準與「一份實際幾克」是兩回事，必須分開讀出來：
   - nutritionBasis：標示的數值是以什麼為基準。看到「每 100 公克」填 "per100g"；看到「每一份量」填 "perServing"。
   - servingGrams：包裝上「每一份量 ○○ 公克」那個數字。標示只寫毫升時換算不了就填 null。
   - servingsPerPack：包裝上「本包裝含 ○ 份」那個數字，沒寫填 null。
   - packGrams：整包的淨重或內容量（公克）。沒寫但 servingGrams 和 servingsPerPack 都有，就相乘得出。都沒有填 null。
   這三個數字沒讀到就填 null，**絕對不要拿 100 當預設值**，因為那會讓使用者以為吃了一份其實被算成 100 克。

3. kcal / protein / fat 等營養素數值，請一律換算成「每 100 公克」後再填。若標示是以每一份量為基準，就用 servingGrams 換算成每 100 公克（例：一份 85 克含 120 大卡，換算後 kcal 填 141）。換算後 baseUnit 一律填 "gram"、gramsPerUnit 填 100。若連 servingGrams 都沒有、無法換算，就維持原始基準：baseUnit 填 "serve"、gramsPerUnit 填 null、unitLabel 寫出原始基準文字。

4. 若只有食物名稱或只能靠外觀辨識，請用 Google 搜尋查證，優先採用衛生福利部食品藥物管理署「食品營養成分資料庫」、食品業者官方網站、或連鎖店官方營養資訊，source 填 "web"，並在 sourceNote 寫出實際採用的來源名稱。這種情況通常沒有包裝，servingGrams 填 null，但請在 estimatedGrams 填入你對照片中這份餐點的目測重量（公克），沒把握就填 null。

5. 找不到可靠來源時，source 填 "model"、confidence 填 "low"，並在 sourceNote 註明是推估值。不要假裝有來源。

6. 熱量(kcal)與蛋白質(protein)是必要欄位，盡最大努力給值。其餘欄位查不到就填 null，不要用 0 代替不知道。

7. 若照片中有多樣不同的食物，拆成多筆 items。同一樣食物的多張照片（例如品名照＋營養標示照）合併成一筆。

8. 只輸出 JSON，不要加說明文字，不要用 markdown 程式碼框。

輸出格式：
{"items":[{"name":"","aliases":[],"category":"","baseUnit":"gram","gramsPerUnit":100,"unitLabel":"","nutritionBasis":"per100g","servingGrams":null,"servingsPerPack":null,"packGrams":null,"estimatedGrams":null,"kcal":0,"protein":0,"fat":null,"carb":null,"sugar":null,"fiber":null,"sodium":null,"source":"label","sourceNote":"","confidence":"high"}],"notes":""}`;

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

async function callGemini(parts, { useSearch }) {
  const { geminiKey, geminiModel } = getCredentials();
  if (!geminiKey) throw new Error('還沒有填 Gemini API key，請到「我的 > 連線設定」補上');

  const model = geminiModel || DEFAULT_GEMINI_MODEL;
  const url = `${GEMINI_ENDPOINT}/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`;

  const payload = {
    systemInstruction: { parts: [{ text: SYSTEM_RULES }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 4096 }
  };
  if (useSearch) payload.tools = [{ google_search: {} }];

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`Gemini ${res.status}：${detail.slice(0, 300)}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

function readText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(p => p.text || '').join('').trim();
}

function readSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  return chunks
    .map(c => c.web?.title || c.web?.uri)
    .filter(Boolean)
    .slice(0, 5);
}

/**
 * @param {Object} input
 * @param {Array<{base64:string, mimeType:string}>} input.images
 * @param {string} input.textHint  使用者輸入的食物名稱（可空）
 * @returns {Promise<{items:Array, notes:string, sources:Array<string>}>}
 */
export async function analyzeFood({ images = [], textHint = '' }) {
  const parts = [];

  if (textHint && images.length) {
    parts.push({ text: `使用者輸入的食物名稱：「${textHint}」。以下是這項食物的照片，可能包含品名或營養標示。` });
  } else if (textHint) {
    parts.push({ text: `請查出這項食物的營養成分：「${textHint}」。` });
  } else {
    parts.push({ text: '請辨識照片中的食物並查出營養成分。' });
  }

  images.forEach(img => {
    parts.push({ inline_data: { mime_type: img.mimeType || 'image/jpeg', data: img.base64 } });
  });

  let data;
  try {
    data = await callGemini(parts, { useSearch: true });
  } catch (err) {
    // 有些模型版本不支援搜尋工具，退回純模型推論，並把 confidence 壓低
    if (err.status === 400) data = await callGemini(parts, { useSearch: false });
    else throw err;
  }

  const text = readText(data);
  const parsed = extractJson(text);
  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error('Gemini 回傳的內容無法解析成資料，請再試一次或改用手動輸入');
  }

  return {
    items: parsed.items.map(cleanItem).filter(i => i.name),
    notes: parsed.notes || '',
    sources: readSources(data)
  };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function cleanItem(raw) {
  const baseUnit = raw.baseUnit === 'serve' ? 'serve' : 'gram';
  const grams = numOrNull(raw.gramsPerUnit);
  const servingGrams = numOrNull(raw.servingGrams);
  const servingsPerPack = numOrNull(raw.servingsPerPack);
  let packGrams = numOrNull(raw.packGrams);

  // 標示常常只寫「每一份量 ○ 克」和「本包裝含 ○ 份」，整包重量要自己乘出來
  if (packGrams === null && servingGrams !== null && servingsPerPack !== null) {
    packGrams = Math.round(servingGrams * servingsPerPack * 10) / 10;
  }

  return {
    name: String(raw.name || '').trim(),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.filter(Boolean) : [],
    category: String(raw.category || '').trim(),
    baseUnit,
    gramsPerUnit: grams ?? (baseUnit === 'gram' ? 100 : null),
    unitLabel: String(raw.unitLabel || (baseUnit === 'gram' ? '每 100 克' : '每份')).trim(),
    nutritionBasis: raw.nutritionBasis === 'perServing' ? 'perServing' : 'per100g',
    servingGrams,
    servingsPerPack,
    packGrams,
    estimatedGrams: numOrNull(raw.estimatedGrams),
    kcal: numOrNull(raw.kcal),
    protein: numOrNull(raw.protein),
    fat: numOrNull(raw.fat),
    carb: numOrNull(raw.carb),
    sugar: numOrNull(raw.sugar),
    fiber: numOrNull(raw.fiber),
    sodium: numOrNull(raw.sodium),
    source: ['label', 'web', 'model'].includes(raw.source) ? raw.source : 'model',
    sourceNote: String(raw.sourceNote || '').trim(),
    confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'low'
  };
}

export const SOURCE_LABEL = {
  label: '營養標示',
  web: '網路查證',
  model: 'AI 推估',
  manual: '手動輸入',
  seed: '內建參考值'
};
