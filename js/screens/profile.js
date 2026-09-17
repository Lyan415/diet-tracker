import { state, getMeta, setMeta, saveBody, deleteBody, bodyHistory, latestBody,
         syncFromCloud, flushOutbox, outboxSize, outboxLastError, clearOutbox } from '../store.js';
import { suggestedTargets, effectiveTargets, leanMass, ageFrom } from '../nutrition.js';
import { ACTIVITY_LEVELS, APP_VERSION, DEFAULT_GEMINI_MODEL } from '../config.js';
import { getCredentials, setCredentials, ping, validGasUrl } from '../gas.js';
import { openVault, sealVault } from '../vault.js';
import { $, esc, fmt, num, todayStr, toast, confirmBox, round } from '../util.js';

export function renderProfile() {
  const root = $('#screen-profile');
  const profile = getMeta('profile', {});
  const latest = latestBody();
  const suggest = suggestedTargets(profile, latest);
  const current = effectiveTargets(state.meta, profile, latest);

  root.innerHTML = `
    <div class="screen__head">
      <div>
        <h1 class="screen__title">我的</h1>
        <p class="screen__sub">個人資料、目標與連線設定</p>
      </div>
    </div>

    ${profileCard(profile)}
    ${bodyCard(latest)}
    ${targetCard(suggest, current)}
    ${historyCard()}
    ${connCard()}
    <p class="version">前端版本 ${esc(APP_VERSION)}</p>
  `;

  wire(root);
}

// ---------- 固定資料 ----------

