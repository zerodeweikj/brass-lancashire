/**
 * 应用编排：把「联机会话」「Phaser 棋盘」「DOM 界面」串起来。
 *
 * 分工：
 *   session   —— 唯一数据来源（长轮询拿服务器视角状态），不含规则
 *   GameScene —— 只按 state 画棋盘，并把地图点击回传
 *   Lobby/Hud —— 只按 state 画界面，并把按钮点击回传
 *   本文件    —— 行动向导（选目标 → 选牌 → 确认 → 提交），提交后一切以服务器返回为准
 */
import { h, toast, money } from './ui/dom.js';
import Modal from './ui/Modal.js';
import Lobby from './ui/Lobby.js';
import GameHub from './ui/GameHub.js';
import Hud from './ui/Hud.js';
import LoadingScreen from './ui/LoadingScreen.js';
import AuthScreen from './ui/AuthScreen.js';
import ChatPanel from './ui/ChatPanel.js';
import Transition from './ui/Transition.js';
import { setTheme } from './ui/theme.js';
import session from './net/session.js';
import api, { auth } from './net/api.js';
import { MAT_KEY_CN, PLAYER_CSS, ACTION_CN } from './game/mappings.js';

const LS_NAME = 'lancashire.playerName';

const pairKey = (a, b) => [a, b].sort().join('|');

export default class App {
  constructor(game) {
    this.game = game;
    this.session = session;
    this.scene = null;
    this.static = { cards: [], locations: [], incomeTrack: null };
    this.locById = {};
    this.flow = null;          // 当前进行中的行动向导
    this.lastGameOverShown = false;

    this.host = h('div#ui');
    document.body.appendChild(this.host);
    this.modal = new Modal(this.host);
    // 覆盖层打开时禁用 Phaser 输入：Phaser 在 window 级监听鼠标事件，点击 DOM 覆盖层会穿透
    // 命中底下地图槽位（onMouseDownWindow 只跳过 canvas 自身，不跳过 UI 层）。
    // Modal（结算表）与 ActionStrip（行动向导条，内容多时会向下盖住地图上沿）共用同一开关，
    // 任一打开即禁用地图点击，全部关闭才恢复。
    this.modal.onOpenChange = () => this._syncMapInput();
    this.lobby = new Lobby(this.host, session);
    // 平台大厅（选游戏）：点击后的动效与路由回本类处理
    this.hub = new GameHub(this.host, session, {
      onEnterGame: (m, cardEl) => this.enterGameLobby(m, cardEl),
      onAiRoom: (m, cardEl) => this.enterAiRoom(m, cardEl),
      onJoinedRoom: (room) => this.onJoinedFromHub(room),
      onOpenAuth: () => this.authScreen.openLogin(),
    });
    this._entering = false;   // 进场动效进行中（过渡层已吃点击，这里是双保险）
    this.lobby.onExitToHub = () => this.exitToHub();
    this.loading = new LoadingScreen(this.host);
    this.hud = new Hud(this.host, {
      onAction: (k, arg) => this.startFlow(k, arg),
      onUndo: () => this.submit({ type: 'undo' }, '撤回'),
      onUndoAll: () => this.submit({ type: 'undoAll' }, '整回合撤回'),
      onEndTurn: () => this.doEndTurn(),
      onRefresh: () => this.session.refresh().catch((e) => toast(e.message, 'err')),
      onLeave: () => this.leave(),
      onCancel: () => this.cancelFlow(),
      onCheat: (kind, amount) => this.session.cheat(kind === 'money' ? { money: amount } : { actionPoints: amount }),
      onZoomIn: () => this.scene?.zoomBy?.(1.15),
      onZoomOut: () => this.scene?.zoomBy?.(1 / 1.15),
      onPZoomIn: () => this.hud?.pZoomBy?.(1),
      onPZoomOut: () => this.hud?.pZoomBy?.(-1),
      onMapScrollX: (r) => this.scene?.setScrollRatioX?.(r),
      onMapScrollY: (r) => this.scene?.setScrollRatioY?.(r),
    });
    this.hud.setStripOpenChange(() => this._syncMapInput());
    // 账号 UI：右上角账号条 + 登录/注册/设置弹层
    this.authOpen = false;
    this.authScreen = new AuthScreen(this.host, this.session, {
      onLoggedIn: (u) => this.onLoggedIn(u),
      onLoggedOut: () => this.onLoggedOut(),
      onOverlayChange: (open) => this.setAuthOpen(open),
    });
    // 房间聊天（玩家+观众共用；持久实例，随布局在大厅/对局两处挂载点间搬移）
    this.chat = new ChatPanel(this.session);
  }

  /** 账号弹层打开时禁用 Phaser 地图点击，防事件穿透（与 Modal / 行动向导条共用同一开关）。 */
  setAuthOpen(open) {
    this.authOpen = open;
    this._syncMapInput();
  }

  /** 登录成功后：若当前已在某房间（游客身份），把座位绑定到账号。 */
  onLoggedIn() {
    if (this.session.inRoom && this.session.roomId && this.session.token) {
      auth.bindRoom(this.session.roomId, this.session.token).catch(() => { /* 非关键 */ });
    }
  }

  onLoggedOut() {
    // 账号条已由 AuthScreen 重绘；房间座位保留（刷新仍凭房间身份回本局）
  }

  /** 启动判态：有 token 则恢复登录态，刷新页面不掉登录。 */
  async restoreAuth() {
    if (!auth.isLoggedIn) return;
    try {
      const r = await auth.me();
      if (r.authenticated && r.user) { auth.save(auth.token, r.user); this.authScreen.renderBar(); }
      else auth.clear();
    } catch {
      auth.clear();
    }
  }

  /** 任一 DOM 覆盖层（结算 Modal / 行动向导条）打开时禁用地图点击，防事件穿透。
   *  强制拆板抵债期间行动向导条虽打开，但地图仍需可点（点板块抵债），故放行。 */
  _syncMapInput() {
    if (!this.game?.input) return;
    const forecloseOpen = !!(this.hud.stripOpen && this._forecloseKey);
    this.game.input.enabled = !(this.modal.open || (this.hud.stripOpen && !forecloseOpen) || this.authOpen);
  }

  // ---------------- 启动 ----------------

  async boot() {
    // 进站落点：未进房 → 平台大厅（选游戏）；有房间身份（刷新重连）→ 直接房间大厅。
    // 大厅立即挂载，用户无需等待 Phaser 场景就绪（场景注册是异步的）。
    if (this.session.inRoom) this.lobby.mount();
    else { setTheme(null); this.hub.mount(); }

    // 启动判态：本地有登录 token 则恢复账号（刷新页面不掉登录）
    this.restoreAuth();

    this.session.on('update', () => this.sync());
    this.session.on('online', (v) => this.hud.setOnline(v));
    this.session.on('kicked', (m) => { toast(m || '你已离开该房间', 'err', 5000); this.sync(); });
    this.session.on('error', () => { /* 长轮询抖动由 online 事件体现 */ });

    try {
      const sd = await api.staticData();
      this.static = sd;
      this.locById = Object.fromEntries((sd.locations || []).map((l) => [l.id, l]));
      this.hud.setStatic(sd);
    } catch (e) {
      toast(`静态数据加载失败：${e.message}`, 'err', 6000);
    }

    // 场景可能在 new Phaser.Game 之后才异步注册，这里轮询等待并绑定回调。
    this._wireScene();

    try { await this.session.resume(); } catch (e) { /* 身份失效回大厅，sync 兜底 */ }
    this.sync();
  }

