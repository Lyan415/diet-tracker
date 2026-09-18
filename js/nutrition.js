/**
 * 計算依據
 *   BMR：有體脂率時用 Katch-McArdle（370 + 21.6 × 去脂體重 kg），因為它直接吃
 *        身體組成，比只看身高體重的公式準；沒有體脂率時退回 Mifflin-St Jeor。
 *   TDEE：BMR × 活動係數（係數見 config.js 的 ACTIVITY_LEVELS）。
 *   蛋白質：2 g / kg 去脂體重。沒有體脂率時只能用體重估，UI 會標示為估值。
 *
 * 熱量目標會依「目標體重 vs 目前體重」給赤字或盈餘，並夾在 BMR 與 TDEE×1.2 之間，
 * 避免建議值往極端跑。使用者隨時可以改成手動值。
 */

import { ACTIVITY_LEVELS, NUTRIENTS } from './config.js';
import { num, round } from './util.js';

export function ageFrom(birth) {
  if (!birth) return null;
  const [y, m] = String(birth).split('-').map(Number);
  if (!y) return null;
  const now = new Date();
  let age = now.getFullYear() - y;
  if (m && (now.getMonth() + 1) < m) age -= 1;
  return age;
}

export function leanMass(weight, bodyFatPct) {
  const w = num(weight, 0);
  const bf = num(bodyFatPct, null);
  if (!w) return null;
  if (bf === null || bf <= 0 || bf >= 70) return null;
  return round(w * (1 - bf / 100), 1);
}

export function activityFactor(id) {
  const found = ACTIVITY_LEVELS.find(a => a.id === id);
  return found ? found.factor : 1.375;
}

/**
 * @returns {{bmr:number, tdee:number, lbm:number|null, method:string, estimated:boolean}|null}
 */
export function energy(profile, latest) {
  const weight = num(latest?.weight, null);
  const height = num(profile?.height, null);
  const age = ageFrom(profile?.birth);
  if (!weight || !height || age === null) return null;

  const lbm = leanMass(weight, latest?.bodyFat);
  let bmr, method, estimated;

  if (lbm) {
    bmr = 370 + 21.6 * lbm;
    method = 'Katch-McArdle（使用去脂體重）';
    estimated = false;
  } else {
    bmr = 10 * weight + 6.25 * height - 5 * age + (profile.sex === 'female' ? -161 : 5);
    method = 'Mifflin-St Jeor（未填體脂率）';
    estimated = true;
  }

  const tdee = bmr * activityFactor(profile?.activity);
  return { bmr: round(bmr), tdee: round(tdee), lbm, method, estimated };
}

export function suggestedTargets(profile, latest) {
  const e = energy(profile, latest);
  if (!e) return null;

  const weight = num(latest?.weight, 0);
  const goal = num(profile?.targetWeight, weight);
  const diff = goal - weight;

  // 每公斤體脂約 7,700 kcal；抓每天 400 kcal 的缺口，約等於每週 0.36 kg。
  let delta = 0;
  if (diff < -0.5) delta = -400;
  else if (diff > 0.5) delta = 300;

  let kcal = e.tdee + delta;
  kcal = Math.max(e.bmr, Math.min(kcal, e.tdee * 1.2));   // 不建議低於基礎代謝

  // 有去脂體重就照 2 g/kg 去脂體重。沒有體脂率時直接乘體重會高估，
  // 改用 1.6 g/kg 體重推估 —— 以一般體脂率換算下來兩者結果相當接近。
  const protein = e.lbm ? round(e.lbm * 2) : round(weight * 1.6);

  return {
    kcal: round(kcal, -1),
    protein,
    bmr: e.bmr,
    tdee: e.tdee,
    lbm: e.lbm,
    method: e.method,
    proteinEstimated: !e.lbm,
    delta
  };
}

/** 目前生效的每日目標：手動優先，否則用建議值 */
export function effectiveTargets(meta, profile, latest) {
  const manual = meta?.dailyTarget;
  if (manual && manual.mode === 'manual') {
    return { kcal: num(manual.kcal, 0), protein: num(manual.protein, 0), mode: 'manual' };
  }
  const s = suggestedTargets(profile, latest);
  if (!s) return null;
  return { kcal: s.kcal, protein: s.protein, mode: 'auto' };
}

// ============================================================
//  份量換算
// ============================================================

/**
 * 食物庫存的是「每一個基準單位」的營養素。
 *   baseUnit = 'gram'  → 數值是每 gramsPerUnit 克（通常填 100）
 *   baseUnit = 'serve' → 數值是每一份，gramsPerUnit 是一份幾克（可留空）
 *
 * @param qtyType 'unit'（幾份／幾個）或 'gram'（幾克）
 */
export function scaleFood(food, qty, qtyType) {
  const q = num(qty, 0);
  const per = num(food.gramsPerUnit, 0);
  let multiplier;
  let grams = null;

  if (qtyType === 'gram') {
    if (!per) return null;                        // 沒有基準克數就換算不了
    multiplier = q / per;
    grams = q;
  } else {
    multiplier = q;
    if (per) grams = q * per;
  }

  const out = { grams: grams === null ? null : round(grams, 1) };
  NUTRIENTS.forEach(({ key }) => {
    const v = food[key];
    out[key] = (v === null || v === undefined || v === '') ? null : round(num(v) * multiplier, 1);
  });
  return out;
}

