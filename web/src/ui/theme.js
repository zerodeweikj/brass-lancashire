/* 三层主题切换：
   - setTheme(null)     → body.theme-platform（平台壳，暖白）
   - setTheme(gameId)   → body.theme-<gameId>（各游戏 theme.css 提供，如 games/brass/theme.css）
   变量切换由 CSS transition（body 背景/文字 .6s）完成，JS 不逐帧插值。 */
const KNOWN = ['theme-platform', 'theme-brass'];

export function setTheme(gameId) {
  const body = document.body;
  body.classList.remove(...KNOWN);
  body.classList.add(gameId ? 'theme-' + gameId : 'theme-platform');
  body.dataset.theme = gameId || '';
}
