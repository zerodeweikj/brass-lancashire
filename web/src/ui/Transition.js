/**
 * Transition：平台层进场/离场动效调度器。
 *
 * 模板播放器——只认 manifest.transition { template, duration, accent }，
 * 具体表现由 transitions/<template>.js 实现（首个模板：coverPush 封面推近）。
 * 所有模板共享的降级策略在这里统一处理：
 *   - prefers-reduced-motion: reduce  → ≤150ms 纯淡入，无缩放位移
 *   - 缺 transition 块 / 模板不存在  → 纯色淡入 300ms
 *   - 美术加载失败                  → 模板内部回退纯色（见 coverPush）
 *
 * 动效期间全屏过渡层 pointer-events:auto 吃掉所有点击，天然防重复触发；
 * resolve 时机 = 过渡层已遮满全屏（此时可安全 mount 目标页），随后淡出揭幕。
 */
import { setTheme } from './theme.js';
import * as coverPush from './transitions/coverPush.js';

const TEMPLATES = { coverPush };

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; }
  catch { return false; }
}

/** 纯色淡入淡出兜底：绝不白屏。total≈(fadeIn+fadeOut)ms。 */
function fadeThrough(accent, themeGameId, fadeIn = 300, fadeOut = 200) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.id = 'stage-transition';
    el.className = 'st-fade';
    el.style.background = accent || '#14181f';
    document.body.appendChild(el);
    requestAnimationFrame(() => {
      el.style.transition = `opacity ${fadeIn}ms ease`;
      el.style.opacity = '1';
      setTimeout(() => {
        if (themeGameId !== undefined) setTheme(themeGameId);
        resolve();                     // 已遮满，可 mount 目标页
        el.style.transition = `opacity ${fadeOut}ms ease`;
        el.style.opacity = '0';
        setTimeout(() => el.remove(), fadeOut + 40);
      }, fadeIn);
    });
  });
}

/** reduced-motion 快速通道：≤150ms 淡入，无位移缩放。 */
function reducedFade(accent, themeGameId) {
  return fadeThrough(accent, themeGameId, 150, 120);
}

function pickTemplate(manifest) {
  const tr = manifest?.transition;
  if (!tr || !tr.template || !TEMPLATES[tr.template]) return null;
  return TEMPLATES[tr.template];
}

export const Transition = {
  /** 大厅 → 房间列表：封面推近（快过渡）。resolve 时可 mount Lobby。 */
  enterGame(cardEl, manifest) {
    if (prefersReducedMotion()) return reducedFade(manifest?.transition?.accent, manifest?.gameId);
    const tpl = pickTemplate(manifest);
    if (!tpl) return fadeThrough('#14181f', manifest?.gameId);
    return tpl.enter(cardEl, manifest);
  },

  /** 房间列表 → 对局：宽幅 hero 揭幕（重过渡）。resolve 时可开始对局初始化。 */
  enterMatch(manifest, onProgress) {
    if (prefersReducedMotion()) return reducedFade(manifest?.transition?.accent, manifest?.gameId);
    const tpl = pickTemplate(manifest);
    if (!tpl) return fadeThrough('#14181f', manifest?.gameId);
    return tpl.enterMatch(manifest, onProgress);
  },

  /** 对局/房间列表 → 大厅：反向过渡，主题切回平台壳。 */
  exitToLobby() {
    if (prefersReducedMotion()) return reducedFade('#F6F3EE', null);
    return fadeThrough('#F6F3EE', null, 300, 200);
  },
};

export default Transition;