  /** 等待 GameScene 注册并就绪，再绑定地图点击与状态渲染。 */
  _wireScene() {
    const sc = this.game.scene.getScene('GameScene');
    if (!sc) { setTimeout(() => this._wireScene(), 60); return; }
    this.scene = sc;
    const bind = () => {
      sc.onPick = (payload) => this.onMapPick(payload);
      sc.onScrollChange = (s) => this.hud.setMapScroll?.(s);
      sc._notifyScroll?.();
      if (this.session.state) sc.setState(this.session.state);
      if (this.flow) this._reapplyFlow();
    };
    if (sc.ready) bind();
    else sc.events.once('scene-ready', bind);
  }

  /** 场景延迟就绪时，把进行中的行动选择态重新下发给棋盘。 */
  _reapplyFlow() {
    const f = this.flow;
    if (!f) return;
    if (f.kind === 'build' || f.kind === 'doubleBuild') {
      this.scene.setPicker({ kind: 'build', builds: f.opts });
    } else if (f.kind === 'road') {
      this.scene.setPicker({ kind: 'road', links: f.opts });
    } else if (f.kind === 'sell') {
      this.scene.setPicker({ kind: 'sell', mills: f.mills });
    }
  }

  /** 依据会话状态决定「显示大厅」还是「显示对局」。 */
  sync() {
    const s = this.session;
    const playing = s.inRoom && s.room && s.room.status !== 'lobby' && s.state;

    if (playing) {
      this.loading.hide();
      if (this.hub.mounted) this.hub.unmount();
      if (this.lobby.mounted) this.lobby.unmount();
      setTheme(s.gameId || s.room?.gameId || 'brass');
      this.hud.mount();
      this.hud.update(s.state, s.room);
      this.scene?.setState(s.state);
      // 房间聊天挂到右栏挂载点（观战模式同样可用）
      this.chat.mount(this.hud.nodes.chatdock);
      this.chat.update();
      // HUD 挂载后把当前滚动状态推给滚动条（默认整图可见 → 滚动条置灰禁用）。
      if (this.hud.mounted) this.scene?._notifyScroll?.();
      // 刷新/断线重连后，若服务端还挂着待补市场状态 → 重新弹出选择（防向导条丢失）
      if (s.state?.isMyTurn && s.state?.pendingSupplement && !this.hud.stripOpen) {
        this.promptSupplement(s.state.pendingSupplement);
      }
      // 售卖会话（官方步骤 4）同样需要恢复「继续/结束」选择（防 ActionStrip 丢失）
      if (s.state?.isMyTurn && s.state?.pendingSell && !this.hud.stripOpen) {
        this.showSellContinue();
      }
      // 强制拆板抵债：轮到欠债者时弹出向导（地图点击自己的板块）
      if (s.state?.pendingForeclose && s.state?.isMyTurn) {
        const key = s.state.pendingForeclose.pid + ':' + s.state.pendingForeclose.remaining;
        if (this._forecloseKey !== key) {
          this._forecloseKey = key;
          this.promptForeclose(s.state.pendingForeclose);
        }
      } else if (this._forecloseKey) {
        // 抵债结束 / 轮到他人：收起拆板向导
        this._forecloseKey = null;
        this.cancelFlow();
      }
      // 一笔勾销弹窗「算你好彩」
      this.checkForecloseForgiven(s.state);
      // 轮到别人时清掉残留的选择态
      if (!s.state.isMyTurn && this.flow) this.cancelFlow();
      this.checkGameOver(s.state);
    } else if (s.inRoom || s.gameId) {
      // 游戏房间列表层（含已进房）：挂该游戏主题
      if (this.hud.mounted) { this.hud.unmount(); this.scene?.setState(null); }
      if (this.hub.mounted) this.hub.unmount();
      setTheme(s.gameId || s.room?.gameId || 'brass');
      if (!this.lobby.mounted) this.lobby.mount();
      else this.lobby.render();
      this.lastGameOverShown = false;
      // 大厅内已进房（含观战等待）：聊天挂到大厅挂载点；未进房则收起
      if (s.inRoom && this.lobby.chatDockEl) {
        this.chat.mount(this.lobby.chatDockEl);
        this.chat.update();
      } else {
        this.chat.unmount();
      }
      // 玩家点准备后、房主开局前：显示 BGA 风格等待画面
      this._syncLoadingScreen();
    } else {
      // 平台大厅（选游戏）：暖白壳
      if (this.hud.mounted) { this.hud.unmount(); this.scene?.setState(null); }
      if (this.lobby.mounted) this.lobby.unmount();
      this.loading.hide();
      this.chat.unmount();
      setTheme(null);
      if (!this.hub.mounted) this.hub.mount();
      this.lastGameOverShown = false;
    }
  }

  /** 在「已进房未开局」状态下，若自己已准备则覆盖等待画面。 */
  _syncLoadingScreen() {
    const s = this.session;
    if (!s.inRoom || !s.room || s.room.status !== 'lobby') {
      this.loading.hide();
      return;
    }
    const me = (s.room.seats || []).find((x) => x.isMe);
    if (me?.ready) {
      const allReady = s.room.seats.length >= 2 && s.room.seats.every((x) => x.ready);
      const isHost = s.isHost;
      const message = isHost
        ? (allReady ? '全部玩家已准备，点击下方按钮开局' : '已准备，等待其他玩家…')
        : (allReady ? '全部玩家已准备，等待房主开局…' : '已准备，等待其他玩家…');
      this.loading.show({
        message,
        sub: 'Brass: Lancashire',
        progress: allReady ? 90 : 55,
        onCancelReady: () => {
          this.session.setReady(false).catch((e) => toast(e.message, 'err'));
        },
      });
      // 等待画面盖住大厅期间，把房间聊天搬到遮罩之上（否则房主开局即 ready，永远点不到发送）
      if (this.loading.chatEl) this.chat.mount(this.loading.chatEl);
      // 房主在全部准备后需要能从等待画面直接开局
      if (isHost && allReady) {
        this.loading.setActions?.([
          {
            label: '开始游戏', cls: 'primary',
            onClick: () => this.session.start().catch((e) => toast(e.message, 'err')),
          },
        ]);
      }
    } else {
      this.loading.hide();
    }
  }

  async leave() {
    if (this.session.isSpectator) {
      if (!confirm('确定退出观战吗？再次观战可随时从大厅房间列表进入。')) return;
    } else if (!confirm('确定离开房间吗？对局进度会保留在服务器上；若只是意外断线或刷新页面，重开本页会凭本地身份自动回到本局（无需房主同意）。主动离开则会释放你的座位。')) return;
    this.cancelFlow();
    await this.session.leaveRoom();
    this.sync();
  }

  // ---------------- 平台大厅路由（GameHub ↔ 房间列表） ----------------

  /** 大厅点「进入游戏」：封面推近动效 → 落到该游戏房间列表。 */
  async enterGameLobby(manifest, cardEl) {
    if (this._entering) return;
    this._entering = true;
    try {
      this.session.gameId = manifest.gameId;
      await Transition.enterGame(cardEl, manifest);   // resolve 时过渡层已遮满
      this.sync();                                    // 过渡层下 mount 房间列表
    } finally {
      this._entering = false;
    }
  }

