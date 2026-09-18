import { SYMBOLS, PASSCODE_MIN, PASSCODE_MAX, PATTERN_MIN, LOCK_WIPE_AT,
         DEFAULT_GEMINI_MODEL } from '../config.js';
import { LOCK_MODES, getLockMode, needsCode, hasCreds,
         saveCreds, loadCreds, wipeCreds,
         recordFailure, resetLock, lockRemaining } from '../vault.js';
import { setCredentials, ping, validGasUrl } from '../gas.js';
import { $, esc, toast, confirmBox } from '../util.js';

let onDone = null;

export function mountGate(callback) {
  onDone = callback;
  start();
}

async function start() {
  const gate = $('#gate');

  if (!hasCreds()) { gate.hidden = false; $('#app').hidden = true; renderSetup(gate); return; }

  // 不上鎖：完全不顯示登入畫面，直接進去
  if (!needsCode()) {
    try {
      const creds = await loadCreds();
      enter(creds);
      return;
    } catch {
      gate.hidden = false; $('#app').hidden = true; renderSetup(gate); return;
    }
  }

  gate.hidden = false;
  $('#app').hidden = true;
  renderUnlock(gate);
}

function enter(creds) {
  setCredentials(creds);
  $('#gate').hidden = true;
  $('#app').hidden = false;
  onDone?.(creds);
}

// ============================================================
//  連連看圖形鎖
// ============================================================

export function patternMarkup(id = 'pattern') {
  return `<div class="pattern" id="${id}">
    <svg class="pattern__trace" viewBox="0 0 300 300" aria-hidden="true">
      <polyline points="" fill="none" stroke="var(--ps-triangle)" stroke-width="5"
                stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
    </svg>
    ${Array.from({ length: 9 }, (_, i) => `<div class="pattern__dot" data-dot="${i}"><span></span></div>`).join('')}
  </div>`;
}

/**
 * 一筆畫手勢。用 pointer 事件並在容器上設 touch-action:none，
 * 所以拖曳不會捲動畫面，也不會有連點兩下被當成放大的問題。
 */
export function wirePattern(rootId, { onDraw, onFinish }) {
  const box = $(`#${rootId}`);
  if (!box) return;
  const dots = Array.from(box.querySelectorAll('[data-dot]'));
  const line = box.querySelector('polyline');
  let path = [];
  let drawing = false;

  const centers = () => dots.map(d => {
    const r = d.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    return { x: r.left - b.left + r.width / 2, y: r.top - b.top + r.height / 2, w: r.width };
  });

  const paint = (cursor) => {
    const b = box.getBoundingClientRect();
    const cs = centers();
    const pts = path.map(i => `${(cs[i].x / b.width) * 300},${(cs[i].y / b.height) * 300}`);
    if (cursor) pts.push(`${(cursor.x / b.width) * 300},${(cursor.y / b.height) * 300}`);
    line.setAttribute('points', pts.join(' '));
    dots.forEach((d, i) => d.classList.toggle('is-on', path.includes(i)));
  };

  const hit = (x, y) => {
    const cs = centers();
    for (let i = 0; i < cs.length; i++) {
      const dx = x - cs[i].x, dy = y - cs[i].y;
      if (Math.hypot(dx, dy) < cs[i].w * 0.62) return i;
    }
    return -1;
  };

  const local = (e) => {
    const b = box.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };

  box.addEventListener('pointerdown', (e) => {
    box.setPointerCapture?.(e.pointerId);
    drawing = true;
    path = [];
    const p = local(e);
    const i = hit(p.x, p.y);
    if (i >= 0) path.push(i);
    paint(p);
    onDraw?.(path.length);
  });

  box.addEventListener('pointermove', (e) => {
    if (!drawing) return;
    e.preventDefault();
    const p = local(e);
    const i = hit(p.x, p.y);
    if (i >= 0 && !path.includes(i)) { path.push(i); onDraw?.(path.length); }
    paint(p);
  });

  const end = () => {
    if (!drawing) return;
    drawing = false;
    paint(null);
    const code = path.join('-');
    const len = path.length;
    setTimeout(() => { path = []; paint(null); }, 260);
    onFinish?.(code, len);
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
  box.addEventListener('pointerleave', end);
}

// ============================================================
//  符號鍵盤
// ============================================================

export function symbolPadMarkup() {
  return `<div class="pad">${SYMBOLS.map(s => `
    <button class="pad__key" type="button" data-sym="${s.id}"
            style="--key-color:${s.color}" aria-label="${s.label}">${s.glyph}</button>`).join('')}</div>`;
}

// ============================================================
//  解鎖
// ============================================================

function renderUnlock(gate) {
  const mode = getLockMode();
  gate.innerHTML = `
    <div class="gate__panel">
      <h1 class="gate__title">${mode === 'pattern' ? '畫出你的圖形' : '輸入符號密碼'}</h1>
      <p class="gate__hint">解開後才能連上你的資料</p>
      ${mode === 'pattern' ? '' : '<div class="gate__dots" id="dots"></div>'}
      <p class="gate__error" id="gateError"></p>
      ${mode === 'pattern' ? patternMarkup('unlockPattern') : symbolPadMarkup()}
      ${mode === 'pattern' ? '' : `
        <div class="row">
          <button class="btn btn--ghost grow" type="button" data-act="back">刪除</button>
          <button class="btn btn--go grow" type="button" data-act="enter">進入</button>
        </div>`}
      <p class="small muted" style="margin-top:20px">
        連續錯 ${LOCK_WIPE_AT} 次會清除本機的連線設定，屆時要重新輸入網址與 token。
      </p>
      <button class="btn btn--ghost btn--sm" type="button" data-act="reset" style="margin-top:12px">重新設定連線</button>
    </div>`;

  let code = [];
  const drawDots = () => {
    const box = $('#dots');
    if (box) box.innerHTML = code.map(() => '<span class="gate__dot is-filled"></span>').join('')
      || '<span class="gate__dot"></span>';
  };
  drawDots();

  if (mode === 'pattern') {
    wirePattern('unlockPattern', {
      onFinish: (pattern, len) => {
        if (len < PATTERN_MIN) { $('#gateError').textContent = `至少要連 ${PATTERN_MIN} 個點`; return; }
        attempt(pattern);
      }
    });
  }

  gate.onclick = async (e) => {
    const key = e.target.closest('[data-sym]');
    if (key) { if (code.length < PASSCODE_MAX) { code.push(key.dataset.sym); drawDots(); } return; }

    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'back') { code.pop(); drawDots(); }
    if (act === 'enter') {
      if (code.length < PASSCODE_MIN) { $('#gateError').textContent = `密碼至少 ${PASSCODE_MIN} 個符號`; return; }
      const ok = await attempt(code.join(''));
      if (!ok) { code = []; drawDots(); }
    }
    if (act === 'reset') {
      const ok = await confirmBox('要清除本機的連線設定嗎？雲端資料不會被刪，但你需要重新輸入 GAS 網址與 token。', '清除');
      if (ok) { wipeCreds(); resetLock(); start(); }
    }
  };
}

