import { APP_VERSION, STORAGE } from './config.js';
import { loadLocal, syncFromCloud, subscribe, state, outboxSize, flushOutbox } from './store.js';
import { mountGate } from './screens/gate.js';
import { renderToday } from './screens/today.js';
import { renderAdd } from './screens/add.js';
import { renderFoods } from './screens/foods.js';
import { renderStats } from './screens/stats.js';
import { renderProfile } from './screens/profile.js';
import { $, $$, toast, showWorking, hideWorking } from './util.js';

const RENDERERS = {
  today: renderToday,
  add: renderAdd,
  foods: renderFoods,
  stats: renderStats,
  profile: renderProfile
};

let current = 'today';
let ready = false;

export function go(tab) {
  if (!RENDERERS[tab]) return;
  current = tab;
  localStorage.setItem(STORAGE.prefs, JSON.stringify({ tab }));

  $$('.screen').forEach(s => s.classList.toggle('is-active', s.id === `screen-${tab}`));
  $$('.tabbar__btn').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
  RENDERERS[tab]();
  window.scrollTo({ top: 0 });
}

/**
 * 資料變動後重畫目前這一頁。
 * 「新增」頁是例外：使用者可能正在填表或看辨識結果，背景同步不該把輸入洗掉，
 * 所以只有該頁自己明確要求時（force）才重畫。
 */
export function refresh(force = false) {
  if (!ready) return;
  if (current === 'add' && !force) return;
  RENDERERS[current]();
}

function updateStatusBar() {
  const bar = $('#statusbar');
  const pending = outboxSize();
  if (!navigator.onLine) {
    bar.hidden = false;
    bar.textContent = '離線中，紀錄會先存在本機，恢復連線後補送';
  } else if (pending) {
    bar.hidden = false;
    bar.textContent = `${pending} 筆變更還沒上傳，點這裡重送`;
  } else {
    bar.hidden = true;
  }
  document.body.classList.toggle('has-status', !bar.hidden);
}

async function boot() {
  $('#versionTag').textContent = `v${APP_VERSION}`;
  loadLocal();

  $('.tabbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-tab]');
    if (btn) go(btn.dataset.tab);
  });

  $('#statusbar').addEventListener('click', async () => {
    if (!navigator.onLine) return;
    const r = await flushOutbox();
    toast(`重送 ${r.sent} 筆，剩 ${r.failed} 筆`, r.failed ? 'error' : 'ok');
    updateStatusBar();
  });

  window.addEventListener('online', () => { updateStatusBar(); flushOutbox().then(updateStatusBar); });
  window.addEventListener('offline', updateStatusBar);

  subscribe((what) => {
    if (what === 'sync') updateStatusBar();
    else refresh();
  });

  mountGate(async () => {
    ready = true;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE.prefs) || '{}');
      go(saved.tab && RENDERERS[saved.tab] ? saved.tab : 'today');
    } catch {
      go('today');
    }
    updateStatusBar();

    // 開機拉一次雲端真相。失敗也不擋操作 —— 寫入是逐列的，
    // 就算初次拉取沒成功，之後的新增或刪除也只會動到指定的那一列。
    // Apps Script 冷啟動要 5～10 秒，所以這段一定要有進行中的提示。
    showWorking('連線同步中…');
    const ok = await syncFromCloud({ silent: true });
    hideWorking();
    if (!ok && state.lastError) {
      toast(`同步失敗：${state.lastError}`, 'error');
    }
    refresh();
    updateStatusBar();
  });
}

boot();