  /** 大厅点「AI 陪练房」：动效 → 直接建该游戏的机器人陪练房并进房（游客可用）。 */
  async enterAiRoom(manifest, cardEl) {
    if (this._entering) return;
    this._entering = true;
    try {
      const name = (auth.user?.displayName || localStorage.getItem(LS_NAME) || '').trim()
        || `玩家${Math.floor(Math.random() * 90 + 10)}`;
      localStorage.setItem(LS_NAME, name);
      this.session.gameId = manifest.gameId;
      await Transition.enterGame(cardEl, manifest);
      await this.session.createRoom('', name, true, '', manifest.gameId);
      // createRoom 内部 _adopt 会 emit update → sync 落到已进房的房间大厅
    } catch (e) {
      toast(e.message || '创建陪练房失败', 'err');
      this.sync();
    } finally {
      this._entering = false;
    }
  }

  /** 大厅顶栏房号加入成功：落到该房间所属游戏的房间列表。 */
  async onJoinedFromHub(room) {
    const gid = room?.gameId || 'brass';
    this.session.gameId = gid;
    let manifest = null;
    try { manifest = (await this.session.games()).find((g) => g.gameId === gid) || null; } catch { /* 用纯色降级 */ }
    if (manifest) await Transition.enterGame(null, manifest);   // 无卡片起点 → 纯色淡入
    else setTheme(gid);
    this.sync();
  }

  /** 房间列表顶部「返回大厅」：离开房间（如有）→ 反向过渡 → 平台大厅。 */
  async exitToHub() {
    if (this._entering) return;
    if (this.session.inRoom) {
      await this.leave();                  // 内含 confirm；用户取消则留在房间
      if (this.session.inRoom) return;
    }
    this._entering = true;
    try {
      this.session.gameId = '';
      await Transition.exitToLobby();
      this.sync();
    } finally {
      this._entering = false;
    }
  }

  get state() { return this.session.state; }

  // ---------------- 提交 ----------------

  async submit(action, label) {
    try {
      const r = await this.session.submit(action);
      if (r?.ok) {
        this.cancelFlow();
        // 建造铁/煤厂后服务端暂停回合，等待玩家选择「补入市场 / 留在板块上」
        if (r.detail?.needSupplement) {
          this.promptSupplement(r.detail.needSupplement);
          return true;
        }
        // 售卖会话（官方步骤 4）：还有可售棉花厂 → 询问继续/结束
        if (r.detail?.needSellContinue) {
          this.showSellContinue();
          return true;
        }
        // 远方市场命中 X：视为跳过（不翻棉花厂、无收入）
        if (r.detail?.skipped) {
          toast('远方市场命中 X：本次售卖视为跳过（不翻棉花厂、无收入）', 'warn', 4200);
          return true;
        }
        // 强制拆板抵债：仍需继续拆除下一块
        if (r.detail?.foreclose) {
          this.promptForeclose(r.detail.foreclose);
          return true;
        }
        toast(`${label || ACTION_CN[action.type] || '行动'}成功${r.message ? `：${r.message}` : ''}`, 'ok', 2200);
        return true;
      }
      toast(`${label || ''}失败：${r?.message || '未知原因'}`, 'err', 5200);
      // 失败时若服务端仍挂着待补市场状态（如版本过期），把选择向导条还回来
      if (this.state?.pendingSupplement && this.state?.isMyTurn && !this.hud.stripOpen) {
        this.promptSupplement(this.state.pendingSupplement);
      }
      return false;
    } catch (e) {
      toast(`提交失败：${e.message}`, 'err', 5200);
      if (this.state?.pendingSupplement && this.state?.isMyTurn && !this.hud.stripOpen) {
        this.promptSupplement(this.state.pendingSupplement);
      }
      return false;
    }
  }

  /** 建造产铁/煤厂后的补充市场抉择（2026-08-11 用户规定：必须由玩家选择，不能默认补入）。 */
  promptSupplement(need) {
    const resName = need.resource === 'iron' ? '铁' : '煤';
    const flipNote = need.willFlip
      ? '全部卖出 → 板块翻面并获翻面奖励（收入轨前进）'
      : `市场只能容纳 ${need.put} 单位，剩 ${need.qty - need.put} 单位留在板块上（不翻面）`;
    this.hud.clearHandSelectable();
    this.scene?.setPicker(null);
    this.hud.setHint(null);
    this.hud.showStrip({
      title: `补充${resName}到市场？`,
      cancelable: false,          // 引擎处于 pendingSupplement，必须先做选择
      body: h('div.as-bill', null,
        h('div', null, `刚建好的${resName}厂产出 ${need.qty} 单位${resName}。`),
        h('div', null, `补入市场：${need.put} 单位移入市场，立即得 ${money(need.gain)}。`),
        h('div.as-note', null, flipNote),
      ),
      actions: [
        { label: `补入市场 +${money(need.gain)}`, cls: 'primary',
          onClick: () => this.submit({ type: 'supplement_market', supply: true }, '补充市场') },
        { label: '留在板块上', onClick: () => this.submit({ type: 'supplement_market', supply: false }, '留板') },
      ],
    });
  }

  /** 强制拆板抵债向导（轮末收入为负且无力支付时触发，引擎挂起 pendingForeclose）。
   *  玩家在地图上点击【自己】的一块产业板块进行拆除抵债；地图高亮自己的板块。 */
  promptForeclose(pend) {
    this._forecloseKey = pend.pid + ':' + pend.remaining;
    const st = this.state;
    const p = (st.players || []).find((x) => x.id === pend.pid);
    const tiles = (p?.industryTiles || []).map((t) => ({
      tileId: t.id, location: t.location, slotIndex: t.slotIndex,
      level: t.level, industry: t.industry,
    }));
    this.hud.clearHandSelectable();
    this.scene?.setPicker({ kind: 'foreclose', tiles });
    this.hud.setHint('你收入为负且无力支付，请点击你自己的产业板块进行拆除抵债');
    this.hud.showStrip({
      title: '强制拆板抵债',
      cancelable: false,          // 引擎处于 pendingForeclose，必须先拆板
      body: h('div.as-bill', null,
        h('div', null, '你本轮收入为负且无力支付，需拆除自己的产业板块抵债。'),
        h('div.as-note', null, `尚欠 ${money(pend.remaining)}：每拆一块，其建造费用的一半（向下取整）用于还债，多余部分归你。`),
        h('div.as-note', null, '若所有板块拆光仍不足以抵债，则按 1 分=1 钱 扣分；分数扣到 0 仍不足则一笔勾销。'),
      ),
      actions: [],
    });
  }

  /** 一笔勾销弹窗「算你好彩」（拆光+扣分仍不足抵债时触发）。 */
  checkForecloseForgiven(st) {
    const fg = st?.forecloseForgiven;
    if (!fg) return;
    const key = `${st.phase}-${st.round}-${fg.pid}`;
    if (this._forgivenShown?.has(key)) return;
    (this._forgivenShown ||= new Set()).add(key);
    this.cancelFlow();
    const name = (st.players || []).find((p) => p.id === fg.pid)?.name || fg.pid;
    this.modal.onCancel = null;
    this.modal.show({
      title: '算你好彩',
      body: h('div.as-bill', null,
        h('div', null, `${name} 已无产业可拆，分数也扣到 0 仍不足以抵债——`),
        h('div.as-note', null, '本局剩余债务一笔勾销，算你走运！'),
        h('div.as-note', { style: 'margin-top:6px;opacity:.72' }, '本局债务已由国家兜底。'),
      ),
      cancelable: false,
      actions: [{ label: '国补干嘛不薅？', kind: 'primary', onClick: () => this.modal.close() }],
    });
  }

