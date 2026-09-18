/**
 * 对局 HUD（BGA 三栏式排版，2026-08-09 重构）：
 *   - 顶部固定行动条：状态 + 「文件夹式」行动菜单（建造子菜单含「返回上一级」）+ 常驻 撤回/结束回合
 *   - 版图左上方悬浮「手牌 (N)」横向平铺常驻面板（用我们自己的卡图，悬停放大）
 *   - 右侧栏：4 个玩家面板（红→白→黄→紫，用我们自己的个人面板底图 + 我们的板块图，按 mat 渲染）
 *   - 美术全部用我们自己的素材，只借 BGA 的排版骨架
 *
 * 纯展示 + 事件回调，不做任何规则判断（可用性一律取服务器下发的 buttonEnabled）。
 */
import { h, clear, money } from './dom.js';
import { PLAYER_CSS } from '../game/mappings.js';
import ActionStrip from './ActionStrip.js';

const ACTION_KEYS = ['build', 'doubleBuild', 'road', 'develop', 'sell', 'loan', 'skip'];

// 个人面板槽位 tile_id 前缀 → 引擎 mat 键
const SLOT2MAT = { cotton: 'cotton', port: 'port', shipyard: 'shipyard', ironworks: 'iron', colliery: 'coal' };
// 悬停提示用产业中文名（前缀 → 中文；colliery/ironworks 为 mat 前的原始 tile_id 前缀）
const INDUSTRY_CN = { cotton: '棉纺厂', port: '港口', shipyard: '造船厂', ironworks: '铁厂', colliery: '煤厂' };

export default class Hud {
  /**
   * @param {HTMLElement} host
   * @param {object} deps { onAction(kind, arg), onUndo(), onUndoAll(), onEndTurn(), onRefresh(), onLeave(), onCancel(), onCheat(kind, amount), onZoomIn(), onZoomOut() }
   */
  constructor(host, deps) {
    this.host = host;
    this.deps = deps;
    this.state = null;
    this.room = null;
    this.incomeTrack = null;
    this.cardDefs = {};
    this.locNames = {};
    this.hint = null;
    this.online = true;
    this.menu = 'root';           // 'root' | 'build' | 'loan'
    this.nodes = {};
    this.cardUrls = {};           // cardId -> manifest 图片路径
    this.boardSlots = null;       // 个人面板槽位
    this.boardImg = 'assets/player_board.jpg';
    this.boardW = 1417;
    this.boardH = 960;
    this.slotSize = 86;
    this.panelW = 286;            // 右侧栏内个人面板绘制宽度（与 CSS 对应）
    this._assetsPromise = null;
    this._zoomEl = null;
    this.pZoom = 1;             // 玩家面板列缩放因子 [1, 3]，与地图 _zoom 上限一致
    this._pbTipEl = null;       // 个人面板产业悬停提示（单例，挂 document.body，避免被面板 overflow 裁剪）
    this.strip = new ActionStrip();
    this.handSel = null;        // { count, filter(id), onChange(sel), onDone(sel), onCancel() } 或 null
    this._selCards = [];        // 当前已选手牌索引（在手牌数组中的索引）
  }

