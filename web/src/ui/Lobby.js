/**
 * 大厅：建房 / 找房 / 座位 / 准备 / 开局。
 * 只依赖 session 的房间信息，不碰对局状态。
 */
import { h, clear, toast } from './dom.js';
import { PLAYER_CSS, PLAYER_CN } from '../game/mappings.js';
import { API_BASE, auth } from '../net/api.js';
import { openFeedback } from './Feedback.js';

const LS_NAME = 'lancashire.playerName';

export default class Lobby {
  constructor(host, session) {
    this.host = host;
    this.session = session;
    this.rooms = [];
    this.root = null;
    this.busy = false;
    this.name = localStorage.getItem(LS_NAME) || '';
    this.roomName = '';
    this.roomPwd = '';
    this._timer = null;
  }

  mount() {
    this.root = h('div#lobby');
    this.host.appendChild(this.root);
    this.render();
    this.refreshRooms();
    this._timer = setInterval(() => {
      if (this.root && !this.session.inRoom) this.refreshRooms();
    }, 4000);
  }

  unmount() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this.root) { this.root.remove(); this.root = null; }
  }

  get mounted() { return !!this.root; }

  /** 用户是否正在大厅内某输入框里打字：是则不触发自动重建，避免打断输入。 */
  _typing() {
    const el = (typeof document !== 'undefined') && document.activeElement;
    return !!el && !!this.root && this.root.contains(el)
      && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
  }

  async refreshRooms() {
    try {
      this.rooms = await this.session.listRooms();
      if (this.root && !this.session.inRoom && !this._typing()) this.render();
    } catch (e) {
      /* 服务器未启动时静默，render 里会给出提示 */
      this.rooms = null;
      if (this.root && !this.session.inRoom && !this._typing()) this.render();
    }
  }

  async guard(fn) {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try { await fn(); } catch (e) { toast(e.message || String(e), 'err', 5000); } finally {
      this.busy = false;
      if (this.root) this.render();
    }
  }

  render() {
    if (!this.root) return;
    clear(this.root);
    this.root.appendChild(this.session.inRoom && this.session.room
      ? this._seatView()
      : this._entryView());
    this.root.appendChild(this._feedbackFoot());
  }

  /** 大厅底部常驻的留言入口（进房前/后都可见）。 */
  _feedbackFoot() {
    return h('div.feedback-foot', null,
      h('button.ghost', { onclick: () => openFeedback() }, '留言 / 提意见'),
    );
  }

  // ---------------- 未进房：建房 / 房间列表 ----------------

  _entryView() {
    const nameIn = h('input', {
      placeholder: '你的昵称', value: this.name, maxlength: 16,
      oninput: (e) => { this.name = e.target.value; localStorage.setItem(LS_NAME, this.name); },
    });
    const roomIn = h('input', {
      placeholder: '房间名（可留空）', maxlength: 20, value: this.roomName,
      oninput: (e) => { this.roomName = e.target.value; },
    });
    const pwdIn = h('input', {
      placeholder: '房间密码（可留空，留空则任何人可进）', type: 'password', maxlength: 32,
      value: this.roomPwd,
      oninput: (e) => { this.roomPwd = e.target.value; },
    });
    const codeIn = h('input', { placeholder: '房间号，如 A1B2C3', maxlength: 8 });

    const pickName = () => (this.name.trim() || `玩家${Math.floor(Math.random() * 90 + 10)}`);

    const create = () => this.guard(async () => {
      const nm = pickName();
      this.name = nm; localStorage.setItem(LS_NAME, nm);
      await this.session.createRoom(this.roomName.trim(), nm, !!this.withBot, this.roomPwd.trim());
    });
    const joinById = (rid, requirePwd = false) => this.guard(async () => {
      const nm = pickName();
      this.name = nm; localStorage.setItem(LS_NAME, nm);
      let pwd = '';
      if (requirePwd) {
        pwd = await this._askPassword('「' + rid + '」需要密码');
        if (pwd === null) return;  // 取消
      }
      await this.session.joinRoom(rid.trim().toUpperCase(), nm, pwd);
    });
    const joinByCode = () => this.guard(async () => {
      const rid = codeIn.value.trim().toUpperCase();
      if (!rid) return;
      const nm = pickName();
      this.name = nm; localStorage.setItem(LS_NAME, nm);
      try {
        await this.session.joinRoom(rid, nm, '');
      } catch (e) {
        // 若房间带密码，先尝试进房会被拒，捕获后弹窗要密码再重试
        if (/密码/.test(e.message || '')) {
          const pwd = await this._askPassword('「' + rid + '」需要密码');
          if (pwd === null) return;
          await this.session.joinRoom(rid, nm, pwd);
        } else {
          throw e;
        }
      }
    });
    // 观战（必须登录；密码房同样要密码；不占座位、只读视角）
    const spectateById = (rid, requirePwd = false) => this.guard(async () => {
      let pwd = '';
      if (requirePwd) {
        pwd = await this._askPassword('观战「' + rid + '」需要密码');
        if (pwd === null) return;  // 取消
      }
      await this.session.spectate(rid, pwd);
    });

    let list;
    if (this.rooms === null) {
      list = h('div.empty', null, `连不上服务器（${API_BASE || location.origin}）。请确认已启动后端。`);
    } else if (!this.rooms.length) {
      list = h('div.empty', null, '暂无房间，先创建一个吧。');
    } else {
      list = h('div.roomlist', null, ...this.rooms.map((r) => h('div.roomrow', null,
        h('div', null,
          h('div.rn', null,
            r.hasPassword ? h('span.lock', { title: '需密码' }, '🔒') : null,
            r.name),
          h('div.rm', null, `${r.roomId} · ${r.seatCount}/${r.maxSeats} 人 · ${
            r.status === 'lobby' ? '等待中' : r.status === 'playing' ? '进行中' : '已结束'}${
            r.spectatorCount ? ` · ${r.spectatorCount} 人观战` : ''}`),
        ),
        h('div.rbtns', null,
          h('button.sm', {
            disabled: this.busy || r.status !== 'lobby' || r.seatCount >= r.maxSeats,
            onclick: () => joinById(r.roomId, r.hasPassword),
          }, '加入'),
          h('button.sm.ghost', {
            disabled: this.busy || !auth.isLoggedIn,
            title: auth.isLoggedIn ? '只读观看本房间（不占座位）' : '登录后可观战',
            onclick: () => spectateById(r.roomId, r.hasPassword),
          }, '观战'),
        ),
      )));
    }

    return h('div.box.panel', null,
      h('h1', null, '工业革命·兰开夏'),
      h('div.sub', null, '局域网联机 · 2~4 人 · 完整运河与铁路两个时代'),
      h('div.grid', null,
        h('div.sec', null,
          h('h3', null, '① 昵称'),
          h('div.field', null, nameIn),
          h('h3', null, '② 创建房间'),
          h('div.field', null, roomIn),
          h('div.field', { style: { marginTop: '6px' } }, pwdIn),
          h('button.primary', { style: { marginTop: '6px' }, disabled: this.busy, onclick: create }, '创建'),
          h('label.chk', {
            style: { display: 'block', marginTop: '6px', fontSize: '13px', color: 'var(--muted)' },
          },
            h('input', { type: 'checkbox', onchange: (e) => { this.withBot = e.target.checked; } }),
            ' 带机器人房主（自动跳过陪练，满员自动开局）'),
          h('h3', null, '③ 或输入房间号加入'),
          h('div.field', null, codeIn,
            h('button', {
              disabled: this.busy,
              onclick: joinByCode,
            }, '加入')),
          h('div.lanhint', null,
            '同一局域网的其他设备，浏览器打开 ',
            h('code', null, `${location.origin}`),
            ' 即可加入同一局。',
          ),
        ),
        h('div.sec', null,
          h('h3', null, '房间列表'),
          list,
          h('div', { style: { marginTop: '8px' } },
            h('button.sm.ghost', { onclick: () => this.refreshRooms() }, '刷新列表')),
        ),
      ),
    );
  }

  /** 弹出一个密码输入框，返回 Promise<密码字符串|null>（null=取消）。 */
  _askPassword(title) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (val) => {
        if (done) return;
        done = true;
        overlay.remove();
        resolve(val);
      };
      const inp = h('input.pwd-input', {
        type: 'password', placeholder: '输入房间密码', maxlength: 32, autofocus: 'autofocus',
        oninput: (e) => { inp.value = e.target.value; },
        onkeydown: (e) => { if (e.key === 'Enter') okBtn.click(); },
      });
      const okBtn = h('button.primary', { onclick: () => finish(inp.value) }, '确定');
      const cancelBtn = h('button', { onclick: () => finish(null) }, '取消');
      const overlay = h('div.pwd-overlay', {
        onclick: (e) => { if (e.target === overlay) finish(null); },
      }, h('div.pwd-card', null,
        h('div.pwd-title', null, title),
        h('div.field', null, inp),
        h('div', { style: { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '10px' } },
          cancelBtn, okBtn),
      ));
      document.body.appendChild(overlay);
      setTimeout(() => inp.focus(), 0);
    });
  }

  // ---------------- 已进房：座位与准备 ----------------

  _seatView() {
    const room = this.session.room;
    if (this.session.isSpectator) return this._spectatorView(room);
    const seats = room.seats || [];
    const me = seats.find((s) => s.isMe);
    const allReady = seats.length >= 2 && seats.every((s) => s.ready);

    const rows = seats.map((s) => {
      const av = s.avatar || (s.isBot ? '🤖' : '');   // 登录玩家显示账号头像，机器人固定，游客不显示
      return h('div.seat', {
        style: { borderLeftColor: PLAYER_CSS[s.color] || '#888' },
      },
      h('div.nm', null, av ? h('span.sv-av', { text: av }) : null, `${s.name}`),
      h('div.tag', null, `${PLAYER_CN[s.color] || s.color}方 · ${s.playerId}`),
      s.isMe ? h('div.tag.ready', null, '你') : null,
      h('div.tag' + (s.ready ? '.ready' : ''), null, s.ready ? '已准备' : '未准备'),
      );
    });

    for (let i = seats.length; i < (room.maxSeats || 4); i++) {
      rows.push(h('div.seat', { style: { opacity: .45 } }, h('div.nm', null, '空座位')));
    }

    return h('div.box.panel', null,
      h('h1', null, room.name),
      h('div.sub', null,
        `房间号 ${room.roomId} · ${seats.length}/${room.maxSeats} 人`,
        this.session.isHost ? ' · 你是房主' : '',
      ),
      h('div.seats', null, ...rows),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', {
          disabled: this.busy,
          onclick: () => this.guard(() => this.session.setReady(!me?.ready)),
        }, me?.ready ? '取消准备' : '准备'),
        this.session.isHost
          ? h('button.primary', {
            disabled: this.busy || !allReady,
            title: allReady ? '' : '至少 2 人且全部准备后才能开始',
            onclick: () => this.guard(() => this.session.start()),
          }, '开始游戏')
          : h('button', { disabled: true }, '等待房主开始'),
        h('div', { style: { flex: 1 } }),
        h('button.warn', {
          disabled: this.busy,
          onclick: () => this.guard(() => this.session.leaveRoom()),
        }, '离开房间'),
      ),
      h('div.lanhint', null,
        '把这个地址发给同局域网的队友：',
        h('code', null, location.origin),
        '，他们在房间列表里选 ',
        h('code', null, room.roomId),
        ' 加入即可。',
      ),
      // 房间聊天挂载点（ChatPanel 实例由 app 搬移到这里，消息区持久不丢草稿）
      this.chatDockEl = h('div.chatdock-slot'),
    );
  }

  // ---------------- 观战等待视图（对局未开始；开局后 app.sync 自动切到对局 HUD） ----------------

  _spectatorView(room) {
    const seats = room.seats || [];
    const specs = room.spectators || [];
    return h('div.box.panel', null,
      h('h1', null, room.name),
      h('div.sub', null,
        `房间号 ${room.roomId} · ${seats.length}/${room.maxSeats} 人 · `,
        h('span.spec-badge', null, '观战中'),
        ' · 等待开局',
      ),
      h('div.seats', null,
        ...seats.map((s) => {
          const av = s.avatar || (s.isBot ? '🤖' : '');
          return h('div.seat', { style: { borderLeftColor: PLAYER_CSS[s.color] || '#888' } },
            h('div.nm', null, av ? h('span.sv-av', { text: av }) : null, `${s.name}`),
            h('div.tag', null, `${PLAYER_CN[s.color] || s.color}方 · ${s.playerId}`),
            h('div.tag' + (s.ready ? '.ready' : ''), null, s.ready ? '已准备' : '未准备'),
          );
        }),
      ),
      specs.length ? h('div.spec-list', null,
        h('div.tag', null, `观众（${specs.length}）`),
        h('div.spec-names', null, specs.map((sp) =>
          h('span.spec-name' + (sp.isMe ? '.me' : ''), null,
            sp.avatar ? h('span.sv-av', { text: sp.avatar }) : null,
            (sp.name || '观众') + (sp.isMe ? '（你）' : '')),
        )),
      ) : null,
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '8px' } },
        h('button.warn', {
          disabled: this.busy,
          onclick: () => this.guard(() => this.session.leaveRoom()),
        }, '退出观战'),
      ),
      this.chatDockEl = h('div.chatdock-slot'),
    );
  }
}
