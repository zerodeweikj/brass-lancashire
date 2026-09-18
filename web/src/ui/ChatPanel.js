/**
 * 房间聊天面板（玩家 + 观众共用；大厅等待阶段与对局中均可用）。
 *
 * 设计要点：
 * - root 为持久元素，mount(parent) 只是搬移挂载点（大厅/对局两处布局复用同一实例）；
 * - 消息区随 session.room.chatMsgs 重建，输入行永不重建 —— 正在打字时新消息到达
 *   不会丢草稿、不会抢焦点；
 * - 观众发言由服务端打 role='spectator'，前端渲染【观战】标识；
 * - 用户内容一律 textContent 注入，防 XSS。
 */
import { h, clear, toast } from './dom.js';

const MAX_LEN = 200;   // 与后端 CHAT_TEXT_MAX 一致

export default class ChatPanel {
  constructor(session) {
    this.session = session;
    this._lastCount = 0;
    this._stickBottom = true;   // 用户回翻历史时暂不强制吸底

    this.msgs = h('div.cp-msgs');
    this.input = h('input.cp-input', {
      maxlength: MAX_LEN, placeholder: '发送消息…（Enter 发送）',
      onkeydown: (e) => { if (e.key === 'Enter') this._send(); },
      oninput: () => { this._draft = this.input.value; },
    });
    this.sendBtn = h('button.cp-send', { onclick: () => this._send() }, '发送');
    this.root = h('div#chatdock.panel', null,
      h('div.cp-head', null, '房间聊天'),
      this.msgs,
      h('div.cp-row', null, this.input, this.sendBtn),
    );
  }

  /** 搬移挂载点（el 为 null 时仅暂存不报错）。 */
  mount(el) {
    if (el && this.root.parentNode !== el) el.appendChild(this.root);
  }

  unmount() { this.root.remove(); }

  /** 按 session.room.chatMsgs 重渲消息区（输入行不动）。 */
  update() {
    const list = (this.session.room && this.session.room.chatMsgs) || [];
    // 用户回翻时不吸底；贴底状态下新消息自动滚到底
    const nearBottom = this.msgs.scrollHeight - this.msgs.scrollTop - this.msgs.clientHeight < 40;
    this._stickBottom = nearBottom || list.length > this._lastCount && this._stickBottom;
    clear(this.msgs);
    if (!list.length) {
      this.msgs.appendChild(h('div.cp-empty', null, '还没有消息，来打个招呼吧。'));
    } else {
      for (const m of list) {
        const time = new Date((m.ts || 0) * 1000);
        const hh = String(time.getHours()).padStart(2, '0');
        const mm = String(time.getMinutes()).padStart(2, '0');
        this.msgs.appendChild(h('div.cp-msg' + (m.role === 'spectator' ? '.spec' : ''), null,
          h('span.cp-meta', null,
            m.role === 'spectator' ? h('span.cp-tag', { text: '观战' }) : null,
            h('span.cp-name', { text: m.from || '玩家' }),
            h('span.cp-time', null, `${hh}:${mm}`),
          ),
          h('div.cp-text', { text: m.text || '' }),
        ));
      }
    }
    this._lastCount = list.length;
    if (this._stickBottom) this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  async _send() {
    const text = (this.input.value || '').trim();
    if (!text) return;
    this.sendBtn.disabled = true;
    try {
      await this.session.chat(text);
      this.input.value = '';
      this._draft = '';
      this._stickBottom = true;   // 自己发言后吸底
    } catch (e) {
      toast(e.message || '发送失败', 'err', 3000);
    } finally {
      this.sendBtn.disabled = false;
      this.input.focus();
    }
  }
}
