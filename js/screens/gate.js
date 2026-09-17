import { SYMBOLS, PASSCODE_MIN, PASSCODE_MAX, LOCK_WIPE_AT, DEFAULT_GEMINI_MODEL } from '../config.js';
import { sealVault, openVault, hasVault, recordFailure, resetLock, lockRemaining, wipeVault } from '../vault.js';
import { setCredentials, ping, validGasUrl } from '../gas.js';
import { $, esc, toast, confirmBox } from '../util.js';

let code = [];
let onDone = null;

export function mountGate(callback) {
  onDone = callback;
  render();
}

function render() {
  const root = $('#gate');
  root.hidden = false;
  $('#app').hidden = true;
  code = [];
  root.innerHTML = hasVault() ? unlockMarkup() : setupMarkup();
  if (hasVault()) wireUnlock(root); else wireSetup(root);
}

// ============================================================
//  解鎖
// ============================================================

function padMarkup() {
  return `<div class="pad">${SYMBOLS.map(s => `
    <button class="pad__key" type="button" data-sym="${s.id}"
            style="--key-color:${s.color}" aria-label="${s.label}">${s.glyph}</button>`).join('')}</div>`;
}

function unlockMarkup() {
  return `
    <div class="gate__panel">
      <h1 class="gate__title">輸入符號密碼</h1>
      <p class="gate__hint">解開後才能連上你的資料</p>
      <div class="gate__dots" id="dots"></div>
      <p class="gate__error" id="gateError"></p>
      ${padMarkup()}
      <div class="row">
        <button class="btn btn--ghost grow" type="button" data-act="back">刪除</button>
        <button class="btn btn--go grow" type="button" data-act="enter">進入</button>
      </div>
      <p class="small muted" style="margin-top:20px">
        連續輸錯 ${LOCK_WIPE_AT} 次會清除本機的連線設定，屆時要重新輸入網址與 token。
      </p>
      <button class="btn btn--ghost btn--sm" type="button" data-act="reset" style="margin-top:12px">重新設定連線</button>
    </div>`;
}

function drawDots() {
  $('#dots').innerHTML = code.map(() => '<span class="gate__dot is-filled"></span>').join('')
    || '<span class="gate__dot"></span>';
}

function wireUnlock(root) {
  drawDots();

  root.addEventListener('click', async (e) => {
    const key = e.target.closest('[data-sym]');
    if (key) {
      if (code.length < PASSCODE_MAX) { code.push(key.dataset.sym); drawDots(); }
      return;
    }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') { code.pop(); drawDots(); }
    if (act === 'enter') await attemptUnlock();
    if (act === 'reset') {
      const ok = await confirmBox('要清除本機的連線設定嗎？雲端資料不會被刪，但你需要重新輸入 GAS 網址與 token。', '清除');
      if (ok) { wipeVault(); resetLock(); render(); }
    }
  });
}

async function attemptUnlock() {
  const errBox = $('#gateError');
  const wait = lockRemaining();
  if (wait > 0) {
    errBox.textContent = `輸錯太多次，請等 ${Math.ceil(wait / 1000)} 秒再試`;
    return;
  }
  if (code.length < PASSCODE_MIN) {
    errBox.textContent = `密碼至少 ${PASSCODE_MIN} 個符號`;
    return;
  }

  try {
    const vault = await openVault(code.join(''));
    resetLock();
    setCredentials(vault);
    $('#gate').hidden = true;
    $('#app').hidden = false;
    onDone?.(vault);
  } catch {
    const { fails, waitMs, wiped } = recordFailure();
    code = []; drawDots();
    if (wiped) {
      errBox.textContent = '輸錯次數過多，本機連線設定已清除';
      setTimeout(render, 1600);
    } else if (waitMs) {
      errBox.textContent = `密碼不對（第 ${fails} 次），請等 ${Math.ceil(waitMs / 1000)} 秒`;
    } else {
      errBox.textContent = `密碼不對（第 ${fails} 次）`;
    }
  }
}

// ============================================================
//  首次設定
// ============================================================