  mount() {
    if (this.nodes.top) return;
    this.nodes.top = h('div#topbar.panel');
    this.nodes.topStatus = h('div.tb-status');
    this.nodes.topActions = h('div.tb-actions');
    this.nodes.top.appendChild(this.nodes.topStatus);
    this.nodes.top.appendChild(this.nodes.topActions);

    this.nodes.hand = h('div#handpanel.panel');
    this.nodes.handCards = h('div#handcards');
    this.nodes.hand.appendChild(this.nodes.handCards);
    this.strip.mount(this.nodes.hand);
    this.nodes.right = h('div#rightcol.panel');
    this.nodes.ppanels = h('div#ppanels');
    this.nodes.plog = h('div#plog', null, h('div.hd', null, '对局日志'), h('div.bd'));
    this.nodes.right.appendChild(this.nodes.ppanels);
    this.nodes.right.appendChild(this.nodes.plog);
    // 房间聊天挂载点（ChatPanel 实例由 app 搬移到这里，输入行持久不丢草稿）
    this.nodes.chatdock = h('div.chatdock-slot');
    this.nodes.right.appendChild(this.nodes.chatdock);
    // 玩家面板列缩放按钮（＋/－）：与地图 #zoomctl 同手感，仅缩放 #ppanels 内容，
    // 不影响 #rightcol 宽度，故顶部/手牌/地图等独立绝对定位元素不会被挤压或移位。
    this.nodes.pzval = h('span.pzval', null, '×1.0');
    this.nodes.pzoom = h('div#pzoomctl', null,
      h('span.pzlabel', { title: '玩家面板缩放' }, '面板'),
      h('button.zoombtn', { title: '放大玩家面板', onclick: () => this.deps.onPZoomIn?.() }, '＋'),
      h('button.zoombtn', { title: '缩小玩家面板', onclick: () => this.deps.onPZoomOut?.() }, '－'),
      this.nodes.pzval);
    this.nodes.right.insertBefore(this.nodes.pzoom, this.nodes.ppanels);
    this.pZoom = 1;            // 重挂载（重进对局）时重置缩放，避免残留上一局状态
    this.nodes.ppanels.style.setProperty('--pzoom', '1');
    if (this.nodes.pzval) this.nodes.pzval.textContent = '×1.0';
    // 地图缩放按钮（＋/－）：手牌行/玩家面板/地图三方交界角
    this.nodes.zoom = h('div#zoomctl', null,
      h('button.zoombtn', { title: '放大地图', onclick: () => this.deps.onZoomIn?.() }, '＋'),
      h('button.zoombtn', { title: '缩小地图', onclick: () => this.deps.onZoomOut?.() }, '－'));

    // 地图平移滚动条（经典十字：右侧竖向 + 底部横向）；玩家唯一平移方式，拖拽地图平移已禁用
    const sbY = h('div#mapscroll-y', { title: '上下平移地图' }, h('div.thumb'));
    const sbX = h('div#mapscroll-x', { title: '左右平移地图' }, h('div.thumb'));
    this.nodes.scrollY = sbY;
    this.nodes.scrollX = sbX;
    this._initScrollbar(sbY, 'y');
    this._initScrollbar(sbX, 'x');

    for (const n of ['top', 'hand', 'right', 'zoom', 'scrollY', 'scrollX']) this.host.appendChild(this.nodes[n]);

    this._zoomInit();
    this.ensureAssets();
  }

  unmount() {
    this.strip.unmount();
    if (this._pbTipEl) { this._pbTipEl.remove(); this._pbTipEl = null; }
    for (const n of Object.values(this.nodes)) n?.remove();
    this.nodes = {};
  }

  get mounted() { return !!this.nodes.top; }

  async ensureAssets() {
    if (this._assetsPromise) return this._assetsPromise;
    this._assetsPromise = (async () => {
      try {
        const [pb, man] = await Promise.all([
          fetch('data/player_board.json').then((r) => r.json()),
          fetch('data/asset_manifest.json').then((r) => r.json()),
        ]);
        this.boardSlots = pb.slots || [];
        this.boardImg = pb.background || 'assets/player_board.jpg';
        this.boardW = pb.size?.width || 1417;
        this.boardH = pb.size?.height || 960;
        this.slotSize = pb.slotSize || 86;
        this.cardUrls = man.cards || {};
      } catch (e) {
        console.warn('[Hud] 个人面板/卡牌素材加载失败，将回退文字', e);
      }
      // 素材到位后，若已有状态则补渲玩家面板与手牌图
      if (this.state && this.room) this.update(this.state, this.room);
    })();
    return this._assetsPromise;
  }

  setStatic({ incomeTrack, cards, locations }) {
    if (incomeTrack) this.incomeTrack = incomeTrack;
    if (cards) this.cardDefs = Object.fromEntries(cards.map((c) => [c.id, c]));
    if (locations) this.locNames = Object.fromEntries(locations.map((l) => [l.id, l.name]));
  }

