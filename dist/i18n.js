'use strict';

// Interface language. ?lang=en|zh wins and is remembered; otherwise the saved choice, otherwise the
// browser language (Chinese browsers get Chinese, everyone else English).
const LANG = (() => {
  const asked = new URLSearchParams(location.search).get('lang');
  try {
    if (asked === 'en' || asked === 'zh') {
      localStorage.setItem('raceopic-lang', asked);
      return asked;
    }
    const saved = localStorage.getItem('raceopic-lang');
    if (saved === 'en' || saved === 'zh') return saved;
  } catch {
    if (asked === 'en' || asked === 'zh') return asked;
  }
  return /^zh\b/i.test(navigator.language || '') ? 'zh' : 'en';
})();

// L('中文', 'English') picks the current language.
const L = (zh, en) => (LANG === 'en' ? en : zh);

const GP_EN = {
  '澳大利亚大奖赛': 'Australian Grand Prix', '中国大奖赛': 'Chinese Grand Prix', '日本大奖赛': 'Japanese Grand Prix',
  '迈阿密大奖赛': 'Miami Grand Prix', '加拿大大奖赛': 'Canadian Grand Prix', '摩纳哥大奖赛': 'Monaco Grand Prix',
  '巴塞罗那大奖赛': 'Barcelona Grand Prix', '奥地利大奖赛': 'Austrian Grand Prix', '英国大奖赛': 'British Grand Prix',
  '比利时大奖赛': 'Belgian Grand Prix', '匈牙利大奖赛': 'Hungarian Grand Prix', '荷兰大奖赛': 'Dutch Grand Prix',
  '意大利大奖赛': 'Italian Grand Prix', '西班牙大奖赛': 'Spanish Grand Prix', '阿塞拜疆大奖赛': 'Azerbaijan Grand Prix',
  '巴林（马来西亚）大奖赛': 'Bahrain Grand Prix in Malaysia', '新加坡大奖赛': 'Singapore Grand Prix',
  '美国大奖赛': 'United States Grand Prix', '墨西哥城大奖赛': 'Mexico City Grand Prix', '巴西大奖赛': 'Brazilian Grand Prix',
  '圣保罗大奖赛': 'São Paulo Grand Prix', '巴林大奖赛': 'Bahrain Grand Prix', '拉斯维加斯大奖赛': 'Las Vegas Grand Prix',
  '卡塔尔大奖赛': 'Qatar Grand Prix', '阿布扎比大奖赛': 'Abu Dhabi Grand Prix',
  '沙特阿拉伯大奖赛': 'Saudi Arabian Grand Prix', '艾米利亚-罗马涅大奖赛': 'Emilia Romagna Grand Prix',
};
// Races added from OpenF1 carry English names; show the Chinese one where it is known.
const GP_ZH = {...Object.fromEntries(Object.entries(GP_EN).map(([zh, en]) => [en, zh])),
  'Brazilian Grand Prix': '巴西大奖赛', 'Spanish Grand Prix': '西班牙大奖赛', 'Bahrain Grand Prix': '巴林大奖赛'};
const gpName = name => (LANG === 'en' ? GP_EN[name] || name : GP_ZH[name] || name);

function applyLanguage() {
  // Static markup carries its English in data-en (text), data-en-label (aria-label) and data-en-title.
  document.documentElement.lang = L('zh-CN', 'en');
  if (LANG === 'en') {
    for (const node of document.querySelectorAll('[data-en]')) node.textContent = node.dataset.en;
    for (const node of document.querySelectorAll('[data-en-html]')) node.innerHTML = node.dataset.enHtml;
    for (const node of document.querySelectorAll('[data-en-label]')) node.setAttribute('aria-label', node.dataset.enLabel);
    for (const node of document.querySelectorAll('[data-en-title]')) node.title = node.dataset.enTitle;
    const title = document.querySelector('meta[name="title-en"]');
    if (title) document.title = title.content;
  }
  const toggle = document.getElementById('langToggle');
  if (toggle) {
    const next = new URLSearchParams(location.search);
    next.set('lang', LANG === 'en' ? 'zh' : 'en');
    toggle.href = `${location.pathname}?${next}${location.hash}`;
    toggle.textContent = LANG === 'en' ? '中文' : 'EN';
    toggle.setAttribute('aria-label', LANG === 'en' ? '切换到中文' : 'Switch to English');
    toggle.lang = LANG === 'en' ? 'zh-CN' : 'en';
    // The page rewrites its query as you explore; switch from the current one, not the one at load.
    toggle.onclick = event => {
      event.preventDefault();
      const query = new URLSearchParams(location.search);
      query.set('lang', LANG === 'en' ? 'zh' : 'en');
      location.href = `${location.pathname}?${query}${location.hash}`;
    };
  }
}

applyLanguage();