  async doEndTurn() {
    try {
      await this.session.endTurn();
      this.cancelFlow();
    } catch (e) { toast(e.message, 'err', 4200); }
  }

  // ---------------- 行动向导框架 ----------------

  cancelFlow() {
    this.flow = null;
    this._resPick = null;
    this._forecloseKey = null;
    this.modal.close();
    this.hud.closeStrip();
    this.hud.clearHandSelectable();
    this.scene?.drawRoute?.(null);
    this.scene?.setPicker(null);
    this.hud.setHint(null);
  }

  startFlow(kind, arg) {
    this.cancelFlow();
    const st = this.state;
    if (!st?.isMyTurn) return;
    // 售卖会话未结束：只允许继续出售或结束（其他行动被引擎拒绝）
    if (st.pendingSell && kind !== 'sell') {
      toast('请先结束当前售卖行动', 'err');
      this.showSellContinue();
      return;
    }
    this.flow = { kind };
    switch (kind) {
      case 'build': return this.flowBuild(false);
      case 'doubleBuild': return this.flowBuild(true);
      case 'road': return this.flowRoad();
      case 'develop': return this.flowDevelop();
      case 'sell': return this.flowSell();
      case 'loan': return this.flowLoan(arg);
      case 'skip': return this.flowSkip();
      default: return this.cancelFlow();
    }
  }

  onMapPick(payload) {
    // 强制拆板抵债：引擎处于 pendingForeclose，此时 this.flow 已被 cancelFlow 清空，
    // 故 foreclose 必须绕过 flow 守卫，直接走拆除提交。
    if (payload.kind === 'foreclose') { this.onForecloseTile(payload.tileId); return; }
    const f = this.flow;
    if (!f) return;
    if (payload.kind === 'build') this.onBuildSlot(payload.options);
    else if (payload.kind === 'road') this.onRoadLink(payload.link);
    else if (payload.kind === 'sell') this.onSellMill(payload.mill);
    else if (payload.kind === 'resource') this.onResourcePick(payload.tileId);
  }

  onForecloseTile(tileId) {
    if (!this.state?.pendingForeclose) return;
    this.submit({ type: 'foreclose_tile', tileId }, '拆除抵债');
  }

  /**
   * 通用选牌步骤（2026-08-11 起走 ActionStrip + 左侧手牌高亮，不再用 Modal 弹窗）：
   * 左侧手牌区点亮可选牌供玩家直接点选，右侧向导条显示说明与「下一步」。
   * filter(cardId) 决定哪些牌可用；选满 count 张后「下一步」才可点。
   */
  pickCards({ title, count, filter, note, onDone, okLabel = '下一步' }) {
    const st = this.state;
    const me = (st.players || []).find((p) => p.id === st.viewerId);
    const hand = me?.hand || [];
    const allowed = hand.map((c, i) => (filter ? filter(c) : true) ? i : -1).filter((i) => i >= 0);
    if (!allowed.length) {
      toast(count > 1 ? '手牌不足以完成这次行动' : '没有可用于这次行动的手牌', 'err', 4200);
      return this.cancelFlow();
    }
    if (count > allowed.length) {
      toast(`需要 ${count} 张可用手牌，你只有 ${allowed.length} 张`, 'err', 4200);
      return this.cancelFlow();
    }
    // 选牌阶段不需要地图：清掉选择态高亮，避免误点地图改变已选目标
    this.scene?.setPicker(null);
    this.hud.setHint(null);

    const tip = count > 1
      ? `请在左侧点选 ${count} 张手牌（弃置后驱动本次行动）`
      : '请在左侧点选 1 张要弃置的手牌';
    const render = (sel) => {
      this.hud.setStripBody(h('div.as-pick', null,
        note ? h('div.as-note', null, note) : null,
        h('div.as-hint', null, tip),
        h('div.as-picked', null, sel.length
          ? `已选 ${sel.length}/${count}：${sel.map((i) => this.hud.cardLabel(hand[i])).join('、')}`
          : '尚未选择（选好后可点其他手牌更换）'),
      ));
      this.hud.setStripActions([{
        label: okLabel, cls: 'primary', disabled: sel.length !== count,
        onClick: () => { if (sel.length === count) onDone(sel.map((i) => hand[i])); },
      }], true);
    };

    this.hud.showStrip({ title, cancelable: true, onCancel: () => this.cancelFlow(), body: null, actions: [] });
    this.hud.setHandSelectable({
      count,
      filter: (id) => (filter ? !!filter(id) : true),
      onChange: (sel) => render(sel),
      onCancel: () => this.cancelFlow(),
    });
    render([]);
  }

  /** 通用确认步骤（ActionStrip 费用清单 + 确认按钮）。 */
  confirm({ title, lines, onOk, okLabel = '确认执行' }) {
    // 进入确认阶段后退出选牌态：手牌不再可点，避免"确认内容与实际选择不一致"
    this.hud.clearHandSelectable();
    this.scene?.setPicker(null);
    this.hud.setHint(null);
    this.hud.showStrip({
      title,
      cancelable: true,
      onCancel: () => this.cancelFlow(),
      body: h('div.as-bill', null, ...lines.flat().filter(Boolean).map((l) => h('div', null, l))),
      actions: [{ label: okLabel, cls: 'primary', onClick: onOk }],
    });
  }

  /**
   * 地图选源：需要消耗铁/煤时，玩家在地图上点击对应建筑选择来源（而非系统代选）。
   * 同一建筑可重复点击以消耗多个单位（最多其板上剩余）；总量凑满即自动完成。
   * onDone(picked)：picked 为来源对象数组，同一建筑消耗 n 个单位会重复出现 n 次
   * （tileId 按次数展开，供引擎按 preferred 逐次消耗）。
   */
  startResourcePick({ kind, amount, sources, onDone }) {
    if (amount <= 0) return onDone([]);
    const usable = (sources || []).filter((s) => (s.remaining || 0) > 0);
    if (usable.length <= 1) return onDone(usable.length ? [usable[0]] : []);
    // 进入地图选源态：必须收起所有覆盖层与手牌选择态 —— 否则 Modal 遮罩盖住地图无法点击建筑，
    // 且向导条开启期间地图输入被禁用（防穿透联动），玩家根本点不到铁厂/煤厂。
    this.modal.close();
    this.hud.closeStrip();
    this.hud.clearHandSelectable();
    this._resPick = { kind, needed: amount, usable, alloc: {}, onDone };
    this._renderResPick();
  }

  _renderResPick() {
    const rp = this._resPick;
    if (!rp) return;
    const total = Object.values(rp.alloc).reduce((a, b) => a + b, 0);
    const cn = rp.kind === 'iron' ? '铁厂' : '煤厂';
    this.scene?.setPicker({ kind: 'resource', resKind: rp.kind, sources: rp.usable, alloc: rp.alloc });
    this.hud.setHint(`请在地图上点击${cn}选择要消耗的来源（可重复点同一座取多个）：已选 ${total} / ${rp.needed}`
      + (rp.kind === 'coal' ? '；仅与你路网相连的煤厂可选' : ''));
  }

  onResourcePick(tileId) {
    const rp = this._resPick;
    if (!rp) return;
    const src = rp.usable.find((s) => s.tileId === tileId);
    if (!src) return;
    const total = Object.values(rp.alloc).reduce((a, b) => a + b, 0);
    if (total >= rp.needed) return;
    if ((rp.alloc[tileId] || 0) >= (src.remaining || 0)) return;
    rp.alloc[tileId] = (rp.alloc[tileId] || 0) + 1;
    this._renderResPick();
    if (Object.values(rp.alloc).reduce((a, b) => a + b, 0) >= rp.needed) this._finishResPick();
  }

