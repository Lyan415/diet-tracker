// 改版時只要動這一行，畫面右下角的版本標記就會跟著變，方便確認手機拿到的是不是新版
export const APP_VERSION = '1.5.0';

export const TZ = 'Asia/Taipei';

// PlayStation 手把符號。前四個是面板按鍵，後四個是方向鍵。
export const SYMBOLS = [
  { id: 'triangle', glyph: '△', color: 'var(--ps-triangle)', label: '三角' },
  { id: 'circle',   glyph: '○', color: 'var(--ps-circle)',   label: '圓'   },
  { id: 'cross',    glyph: '✕', color: 'var(--ps-cross)',    label: '叉'   },
  { id: 'square',   glyph: '□', color: 'var(--ps-square)',   label: '方'   },
  { id: 'up',       glyph: '▲', color: 'var(--ps-dpad)',     label: '上'   },
  { id: 'down',     glyph: '▼', color: 'var(--ps-dpad)',     label: '下'   },
  { id: 'left',     glyph: '◀', color: 'var(--ps-dpad)',     label: '左'   },
  { id: 'right',    glyph: '▶', color: 'var(--ps-dpad)',     label: '右'   }
];

export const PASSCODE_MIN = 4;
export const PASSCODE_MAX = 16;

// 連續輸錯的處置：5 次後開始遞增等待，10 次直接刪掉本機那團密文。
// 密文一刪，別人就算猜中密碼也拿不到 token，等於線上暴力破解無效。
export const LOCK_SOFT_AT = 5;
export const LOCK_WIPE_AT = 10;
export const PBKDF2_ITERATIONS = 250000;

export const STORAGE = {
  vault:    'dt.vault',      // 上鎖模式：加密後的 { gasUrl, token, geminiKey }
  plain:    'dt.creds',      // 不上鎖模式：同樣內容，明文
  lockMode: 'dt.lockMode',   // none | pattern | symbol
  lock:     'dt.lock',       // { fails, until }
  cache:    'dt.cache',      // 雲端資料的本機快取
  outbox:   'dt.outbox',     // 還沒上傳的逐列寫入
  syncMode: 'dt.syncMode',   // auto（背景上傳）| manual（按鈕才上傳）
  keepPhotos: 'dt.keepPhotos', // '1' 判讀後把照片存進 Drive；預設不存
  prefs:    'dt.prefs'       // 不敏感的本機偏好（最後選的分頁等）
};

// 連連看圖形鎖：3×3 點陣，至少要連幾個點
export const PATTERN_MIN = 4;

export const GAS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;

export const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
export const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export const ACTIVITY_LEVELS = [
  { id: 'office_low',  label: '辦公室工作，一週運動兩天以下', factor: 1.375 },
  { id: 'office_high', label: '辦公室工作，一週運動三天以上', factor: 1.55  },
  { id: 'onfoot',      label: '常走動的工作',                factor: 1.65  },
  { id: 'labor',       label: '體力工作者',                  factor: 1.725 }
];

export const NUTRIENTS = [
  { key: 'kcal',    label: '熱量',   unit: 'kcal' },
  { key: 'protein', label: '蛋白質', unit: 'g' },
  { key: 'fat',     label: '脂肪',   unit: 'g' },
  { key: 'carb',    label: '碳水',   unit: 'g' },
  { key: 'sugar',   label: '糖',     unit: 'g' },
  { key: 'fiber',   label: '纖維',   unit: 'g' },
  { key: 'sodium',  label: '鈉',     unit: 'mg' }
];

/**
 * 上網查營養成分時的指定來源，依食物類型分層。
 * Gemini 的 prompt 和「手動查食物」畫面都讀這一份，要增刪只改這裡。
 */
export const NUTRITION_SOURCES = [
  {
    tier: '生鮮、基礎食材與原物料',
    sites: [
      { name: '衛福部食藥署 食品營養成分資料庫', domain: 'fda.gov.tw' },
      { name: '機能營養管理資訊網（食藥署資料圖表化）', domain: 'justnutrition.tw' },
      { name: '安永生活誌 台灣常見食物營養成分資料庫', domain: 'anyongfresh.com' }
    ]
  },
  {
    tier: '連鎖速食與早午餐品牌',
    sites: [
      { name: '麥當勞 營養計算機', domain: 'mcdonalds.com' },
      { name: '摩斯漢堡 商品營養分析表', domain: 'mos.com.tw' },
      { name: '漢堡王 食物營養成份參考表', domain: 'burgerking.com.tw' },
      { name: '麥味登 官網產品介紹', domain: 'mwd.com.tw' },
      { name: '台大膳食協調委員會 校內早餐類熱量表', domain: 'ntu.edu.tw' }
    ]
  },
  {
    tier: '傳統早餐店、一般小吃的估算值',
    sites: [
      { name: '好食課 早餐店熱量與減肥吃法', domain: 'learneating.com' },
      { name: 'Nuture Fit 全台早餐店漢堡熱量表', domain: 'nuturefit.com' }
    ]
  }
];
