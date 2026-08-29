/**
 * 极简 DOM 构造工具（不引第三方框架，保持构建产物小、离线可跑）。
 */

/**
 * h('div.cls#id', { onclick, title, disabled, html }, ...children)
 * children 可以是字符串、节点、数组、null（自动跳过）。
 */
export function h(spec, props, ...children) {
  const m = /^([a-zA-Z0-9-]+)?((?:[.#][\w-]+)*)$/.exec(spec) || [];
  const tag = m[1] || 'div';
  const el = document.createElement(tag);
  for (const tk of (m[2] || '').match(/[.#][\w-]+/g) || []) {
    if (tk[0] === '.') el.classList.add(tk.slice(1));
    else el.id = tk.slice(1);
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'checked') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(4)) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** 金额显示统一带 £ */
export const money = (n) => `£${n ?? 0}`;

/** 简易气泡提示（右上角，几秒后消失） */
let toastHost = null;
export function toast(text, kind = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = h('div.toast-host');
    document.body.appendChild(toastHost);
  }
  const t = h(`div.toast.toast-${kind}`, null, text);
  toastHost.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, ms);
  return t;
}
