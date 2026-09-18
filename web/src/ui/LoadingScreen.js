/**
 * BGA 风格等待画面：
 *  - 全屏半透明毛玻璃背景
 *  - 顶部游戏标题 / 副标题
 *  - 中央游戏盒封面图
 *  - 底部进度条 + 状态文案
 *  - 保留「取消准备」按钮（玩家点准备后、房主开局前可取消）
 */
import { h, clear } from './dom.js';

export default class LoadingScreen {
  constructor(host) {
    this.host = host;
    this.root = null;
    this._dots = 0;
    this._dotTimer = null;
  }

  mount() {
    if (this.root) return;
    this.root = h('div#loadingscreen', { style: { display: 'none' } });
    this.host.appendChild(this.root);
  }

  unmount() {
    this._stopDots();
    if (this.root) { this.root.remove(); this.root = null; }
    this._lastKey = null;
    this._onCancelReady = null;
  }

  show({ message, sub = '', progress = null, onCancelReady = null } = {}) {
    this.mount();
    if (!this.root) return;
    const key = JSON.stringify({ message, sub, hasCancel: !!onCancelReady });
    const wasHidden = this.root.style.display === 'none';
    // 避免每次 sync 都清空重建：内容相同时只更新进度/文案，防止点击时按钮被移除
    if (!wasHidden && this._lastKey === key) {
      this.setMessage(message);
      if (progress != null) this.setProgress(progress);
      this._onCancelReady = onCancelReady;
      return;
    }
    this._lastKey = key;
    this._onCancelReady = onCancelReady;
    clear(this.root);
    this.root.style.display = 'flex';

    this.root.appendChild(
      h('div.ls-backdrop', null,
        h('div.ls-vignette'),
        h('div.ls-content', null,
          h('div.ls-header', null,
            h('div.ls-title', null, '工业革命·兰开夏'),
            h('div.ls-sub', null, sub || 'Brass: Lancashire'),
          ),
          h('div.ls-box', null,
            h('img.ls-cover', { src: 'assets/cover.webp', alt: 'Brass: Lancashire 封面' }),
          ),
          h('div.ls-footer', null,
            h('div.ls-bar', null,
              h('div.ls-progress', { style: { width: progress == null ? '100%' : `${Math.max(0, Math.min(100, progress))}%` } }),
            ),
            h('div.ls-msg', null, message || '正在准备…'),
            onCancelReady
              ? h('button.ls-cancel', { onclick: () => this._onCancelReady?.() }, '取消准备')
              : null,
          ),
          // 聊天挂载点：等待画面盖住大厅时，房间聊天搬到遮罩之上（房主开局即 ready，必须能聊天）
          (this.chatEl = h('div.ls-chatdock')),
        ),
      ),
    );

    this._startDots();
  }

  hide() {
    this._stopDots();
    if (this.root) {
      this.root.style.display = 'none';
      this._lastKey = null;
    }
  }

  setMessage(msg) {
    const el = this.root?.querySelector('.ls-msg');
    if (el) el.textContent = msg || '正在准备…';
  }

  setProgress(pct) {
    const el = this.root?.querySelector('.ls-progress');
    if (el) el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  /** 在等待画面底部追加行动按钮（如房主的「开始游戏」）。 */
  setActions(actions) {
    const foot = this.root?.querySelector('.ls-footer');
    if (!foot) return;
    // 移除旧 action 容器（保留 msg/bar/cancel）
    const old = foot.querySelector('.ls-actions');
    if (old) old.remove();
    if (!actions || !actions.length) return;
    const wrap = h('div.ls-actions', {
      style: {
        display: 'flex', gap: '10px', flexWrap: 'wrap',
        justifyContent: 'center', marginTop: '6px',
      },
    });
    for (const a of actions) {
      const cls = ['ls-action'];
      if (a.cls === 'primary') cls.push('primary');
      wrap.appendChild(h(`button.${cls.join('.')}`, {
        onclick: () => a.onClick?.(),
      }, a.label));
    }
    foot.appendChild(wrap);
  }

  _startDots() {
    this._stopDots();
    this._dots = 0;
    const el = this.root?.querySelector('.ls-msg');
    if (!el) return;
    const base = el.textContent.replace(/[.]{0,3}$/, '').trim();
    this._dotTimer = setInterval(() => {
      this._dots = (this._dots + 1) % 4;
      el.textContent = base + '.'.repeat(this._dots);
    }, 520);
  }

  _stopDots() {
    if (this._dotTimer) { clearInterval(this._dotTimer); this._dotTimer = null; }
  }
}