  _finishResPick() {
    const rp = this._resPick;
    if (!rp) return;
    this._resPick = null;
    this.scene?.setPicker(null);
    this.hud.setHint(null);
    const picked = [];
    for (const s of rp.usable) {
      const c = rp.alloc[s.tileId] || 0;
      for (let i = 0; i < c; i++) picked.push(s); // 同建筑消耗多个 → tileId 重复展开
    }
    rp.onDone(picked);
  }

  billLines(bill, base) {
    const out = [];
    if (base !== undefined) out.push(`基础花费：${money(base)}`);
    if (!bill) return out;
    if (bill.coalFree || bill.coalBuy) {
      out.push(`煤：免费取用 ${bill.coalFree}，市场采购 ${bill.coalBuy}（${money(bill.coalCost)}）`);
    }
    if (bill.ironFree || bill.ironBuy) {
      out.push(`铁：免费取用 ${bill.ironFree}，市场采购 ${bill.ironBuy}（${money(bill.ironCost)}）`);
    }
    return out;
  }

  // ---------------- 建造 ----------------

  flowBuild(double) {
    const st = this.state;
    const opts = (double ? st.legalDoubleBuilds : st.legalBuilds) || [];
    if (!opts.length) { toast('当前没有可建造的位置', 'err'); return this.cancelFlow(); }
    this.flow = { kind: double ? 'doubleBuild' : 'build', double, opts };
    this.scene?.setPicker({ kind: 'build', builds: opts });
    this.hud.setHint(double
      ? '双牌建造：在地图上点击目标槽位（可突破运输网限制，消耗 2 行动点 + 2 张手牌）'
      : '建造：在地图上点击高亮的目标槽位');
  }

  onBuildSlot(options) {
    const f = this.flow;
    if (!f || (f.kind !== 'build' && f.kind !== 'doubleBuild')) return;
    if (options.length === 1) return this.buildChooseCards(options[0]);

    this.hud.showStrip({
      title: `${this.locName(options[0].location)} 槽位 ${options[0].slotIndex + 1} · 选择要建造的产业`,
      cancelable: true,
      onCancel: () => this.cancelFlow(),
      body: h('div.opts', null, ...options.map((o) => h('div.as-opt', {
        onclick: () => this.buildChooseCards(o),
      },
      h('div', null, `${o.level} 级${o.industry}`),
      h('div.as-tag', null,
        `合计 ${money(o.totalMoney)}`,
        o.bill?.coalBuy ? ` · 含市场买煤 ${money(o.bill.coalCost)}` : '',
        o.bill?.ironBuy ? ` · 含市场买铁 ${money(o.bill.ironCost)}` : '',
      ),
      ))),
      actions: [],
    });
  }

  buildChooseCards(opt) {
    const f = this.flow;
    const double = !!f.double;
    const cardDefs = Object.fromEntries((this.static.cards || []).map((c) => [c.id, c]));
    // netOk=false：该落点不在自有运输网内，只有「该城市牌」能驱动（产业牌须走运输网）
    const netOk = opt.netOk !== false;
    const filter = double ? null : (id) => {
      const c = cardDefs[id];
      if (!c) return false;
      if (c.type === 'city') return c.city === opt.location;
      return netOk && c.industry === opt.industry;
    };
    this.pickCards({
      title: `${double ? '双牌建造' : '建造'} · ${this.locName(opt.location)} ${opt.level} 级${opt.industry}`,
      count: double ? 2 : 1,
      filter,
      note: double
        ? '双牌建造：任意 2 张手牌，可在运输网之外落子，消耗 2 个行动点。'
        : (netOk
          ? `可用手牌：${this.locName(opt.location)} 城市牌，或${opt.industry}产业牌。`
          : `${this.locName(opt.location)} 不在你的运输网内，只能用该城市牌驱动建造。`),
      onDone: (cards) => this.buildConfirm(opt, cards),
    });
  }

  buildConfirm(opt, cards) {
    const ironNeeded = (opt.cost && opt.cost.iron) || 0;
    this.startResourcePick({
      kind: 'iron', amount: ironNeeded, sources: this.state.ironSources,
      onDone: (picked) => this._confirmBuild(opt, cards, picked),
    });
  }

  /** 按建筑分组展示消耗明细（同一建筑消耗多个 → 「×N」）。 */
  _groupPicked(picked) {
    const grp = new Map();
    for (const s of picked) {
      if (!grp.has(s.tileId)) grp.set(s.tileId, []);
      grp.get(s.tileId).push(s);
    }
    return [...grp.values()];
  }

  _confirmBuild(opt, cards, picked) {
    const ironFrom = picked.map((s) => s.tileId);
    const groups = this._groupPicked(picked);
    const ironTxt = groups.map((arr) =>
      `${this.locName(arr[0].location)} ${arr[0].level}级铁厂${arr.length > 1 ? ` ×${arr.length}` : ''}`).join('、');
    this.confirm({
      title: '确认建造',
      lines: [
        `位置：${this.locName(opt.location)} · 槽位 ${opt.slotIndex + 1}`,
        `建筑：${opt.level} 级${opt.industry}`,
        ...this.billLines(opt.bill, opt.cost?.money ?? 0),
        `合计支出：${money(opt.totalMoney)}`,
        `弃牌：${cards.map((c) => this.hud.cardLabel(c)).join('、')}`,
        this.flow.double ? '消耗 2 个行动点' : '消耗 1 个行动点',
        ironFrom.length ? `消耗铁厂：${ironTxt}` : '消耗铁：全部从市场购买',
      ],
      onOk: () => this.submit({
        type: this.flow.double ? 'doubleBuild' : 'build',
        location: opt.location,
        slotIndex: opt.slotIndex,
        industry: opt.industry,
        cardIds: cards,
        ironFrom,
      }, this.flow.double ? '双牌建造' : '建造'),
    });
  }

  // ---------------- 修路 ----------------

  flowRoad() {
    const st = this.state;
    const opts = st.legalLinks || [];
    if (!opts.length) { toast('当前没有可修建的连结', 'err'); return this.cancelFlow(); }
    this.flow = { kind: 'road', picked: [], opts };
    this.scene?.setPicker({ kind: 'road', links: opts });
    this.hud.setHint(st.phase === 'canal'
      ? '修运河：点击高亮的连结位置（£3）'
      : '修铁路：点击高亮的连结位置（1 条 £5+1煤 / 2 条 £15+2煤）');
  }

  onRoadLink(link) {
    const f = this.flow;
    if (!f || f.kind !== 'road') return;
    const st = this.state;
    if (st.phase === 'canal') {
      f.picked = [link];
      return this.roadChooseCards();
    }
    if (!f.picked.length) {
      f.picked = [link];
      this.hud.showStrip({
        title: `已选：${this.locName(link.from)} — ${this.locName(link.to)} · 铁路时代可一次修两条`,
        cancelable: true,
        onCancel: () => this.cancelFlow(),
        body: h('div.as-bill', null,
          h('div', null, `只修这一条：${money(5)} + 1 煤（合计约 ${money(link.totalMoney)}）`),
          h('div', null, `一次修两条：${money(15)} + 2 煤（煤优先取免费煤厂，不足按市场价补买）`),
        ),
        actions: [
          { label: '只修这一条', onClick: () => { this.hud.closeStrip(); this.roadChooseCards(); } },
          {
            label: '再选第二条',
            cls: 'primary',
            onClick: () => {
              this.hud.closeStrip();
              const cands = this.secondRailCandidates(link);
              if (!cands.length) { toast('没有可作为第二条的相邻铁路位置', 'err'); return this.roadChooseCards(); }
              this.scene?.setPicker({ kind: 'road', links: cands });
              this.hud.setHint('请点击第二条铁路的位置（与第一条或你的运输网相接）');
            },
          },
        ],
      });
      return;
    }
    f.picked.push(link);
    this.roadChooseCards();
  }

