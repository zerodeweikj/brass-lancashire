/**
 * 联机会话：身份持久化 + 长轮询同步 + 行动提交。
 *
 * 关键约定（对齐服务端 server/app/rooms.py）：
 * - 客户端只存 token；playerId 由服务端按座位解析，行动里带的 playerId 会被服务端覆盖。
 * - rev = "房间修订.对局版本"，长轮询用它判断「有没有变化」。
 * - 下发的 state 已按视角裁剪：他人 hand 为空、drawPile/undoStack 不下发。
 */
import api, { ApiError } from './api.js';

const LS_KEY = 'lancashire.session.v1';

function loadSaved() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveSaved(obj) {
  try {
    if (obj) localStorage.setItem(LS_KEY, JSON.stringify(obj));
    else localStorage.removeItem(LS_KEY);
  } catch { /* 隐私模式下 localStorage 不可用，忽略 */ }
}

export class Session {
  constructor() {
    this.roomId = null;
    this.token = null;
    this.playerName = '';
    this.room = null;        // room_view 结果
    this.state = null;       // view_for 结果
    this.rev = '';
    this.polling = false;
    this.online = true;
    this.lastError = null;
    this._handlers = {};
    this._abort = null;
    this._pollSeq = 0;

    const saved = loadSaved();
    if (saved) {
      this.roomId = saved.roomId || null;
      this.token = saved.token || null;
      this.playerName = saved.playerName || '';
    }
  }

  // ---------------- 事件 ----------------

  on(evt, fn) {
    (this._handlers[evt] ||= []).push(fn);
    return () => this.off(evt, fn);
  }

  off(evt, fn) {
    const arr = this._handlers[evt];
    if (arr) this._handlers[evt] = arr.filter((f) => f !== fn);
  }

  emit(evt, payload) {
    for (const fn of this._handlers[evt] || []) {
      try { fn(payload); } catch (e) { console.error(`[session] ${evt} 回调异常`, e); }
    }
  }

  // ---------------- 身份 ----------------

  get myPlayerId() { return this.room?.myPlayerId || this.state?.viewerId || null; }
  get isHost() { return !!this.room?.isHost; }
  get isMyTurn() { return !!this.state?.isMyTurn; }
  get me() { return (this.state?.players || []).find((p) => p.id === this.myPlayerId) || null; }
  get inRoom() { return !!(this.roomId && this.token); }
  get inGame() { return !!(this.state && this.room?.status !== 'lobby'); }
  /** 机器人陪练房：房内有服务端机器人，可用作弊补给。 */
  get isBotRoom() { return !!this.room?.bot; }

  _persist() {
    saveSaved(this.roomId && this.token
      ? { roomId: this.roomId, token: this.token, playerName: this.playerName }
      : null);
  }

  _adopt(resp) {
    if (!resp) return;
    if (resp.room) this.room = resp.room;
    if (resp.state !== undefined) this.state = resp.state;
    if (resp.rev) this.rev = resp.rev;
    this.emit('update', this);
  }

  // ---------------- 大厅 ----------------

  async health() { return api.health(); }
  async listRooms() { return (await api.listRooms()).rooms || []; }

  async createRoom(roomName, playerName, withBot = false, password = '') {
    const r = await api.createRoom(roomName, playerName, withBot, password);
    this.roomId = r.room.roomId;
    this.token = r.token;
    this.playerName = playerName;
    this._persist();
    this._adopt(r);
    this.startPolling();
    return r.room;
  }

  async joinRoom(roomId, playerName, password = '') {
    const r = await api.joinRoom(roomId, playerName, password);
    this.roomId = r.room.roomId;
    this.token = r.token;
    this.playerName = playerName;
    this._persist();
    this._adopt(r);
    this.startPolling();
    return r.room;
  }

