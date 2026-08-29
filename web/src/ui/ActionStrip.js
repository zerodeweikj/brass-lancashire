/**
 * 行动向导条：固定在手牌区右侧，替代原来挡住地图的 Modal 弹窗。
 * 支持标题、内容区、底部操作按钮、取消回调。
 *
 * 内容较多时向导条会向下生长（超出手牌行高度）并覆盖地图上沿，因此它与 Modal 一样
 * 必须通过 onOpenChange 联动宿主禁用 Phaser 输入 —— Phaser 在 window 级捕获鼠标事件，
 * 否则「点向导条」会穿透命中底下的地图槽位（详见 Modal.onOpenChange 与穿透回归测试）。
 */
import { h, clear } from './dom.js';

export default class ActionStrip {
  constructor() {
    this.el = h('div#actionstrip.panel');
    this._title = h('div.as-title');
    this._body = h('div.as-body');
    this._foot = h('div.as-foot');
    this.el.appendChild(this._title);
    this.el.appendChild(this._body);
    this.el.appendChild(this._foot);
    this._onCancel = null;
    this._open = false;
    this.onOpenChange = null;   // (open:boolean) => void，由宿主注入
    this._keyHandler = (e) => {
      if (e.key === 'Escape' && this._onCancel) {
        e.preventDefault();
        e.stopPropagation();
        this._onCancel();
      }
    };
  }

  mount(parent) {
    if (this.el.parentNode !== parent) parent.appendChild(this.el);
    document.addEventListener('keydown', this._keyHandler);
  }

  unmount() {
    document.removeEventListener('keydown', this._keyHandler);
    this.el.remove();
    if (this._open) { this._open = false; this.onOpenChange?.(false); }
  }

  /** 以内部标记为准（不读 computedStyle：元素未挂载时 computedStyle 不可靠）。 */
  get open() { return this._open; }

  /**
   * @param {object} opts
   * @param {string} [opts.title]
   * @param {Node|string|null} [opts.body]
   * @param {Array<{label:string, cls?:string, disabled?:boolean, onClick:()=>void}>} [opts.actions]
   * @param {boolean} [opts.cancelable=true]  false 时隐藏取消按钮（用于 pendingSupplement 等强制等待）
   * @param {()=>void} [opts.onCancel]
   */
  show(opts = {}) {
    this._setTitle(opts.title || '');
    this._setBody(opts.body != null ? opts.body : null);
    this._setActions(opts.actions || [], opts.cancelable !== false);
    this._onCancel = opts.onCancel || null;
    this.el.style.display = 'flex';
    if (!this._open) { this._open = true; this.onOpenChange?.(true); }
  }

  close() {
    this.el.style.display = 'none';
    this._onCancel = null;
    if (this._open) { this._open = false; this.onOpenChange?.(false); }
  }

  setTitle(title) { this._setTitle(title); }
  setBody(body) { this._setBody(body); }
  setActions(actions, cancelable = true) { this._setActions(actions, cancelable); }

  _setTitle(text) {
    clear(this._title);
    this._title.appendChild(document.createTextNode(text));
    this._title.style.display = text ? '' : 'none';
  }

  _setBody(body) {
    clear(this._body);
    if (body == null) {
      this._body.style.display = 'none';
      return;
    }
    this._body.style.display = '';
    if (body instanceof Node) this._body.appendChild(body);
    else this._body.appendChild(h('div', { text: String(body) }));
  }

  _setActions(actions, cancelable) {
    clear(this._foot);
    for (const a of actions) {
      const cls = ['as-btn'];
      if (a.cls) cls.push(...a.cls.split(' '));
      const btn = h(`button.${cls.join('.')}`, {
        disabled: !!a.disabled,
        onclick: (e) => { e.stopPropagation(); a.onClick(); },
      }, a.label);
      this._foot.appendChild(btn);
    }
    if (cancelable) {
      this._foot.appendChild(h('button.as-btn.ghost', {
        onclick: (e) => { e.stopPropagation(); this._onCancel?.(); },
      }, '取消'));
    }
    this._foot.style.display = (actions.length || cancelable) ? '' : 'none';
  }
}