  /** 第二条铁路的候选：未被占用、当代相邻，且触到第一条端点或本就是合法落点。 */
  secondRailCandidates(first) {
    const st = this.state;
    const occupied = new Set();
    for (const p of st.players || []) {
      for (const l of p.linkTiles || []) occupied.add(pairKey(l.endpoints[0], l.endpoints[1]));
    }
    occupied.add(pairKey(first.from, first.to));
    const legal = new Set((st.legalLinks || []).map((l) => pairKey(l.from, l.to)));
    const out = [];
    for (const lp of this.scene.linkPoints || []) {
      const [a, b] = lp.cities;
      const k = pairKey(a, b);
      if (occupied.has(k)) continue;
      const la = this.locById[a];
      if (!la || !(la.rail_adj || []).includes(b)) continue;
      const touches = a === first.from || a === first.to || b === first.from || b === first.to;
      if (touches || legal.has(k)) out.push({ from: a, to: b, type: 'rail', totalMoney: 15 });
    }
    return out;
  }

  roadChooseCards() {
    const f = this.flow;
    const n = f.picked.length;
    const st = this.state;
    const base = st.phase === 'canal' ? 3 : (n === 1 ? 5 : 15);
    const coal = st.phase === 'canal' ? 0 : (n === 1 ? 1 : 2);
    this.scene?.setPicker(null);
    this.hud.setHint(null);
    this.pickCards({
      title: `修${st.phase === 'canal' ? '运河' : '铁路'} · ${
        f.picked.map((l) => `${this.locName(l.from)}—${this.locName(l.to)}`).join(' + ')}`,
      count: 1,
      filter: null,
      note: `修路可弃任意 1 张手牌。基础 ${money(base)}${coal ? ` + ${coal} 煤` : ''}。`,
      onDone: (cards) => this.roadConfirm(cards, base, coal),
    });
  }

  /** 修路用煤：只高亮与道路端点（共享路网）相连的煤厂，与引擎 pay_coal 语义一致。 */
  async roadConfirm(cards, base, coal) {
    const f = this.flow;
    let coalSources = this.state.coalSources || [];
    if (coal > 0 && f.picked?.length) {
      try {
        const anchors = [...new Set(f.picked.flatMap((l) => [l.from, l.to]))];
        const best = new Map();
        for (const a of anchors) {
          const pv = await this.session.preview(a, coal, 0);
          for (const s of pv.coalSources || []) {
            const prev = best.get(s.tileId);
            if (!prev || (s.distance ?? 99) < prev.distance) best.set(s.tileId, s);
          }
        }
        if (best.size) coalSources = [...best.values()];
      } catch (e) { /* 预览失败退回全局煤源，引擎仍会按道路校验 */ }
      // 预览期间玩家可能已取消整个行动（cancelFlow 清掉了 flow），此时不要再弹选源态
      if (!this.flow || this.flow.kind !== 'road') return;
    }
    this.startResourcePick({
      kind: 'coal', amount: coal, sources: coalSources,
      onDone: (picked) => this._confirmRoad(cards, base, coal, picked),
    });
  }

  _confirmRoad(cards, base, coal, picked) {
    const f = this.flow;
    const single = f.picked.length === 1 ? f.picked[0] : null;
    const coalFrom = picked.map((s) => s.tileId);
    const groups = this._groupPicked(picked);
    const coalTxt = groups.map((arr) =>
      `${this.locName(arr[0].location)} ${arr[0].level}级煤厂${arr.length > 1 ? ` ×${arr.length}` : ''}`).join('、');
    // 运河时代修路不需要煤，确认框不应出现任何煤相关文本
    const coalLines = coal > 0 ? [
      `基础花费：${money(base)}，需要 ${coal} 煤`,
      single && single.totalMoney !== undefined
        ? `预计合计支出：${money(single.totalMoney)}`
        : '煤优先从相连煤厂免费取用，不足部分按市场价自动补买。',
      picked.length ? `消耗煤厂：${coalTxt}` : '消耗煤：全部从市场购买',
    ] : [
      `基础花费：${money(base)}`,
      single && single.totalMoney !== undefined ? `预计合计支出：${money(single.totalMoney)}` : null,
    ];
    this.confirm({
      title: '确认修路',
      lines: [
        `连结：${f.picked.map((l) => `${this.locName(l.from)} — ${this.locName(l.to)}`).join('、')}`,
        ...coalLines.filter(Boolean),
        `弃牌：${cards.map((c) => this.hud.cardLabel(c)).join('、')}`,
      ],
      onOk: () => this.submit({
        type: 'road',
        links: f.picked.map((l) => ({ from: l.from, to: l.to })),
        cardId: cards[0],
        coalFrom,
      }, '修路'),
    });
  }

  // ---------------- 发展 ----------------