  async leaveRoom() {
    this.stopPolling();
    if (this.roomId && this.token) {
      try { await api.leaveRoom(this.roomId, this.token); } catch { /* 房间可能已解散 */ }
    }
    this.roomId = this.token = null;
    this.room = this.state = null;
    this.rev = '';
    this._persist();
    this.emit('update', this);
  }

  async setReady(ready) {
    this._adopt(await api.setReady(this.roomId, this.token, ready));
  }

  async start(seed) {
    this._adopt(await api.start(this.roomId, this.token, seed));
  }

  async restart() {
    this._adopt(await api.restart(this.roomId, this.token));
  }

  /** 断线/刷新后凭本地 token 复原；token 失效则清空本地身份。 */
  async resume() {
    if (!this.inRoom) return false;
    try {
      this._adopt(await api.state(this.roomId, this.token, { since: '', wait: 0 }));
      this.startPolling();
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
        this.roomId = this.token = null;
        this._persist();
      }
      return false;
    }
  }

  // ---------------- 同步 ----------------

  startPolling() {
    if (this.polling) return;
    this.polling = true;
    const seq = ++this._pollSeq;
    this._loop(seq);
  }

  stopPolling() {
    this.polling = false;
    this._pollSeq++;
    if (this._abort) { this._abort.abort(); this._abort = null; }
  }

  async _loop(seq) {
    while (this.polling && seq === this._pollSeq && this.inRoom) {
      this._abort = new AbortController();
      try {
        const r = await api.state(this.roomId, this.token, {
          since: this.rev, wait: 25, signal: this._abort.signal,
        });
        if (seq !== this._pollSeq) return;
        if (!this.online) { this.online = true; this.emit('online', true); }
        this.lastError = null;
        if (r.changed || !this.state) this._adopt(r);
        else this.rev = r.rev;
      } catch (e) {
        if (e.name === 'AbortError' || seq !== this._pollSeq) return;
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          // 身份或房间失效：停轮询并通知上层回大厅
          this.polling = false;
          this.roomId = this.token = null;
          this.room = this.state = null;
          this._persist();
          this.emit('kicked', e.message);
          this.emit('update', this);
          return;
        }
        if (this.online) { this.online = false; this.emit('online', false); }
        this.lastError = e.message;
        this.emit('error', e);
        await new Promise((res) => setTimeout(res, 1500));   // 网络抖动，退避重试
      }
    }
  }

  /** 立刻拉一次（提交行动后本地已同步，这里主要给手动刷新用）。 */
  async refresh() {
    if (!this.inRoom) return;
    this._adopt(await api.state(this.roomId, this.token, { since: '', wait: 0 }));
  }

  // ---------------- 行动 ----------------

  /**
   * 提交行动。服务端校验失败不会改状态，返回 { ok:false, code, message, stage }。
   * 无论成功失败都会用返回的 state 覆盖本地视角，保证与服务端一致。
   */
  async submit(action) {
    if (!this.inRoom) throw new Error('尚未加入房间');
    const r = await api.action(this.roomId, this.token, action);
    if (r.state) this.state = r.state;
    if (r.rev) this.rev = r.rev;
    this.emit('update', this);
    if (!r.result?.ok) this.emit('actionFailed', r.result);
    else this.emit('actionOk', r.result);
    return r.result;
  }

  async endTurn() {
    const r = await api.endTurn(this.roomId, this.token);
    this._adopt(r);
    return r;
  }

  /** 陪练房补给：加钱 / 加行动点，用于快速凑齐各行动前置。 */
  async cheat({ money = 0, actionPoints = 0 } = {}) {
    const r = await api.cheat(this.roomId, this.token, { money, actionPoints });
    this._adopt(r);
    return r;
  }

  /** 成本预览：某地点需 coal/iron 时，哪些是免费来源、要向市场买多少钱。 */
  async preview(location, coal = 0, iron = 0) {
    return api.preview(this.roomId, this.token, location, coal, iron);
  }
}

export const session = new Session();
export default session;