  setHint(text) { this.hint = text; this._renderButtons(); }

  setOnline(v) { this.online = v; this._renderTop(); }

  /** 玩家面板列缩放：delta>0 放大，<0 缩小；因子范围 [1, 3]，每档 ×1.15 / ÷1.15。 */
  pZoomBy(delta) {
    const factor = delta > 0 ? 1.15 : 1 / 1.15;
    const next = Math.max(1, Math.min(3, this.pZoom * factor));
    if (Math.abs(next - this.pZoom) < 1e-6) return;   // 已到边界，无变化
    this.pZoom = next;
    this._applyPZoom();
  }

  _applyPZoom() {
    if (this.nodes.ppanels) {
      // 用 CSS 变量驱动 .ppanel 的 width:calc(100% * var(--pzoom))，确定性缩放整块面板；
      // 不依赖 `zoom` 属性（flex + overflow:auto 容器上 Chromium 不随 zoom 实时重算布局）。
      this.nodes.ppanels.style.setProperty('--pzoom', this.pZoom.toFixed(3));
    }
    if (this.nodes.pzval) this.nodes.pzval.textContent = '×' + this.pZoom.toFixed(1);
  }

  // ---------------- ActionStrip 代理 ----------------
  /** 注入向导条开合回调（宿主用它联动 Phaser 输入开关，防点击穿透）。 */
  setStripOpenChange(fn) { this.strip.onOpenChange = fn; }
  showStrip(opts) { this.strip.show(opts); }
  setStripTitle(title) { this.strip.setTitle(title); }
  setStripBody(body) { this.strip.setBody(body); }
  setStripActions(actions, cancelable) { this.strip.setActions(actions, cancelable); }
  closeStrip() { this.strip.close(); }
  get stripOpen() { return this.strip.open; }

  update(state, room) {
    this.state = state;
    this.room = room;
    if (!this.mounted) return;
    // 观战模式：隐藏整个手牌区（内含行动向导条，观众永远不会触发向导）
    const spec = !!room?.iAmSpectator;
    if (this.nodes.hand) this.nodes.hand.style.display = spec ? 'none' : '';
    this._renderTop();
    this._renderPlayers();
    this._renderLog();
    this._renderHand();
    this._renderButtons();
  }

  // ---------------- 文案 / 素材工具 ----------------

  incomeOf(p) {
    const pos = p?.incomePos ?? 0;
    const arr = this.incomeTrack?.positions;
    if (!arr) return null;
    return arr[Math.max(0, Math.min(arr.length - 1, pos))];
  }

  cardLabel(id) {
    const c = this.cardDefs[id];
    if (!c) return id;
    if (c.type === 'city') return this.locNames[c.city] || c.city;
    return c.industry || id;
  }

  cardKind(id) { return this.cardDefs[id]?.type || 'city'; }

  cardImgUrl(id) { return this.cardUrls[id] || null; }

  /** 手牌小卡片（也用于选牌弹窗）；优先用我们自己的卡图，悬停放大。 */
  cardChip(id, i, opts = {}) {
    const kind = this.cardKind(id);
    const cls = ['card', kind];
    if (opts.pickable) cls.push('pick');
    if (opts.selected) cls.push('sel');
    if (opts.dim) cls.push('dim');
    const url = this.cardImgUrl(id);
    const chip = h(`div.${cls.join('.')}`, {
      onclick: opts.onClick ? () => opts.onClick(i, id) : null,
      title: id,
    },
      url ? h('img', { src: url, alt: id, draggable: 'false' }) : h('div.t', null, kind === 'city' ? '城市' : '产业'),
      url ? null : h('div.n', null, this.cardLabel(id)),
      opts.badge ? h('div.idx', null, opts.badge) : null,
    );
    if (url) this._bindZoom(chip, url);
    return chip;
  }

  // ---------------- 悬浮放大 ----------------