async function attempt(code) {
  const errBox = $('#gateError');
  const wait = lockRemaining();
  if (wait > 0) {
    errBox.textContent = `錯太多次，請等 ${Math.ceil(wait / 1000)} 秒再試`;
    return false;
  }
  try {
    const creds = await loadCreds(code);
    resetLock();
    enter(creds);
    return true;
  } catch {
    const { fails, waitMs, wiped } = recordFailure();
    if (wiped) {
      errBox.textContent = '錯誤次數過多，本機連線設定已清除';
      setTimeout(start, 1600);
    } else if (waitMs) {
      errBox.textContent = `不對（第 ${fails} 次），請等 ${Math.ceil(waitMs / 1000)} 秒`;
    } else {
      errBox.textContent = `不對（第 ${fails} 次）`;
    }
    return false;
  }
}

// ============================================================
//  可重用的輸入對話框（設定頁要驗證或變更鎖時用）
// ============================================================

/**
 * 跳出對話框請使用者做一次鎖的動作，回傳那組代碼；取消回 null。
 * @param {string} title 提示文字
 * @param {string} mode  none 直接回空字串（不需要代碼）
 */
export function promptCode(title, mode = getLockMode()) {
  if (mode === 'none') return Promise.resolve('');

  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `
      <div class="modal__panel" style="text-align:center">
        <p class="modal__text">${esc(title)}</p>
        ${mode === 'pattern' ? patternMarkup('promptPattern') : `
          <div class="gate__dots" id="promptDots"></div>
          ${symbolPadMarkup()}`}
        <p class="gate__error" id="promptError"></p>
        <div class="modal__actions">
          <button class="btn btn--ghost" data-act="cancel">取消</button>
          ${mode === 'pattern' ? '' : `
            <button class="btn btn--ghost" data-act="back">刪除</button>
            <button class="btn btn--go" data-act="ok">確定</button>`}
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let code = [];
    const draw = () => {
      const box = wrap.querySelector('#promptDots');
      if (box) box.innerHTML = code.map(() => '<span class="gate__dot is-filled"></span>').join('')
        || '<span class="gate__dot"></span>';
    };
    draw();

    const finish = (value) => { wrap.remove(); resolve(value); };

    if (mode === 'pattern') {
      wirePattern('promptPattern', {
        onFinish: (pattern, len) => {
          if (len < PATTERN_MIN) {
            wrap.querySelector('#promptError').textContent = `至少要連 ${PATTERN_MIN} 個點`;
            return;
          }
          finish(pattern);
        }
      });
    }

    wrap.addEventListener('click', (e) => {
      const key = e.target.closest('[data-sym]');
      if (key) { if (code.length < PASSCODE_MAX) code.push(key.dataset.sym); draw(); return; }
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'back') { code.pop(); draw(); return; }
      if (act === 'cancel') finish(null);
      if (act === 'ok') {
        if (code.length < PASSCODE_MIN) {
          wrap.querySelector('#promptError').textContent = `至少 ${PASSCODE_MIN} 個符號`;
          return;
        }
        finish(code.join(''));
      }
    });
  });
}

// ============================================================
//  首次設定
// ============================================================

function renderSetup(gate) {
  gate.innerHTML = `
    <div class="gate__panel" style="max-width:420px;text-align:left">
      <h1 class="gate__title">設定連線</h1>
      <p class="gate__hint">
        網址與 token 只存在這台裝置，不會寫進程式碼，也不會上傳。
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

      <h2 class="gate__title" style="font-size:1rem">要不要上鎖？</h2>
      <p class="gate__hint">
        擋住「看到 GitHub 專案的陌生人」靠的是 token 不寫在程式碼裡，這已經生效了。
        上鎖只多防一種情況：別人拿到你已設定好的手機。
      </p>
      <div class="stack" style="margin-bottom:16px">
        ${LOCK_MODES.map((m, i) => `
          <label class="lockopt">
            <input type="radio" name="lockmode" value="${m.id}" ${i === 0 ? 'checked' : ''}>
            <span>
              <strong>${esc(m.label)}</strong>
              <span class="small muted">${esc(m.hint)}</span>
            </span>
          </label>`).join('')}
      </div>

      <div id="codeArea"></div>
      <p class="gate__error" id="gateError"></p>
      <button class="btn btn--go btn--block" type="button" data-act="finish">完成設定</button>
    </div>`;

  let mode = 'none';
  let first = null;
  let code = [];

  const renderCodeArea = () => {
    const area = $('#codeArea');
    first = null; code = [];
    if (mode === 'none') {
      area.innerHTML = `<p class="small muted">開啟 App 會直接進入。之後想加鎖可以到「我的 → 登入鎖」改。</p>`;
      return;
    }
    if (mode === 'pattern') {
      area.innerHTML = `
        <p class="small muted" id="stageHint">畫出圖形（至少 ${PATTERN_MIN} 個點）</p>
        ${patternMarkup('setupPattern')}`;
      wirePattern('setupPattern', { onFinish: (pattern, len) => takeCode(pattern, len >= PATTERN_MIN) });
      return;
    }
    area.innerHTML = `
      <p class="small muted" id="stageHint">按 ${PASSCODE_MIN}～${PASSCODE_MAX} 個符號</p>
      <div class="gate__dots" id="dots"></div>
      ${symbolPadMarkup()}
      <div class="row">
        <button class="btn btn--ghost grow" type="button" data-act="back">刪除</button>
        <button class="btn btn--ghost grow" type="button" data-act="next">下一步</button>
      </div>`;
    drawDots();
  };

  const drawDots = () => {
    const box = $('#dots');
    if (box) box.innerHTML = code.map(() => '<span class="gate__dot is-filled"></span>').join('')
      || '<span class="gate__dot"></span>';
  };

  /** 兩階段確認：第一次記下來，第二次比對 */
  const takeCode = (value, valid) => {
    const err = $('#gateError');
    if (!valid) { err.textContent = '太短了，請再畫長一點'; return; }
    if (!first) {
      first = value;
      err.textContent = '';
      $('#stageHint').textContent = '再做一次相同的動作確認';
      code = []; drawDots();
      return;
    }
    if (first !== value) {
      err.textContent = '兩次不一樣，請重新設定';
      first = null; code = []; drawDots();
      $('#stageHint').textContent = mode === 'pattern'
        ? `畫出圖形（至少 ${PATTERN_MIN} 個點）`
        : `按 ${PASSCODE_MIN}～${PASSCODE_MAX} 個符號`;
      return;
    }
    err.textContent = '已確認，可以按完成設定';
  };

  renderCodeArea();

  gate.onchange = (e) => {
    if (e.target.name === 'lockmode') { mode = e.target.value; renderCodeArea(); }
  };

  gate.onclick = async (e) => {
    const key = e.target.closest('[data-sym]');
    if (key) { if (code.length < PASSCODE_MAX) { code.push(key.dataset.sym); drawDots(); } return; }

    const act = e.target.closest('[data-act]')?.dataset.act;

    if (act === 'back') { code.pop(); drawDots(); return; }
    if (act === 'next') { takeCode(code.join(''), code.length >= PASSCODE_MIN); return; }

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

    if (act !== 'finish') return;

    const err = $('#gateError');
    const url = $('#setupUrl').value.trim();
    const token = $('#setupToken').value.trim();
    if (!validGasUrl(url) || !token) { err.textContent = '請先填好網址與 token'; return; }
    if (mode !== 'none' && !first) { err.textContent = '請先設定並確認你的鎖'; return; }

    const payload = {
      gasUrl: url,
      token,
      geminiKey: $('#setupKey').value.trim(),
      geminiModel: DEFAULT_GEMINI_MODEL
    };
    await saveCreds(mode, first, payload);
    toast(mode === 'none' ? '連線設定已儲存' : '連線設定已加密儲存', 'ok');
    enter(payload);
  };
}
