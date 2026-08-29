/**
 * 单例模态框。行动向导的每一步都复用它，避免堆叠多层弹窗。
 */
import { h, clear } from './dom.js';

export default class Modal {
  constructor(host) {
    this.host = host;
    this.root = null;
    this.onCancel = null;
  }

  get open() { return !!this.root; }

  /**
   * @param {object} o
   * @param {string} o.title    标题
   * @param {string} [o.step]   步骤提示，如 "2 / 4 选择手牌"
   * @param {Node|Node[]} o.body
   * @param {Array<{label:string, kind?:string, disabled?:boolean, onClick:Function}>} [o.actions]
   * @param {boolean} [o.cancelable=true] 是否显示取消并允许 Esc / 点遮罩关闭
   */
  show(o) {
    this.close();
    const box = h('div.box.panel', null,
      h('div.hd', null, o.title, o.step ? h('span.step', null, o.step) : null),
      h('div.bd', null, Array.isArray(o.body) ? o.body : [o.body]),
      h('div.ft', null,
        o.cancelable === false ? null
          : h('button.ghost', { onclick: () => this.cancel() }, '取消'),
        ...(o.actions || []).map((a) => h(`button${a.kind ? `.${a.kind}` : ''}`, {
          disabled: a.disabled, onclick: () => a.onClick(),
        }, a.label)),
      ),
    );
    this.root = h('div#modal', {
      onclick: (e) => { if (e.target === this.root && o.cancelable !== false) this.cancel(); },
    }, box);
    this.cancelable = o.cancelable !== false;
    this.host.appendChild(this.root);
    this._key = (e) => {
      if (e.key === 'Escape' && this.cancelable) this.cancel();
    };
    window.addEventListener('keydown', this._key);
    this.onOpenChange?.(true);   // 弹窗打开：通知宿主禁用地图点击（防穿透）
    return box;
  }

  /** 只替换内容区，不重建外壳（步骤切换时保持位置稳定）。 */
  setBody(body) {
    if (!this.root) return;
    const bd = this.root.querySelector('.bd');
    clear(bd);
    for (const n of [body].flat()) if (n) bd.appendChild(n);
  }

  setActions(actions, cancelable = true) {
    if (!this.root) return;
    const ft = this.root.querySelector('.ft');
    clear(ft);
    this.cancelable = cancelable;
    if (cancelable) ft.appendChild(h('button.ghost', { onclick: () => this.cancel() }, '取消'));
    for (const a of actions || []) {
      ft.appendChild(h(`button${a.kind ? `.${a.kind}` : ''}`, {
        disabled: a.disabled, onclick: () => a.onClick(),
      }, a.label));
    }
  }

  setTitle(title, step) {
    if (!this.root) return;
    const hd = this.root.querySelector('.hd');
    clear(hd);
    hd.appendChild(document.createTextNode(title));
    if (step) hd.appendChild(h('span.step', null, step));
  }

  cancel() {
    const fn = this.onCancel;
    this.close();
    fn?.();
  }

  close() {
    if (this._key) { window.removeEventListener('keydown', this._key); this._key = null; }
    if (this.root) { this.root.remove(); this.root = null; }
    this.onOpenChange?.(false);   // 弹窗关闭：恢复地图点击
  }
}