  _zoomInit() {
    if (this._zoomEl) return;
    this._zoomEl = h('div#cardzoom');
    document.body.appendChild(this._zoomEl);
    document.addEventListener('mousemove', (e) => {
      if (this._zoomEl.style.display === 'block') this._posZoom(e);
    });
  }

  _bindZoom(el, url) {
    el.addEventListener('mouseenter', () => {
      this._zoomEl.innerHTML = '';
      this._zoomEl.appendChild(h('img', { src: url }));
      this._zoomEl.style.display = 'block';
    });
    el.addEventListener('mouseleave', () => { this._zoomEl.style.display = 'none'; });
  }

  _posZoom(e) {
    const pad = 18;
    const r = this._zoomEl.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > window.innerWidth) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight) y = e.clientY - r.height - pad;
    this._zoomEl.style.left = x + 'px';
    this._zoomEl.style.top = y + 'px';
  }

  // ---------------- 地图平移滚动条 ----------------

  _initScrollbar(root, orient) {
    const thumb = root.querySelector('.thumb');
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const onInput = (ratio) => {
      if (orient === 'y') this.deps.onMapScrollY?.(ratio);
      else this.deps.onMapScrollX?.(ratio);
    };
    let dragging = false;
    const trackLen = () => (orient === 'y' ? root.clientHeight : root.clientWidth);
    const ratioFromEvent = (ev) => {
      const rect = root.getBoundingClientRect();
      const pos = orient === 'y' ? (ev.clientY - rect.top) : (ev.clientX - rect.left);
      const tl = trackLen();
      const th = (orient === 'y' ? thumb.offsetHeight : thumb.offsetWidth) || 14;
      const inner = Math.max(1, tl - th);
      return clamp01((pos - th / 2) / inner);
    };
    thumb.addEventListener('pointerdown', (e) => {
      dragging = true; thumb.setPointerCapture(e.pointerId); e.stopPropagation();
    });
    thumb.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      onInput(ratioFromEvent(e));
    });
    const end = (e) => { dragging = false; try { thumb.releasePointerCapture(e.pointerId); } catch {} };
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', () => { dragging = false; });
    // 点击轨道（非滑块）跳转
    root.addEventListener('pointerdown', (e) => {
      if (e.target === thumb) return;
      onInput(ratioFromEvent(e));
    });
  }

  /** 由场景滚动状态驱动滚动条滑块位置与可用态。 */
  setMapScroll(s) {
    if (!s) { this._lastScroll = null; return; }
    this._lastScroll = s;
    const apply = (root, orient) => {
      if (!root) return;
      const thumb = root.querySelector('.thumb');
      const trackLen = orient === 'y' ? root.clientHeight : root.clientWidth;
      const frac = orient === 'y' ? s.fracY : s.fracX;
      const ratio = orient === 'y' ? s.ratioY : s.ratioX;
      const enabled = (orient === 'y' ? s.rangeY : s.rangeX) > 0;
      root.classList.toggle('disabled', !enabled);
      const th = Math.max(14, Math.min(1, frac) * trackLen);
      if (orient === 'y') thumb.style.height = th + 'px';
      else thumb.style.width = th + 'px';
      const inner = Math.max(1, trackLen - th);
      const pos = ratio * inner;
      if (orient === 'y') thumb.style.top = pos + 'px';
      else thumb.style.left = pos + 'px';
    };
    apply(this.nodes.scrollY, 'y');
    apply(this.nodes.scrollX, 'x');
  }

  // ---------------- 分区渲染 ----------------

  _renderTop() {
    const el = this.nodes.topStatus; if (!el) return;
    clear(el);
    const st = this.state;
    const cur = st && (st.players || []).find((p) => p.id === st.currentPlayer);
    const seg = (k, v, style) => h('div.seg', null, h('span.k', null, k), h('span.v', { style }, v));

    el.appendChild(seg('时代', st?.phase === 'rail' ? '铁路' : '运河'));
    el.appendChild(h('div.sep'));
    el.appendChild(seg('回合', String(st?.round ?? '-')));
    el.appendChild(h('div.sep'));
    el.appendChild(seg('行动点', String(st?.actionPoints ?? '-')));
    el.appendChild(h('div.sep'));
    el.appendChild(seg('当前', cur ? cur.name : '-', { color: PLAYER_CSS[cur?.color] || '#fff' }));
    el.appendChild(h('div.sep'));
    el.appendChild(seg('牌堆', String(st?.deckRemaining ?? '-')));
    el.appendChild(h('div.sep'));
    el.appendChild(h('div.seg', null,
      h('span.dot' + (this.online ? '.on' : '.off')),
      h('span.k', null, this.online ? '已连接' : '重连中'),
      this.room ? h('span.k', null, `· ${this.room.roomId}`) : null,
    ));
    // 观战身份标识（只读，不可行动）
    if (this.room?.iAmSpectator) {
      el.appendChild(h('div.sep'));
      el.appendChild(h('div.seg', null, h('span.spec-badge', null, '观战中')));
    }
    el.appendChild(h('button.sm.ghost', { onclick: () => this.deps.onRefresh?.() }, '刷新'));
    // 作弊按钮仅用于本地机器人房调试，正式上线前隐藏
    // if (this.room?.bot) {
    //   el.appendChild(h('button.sm.ghost', { onclick: () => this.deps.onCheat?.('money', 20) }, '＋£20'));
    //   el.appendChild(h('button.sm.ghost', { onclick: () => this.deps.onCheat?.('ap', 1) }, '＋1行动点'));
    // }
    el.appendChild(h('button.sm.ghost', { onclick: () => this.deps.onLeave?.() },
      this.room?.iAmSpectator ? '退出观战' : '离开'));
  }

  _renderHand() {
    const el = this.nodes.handCards; if (!el) return;
    clear(el);
    const st = this.state; if (!st) return;
    const me = (st.players || []).find((p) => p.id === st.viewerId);
    const hand = me?.hand || [];
    const sel = this.handSel;
    const info = `抽牌堆 ${st.deckRemaining ?? 0}　弃牌堆 ${st.discardCount ?? 0}`
      + (st.remoteMarketDeck ? `　远方市场 ${st.remoteMarketDeck.remaining}` : '');
    el.appendChild(h('div.hd', null,
      h('span', null, `手牌 (${hand.length})`),
      h('span.hdinfo', null, info)));
    const row = h('div.cards' + (sel ? '.selecting' : ''), null);
    if (!hand.length) {
      row.appendChild(h('div.note', null, '手牌已出完'));
    } else {
      hand.forEach((id, i) => {
        const url = this.cardImgUrl(id);
        const isSel = this._selCards.includes(i);
        const pickable = sel ? sel.filter(id) : false;
        const cls = ['hcard'];
        if (pickable) cls.push('pickable');
        if (isSel) cls.push('sel');
        if (sel && !pickable && !isSel) cls.push('dim');
        const chip = h(`div.${cls.join('.')}`, {
          title: this.cardLabel(id),
          onclick: sel ? () => this._toggleHandCard(i) : null,
        },
          url
            ? h('img', { src: url, alt: id, draggable: 'false' })
            : h('div.fallback', null, this.cardLabel(id)),
        );
        if (url && !sel) this._bindZoom(chip, url);
        row.appendChild(chip);
      });
    }
    el.appendChild(row);
  }

  /** 进入选手牌模式：filter(id) 判定某张牌是否可选；onChange 每次变化回调；onDone 达到 count 时回调；onCancel 取消。 */
  setHandSelectable(opts) {
    this.handSel = opts || null;
    this._selCards = [];
    this._renderHand();
  }

  clearHandSelectable() {
    this.handSel = null;
    this._selCards = [];
    this._renderHand();
  }

  get selectedCardIndices() { return [...this._selCards]; }

  _toggleHandCard(i) {
    if (!this.handSel) return;
    const idx = this._selCards.indexOf(i);
    if (idx >= 0) {
      this._selCards.splice(idx, 1);
    } else if (this._selCards.length < this.handSel.count) {
      this._selCards.push(i);
    } else {
      // 已达上限：替换最后一张
      this._selCards[this._selCards.length - 1] = i;
    }
    this._selCards.sort((a, b) => a - b);
    this._renderHand();
    this.handSel.onChange?.(this._selCards);
    if (this._selCards.length === this.handSel.count) {
      this.handSel.onDone?.(this._selCards);
    }
  }

  _renderPlayers() {
    const el = this.nodes.ppanels; if (!el) return;
    clear(el);
    this._hidePbTip();   // 重渲前先收起悬停提示，避免「残留旧提示」错觉
    const st = this.state; if (!st) return;
    const order = st.turnOrder || (st.players || []).map((p) => p.id);
    // 座位头像：登录玩家带自己的账号头像进对局（房间视图注入）；机器人固定头像；游客不显示
    const avByPid = {};
    ((this.room && this.room.seats) || []).forEach((s) => {
      if (s.playerId) avByPid[s.playerId] = s.avatar || (s.isBot ? '🤖' : '');
    });

    order.forEach((pid, i) => {
      const p = (st.players || []).find((x) => x.id === pid);
      if (!p) return;
      const isMe = p.id === st.viewerId;
      const inc = this.incomeOf(p);
      const vp = st.scores?.[p.id]?.total ?? 0;
      const av = avByPid[p.id] || (p.isBot ? '🤖' : '');

      const panel = h(`div.ppanel${p.id === st.currentPlayer ? '.cur' : ''}`, {
        style: { borderTopColor: PLAYER_CSS[p.color] || '#888' },
      });
      panel.appendChild(h('div.phead', null,
        h('span.dot', { style: { background: PLAYER_CSS[p.color] || '#888' } }),
        av ? h('span.pav', { text: av }) : null,
        h('span.nm', null, `${i + 1}. ${p.name}`),
        isMe ? h('span.me', null, '我') : null,
        h('span.stat', null, `${money(p.money)} · 收入 ${inc == null ? '-' : inc} · 连接 ${p.remainingLinks ?? '-'} · VP ${vp}`),
      ));
      // 观战模式：每个玩家面板显示其手牌牌背（数量 = handCount，牌面一律不可见）
      if (this.room?.iAmSpectator) {
        const n = p.handCount ?? 0;
        panel.appendChild(h('div.phand', null,
          h('span.phand-k', null, `手牌 ${n}`),
          h('div.phand-backs', null, ...Array.from({ length: n }, () =>
            h('img.pback', { src: 'assets/markers/hand_card_back.jpg', alt: '牌背', draggable: 'false' }),
          )),
        ));
      }
      // 必须先挂到 DOM，.pboard 的 width:100% 才能获得真实可用宽度；
      // 若先 renderBoard 再 append，board.clientWidth 为 0，会误用 this.panelW 默认值，
      // 导致 board 高度按 286px 计算而实际宽度 268px，宽高比失调、底图拉伸、tile 视觉上偏上。
      el.appendChild(panel);
      this.renderBoard(p, panel);
    });
  }

  /** 用我们自己的个人面板底图 + 我们的板块图，按 mat 剩余渲染（>0 显示、=0 露底图）。
   *  board 宽度由 CSS 100% 填充满 .ppanel，高度按 1417/960 比例自动保持；
   *  tile 以槽位中心定位（slot.x/y 是细胞中心，故减去 slotSize/2）。 */
  renderBoard(p, panelEl) {
    const board = h('div.pboard', {
      style: { position: 'relative', backgroundImage: `url(${this.boardImg})` },
    });
    panelEl.appendChild(board);

    // 关键：板块用「相对 board 的百分比」定位，而不是用 board.clientWidth 实时换算的像素。
    // 这样无论面板因滚动条出现/布局重排/窗口缩放导致宽度如何变化，板块都严格钉在底图
    // （background-size:100% 100% + CSS aspect-ratio:1417/960）的相对坐标上，重渲染（如执行
    // 发展行动触发 _renderPlayers）绝不会再和底图错位。读 clientWidth 还有一个 286px 的兜底值，
    // 一旦读到 0 就会用错比例导致整片偏移——百分比方案彻底消除了这个兜底与宽度依赖。
      if (this.boardSlots && p.mat) {
      const half = this.slotSize / 2;
      for (const s of this.boardSlots) {
        const [prefix, lv] = s.tile_id.split('_');
        const key = SLOT2MAT[prefix];
        const level = Number(lv);
        const cnt = (key && p.mat[key]?.[level]) || 0;
        if (cnt <= 0) continue;
        const leftPct = ((s.x - half) / this.boardW) * 100;
        const topPct = ((s.y - half) / this.boardH) * 100;
        const wPct = (this.slotSize / this.boardW) * 100;
        const hPct = (this.slotSize / this.boardH) * 100;
        const name = (INDUSTRY_CN[prefix] || prefix) + level;
        const tile = h('img.ptile', {
          src: `assets/tiles/${p.color}_${s.tile_id}.jpg`,
          alt: s.tile_id,
          style: {
            position: 'absolute',
            left: leftPct + '%',
            top: topPct + '%',
            width: wPct + '%',
            height: hPct + '%',
            objectFit: 'contain',
          },
          onmouseenter: (e) => this._showPbTip(e),
          onmousemove: (e) => this._showPbTip(e),
          onmouseleave: (e) => this._hidePbTip(e),
        });
        // 把本板块的剩余数量绑到该 DOM 元素自身：缩放后悬停对象仍是该元素，绝不会错显成相邻板块
        tile.dataset.pbTip = `${name} 剩余数量 ${cnt}`;
        board.appendChild(tile);
      }
    }
  }

  // ---------- 个人面板产业板块悬停提示（跟随鼠标，缩放无关） ----------
  /** 懒创建单例提示元素：挂 document.body，position:fixed，不被 #ppanels/#rightcol 的 overflow 裁剪。 */
  _ensurePbTip() {
    if (this._pbTipEl) return this._pbTipEl;
    const t = document.createElement('div');
    t.id = 'ptip';
    t.style.display = 'none';
    document.body.appendChild(t);
    this._pbTipEl = t;
    return t;
  }
  /** 悬停某产业板块：显示其自身绑定的剩余数量，并跟随光标。
   * 用 clientX/clientY 做 fixed 定位，缩放/滚动都不偏；
   * 当光标靠近视口右/下边缘时，自动把提示翻转到光标左/上方，避免被截断。 */
  _showPbTip(e) {
    const el = this._ensurePbTip();
    const tip = e.currentTarget.dataset.pbTip;
    if (!tip) { el.style.display = 'none'; return; }
    el.textContent = tip;
    el.style.display = 'block';
    const margin = 14;
    // 先按默认右下定位以获取实际尺寸，再按视口边界翻转
    el.style.left = (e.clientX + margin) + 'px';
    el.style.top = (e.clientY + margin) + 'px';
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = e.clientX + margin;
    let top = e.clientY + margin;
    if (left + w > vw) left = e.clientX - w - margin;
    if (top + h > vh) top = e.clientY - h - margin;
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }
  _hidePbTip() {
    if (this._pbTipEl) this._pbTipEl.style.display = 'none';
  }

  _renderLog() {
    const bd = this.nodes.plog?.querySelector('.bd'); if (!bd) return;
    clear(bd);
    const lines = (this.state?.log || []).slice(-40);
    if (!lines.length) { bd.appendChild(h('div.li', null, '（暂无记录）')); return; }
    const nameOf = Object.fromEntries((this.state?.players || []).map((p) => [p.id, p.name]));
    const phaseLabel = { canal: '运河时代', rail: '铁路时代' };
    for (const t of lines) {
      let txt;
      if (typeof t === 'string') {
        // 兼容旧版纯字符串条目
        txt = t;
      } else {
        // 后端下发的日志条目是对象 {round, phase, text}
        const round = (t.round != null) ? ('R' + t.round) : '';
        const ph = phaseLabel[t.phase] || t.phase || '';
        const body = (t.text != null) ? t.text : ((t.msg != null) ? t.msg : '');
        const prefix = [round, ph].filter(Boolean).join(' · ');
        txt = prefix ? (prefix + ' · ' + body) : body;
      }
      txt = txt.replace(/\bP[1-4]\b/g, (m) => nameOf[m] || m);
      bd.appendChild(h('div.li', null, txt));
    }
    bd.scrollTop = bd.scrollHeight;
  }

  _renderButtons() {
    const el = this.nodes.topActions; if (!el) return;
    clear(el);
    const st = this.state; if (!st) return;
    // 观战模式：不下发任何操作入口（服务端也已清空 buttonEnabled/合法着法）
    if (this.room?.iAmSpectator) {
      el.appendChild(h('div.hintline', null, '观战模式：你只能观看，不能操作'));
      return;
    }
    const be = st.buttonEnabled || {};
    const mine = !!st.isMyTurn;

    if (this.hint) {
      el.appendChild(h('div.hintline', null, this.hint));
      el.appendChild(h('button.warn', { onclick: () => this.deps.onCancel?.() }, '取消当前操作'));
      return;
    }

    const mk = (label, kind, opt = {}) => h('button', {
      disabled: opt.disabled !== undefined ? opt.disabled : (!mine || !be[kind]),
      onclick: () => {
        if (opt.menu) { this.menu = opt.menu; this._renderButtons(); }
        else { this.menu = 'root'; this.deps.onAction?.(kind, opt.arg); }
      },
    }, label);

    const loanOk = mine && be.loan;

    if (this.menu === 'build') {
      el.appendChild(mk('建造产业板块', 'build'));
      el.appendChild(mk('建造连接板块', 'road'));
      el.appendChild(mk('双手牌建造产业板块', 'doubleBuild'));
      el.appendChild(h('button.ghost', {
        onclick: () => { this.menu = 'root'; this._renderButtons(); },
      }, '返回上一级'));
    } else if (this.menu === 'loan') {
      const tiers = [10, 20, 30];
      for (const g of tiers) {
        el.appendChild(mk(`贷款 ${g} 元`, 'loan', { arg: g / 10, disabled: !loanOk }));
      }
      el.appendChild(h('button.ghost', {
        onclick: () => { this.menu = 'root'; this._renderButtons(); },
      }, '返回上一级'));
    } else {
      const buildOk = mine && (be.build || be.road || be.doubleBuild);
      el.appendChild(mk('建造', 'build', { disabled: !buildOk, menu: 'build' }));
      el.appendChild(mk('售卖棉花', 'sell'));
      el.appendChild(mk('发展', 'develop'));
      el.appendChild(mk('贷款', 'loan', { disabled: !loanOk, menu: 'loan' }));
      el.appendChild(mk('跳过', 'skip'));
    }

    // 撤回双按钮：母集/子集都常驻
    el.appendChild(h('button', {
      disabled: !mine || !st.undoAvailable,
      onclick: () => this.deps.onUndo?.(),
    }, '撤回上一步'));
    el.appendChild(h('button', {
      disabled: !mine || !st.undoAvailable,
      onclick: () => this.deps.onUndoAll?.(),
    }, '整回合撤回'));
    const me = (st.players || []).find((p) => p.id === st.viewerId);
    const canEnd = mine && (st.actionPoints <= 0 || !(me?.hand || []).length);
    el.appendChild(h('button.primary', {
      disabled: !canEnd,
      title: canEnd ? '' : '本回合行动点未用完（手牌 = 行动点）',
      onclick: () => this.deps.onEndTurn?.(),
    }, '结束回合'));

    if (!mine) {
      const cur = (st.players || []).find((p) => p.id === st.currentPlayer);
      el.insertBefore(h('div.hintline', null, `等待 ${cur?.name || '其他玩家'} 行动…`), el.firstChild);
    }
  }
}