function profileCard(p) {
  const age = ageFrom(p.birth);
  return `<div class="card">
    <h2 class="card__title">
      基本資料
      ${age !== null ? `<span class="small muted">${age} 歲</span>` : ''}
    </h2>
    <div class="stack">
      <div class="field--split">
        <div class="field">
          <label for="pNick">稱呼</label>
          <input id="pNick" type="text" value="${esc(p.nickname || '')}">
        </div>
        <div class="field">
          <label for="pBirth">出生年月</label>
          <input id="pBirth" type="month" value="${esc(p.birth || '')}">
        </div>
      </div>
      <div class="field--split">
        <div class="field">
          <label for="pSex">生理性別</label>
          <select id="pSex">
            <option value="male" ${p.sex === 'male' ? 'selected' : ''}>男</option>
            <option value="female" ${p.sex === 'female' ? 'selected' : ''}>女</option>
          </select>
        </div>
        <div class="field">
          <label for="pHeight">身高 (cm)</label>
          <input id="pHeight" type="number" inputmode="decimal" min="0" value="${p.height ?? ''}">
        </div>
      </div>
      <div class="field">
        <label for="pTarget">目標體重 (kg)</label>
        <input id="pTarget" type="number" inputmode="decimal" min="0" step="0.1" value="${p.targetWeight ?? ''}">
      </div>
      <div class="field">
        <label for="pActivity">日常活動量</label>
        <select id="pActivity">
          ${ACTIVITY_LEVELS.map(a =>
            `<option value="${a.id}" ${p.activity === a.id ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}
        </select>
      </div>
      <button class="btn btn--go btn--block" data-act="saveProfile">儲存基本資料</button>
    </div>
  </div>`;
}

// ---------- 體位 ----------

function bodyCard(latest) {
  const lbm = latest ? leanMass(latest.weight, latest.bodyFat) : null;
  return `<div class="card">
    <h2 class="card__title">
      記一筆體位
      ${latest ? `<span class="small muted">上次 ${esc(latest.date)}・${fmt(latest.weight, 1)} kg</span>` : ''}
    </h2>
    <div class="stack">
      <div class="field--split">
        <div class="field">
          <label for="bWeight">體重 (kg)</label>
          <input id="bWeight" type="number" inputmode="decimal" min="0" step="0.1"
                 value="${latest?.weight ?? ''}">
        </div>
        <div class="field">
          <label for="bFat">體脂率 (%)</label>
          <input id="bFat" type="number" inputmode="decimal" min="0" max="70" step="0.1"
                 value="${latest?.bodyFat ?? ''}">
        </div>
      </div>
      <div class="field">
        <label for="bDate">日期</label>
        <input id="bDate" type="date" value="${esc(todayStr())}" max="${esc(todayStr())}">
      </div>
      ${lbm ? `<p class="small muted" style="margin:0">目前去脂體重約 ${fmt(lbm, 1)} kg</p>` : `
        <p class="small muted" style="margin:0">
          填了體脂率才能用 Katch-McArdle 算基礎代謝，蛋白質建議也才是以去脂體重為基準。
        </p>`}
      <button class="btn btn--go btn--block" data-act="saveBody">記錄</button>
    </div>
  </div>`;
}

// ---------- 目標 ----------

function targetCard(suggest, current) {
  if (!suggest) {
    return `<div class="card">
      <h2 class="card__title">每日目標</h2>
      <p class="small muted" style="margin:0">
        填好出生年月、身高、活動量，再記一筆體重，就會算出建議值。
      </p>
    </div>`;
  }

  const isManual = current?.mode === 'manual';
  const changed = isManual && (current.kcal !== suggest.kcal || current.protein !== suggest.protein);

  return `<div class="card">
    <h2 class="card__title">每日目標</h2>
    <div class="stack">
      <p class="small muted" style="margin:0">
        基礎代謝 ${fmt(suggest.bmr)} kcal・每日總消耗 ${fmt(suggest.tdee)} kcal<br>
        算法：${esc(suggest.method)}
        ${suggest.lbm ? `・去脂體重 ${fmt(suggest.lbm, 1)} kg` : ''}
      </p>
      <div class="field--split">
        <div class="field">
          <label>建議熱量</label>
          <div class="gauge__value" style="font-size:1.5rem;color:var(--kcal)">${fmt(suggest.kcal)}<span class="gauge__unit">kcal</span></div>
        </div>
        <div class="field">
          <label>建議蛋白質${suggest.proteinEstimated ? '（估值）' : ''}</label>
          <div class="gauge__value" style="font-size:1.5rem;color:var(--protein)">${fmt(suggest.protein)}<span class="gauge__unit">g</span></div>
        </div>
      </div>
      ${suggest.delta !== 0 ? `<p class="small muted" style="margin:0">
        已依目標體重${suggest.delta < 0 ? '扣掉' : '加上'} ${fmt(Math.abs(suggest.delta))} kcal，並限制不低於基礎代謝。
      </p>` : ''}

      <div class="field--split">
        <div class="field">
          <label for="tKcal">我要用的熱量目標</label>
          <input id="tKcal" type="number" inputmode="decimal" min="0" value="${current?.kcal ?? suggest.kcal}">
        </div>
        <div class="field">
          <label for="tProtein">我要用的蛋白質目標</label>
          <input id="tProtein" type="number" inputmode="decimal" min="0" value="${current?.protein ?? suggest.protein}">
        </div>
      </div>
      <div class="row">
        <button class="btn btn--ghost grow" data-act="useSuggest">改用建議值</button>
        <button class="btn btn--go grow" data-act="saveTarget">存成手動值</button>
      </div>
      <p class="small muted" style="margin:0">
        目前生效：${isManual ? `手動值${changed ? '（與建議值不同）' : ''}` : '建議值，體重體脂更新時會自動跟著變'}
      </p>
    </div>
  </div>`;
}

// ---------- 歷史 ----------

function historyCard() {
  const list = bodyHistory().slice(-8).reverse();
  if (!list.length) return '';
  return `<div class="card">
    <h2 class="card__title">最近的體位紀錄</h2>
    ${list.map(b => `
      <div class="entry">
        <div class="grow">
          <div class="entry__name">${esc(b.date)}</div>
          <div class="entry__meta">
            ${fmt(b.weight, 1)} kg${b.bodyFat ? `・體脂 ${fmt(b.bodyFat, 1)} %` : ''}
          </div>
        </div>
        <button class="btn btn--ghost btn--sm" data-act="delBody" data-id="${esc(b.id)}" aria-label="刪除">✕</button>
      </div>`).join('')}
  </div>`;
}

// ---------- 連線 ----------

function connCard() {
  const c = getCredentials();
  const pending = outboxSize();
  const lastErr = outboxLastError();
  return `<div class="card">
    <h2 class="card__title">
      連線設定
      ${pending ? `<span class="tag tag--low">${pending} 筆待上傳</span>` : ''}
    </h2>
    <div class="stack">
      <p class="small muted" style="margin:0">
        網址、token 與 Gemini key 都用符號密碼加密後存在這台裝置，不會寫進程式碼也不會存進試算表。
      </p>
      <div class="field">
        <label for="cUrl">Apps Script 網址</label>
        <input id="cUrl" type="text" value="${esc(c.gasUrl || '')}"
               autocomplete="off" data-lpignore="true" data-form-type="other" spellcheck="false">
      </div>
      <div class="field">
        <label for="cToken">API token</label>
        <input id="cToken" type="password" value="${esc(c.token || '')}"
               autocomplete="off" data-lpignore="true" data-form-type="other">
      </div>
      <div class="field">
        <label for="cKey">Gemini API key</label>
        <input id="cKey" type="password" value="${esc(c.geminiKey || '')}"
               autocomplete="off" data-lpignore="true" data-form-type="other">
      </div>
      <div class="field">
        <label for="cModel">Gemini 模型</label>
        <input id="cModel" type="text" value="${esc(c.geminiModel || DEFAULT_GEMINI_MODEL)}" spellcheck="false">
      </div>
      ${lastErr ? `<p class="small" style="margin:0;color:var(--ps-circle)">
        最後一筆失敗：${esc(lastErr.action)}（${esc(lastErr.at)}）<br>${esc(lastErr.error)}
      </p>` : ''}
      <p class="small" id="connResult" style="margin:0;min-height:1.3em"></p>
      <div class="row row--wrap">
        <button class="btn btn--ghost btn--sm" data-act="testConn">測試連線</button>
        <button class="btn btn--ghost btn--sm" data-act="resync">重新同步</button>
        ${pending ? '<button class="btn btn--ghost btn--sm" data-act="flush">重送待上傳</button>' : ''}
        ${pending ? '<button class="btn btn--ghost btn--sm" data-act="clearBox">清空佇列</button>' : ''}
        <button class="btn btn--primary btn--sm" data-act="saveConn">儲存設定</button>
      </div>
    </div>
  </div>`;
}

// ============================================================

function wire(root) {
  root.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const { act, id } = btn.dataset;

    try {
      if (act === 'saveProfile') {
        await setMeta('profile', {
          nickname: $('#pNick').value.trim(),
          birth: $('#pBirth').value,
          sex: $('#pSex').value,
          height: num($('#pHeight').value, null),
          targetWeight: num($('#pTarget').value, null),
          activity: $('#pActivity').value
        });
        toast('基本資料已儲存', 'ok');
        renderProfile();
      }

      if (act === 'saveBody') {
        const weight = num($('#bWeight').value, null);
        if (weight === null) { toast('請填體重', 'error'); return; }
        const before = effectiveTargets(state.meta, getMeta('profile', {}), latestBody());
        await saveBody({
          date: $('#bDate').value || todayStr(),
          weight,
          bodyFat: num($('#bFat').value, null),
          note: ''
        });
        renderProfile();
        await offerNewTargets(before);
      }

      if (act === 'delBody') {
        if (await confirmBox('要刪掉這筆體位紀錄嗎？', '刪除')) {
          await deleteBody(id);
          renderProfile();
        }
      }

      if (act === 'useSuggest') {
        await setMeta('dailyTarget', { mode: 'auto' });
        toast('已改用建議值', 'ok');
        renderProfile();
      }

      if (act === 'saveTarget') {
        await setMeta('dailyTarget', {
          mode: 'manual',
          kcal: num($('#tKcal').value, 0),
          protein: num($('#tProtein').value, 0)
        });
        toast('已存成手動目標', 'ok');
        renderProfile();
      }

      if (act === 'testConn') {
        const box = $('#connResult');
        const url = $('#cUrl').value.trim();
        if (!validGasUrl(url)) { box.textContent = '網址格式不對，結尾要是 /exec'; return; }
        box.textContent = '連線中…';
        const r = await ping(url, $('#cToken').value.trim());
        box.textContent = r.authed ? `連線成功，後端版本 ${r.version}` : `連上了，但 token 不正確`;
      }

      if (act === 'saveConn')  await saveConnection();
      if (act === 'resync')    { await syncFromCloud(); toast('已重新同步', 'ok'); renderProfile(); }
      if (act === 'clearBox') {
        if (await confirmBox('要清空待送佇列嗎？這些變更就不會再上傳，但本機和雲端已有的資料不受影響。', '清空')) {
          clearOutbox();
          renderProfile();
        }
      }

      if (act === 'flush') {
        const r = await flushOutbox();
        toast(`重送 ${r.sent} 筆，剩 ${r.failed} 筆`, r.failed ? 'error' : 'ok');
        renderProfile();
      }
    } catch (err) {
      toast(err.message || '操作失敗', 'error');
    }
  };
}

/** 體位更新後，若建議值變了就問要不要套用（手動值不會被偷偷蓋掉） */
async function offerNewTargets(before) {
  const profile = getMeta('profile', {});
  const suggest = suggestedTargets(profile, latestBody());
  if (!suggest) return;

  const mode = getMeta('dailyTarget', {})?.mode;
  if (mode !== 'manual') { toast('已更新，目標值跟著重算', 'ok'); return; }

  if (before && before.kcal === suggest.kcal && before.protein === suggest.protein) {
    toast('已記錄', 'ok');
    return;
  }

  const ok = await confirmBox(
    `新的建議值是 ${fmt(suggest.kcal)} kcal、蛋白質 ${fmt(suggest.protein)} g。要改成這組嗎？（你目前用的是手動值）`,
    '改用建議值'
  );
  if (ok) {
    await setMeta('dailyTarget', { mode: 'auto' });
    renderProfile();
  }
}

/** 改連線設定要重新加密，所以得再輸入一次符號密碼 */
async function saveConnection() {
  const payload = {
    gasUrl: $('#cUrl').value.trim(),
    token: $('#cToken').value.trim(),
    geminiKey: $('#cKey').value.trim(),
    geminiModel: $('#cModel').value.trim() || DEFAULT_GEMINI_MODEL
  };
  if (!validGasUrl(payload.gasUrl)) { toast('網址格式不對', 'error'); return; }

  const pass = await askPasscode();
  if (!pass) return;

  try {
    await openVault(pass);            // 先驗證密碼正確
  } catch {
    toast('密碼不對，設定未變更', 'error');
    return;
  }
  await sealVault(pass, payload);
  setCredentials(payload);
  toast('設定已更新', 'ok');
  renderProfile();
}

function askPasscode() {
  return new Promise(resolve => {
    import('../config.js').then(({ SYMBOLS, PASSCODE_MAX }) => {
      let code = [];
      const wrap = document.createElement('div');
      wrap.className = 'modal';
      wrap.innerHTML = `
        <div class="modal__panel" style="text-align:center">
          <p class="modal__text">輸入符號密碼以儲存設定</p>
          <div class="gate__dots" id="pcDots"></div>
          <div class="pad">
            ${SYMBOLS.map(s => `<button class="pad__key" data-sym="${s.id}" style="--key-color:${s.color}">${s.glyph}</button>`).join('')}
          </div>
          <div class="modal__actions">
            <button class="btn btn--ghost" data-act="cancel">取消</button>
            <button class="btn btn--ghost" data-act="back">刪除</button>
            <button class="btn btn--go" data-act="ok">確定</button>
          </div>
        </div>`;
      const draw = () => {
        wrap.querySelector('#pcDots').innerHTML =
          code.map(() => '<span class="gate__dot is-filled"></span>').join('')
          || '<span class="gate__dot"></span>';
      };
      wrap.addEventListener('click', (e) => {
        const sym = e.target.closest('[data-sym]');
        if (sym) { if (code.length < PASSCODE_MAX) code.push(sym.dataset.sym); draw(); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'back') { code.pop(); draw(); return; }
        if (act === 'cancel') { wrap.remove(); resolve(null); }
        if (act === 'ok') { wrap.remove(); resolve(code.join('')); }
      });
      document.body.appendChild(wrap);
      draw();
    });
  });
}