function setupMarkup() {
  return `
    <div class="gate__panel" style="max-width:420px;text-align:left">
      <h1 class="gate__title">設定連線</h1>
      <p class="gate__hint">
        網址與 token 只會加密後存在這台裝置，不會寫進程式碼，也不會上傳。
      </p>

      <div class="stack">
        <div class="field">
          <label for="setupUrl">Apps Script 網頁應用程式網址</label>
          <input id="setupUrl" type="text" inputmode="url" placeholder="https://script.google.com/macros/s/.../exec"
                 autocomplete="off" data-lpignore="true" data-form-type="other" spellcheck="false">
        </div>
        <div class="field">
          <label for="setupToken">API token（Code.gs 裡的 API_TOKEN）</label>
          <input id="setupToken" type="text" autocomplete="off" data-lpignore="true" data-form-type="other" spellcheck="false">
        </div>
        <div class="field">
          <label for="setupKey">Gemini API key（可留空，之後再填）</label>
          <input id="setupKey" type="password" autocomplete="off" data-lpignore="true" data-form-type="other">
        </div>
        <button class="btn btn--ghost" type="button" data-act="test">測試連線</button>
        <p class="small" id="testResult" style="margin:0;min-height:1.3em"></p>
      </div>

      <hr style="border:none;border-top:1px solid var(--line);margin:22px 0">

      <h2 class="gate__title" style="font-size:1rem">設定符號密碼</h2>
      <p class="gate__hint" id="setupStage">請按 ${PASSCODE_MIN}～${PASSCODE_MAX} 個符號</p>
      <div class="gate__dots" id="dots"></div>
      <p class="gate__error" id="gateError"></p>
      ${padMarkup()}
      <div class="row">
        <button class="btn btn--ghost grow" type="button" data-act="back">刪除</button>
        <button class="btn btn--go grow" type="button" data-act="next">下一步</button>
      </div>
    </div>`;
}

function wireSetup(root) {
  let first = null;
  drawDots();

  root.addEventListener('click', async (e) => {
    const key = e.target.closest('[data-sym]');
    if (key) {
      if (code.length < PASSCODE_MAX) { code.push(key.dataset.sym); drawDots(); }
      return;
    }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') { code.pop(); drawDots(); return; }

    if (act === 'test') {
      const url = $('#setupUrl').value.trim();
      const token = $('#setupToken').value.trim();
      const box = $('#testResult');
      if (!validGasUrl(url)) { box.textContent = '網址格式不對，結尾要是 /exec'; return; }
      box.textContent = '連線中，Apps Script 第一次喚醒約需 5–10 秒…';
      try {
        const r = await ping(url, token);
        box.textContent = r.authed
          ? `連線成功，後端版本 ${r.version}`
          : `連上了，但 token 不正確（後端版本 ${r.version}）`;
      } catch (err) {
        box.textContent = `連不上：${err.message}`;
      }
      return;
    }

    if (act !== 'next') return;

    const errBox = $('#gateError');
    if (code.length < PASSCODE_MIN) {
      errBox.textContent = `至少要 ${PASSCODE_MIN} 個符號`;
      return;
    }

    if (!first) {
      first = code.join('');
      code = []; drawDots();
      errBox.textContent = '';
      $('#setupStage').textContent = '再按一次相同的符號密碼確認';
      return;
    }

    if (first !== code.join('')) {
      errBox.textContent = '兩次不一樣，請重新設定';
      first = null; code = []; drawDots();
      $('#setupStage').textContent = `請按 ${PASSCODE_MIN}～${PASSCODE_MAX} 個符號`;
      return;
    }

    const url = $('#setupUrl').value.trim();
    const token = $('#setupToken').value.trim();
    if (!validGasUrl(url) || !token) {
      errBox.textContent = '請先填好網址與 token';
      first = null; code = []; drawDots();
      return;
    }

    const payload = {
      gasUrl: url,
      token,
      geminiKey: $('#setupKey').value.trim(),
      geminiModel: DEFAULT_GEMINI_MODEL
    };
    await sealVault(first, payload);
    setCredentials(payload);
    toast('連線設定已加密儲存', 'ok');
    $('#gate').hidden = true;
    $('#app').hidden = false;
    onDone?.(payload);
  });
}

/** 已登入狀態下改連線設定（在「我的」頁用） */
export async function resealVault(passcode, payload) {
  await sealVault(passcode, payload);
  setCredentials(payload);
}

export function symbolGlyph(id) {
  return SYMBOLS.find(s => s.id === id)?.glyph || esc(id);
}
