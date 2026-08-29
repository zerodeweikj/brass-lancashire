/**
 * 玩家留言浮层（公开意见箱）。
 * 大厅底部按钮调用 openFeedback() 打开；提交 POST /api/feedback，
 * 成功后 toast 并关闭。支持点遮罩 / × / ESC 关闭。
 * 浮层挂在 document.body，独立于大厅与对局 UI，互不干扰。
 */
import { h, clear, toast } from './dom.js';
import { api } from '../net/api.js';

let layerEl = null;
let escHandler = null;

function closeFeedback() {
  if (!layerEl) return;
  if (escHandler) { document.removeEventListener('keydown', escHandler); escHandler = null; }
  layerEl.remove();
  layerEl = null;
}

export function openFeedback() {
  if (layerEl) { layerEl.style.display = 'flex'; return; }

  const ta = h('textarea.fb-text', {
    placeholder: '说说你的想法：Bug、体验、想要的功能都行～',
    maxlength: 2000,
  });
  const ct = h('input.fb-contact', {
    type: 'text', placeholder: '联系方式（选填，方便回访你）', maxlength: 200,
  });
  const count = h('span.fb-count', null, '0 / 2000');
  ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / 2000`; });

  const submit = async () => {
    const text = ta.value.trim();
    if (!text) { toast('请先写点什么', 'err'); return; }
    try {
      await api.feedback(text, ct.value.trim());
      toast('已收到，谢谢你的意见！', 'ok');
      closeFeedback();
    } catch (e) {
      toast(e.message || '提交失败', 'err', 5000);
    }
  };

  const card = h('div.feedback-card', null,
    h('button.fb-close', { title: '关闭', onclick: closeFeedback }, '×'),
    h('h2', null, '留言 / 提意见'),
    h('div.sub', null, '你的每一条留言都会直接送到开发者手里。'),
    ta,
    ct,
    h('div.fb-foot', null,
      count,
      h('button.ghost', { onclick: closeFeedback }, '取消'),
      h('button.primary', { onclick: submit }, '提交'),
    ),
  );

  layerEl = h('div.feedback-overlay', { onclick: (e) => { if (e.target === layerEl) closeFeedback(); } }, card);
  document.body.appendChild(layerEl);

  escHandler = (e) => { if (e.key === 'Escape') closeFeedback(); };
  document.addEventListener('keydown', escHandler);
  setTimeout(() => ta.focus(), 50);
}
