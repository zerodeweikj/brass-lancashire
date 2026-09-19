/**
 * coverPush 封面推近模板：大厅卡片封面 FLIP 放大至全屏 + 主题切换 + 淡出揭幕。
 *
 * 要点（对照设计 6.3）：
 * - FLIP 只动 transform/opacity；rAF 触发类名/样式；cubic-bezier(.22,.61,.36,1)
 * - 主题切换交 CSS 变量过渡（setTheme 换 body class，body 背景 .6s 平滑插值）
 * - hero.webp 加载失败 → 纯色淡入 300ms 降级，绝不白屏
 * - 结束移除 will-change
 * - DOM 契约：#stage-transition.st-coverpush
 */
import { h } from '../dom.js';
import { setTheme } from '../theme.js';

const FLIP_MS = 520;
const EASE = 'cubic-bezier(.22,.61,.36,1)';
const REVEAL_MS = 200;

function loadImage(src, timeoutMs = 2500) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    const timer = setTimeout(() => { img.src = ''; resolve(null); }, timeoutMs);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = src;
  });
}

/** 计算把 rect 放大铺满全屏所需的 translate+scale（保持中心对齐）。 */
function flipTransform(rect) {
  const vw = window.innerWidth, vh = window.innerHeight;
  const scale = Math.max(vw / rect.width, vh / rect.height);
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const dx = vw / 2 - cx, dy = vh / 2 - cy;
  return `translate(${dx}px, ${dy}px) scale(${scale})`;
}

/**
 * 大厅 → 房间列表。
 * cardEl：被点击的游戏卡（取其中封面图做 FLIP 起点）。
 * resolve 时机：封面已放大遮满全屏——此时 mount 目标页，随后淡出揭幕。
 */
export async function enter(cardEl, manifest) {
  const tr = manifest.transition || {};
  const accent = tr.accent || '#14181f';
  const hero = await loadImage(`/games/${manifest.gameId}/hero.webp`);

  const coverImg = cardEl?.querySelector?.('.gh-cover');
  const rect = (coverImg || cardEl)?.getBoundingClientRect?.();

  // 降级：无卡片起点或 hero 加载失败 → 纯色淡入
  if (!rect || rect.width === 0) {
    return plainFade(manifest, accent, hero);
  }

  return new Promise((resolve) => {
    const bg = h('div.st-bg', { style: { background: hero ? '' : accent } });
    if (hero) {
      hero.className = 'st-hero';
      hero.style.opacity = '0';
      bg.appendChild(hero);
    }
    const clone = h('img.st-clone', {
      src: coverImg ? coverImg.src : `/games/${manifest.gameId}/cover.webp`,
      alt: '', draggable: false,
      style: {
        left: rect.left + 'px', top: rect.top + 'px',
        width: rect.width + 'px', height: rect.height + 'px',
        willChange: 'transform, opacity',
      },
    });
    const stage = h('div#stage-transition.st-coverpush', null, bg, clone);
    document.body.appendChild(stage);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        clone.style.transition = `transform ${FLIP_MS}ms ${EASE}, opacity ${FLIP_MS}ms ease`;
        clone.style.transform = flipTransform(rect);
        if (hero) {
          hero.style.transition = `opacity ${FLIP_MS + 200}ms ease`;
          hero.style.opacity = '1';
        } else {
          bg.style.transition = `opacity ${FLIP_MS}ms ease`;
          bg.style.opacity = '1';
        }
        setTheme(manifest.gameId);   // 主题色过渡在封面下方同步进行

        setTimeout(() => {
          resolve();                 // 已遮满：可 mount 目标页
          stage.style.transition = `opacity ${REVEAL_MS}ms ease`;
          stage.style.opacity = '0';
          clone.style.willChange = 'auto';
          setTimeout(() => stage.remove(), REVEAL_MS + 40);
        }, FLIP_MS + 80);
      });
    });
  });
}

/** 纯色淡入 300ms 降级（hero 缺失/卡片不可见）。 */
function plainFade(manifest, accent, hero) {
  return new Promise((resolve) => {
    const stage = h('div#stage-transition.st-coverpush.st-plain', {
      style: { background: accent, opacity: '0' },
    });
    if (hero) { hero.className = 'st-hero'; stage.appendChild(hero); }
    document.body.appendChild(stage);
    requestAnimationFrame(() => {
      stage.style.transition = 'opacity 300ms ease';
      stage.style.opacity = '1';
      setTheme(manifest.gameId);
      setTimeout(() => {
        resolve();
        stage.style.opacity = '0';
        setTimeout(() => stage.remove(), 340);
      }, 300);
    });
  });
}

/**
 * 房间列表 → 对局（重过渡）：hero 全屏淡入 → 停留（遮住素材加载）→ resolve → 淡出。
 * onProgress(0..1)：调用方可回报加载进度，进度未满则延长停留（上限 holdMax）。
 */
export async function enterMatch(manifest, onProgress) {
  const tr = manifest.transition || {};
  const accent = tr.accent || '#14181f';
  const hero = await loadImage(`/games/${manifest.gameId}/hero.webp`);
  const holdMs = Math.min(Math.max(tr.duration || 1500, 800), 2600);

  return new Promise((resolve) => {
    const stage = h('div#stage-transition.st-coverpush.st-match', {
      style: { background: accent, opacity: '0' },
    });
    if (hero) { hero.className = 'st-hero'; stage.appendChild(hero); }
    const title = h('div.st-title', { text: manifest.name || '' });
    stage.appendChild(title);
    document.body.appendChild(stage);

    requestAnimationFrame(() => {
      stage.style.transition = 'opacity 380ms ease';
      stage.style.opacity = '1';
      setTheme(manifest.gameId);
      onProgress?.(0.3);
      setTimeout(() => {
        onProgress?.(1);
        resolve();                   // 揭幕权交给调用方：对局首帧就绪后再淡出
        stage.style.transition = `opacity ${REVEAL_MS}ms ease`;
        stage.style.opacity = '0';
        setTimeout(() => stage.remove(), REVEAL_MS + 40);
      }, holdMs);
    });
  });
}