/**
 * 這項食物有哪些份量可以選。
 *
 * 會出現偏差的關鍵在這裡：包裝的營養標示多半寫「每 100 公克」，但使用者心裡的
 * 「一份」是包裝上另一行的「每一份量 ○○ 公克」。兩者不是同一件事，只有把實際
 * 克數問出來才能正確換算，所以每個選項都必須帶著明確的克數。
 *
 * @returns {Array<{id, label, grams:number|null, needsInput:boolean}>}
 */
export function portionOptions(food) {
  const per = num(food.gramsPerUnit, 0);
  const serving = num(food.servingGrams, 0);
  const pack = num(food.packGrams, 0);
  const opts = [];

  // kind = 'multiplier'：數量直接乘上食物庫的基準值（幾份、幾個 100 克）
  // kind = 'grams'    ：先換算成公克再依基準值等比例計算
  if (food.baseUnit === 'serve') {
    opts.push({
      id: 'serve', kind: 'multiplier',
      label: food.unitLabel || (per ? `1 份（${per} 克）` : '1 份'),
      grams: per || null
    });
    if (pack && per && pack !== per) {
      opts.push({ id: 'pack', kind: 'grams', label: `整包（${pack} 克）`, grams: pack });
    }
    if (per) opts.push({ id: 'gram', kind: 'grams', label: '自行輸入公克', grams: null });
    return opts;
  }

  if (serving) opts.push({ id: 'serving', kind: 'grams', label: `1 份（${serving} 克）`, grams: serving });
  if (pack && pack !== serving) opts.push({ id: 'pack', kind: 'grams', label: `整包（${pack} 克）`, grams: pack });
  opts.push({ id: 'gram', kind: 'grams', label: '自行輸入公克', grams: null });
  opts.push({ id: 'per', kind: 'multiplier', label: `每 ${per || 100} 克`, grams: per || 100 });
  return opts;
}

/** 選定的份量 × 數量 等於幾克。算不出來（例如一份不知道幾克）回 null，不代表不能記錄 */
export function portionGrams(food, optionId, qty) {
  const opt = portionOptions(food).find(o => o.id === optionId);
  if (!opt) return null;
  if (qty === null || qty === undefined || qty === '') return null;
  const q = num(qty, 0);
  if (!(q > 0)) return null;
  if (opt.kind === 'multiplier') return opt.grams ? round(q * opt.grams, 1) : null;
  return round(opt.grams ? q * opt.grams : q, 1);
}

/** 依選定份量算出實際攝取的營養素 */
export function scaleByPortion(food, optionId, qty) {
  const opt = portionOptions(food).find(o => o.id === optionId);
  if (!opt) return null;
  if (qty === null || qty === undefined || qty === '') return null;
  const q = num(qty, 0);
  if (!(q > 0)) return null;
  // 「幾份」就算不知道一份幾克也照樣算得出來，直接乘基準值即可
  if (opt.kind === 'multiplier') return scaleFood(food, q, 'unit');
  return scaleFood(food, opt.grams ? q * opt.grams : q, 'gram');
}

/** 這個份量組合能不能記錄。用它做審核面板的驗證，不要用 portionGrams 是否為 null */
export function portionReady(food, optionId, qty) {
  return scaleByPortion(food, optionId, qty) !== null;
}

/** 每公克蛋白質多少錢，拿來比較食材的蛋白質性價比 */
export function proteinPrice(food) {
  const price = num(food.price, 0);
  const protein = num(food.protein, 0);
  if (!price || !protein) return null;
  return round(price / protein, 2);
}

/** 蛋白質密度：每 100 kcal 含多少克蛋白質，用來挑「補蛋白但不爆熱量」的食物 */
export function proteinDensity(food) {
  const kcal = num(food.kcal, 0);
  const protein = num(food.protein, 0);
  if (!kcal) return null;
  return round((protein / kcal) * 100, 1);
}

/**
 * 依剩餘額度挑食物：優先挑蛋白質密度高、又塞得進剩餘熱量的。
 * 只是排序建議，不是食譜；使用者自己決定要不要吃。
 */
export function suggestFoods(foods, remainKcal, remainProtein, limit = 4) {
  if (remainProtein <= 0 && remainKcal <= 0) return [];
  return foods
    .map(f => {
      const density = proteinDensity(f);
      if (density === null) return null;
      const perServeKcal = num(f.kcal, 0);
      if (!perServeKcal) return null;
      const serves = remainKcal > 0 ? remainKcal / perServeKcal : 0;
      return { food: f, density, serves: round(Math.min(serves, 5), 1) };
    })
    .filter(x => x && x.serves >= 0.3)
    .sort((a, b) => b.density - a.density)
    .slice(0, limit);
}