  flowDevelop() {
    const st = this.state;
    const me = (st.players || []).find((p) => p.id === st.viewerId);
    const avail = [];
    for (const [key, levels] of Object.entries(me?.mat || {})) {
      const have = Object.entries(levels).filter(([, c]) => c > 0).map(([l]) => Number(l));
      if (have.length) avail.push({ key, cn: MAT_KEY_CN[key] || key, level: Math.min(...have) });
    }
    if (!avail.length) { toast('面板上没有可丢弃的板块', 'err'); return this.cancelFlow(); }

    const sel = [];   // 多选集：存 avail 索引，可重复（同一产业可选多次）
    // 引擎限制：一次最多丢 min(2, 面板剩余板块总数)
    const totalTiles = Object.values(me?.mat || {})
      .reduce((s, lv) => s + Object.values(lv).reduce((a, b) => a + b, 0), 0);
    const maxN = Math.min(2, totalTiles);
    const panelCount = (key) => Object.values(me.mat[key] || {}).reduce((a, b) => a + b, 0);

    // 模拟执行：对某个产业已选的若干次，依次丢「当前最低等级」，返回真实等级列表。
    // 绝不谎报等级——例如铁厂各等级只有 1 个，选 2 次会真实丢 L1、L2，而不会显示成 2×L1。
    const levelsFor = (idx) => {
      const a = avail[idx];
      const probe = { ...(me.mat[a.key] || {}) };
      const out = [];
      for (let k = 0; k < sel.filter((x) => x === idx).length; k++) {
        const lv = Object.keys(probe).filter((l) => probe[l] > 0).map(Number);
        if (!lv.length) break;
        const lo = Math.min(...lv);
        probe[lo] -= 1;
        out.push(lo);
      }
      return out;
    };
    // 逐次模拟：按选择顺序返回 [{cn, level}]，用于「本次丢弃」汇总，避免重复文字。
    const planList = () => {
      const probe = {};
      for (const k of Object.keys(me.mat || {})) probe[k] = { ...(me.mat[k] || {}) };
      const out = [];
      for (const i of sel) {
        const a = avail[i];
        const lv = Object.keys(probe[a.key] || {}).filter((l) => probe[a.key][l] > 0).map(Number);
        if (!lv.length) break;
        const lo = Math.min(...lv);
        probe[a.key][lo] -= 1;
        out.push({ cn: a.cn, level: lo });
      }
      return out;
    };
    const planText = () => planList().map((x) => `${x.level}级${x.cn}`).join('、');

    const draw = () => {
      this.hud.setStripBody(h('div.opts', null,
        h('div.as-note', null,
          '发展 = 从面板上丢弃 1~2 个最低等级板块，每丢 1 个消耗 1 铁。同一产业可重复选（如丢 2 个造船厂）；每次都从当前最低等级起弃，显示的是真实将被丢弃的等级。'),
        ...avail.map((a, i) => {
          const times = sel.filter((x) => x === i).length;
          const cap = Math.min(panelCount(a.key), maxN);   // 该产业面板上有几块就能选几次（封顶 2）
          const canAdd = times < cap && sel.length < maxN;
          const ctrl = times > 0
            ? h('span.as-ctr', null,
                h('span.as-cnt', null, `将丢：${levelsFor(i).join('级、')}级`),
                h('span.as-step', { onclick: (e) => { e.stopPropagation(); const k = sel.lastIndexOf(i); if (k >= 0) { sel.splice(k, 1); draw(); } } }, '−'),
                h('span.as-cnt', null, `×${times}`),
                h('span.as-step', { onclick: (e) => { e.stopPropagation(); if (canAdd) { sel.push(i); draw(); } } }, '+'),
              )
            : h('span.as-cnt', null, '点击选择');
          return h(`div.as-opt${times ? '.sel' : ''}`, {
            onclick: () => { if (canAdd) { sel.push(i); draw(); } },
          },
          h('div', null, `${a.cn}（最低 ${a.level} 级）`),
          ctrl,
          );
        }),
        h('div.as-bill', null,
          sel.length
            ? h('div', null, `本次丢弃：${planText()}；需要 ${sel.length} 铁。`)
            : h('div', null, '本次丢弃 0 个板块，需要 0 铁。'),
        ),
      ));
      this.hud.setStripActions([{
        label: '下一步', cls: 'primary', disabled: !sel.length,
        onClick: () => {
          const inds = sel.map((i) => avail[i].cn);
          const planLabel = planText();
          this.pickCards({
            title: `发展 · 丢弃 ${planLabel}`,
            count: 1,
            note: '发展可弃任意 1 张手牌。',
            onDone: (cards) => this.startResourcePick({
              kind: 'iron', amount: sel.length, sources: this.state.ironSources,
              onDone: (picked) => this.confirm({
                title: '确认发展',
                lines: [
                  `丢弃：${planLabel}`,
                  `消耗：${sel.length} 铁${picked.length
                    ? `（${this._groupPicked(picked).map((arr) => `${this.locName(arr[0].location)} ${arr[0].level}级铁厂${arr.length > 1 ? ` ×${arr.length}` : ''}`).join('、')}）`
                    : '（全部从市场购买）'}`,
                  `弃牌：${this.hud.cardLabel(cards[0])}`,
                ],
                onOk: () => this.submit({
                  type: 'develop', industries: inds, cardId: cards[0],
                  ironFrom: picked.map((s) => s.tileId),
                }, '发展'),
              }),
            }),
          });
        },
      }]);
    };
    this.hud.showStrip({
      title: '发展 · 选择要丢弃的板块（最多 2 个）',
      cancelable: true,
      onCancel: () => this.cancelFlow(),
      body: h('div'),
      actions: [],
    });
    draw();
  }

  // ---------------- 出售棉花（官方规则 2026-08-11 规则书） ----------------

  flowSell() {
    const st = this.state;
    const mills = st.sellables || [];
    if (!mills.length) { toast('当前没有可出售的棉花厂', 'err'); return this.cancelFlow(); }
    this.flow = { kind: 'sell', mills };
    // 售卖会话（官方步骤 4）续卖：列表选厂，无需再弃牌；可随时结束
    if (st.pendingSell) {
      this.scene?.setPicker(null);
      this.hud.setHint('继续出售：选择一座棉花厂（无需弃牌），或结束售卖');
      this.hud.showStrip({
        title: '继续出售棉花（步骤 4，不再弃牌）',
        cancelable: false,
        body: h('div.opts', null, ...mills.map((m) => h('div.as-opt', {
          onmouseenter: () => this.scene?.focusLocation?.(m.location),
          onclick: () => this.sellRouteMenu(m),
        },
          h('div', null, `${this.locName(m.location)} · ${m.level} 级棉花厂`),
          h('div.as-tag', null, this.sellRouteSummary(m)),
        ))),
        actions: [
          { label: '结束售卖', onClick: () => this.submit({ type: 'sell_end' }, '结束售卖') },
        ],
      });
      return;
    }
    this.scene?.setPicker({ kind: 'sell', mills });
    this.hud.setHint('出售：点击地图上高亮的棉花厂');
  }

  sellRouteSummary(mill) {
    const ch = [];
    if ((mill.routes || []).some((r) => r.channel === 'distant')) ch.push('远方市场');
    const nPort = (mill.routes || []).filter((r) => r.channel === 'port').length;
    if (nPort) ch.push(`港口 ×${nPort}`);
    return ch.join(' / ') || '无渠道';
  }

  onSellMill(mill) {
    this.flow = { kind: 'sell', mill };
    this.hud.closeStrip();
    this.sellRouteMenu(mill);
  }

  /** 选路线：官方 2.1 港口（翻港口归其拥有者得奖励）/ 2.2 远方市场（抽牌推进市场轨得收入）。 */
  sellRouteMenu(mill) {
    const routes = mill.routes || [];
    const st = this.state;
    if (!routes.length) { toast('该棉花厂没有可达的市场标记', 'err'); return this.cancelFlow(); }
    const back = () => {
      this.scene?.drawRoute?.(null);
      if (st.pendingSell) this.showSellContinue();
      else this.cancelFlow();
    };
    this.hud.showStrip({
      title: '选择售卖路线（悬停可视化）',
      cancelable: !st.pendingSell,   // 会话内强制不能取消
      onCancel: back,
      body: h('div.opts', null, ...routes.map((rt) => {
        const disabled = rt.channel === 'distant' && !st.remoteBonusAvailable;
        const note = disabled ? ' · 远方市场标记已到 X 或牌库已空' : '';
        return h('div.as-opt' + (disabled ? '.disabled' : ''), {
          onmouseenter: disabled ? null : () => (rt.path?.length ? this.scene?.drawRoute?.(rt.path) : null),
          onmouseover: disabled ? null : () => (rt.path?.length ? this.scene?.drawRoute?.(rt.path) : null),
          onmouseleave: () => this.scene?.drawRoute?.(null),
          onclick: disabled ? null : () => {
            this.scene?.drawRoute?.(null);
            this.sellChooseCards(mill, {
              label: rt.label, channel: rt.channel, portTileId: rt.portTileId,
            });
          },
        },
        h('div.as-route-line'), // 绿色小条视觉提示
        h('div', null, `${rt.label}（距离 ${rt.distance}）${note}`),
        h('div.as-tag', null, rt.path.map((p) => this.locName(p)).join(' → ')),
        );
      })),
      actions: [],
    });
  }

  sellChooseCards(mill, opt) {
    this.scene?.setPicker(null);
    this.hud.setHint(null);
    const doSubmit = (cardId) => this.submit({
      type: 'sell', millId: mill.millId, cardId: cardId || undefined,
      channel: opt.channel, portTileId: opt.portTileId || null,
    }, '出售');
    if (this.state.pendingSell) {
      // 会话续卖（官方步骤 4）：无需再弃牌
      doSubmit(null);
      return;
    }
    // 首次售卖（官方步骤 1）：弃任意 1 张手牌。使用左侧手牌区高亮选择 + 右侧 Strip 确认。
    const st = this.state;
    const me = (st.players || []).find((p) => p.id === st.viewerId);
    const hand = me?.hand || [];
    if (!hand.length) { toast('没有手牌可弃', 'err'); return this.cancelFlow(); }

    this.hud.showStrip({
      title: '请丢弃一张手牌',
      cancelable: true,
      onCancel: () => this.cancelFlow(),
      body: h('div', { style: { color: 'var(--muted)', fontSize: '12px' } }, '点击左侧高亮的手牌进行选择'),
      actions: [],
    });
    this.hud.setHandSelectable({
      count: 1,
      filter: () => true, // 售卖可弃任意 1 张手牌
      onChange: (sel) => {
        const cardId = hand[sel[0]];
        this.hud.setStripBody(h('div', null,
          h('div', null, `已选手牌：${this.hud.cardLabel(cardId)}`),
          h('div', { style: { color: 'var(--muted)', fontSize: '12px' } }, '点击其他手牌可更换'),
        ));
        this.hud.setStripActions([
          { label: '确认出售', cls: 'primary', onClick: () => doSubmit(cardId) },
        ], true);
      },
      onDone: (sel) => {
        const cardId = hand[sel[0]];
        this.hud.setStripBody(h('div', null,
          h('div', null, `已选手牌：${this.hud.cardLabel(cardId)}`),
          h('div', { style: { color: 'var(--muted)', fontSize: '12px' } }, '点击其他手牌可更换'),
        ));
        this.hud.setStripActions([
          { label: '确认出售', cls: 'primary', onClick: () => doSubmit(cardId) },
        ], true);
      },
      onCancel: () => this.cancelFlow(),
    });
  }

  /** 售卖会话续卖询问（官方步骤 4：继续或结束）。 */
  showSellContinue() {
    this.hud.showStrip({
      title: '继续出售棉花？（步骤 4）',
      cancelable: false,
      body: h('div', { style: { color: 'var(--muted)', fontSize: '12px' } },
        '你还有可出售的棉花厂：可继续出售（无需再弃牌），或结束本次售卖行动（消耗 1 个行动点）。'),
      actions: [
        { label: '继续出售', cls: 'primary', onClick: () => this.flowSell() },
        { label: '结束售卖', onClick: () => this.submit({ type: 'sell_end' }, '结束售卖') },
      ],
    });
  }

  // ---------------- 贷款 ----------------

  flowLoan(presetTier) {
    const st = this.state;
    const me = (st.players || []).find((p) => p.id === st.viewerId);
    const track = this.static.incomeTrack?.positions || [];
    const now = track[me?.incomePos ?? 0];
    // 从「贷款」子集直接点档位：跳过档位弹窗，立即进入选牌
    if (presetTier) {
      const np = (me?.incomePos ?? 0) - presetTier;
      if (np >= 0) {
        return this.loanChooseCards({ tier: presetTier, gain: presetTier * 10, ok: true, after: track[np] });
      }
      toast('该档位会使收入触底，不可选', 'err');
      return this.cancelFlow();
    }
    const tiers = [1, 2, 3].map((t) => {
      const np = (me?.incomePos ?? 0) - t;
      return {
        tier: t, gain: t * 10, ok: np >= 0,
        after: np >= 0 ? track[np] : null,
      };
    });
    this.hud.showStrip({
      title: '贷款 · 选择档位',
      cancelable: true,
      onCancel: () => this.cancelFlow(),
      body: h('div.opts', null,
        h('div.as-note', null,
          `当前收入 ${now}。贷款立即得钱，但收入轨后退相应格数；收入触底（-10）后不可再贷。`),
        ...tiers.map((t) => h(`div.as-opt${t.ok ? '' : '.disabled'}`, {
          onclick: t.ok ? () => this.loanChooseCards(t) : null,
        },
        h('div', null, `档位 ${t.tier} · 立即 +${money(t.gain)}`),
        h('div.as-tag', null, t.ok ? `收入 ${now} → ${t.after}（后退 ${t.tier} 格）` : '会低于 -10，不可选'),
        )),
      ),
      actions: [],
    });
  }

  loanChooseCards(t) {
    this.pickCards({
      title: `贷款 档位 ${t.tier}（+${money(t.gain)}）`,
      count: 1,
      note: '贷款可弃任意 1 张手牌。',
      onDone: (cards) => this.confirm({
        title: '确认贷款',
        lines: [
          `获得：${money(t.gain)}`,
          `收入轨后退 ${t.tier} 格（收入变为 ${t.after}）`,
          `弃牌：${this.hud.cardLabel(cards[0])}`,
        ],
        onOk: () => this.submit({ type: 'loan', tier: t.tier, cardId: cards[0] }, '贷款'),
      }),
    });
  }

  // ---------------- 跳过 ----------------

  flowSkip() {
    this.pickCards({
      title: '跳过',
      count: 1,
      note: '跳过 = 弃 1 张手牌、消耗 1 个行动点，不产生其他效果。',
      onDone: (cards) => this.confirm({
        title: '确认跳过',
        lines: [`弃牌：${this.hud.cardLabel(cards[0])}`, '消耗 1 个行动点'],
        onOk: () => this.submit({ type: 'skip', cardId: cards[0] }, '跳过'),
      }),
    });
  }

  // ---------------- 结算 ----------------

  checkGameOver(st) {
    if (!st?.gameOver) { this.lastGameOverShown = false; return; }
    if (this.lastGameOverShown) return;
    this.lastGameOverShown = true;
    this.cancelFlow();

    const rows = (st.players || []).map((p) => ({
      p, s: st.scores?.[p.id] || { canal: 0, rail: 0, total: 0 },
    })).sort((a, b) => b.s.total - a.s.total || b.p.money - a.p.money);
    const top = rows[0]?.s.total;

    this.modal.onCancel = null;
    this.modal.show({
      title: '本局结束',
      body: h('table.scoretable', null,
        h('tr', null, h('th', null, '名次'), h('th', null, '玩家'),
          h('th', null, '运河时代'), h('th', null, '铁路时代'), h('th', null, '总分'), h('th', null, '剩余资金')),
        ...rows.map((r, i) => h(`tr${r.s.total === top ? '.win' : ''}`, null,
          h('td', null, String(i + 1)),
          h('td', { style: { color: PLAYER_CSS[r.p.color] } }, r.p.name),
          h('td', null, String(r.s.canal)),
          h('td', null, String(r.s.rail)),
          h('td', null, String(r.s.total)),
          h('td', null, money(r.p.money)),
        )),
      ),
      cancelable: true,
      actions: this.session.isHost ? [{
        label: '再来一局', kind: 'primary',
        onClick: async () => {
          try { await this.session.restart(); this.modal.close(); this.lastGameOverShown = false; } catch (e) { toast(e.message, 'err'); }
        },
      }] : [],
    });
  }

  // ---------------- 小工具 ----------------

  locName(id) { return this.locById[id]?.name || id; }
}
