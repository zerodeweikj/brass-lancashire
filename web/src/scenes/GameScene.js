import Phaser from 'phaser';
import AssetLoader from '../utils/AssetLoader.js';
import { fitIntoSlot, slotScale } from '../utils/fit.js';
import {
  IND_COLOR, PLAYER_HEX, SLOT_TYPE_CN, tileTexKey, tileBackKey,
} from '../game/mappings.js';

/**
 * 对局主场景：完全由服务器下发的状态驱动渲染，本身不含任何游戏规则。
 *
 * 分层（自下而上）：
 *   base   扫描底图（静态，只画一次）
 *   dyn    已落盘产业板块 / 连结板块 / 煤铁市场方块 / 回合顺位头像（每次状态变化重绘）
 *   hint   合法落点高亮与点击热区（进入选择态时才有内容）
 *
 * 对外接口：
 *   setState(state)                     刷新棋盘
 *   setPicker({ builds, links, mills }) 进入/退出选择态
 *   onPick = (payload) => {}            选择回调
 */
const MAP_W = 1936, MAP_H = 1936;
const MIN_ZOOM = 1;      // 1 = contain：整图可见（默认视野，不能再缩小）
const MAX_ZOOM = 3;      // 最大 3× contain
const TILE_SIZE = 78;
const AVATAR_D = 118;
const SLOT_D = 170;

export default class GameScene extends Phaser.Scene {
  constructor() {
    super('GameScene');
    this.state = null;
    this.picker = null;
    this.onPick = null;
    this.onHoverLoc = null;
  }

  preload() {
    this.load.image('map', 'assets/map/main_map.jpg');
    this.load.image('turn_order_slot', 'assets/markers/turn_order_slot.jpg');
    this.load.image('hand_card_back', 'assets/markers/hand_card_back.jpg');
    this.load.image('remote_market_card_back', 'assets/markers/remote_market_card_back.png');
    for (const c of ['red', 'yellow', 'white', 'purple']) {
      const ext = c === 'white' ? 'png' : 'jpg';
      this.load.image(`${c}_avatar`, `assets/avatars/${c}_avatar_1.${ext}`);
      this.load.image(`score_${c}`, `assets/markers/score_${c}.png`);
    }
    // 运河/铁路连接板块（扫描图）：4 色 × 2 时代
    for (const c of ['red', 'yellow', 'white', 'purple']) {
      for (const era of ['canal', 'rail']) {
        this.load.image(`${c}_${era}`, `assets/links/${c}_${era}.png`);
      }
    }
  }

  async create() {
    this.cameras.main.setBackgroundColor('#10151c');

    this.assets = new AssetLoader(this);
    await this.assets.init();

    const [mapPoints, locations, linkPoints] = await Promise.all([
      fetch('data/map_points.json').then((r) => r.json()),
      fetch('data/locations.json').then((r) => r.json()),
      fetch('data/link_points.json').then((r) => r.json()).catch(() => null),
    ]);
    this.mapPoints = mapPoints;
    this.regions = mapPoints.regions || {};
    this.slotXY = mapPoints.locations || {};
    this.locById = Object.fromEntries(locations.map((l) => [l.id, l]));
    this.linkPoints = linkPoints?.links || [];
    this.linkSlotW = linkPoints?.slotWidth || 20;
    this.linkSlotH = linkPoints?.slotHeight || 94;
    this.linkByPair = {};
    for (const lk of this.linkPoints) this.linkByPair[this._pairKey(lk.cities[0], lk.cities[1])] = lk;

    // 分数轨 / 收入轨坐标（半成品已标定：顺时针回环，100 格，pos 落于主图像素空间）。
    // 收入标记夹在尽头(incomePos∈[0,99])；分数标记循环累加(total%100 回绕)。
    this.scoreTrack = await fetch('data/score_track.json').then((r) => r.json()).catch(() => null);
    if (!this.scoreTrack || !Array.isArray(this.scoreTrack.positions) || this.scoreTrack.positions.length !== 100) {
      this.scoreTrack = null;
    }
    this.incomeTrack = await fetch('data/income_track.json').then((r) => r.json()).catch(() => null);

    this.baseC = this.add.container(0, 0);
    this.dynC = this.add.container(0, 0);
    this.hintC = this.add.container(0, 0).setDepth(60);   // 选择态高亮：最高优先级，防止被轨道标记(48)/牌库标记(50)拦截点击
    this.routeC = this.add.container(0, 0);
    this.markC = this.add.container(0, 0).setDepth(50);   // 牌库 / 远方市场轨标记（静态，随地图平移）
    this.trackC = this.add.container(0, 0).setDepth(48);   // 分数轨/收入轨（玩家标记，随地图平移）
    this.baseC.add(this.add.image(0, 0, 'map').setOrigin(0, 0));

    this.tipText = this.add.text(0, 0, '', {
      fontSize: '15px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.82)', padding: { x: 9, y: 6 }, align: 'left',
    }).setScrollFactor(0).setDepth(9000).setVisible(false);

    // 画布已被 main.js 物理裁剪到「地图区域」（insetL=10, insetR=312, insetT=184, insetB=12），
    // 与手牌行(上)/玩家面板(右) 三区互不重叠：地图绝不渲染到另两者之下。
    // 平移只走滚动条（见下方 getScrollState/setScrollRatio*/panBy）。
    // —— 鼠标拖拽平移已按需求禁用；开发者调试需要时取消下面注释启用：
    // this.pan = enableCameraPanZoom(this, { minZoom: 0.2, maxZoom: 8, regionX: null });
    this.fitCamera();
    this.scale.on('resize', () => this.fitCamera());
    this._bindWheel();

    this.input.on('pointermove', (p) => {
      if (this.tipText.visible) this._placeTip(p);
    });

    this.ready = true;
    if (this.state) this.render();
    this.events.emit('scene-ready');
  }

  // ---------------- 对外 ----------------

  /** 相机/缩放/滚动：画布即地图区域，地图可按钮缩放、滚动条平移。 */
  fitCamera() {
    const cam = this.cameras.main;
    const W = this.scale.width, H = this.scale.height;   // 画布 = 区域尺寸
    // 整图可见 = contain（默认视野）
    this._containZoom = Math.min(W / MAP_W, H / MAP_H);
    this._zoom = Phaser.Math.Clamp(this._zoom || 1, MIN_ZOOM, MAX_ZOOM);
    this._applyZoom(true);
  }

  /** 应用 z = containZoom × 用户因子；center=true 时地图中心对齐到画布中心。 */
  _applyZoom(center) {
    const cam = this.cameras.main;
    const z = this._containZoom * this._zoom;
    cam.setZoom(z);
    if (center) cam.centerOn(MAP_W / 2, MAP_H / 2);
    this._notifyScroll();
  }

  /** ＋/－ 按钮缩放：以当前画布中心的世界点为轴（视野不跳）。 */
  zoomBy(factor) {
    const cam = this.cameras.main;
    const cx = cam.scrollX + cam.width / 2;
    const cy = cam.scrollY + cam.height / 2;
    this._zoom = Phaser.Math.Clamp((this._zoom || 1) * factor, MIN_ZOOM, MAX_ZOOM);
    cam.setZoom(this._containZoom * this._zoom);
    cam.scrollX = cx - cam.width / 2;
    cam.scrollY = cy - cam.height / 2;
    this._notifyScroll();
    return this._zoom;
  }

  // ---------- 滚动条（玩家平移；拖拽地图平移已禁用） ----------

  _vw() { return this.cameras.main.width / this.cameras.main.zoom; }
  _vh() { return this.cameras.main.height / this.cameras.main.zoom; }

  /** 滚动条状态：可平移范围（世界px）与当前窗口比例（0..1）。 */
  getScrollState() {
    const cam = this.cameras.main;
    const vw = this._vw(), vh = this._vh();
    const rangeX = Math.max(0, MAP_W - vw);
    const rangeY = Math.max(0, MAP_H - vh);
    const winX = cam.scrollX + cam.width / 2 - vw / 2;
    const winY = cam.scrollY + cam.height / 2 - vh / 2;
    return {
      rangeX, rangeY,
      ratioX: rangeX ? Phaser.Math.Clamp(winX / rangeX, 0, 1) : 0,
      ratioY: rangeY ? Phaser.Math.Clamp(winY / rangeY, 0, 1) : 0,
      fracX: vw / MAP_W,
      fracY: vh / MAP_H,
      vw, vh,
    };
  }

  setScrollRatioX(r) {
    const cam = this.cameras.main;
    const vw = this._vw();
    const rangeX = Math.max(0, MAP_W - vw);
    if (!rangeX) return;
    cam.scrollX = Phaser.Math.Clamp(r, 0, 1) * rangeX - cam.width / 2 + vw / 2;
    this._notifyScroll();
  }

  setScrollRatioY(r) {
    const cam = this.cameras.main;
    const vh = this._vh();
    const rangeY = Math.max(0, MAP_H - vh);
    if (!rangeY) return;
    cam.scrollY = Phaser.Math.Clamp(r, 0, 1) * rangeY - cam.height / 2 + vh / 2;
    this._notifyScroll();
  }

  /** 滚动条箭头：按可见范围的比例平移一小段。 */
  panBy(dx, dy) {
    const cam = this.cameras.main;
    const vw = this._vw(), vh = this._vh();
    const rangeX = Math.max(0, MAP_W - vw);
    const rangeY = Math.max(0, MAP_H - vh);
    if (rangeX) {
      const winX = Phaser.Math.Clamp(cam.scrollX + cam.width / 2 - vw / 2 + dx, 0, rangeX);
      cam.scrollX = winX - cam.width / 2 + vw / 2;
    }
    if (rangeY) {
      const winY = Phaser.Math.Clamp(cam.scrollY + cam.height / 2 - vh / 2 + dy, 0, rangeY);
      cam.scrollY = winY - cam.height / 2 + vh / 2;
    }
    this._notifyScroll();
  }

  _notifyScroll() {
    this._scrollState = this.getScrollState();
    this.onScrollChange?.(this._scrollState);
  }

  /** 鼠标滚轮平移地图：行为像浏览普通网页——滚轮=上下滑动条，Shift+滚轮=左右滑动条。
   *  监听挂在 window 上，仅当光标落在「地图区域(#game)矩形」内才拦截：
   *  这样无论光标下是画布、滚动条轨道还是其它浮层，滚轮都能稳定驱动地图，
   *  不会被某个 DOM 元素把事件吃掉。整图可见（无可平移）时不拦截，交还页面。 */
  _bindWheel() {
    if (this._wheelBound) return;
    this._wheelBound = true;
    const cam = this.cameras.main;
    this._onWheel = (e) => {
      const g = document.getElementById('game');
      if (!g) return;
      const r = g.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right &&
                     e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) return;                       // 不在地图区域：交给页面（手牌/面板等照常）

      const st = this.getScrollState();
      const canY = st.rangeY > 0;
      const canX = st.rangeX > 0;
      if (!canY && !canX) return;               // 整图可见：不拦截，页面照常滚
      e.preventDefault();                        // 否则阻止页面/父容器原生滚动

      // 归一化 world-px：lines(1)→×16，pages(2)→×视口高，px(0)→原值
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 16;
      else if (e.deltaMode === 2) d *= (cam.height || 600);

      // 网页逻辑：滚轮向下(deltaY>0) → 视窗下移 → 看到地图下方内容
      if (e.shiftKey) {
        if (canX) this.panBy(d, 0);
      } else if (canY) {
        this.panBy(0, d);
      }
    };
    window.addEventListener('wheel', this._onWheel, { passive: false });
    this.events.once('shutdown', () => {
      window.removeEventListener('wheel', this._onWheel);
      this._wheelBound = false;
    });
  }

  setState(state) {
    this.state = state;
    if (this.ready) this.render();
  }

  /**
   * 进入选择态。传 null 退出。
   * @param {{kind:string, builds?:Array, links?:Array, mills?:Array}} picker
   */
  setPicker(picker) {
    this.picker = picker;
    if (!this.ready) return;
    if (picker) this._renderHints();
    else this.render();   // picker 清除 → 重绘以恢复板块悬停交互
  }

  // ---------------- 渲染 ----------------

  render() {
    this.dynC.removeAll(true);
    this.routeC?.removeAll(true);
    const st = this.state;
    if (!st) { this.picker = null; this.hintC.removeAll(true); return; }
    this._renderMarket('coal_market', st.coalMarket);
    this._renderMarket('iron_market', st.ironMarket);
    this._renderLinks();
    this._renderTiles();
    this._renderTurnOrder();
    this._renderMarkers();
    this._renderTrack();
    this._renderHints();
  }

  _pairKey(a, b) { return [a, b].sort().join('|'); }

  _slotPos(locId, slotIndex) {
    const s = this.slotXY[locId]?.slots?.[slotIndex];
    return s ? { x: s.x, y: s.y } : null;
  }

  /** 煤/铁市场：每档 2 个格位，按剩余数量从「靠右」开始填（消耗从便宜档先走）。 */
  _renderMarket(regionKey, market) {
    const reg = this.regions[regionKey];
    if (!reg || !market) return;
    const color = reg.color ?? 0xffffff;
    for (const [tier, pts] of Object.entries(reg.positions || {})) {
      const left = market[`price${tier}`] ?? 0;
      pts.forEach(([x, y], i) => {
        const filled = i < left;
        const r = this.add.rectangle(x, y, 30, 30, filled ? color : 0x000000, filled ? 0.95 : 0.25)
          .setStrokeStyle(2, filled ? 0xffffff : 0x666666, filled ? 0.9 : 0.6);
        this.dynC.add(r);
      });
    }
  }

  _renderLinks() {
    for (const p of this.state.players || []) {
      for (const lk of p.linkTiles || []) {
        const geo = this.linkByPair[this._pairKey(lk.endpoints[0], lk.endpoints[1])];
        if (!geo) continue;
        const color = lk.color || p.color;
        const key = `${color}_${lk.type}`;
        // 若扫描图已加载，用扫描图铺满槽位；否则保留旧色块兜底。
        if (this.textures.exists(key)) {
          const img = this.add.image(geo.x, geo.y, key)
            .setOrigin(0.5)
            .setDisplaySize(this.linkSlotW, this.linkSlotH)
            .setAngle(geo.angle || 0);
          this.dynC.add(img);
        } else {
          const w = this.linkSlotW, h = this.linkSlotH;
          const c = this.add.container(geo.x, geo.y);
          const hex = PLAYER_HEX[color] ?? 0x888888;
          const g = this.add.graphics();
          g.fillStyle(hex, 0.98);
          g.fillRoundedRect(-w / 2, -h / 2, w, h, 5);
          g.lineStyle(3, lk.type === 'rail' ? 0x222222 : 0x1b4f72, 1);
          g.strokeRoundedRect(-w / 2, -h / 2, w, h, 5);
          c.add(g);
          if (lk.type === 'rail') {
            const t = this.add.graphics();
            t.lineStyle(3, 0x1a1a1a, 0.85);
            t.lineBetween(-w / 2 + 3, -h / 6, w / 2 - 3, -h / 6);
            t.lineBetween(-w / 2 + 3, h / 6, w / 2 - 3, h / 6);
            c.add(t);
          }
          c.setAngle(geo.angle || 0);
          this.dynC.add(c);
        }
      }
    }
  }

  _renderTiles() {
    for (const p of this.state.players || []) {
      for (const t of p.industryTiles || []) {
        const pos = this._slotPos(t.location, t.slotIndex);
        if (!pos) continue;
        const key = t.flipped
          ? tileBackKey(t.color, t.industry, t.level)
          : tileTexKey(t.color, t.industry, t.level);
        let obj;
        if (key && this.textures.exists(key)) {
          obj = this.add.image(pos.x, pos.y, key).setOrigin(0.5);
          const src = this.textures.get(key).getSourceImage();
          obj.setScale(TILE_SIZE / Math.max(src.width || TILE_SIZE, src.height || TILE_SIZE));
        } else {
          obj = this.add.rectangle(pos.x, pos.y, TILE_SIZE, TILE_SIZE,
            IND_COLOR[t.industry] ?? 0x666666, 0.95)
            .setStrokeStyle(3, PLAYER_HEX[t.color] ?? 0xffffff, 1);
        }
        this.dynC.add(obj);

        // 板上剩余煤/铁：右上角计数徽标
        if (t.boardResources > 0) {
          const bx = pos.x + TILE_SIZE / 2 - 8, by = pos.y - TILE_SIZE / 2 + 8;
          const dot = this.add.circle(bx, by, 15,
            t.resourceType === 'coal' ? 0x2b2b2b : 0xff9f40, 1).setStrokeStyle(2, 0xffffff, 0.95);
          const num = this.add.text(bx, by, String(t.boardResources), {
            fontSize: '18px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
            fontStyle: 'bold',
          }).setOrigin(0.5);
          this.dynC.add(dot); this.dynC.add(num);
        }
        // 归属色环（缺图占位时尤其重要）
        const ring = this.add.rectangle(pos.x, pos.y, TILE_SIZE + 6, TILE_SIZE + 6, 0, 0)
          .setStrokeStyle(3, PLAYER_HEX[t.color] ?? 0xffffff, t.flipped ? 0.45 : 0.9);
        this.dynC.add(ring);

        const hit = this.add.zone(pos.x, pos.y, TILE_SIZE + 8, TILE_SIZE + 8).setOrigin(0.5);
        hit.setInteractive({ useHandCursor: false });
        hit.on('pointerover', () => this._showTip(this._tileTip(t)));
        hit.on('pointerout', () => this._hideTip());
        this.dynC.add(hit);
        // 选点态（建造/拆板/售卖/选源）激活时，底层板块的 hit zone 会让高亮命中区被「截胡」，
        // 故仅在无 picker 时保留板块自身的交互（悬停提示）；picker 激活时由 hintC 高亮区接管点击。
        if (this.picker) hit.disableInteractive();
      }
    }
  }

  _tileTip(t) {
    const owner = (this.state.players || []).find((p) => p.id === t.owner);
    const lines = [
      `${t.location} · ${t.level} 级${t.industry}`,
      `归属：${owner?.name || t.owner}`,
      t.flipped ? '状态：已翻面（已计收入）' : '状态：未翻面',
    ];
    if (t.boardResources > 0) lines.push(`板上${t.resourceType === 'coal' ? '煤' : '铁'}：${t.boardResources}`);
    return lines.join('\n');
  }

  _renderTurnOrder() {
    const to = this.regions.turn_order_track;
    if (!to?.positions?.length) return;
    const order = this.state.turnOrder || [];
    order.forEach((pid, idx) => {
      const pos = to.positions[idx];
      if (!pos) return;
      const [x, y] = pos;
      const pl = (this.state.players || []).find((p) => p.id === pid);
      if (!pl) return;
      fitIntoSlot(this, this.dynC, 'turn_order_slot', x, y, SLOT_D, SLOT_D, 'cover');
      const tex = `${pl.color}_avatar`;
      if (this.textures.exists(tex)) {
        // Container 子对象不能 setMask，头像与遮罩放场景层（本容器 x/y 为 0，坐标可直接复用）
        const [sx] = slotScale(this, tex, AVATAR_D, AVATAR_D, 'cover');
        const img = this.add.image(x, y, tex).setOrigin(0.5).setScale(sx).setDepth(5);
        const mg = this.add.graphics();
        mg.fillStyle(0xffffff, 1);
        mg.fillCircle(x, y, AVATAR_D / 2);
        mg.setVisible(false);
        img.setMask(mg.createGeometryMask());
        this.dynC.add(img); this.dynC.add(mg);
      }
      if (pid === this.state.currentPlayer) {
        const ring = this.add.graphics();
        ring.lineStyle(7, 0x6fd08c, 1);
        ring.strokeCircle(x, y, AVATAR_D / 2 + 7);
        this.dynC.add(ring);
      }
    });
  }

  // ---------------- 选择态高亮 ----------------

  _renderHints() {
    this.hintC.removeAll(true);
    const pk = this.picker;
    if (!pk) return;
    // 选点态激活时，禁用底层板块（dynC）已存在的 hit zone，避免高亮命中区被「截胡」
    for (const o of this.dynC.list) if (o.input) o.disableInteractive();

    if (pk.kind === 'build' && pk.builds?.length) {
      // 同一槽位可能对应多个产业选项，聚合后一次点击给出全部候选
      const byslot = new Map();
      for (const b of pk.builds) {
        const k = `${b.location}#${b.slotIndex}`;
        if (!byslot.has(k)) byslot.set(k, []);
        byslot.get(k).push(b);
      }
      for (const [k, opts] of byslot) {
        const [loc, idx] = k.split('#');
        const pos = this._slotPos(loc, Number(idx));
        if (!pos) continue;
        const only = opts.length === 1 ? opts[0] : null;
        const col = only ? (IND_COLOR[only.industry] ?? 0x6fd08c) : 0x6fd08c;
        const box = this.add.rectangle(pos.x, pos.y, TILE_SIZE + 10, TILE_SIZE + 10, col, 0.22)
          .setStrokeStyle(5, 0x6fd08c, 1);
        this.hintC.add(box);
        this.tweens.add({ targets: box, alpha: { from: 1, to: 0.45 }, duration: 700, yoyo: true, repeat: -1 });
        const hit = this.add.zone(pos.x, pos.y, TILE_SIZE + 14, TILE_SIZE + 14).setOrigin(0.5);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerover', () => this._showTip(opts.map(
          (o) => `${o.location} 槽${o.slotIndex + 1} · ${o.level}级${o.industry} · 共 £${o.totalMoney}`,
        ).join('\n')));
        hit.on('pointerout', () => this._hideTip());
        hit.on('pointerup', () => { if (this.pan?.isPanning()) return; this._hideTip(); this.onPick?.({ kind: 'build', options: opts }); });
        this.hintC.add(hit);
      }
    }

    if (pk.kind === 'road' && pk.links?.length) {
      for (const l of pk.links) {
        const geo = this.linkByPair[this._pairKey(l.from, l.to)];
        if (!geo) continue;
        const w = this.linkSlotW + 12, h = this.linkSlotH + 12;
        const c = this.add.container(geo.x, geo.y);
        const box = this.add.rectangle(0, 0, w, h, 0x6fd08c, 0.3).setStrokeStyle(4, 0x6fd08c, 1);
        c.add(box);
        c.setAngle(geo.angle || 0);
        this.hintC.add(c);
        this.tweens.add({ targets: c, alpha: { from: 1, to: 0.45 }, duration: 700, yoyo: true, repeat: -1 });
        const hit = this.add.zone(geo.x, geo.y, Math.max(w, h), Math.max(w, h)).setOrigin(0.5);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerover', () => this._showTip(
          `${l.from} - ${l.to}\n${l.type === 'canal' ? '运河' : '铁路'} · 共 £${l.totalMoney}`
          + (l.coal ? `（含煤 ${l.coal}）` : ''),
        ));
        hit.on('pointerout', () => this._hideTip());
        hit.on('pointerup', () => { if (this.pan?.isPanning()) return; this._hideTip(); this.onPick?.({ kind: 'road', link: l }); });
        this.hintC.add(hit);
      }
    }

    if (pk.kind === 'sell' && pk.mills?.length) {
      for (const m of pk.mills) {
        const tile = this._findTile(m.millId);
        const pos = tile && this._slotPos(tile.location, tile.slotIndex);
        if (!pos) continue;
        const box = this.add.rectangle(pos.x, pos.y, TILE_SIZE + 10, TILE_SIZE + 10, 0xffd479, 0.25)
          .setStrokeStyle(5, 0xffd479, 1);
        this.hintC.add(box);
        this.tweens.add({ targets: box, alpha: { from: 1, to: 0.45 }, duration: 700, yoyo: true, repeat: -1 });
        const hit = this.add.zone(pos.x, pos.y, TILE_SIZE + 14, TILE_SIZE + 14).setOrigin(0.5);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerover', () => this._showTip(
          `${m.location} · ${m.level} 级棉花厂\n渠道：${m.distant ? '远方市场' : ''}${m.distant && m.ports.length ? ' / ' : ''}${m.ports.length ? `港口 ×${m.ports.length}` : ''}`,
        ));
        hit.on('pointerout', () => this._hideTip());
        hit.on('pointerup', () => { if (this.pan?.isPanning()) return; this._hideTip(); this.onPick?.({ kind: 'sell', mill: m }); });
        this.hintC.add(hit);
      }
    }

    if (pk.kind === 'foreclose' && pk.tiles?.length) {
      // 强制拆板抵债：高亮玩家自己的产业板块，点击即拆除（不返还库存）
      for (const t of pk.tiles) {
        const tile = this._findTile(t.tileId);
        const pos = tile && this._slotPos(tile.location, tile.slotIndex);
        if (!pos) continue;
        const box = this.add.rectangle(pos.x, pos.y, TILE_SIZE + 10, TILE_SIZE + 10, 0xff5555, 0.28)
          .setStrokeStyle(5, 0xff5555, 1);
        this.hintC.add(box);
        this.tweens.add({ targets: box, alpha: { from: 1, to: 0.45 }, duration: 700, yoyo: true, repeat: -1 });
        const hit = this.add.zone(pos.x, pos.y, TILE_SIZE + 14, TILE_SIZE + 14).setOrigin(0.5);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerover', () => this._showTip(
          `${t.industry} · ${t.level} 级 · ${t.location} 槽${t.slotIndex + 1}\n点击拆除抵债（建造费用的一半用于还债，多余归你）`,
        ));
        hit.on('pointerout', () => this._hideTip());
        hit.on('pointerup', () => { if (this.pan?.isPanning()) return; this._hideTip(); this.onPick?.({ kind: 'foreclose', tileId: t.tileId }); });
        this.hintC.add(hit);
      }
    }

    if (pk.kind === 'resource' && pk.sources?.length) {
      // 铁/煤手动选源：在地图上点击建筑消耗（同一建筑可重复点击取多个，最多其板上剩余）
      const resCol = pk.resKind === 'coal' ? 0x39c5ff : 0xff9f40;
      const resName = pk.resKind === 'coal' ? '煤厂' : '铁厂';
      for (const s of pk.sources) {
        const tile = this._findTile(s.tileId);
        const pos = tile && this._slotPos(tile.location, tile.slotIndex);
        if (!pos) continue;
        const n = (pk.alloc && pk.alloc[s.tileId]) || 0;
        const full = n >= (s.remaining || 0);
        const owner = (this.state.players || []).find((p) => p.id === s.owner);
        const box = this.add.rectangle(pos.x, pos.y, TILE_SIZE + 10, TILE_SIZE + 10,
          full ? 0x555555 : resCol, full ? 0.15 : 0.22)
          .setStrokeStyle(5, full ? 0x888888 : resCol, full ? 0.55 : 1);
        this.hintC.add(box);
        if (!full) this.tweens.add({ targets: box, alpha: { from: 1, to: 0.45 }, duration: 700, yoyo: true, repeat: -1 });
        if (n > 0) {
          const badge = this.add.text(pos.x, pos.y - TILE_SIZE / 2 - 16, `×${n}`, {
            fontSize: '22px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
            fontStyle: 'bold', backgroundColor: '#000000cc',
            padding: { left: 7, right: 7, top: 2, bottom: 2 },
          }).setOrigin(0.5);
          this.hintC.add(badge);
        }
        const hit = this.add.zone(pos.x, pos.y, TILE_SIZE + 16, TILE_SIZE + 16).setOrigin(0.5);
        hit.setInteractive({ useHandCursor: true });
        hit.on('pointerover', () => this._showTip(
          `${tile.location} · ${s.level} 级${resName} · 归属：${owner?.name || s.owner}\n板上可消耗：${s.remaining}${n > 0 ? `，已选 ${n}` : ''}${full ? '（已取尽）' : ''}${pk.resKind === 'coal' ? '\n仅与你路网相连的煤厂可被消耗' : ''}`,
        ));
        hit.on('pointerout', () => this._hideTip());
        hit.on('pointerup', () => { if (this.pan?.isPanning()) return; this._hideTip(); this.onPick?.({ kind: 'resource', tileId: s.tileId }); });
        this.hintC.add(hit);
      }
    }
  }

  _findTile(tileId) {
    for (const p of this.state?.players || []) {
      const t = (p.industryTiles || []).find((x) => x.id === tileId);
      if (t) return t;
    }
    return null;
  }

  /** 悬停「选择路线」时，在棋盘上画一条醒目的粗绿实线（棉花厂 → 市场标记）。传 null 清除。 */
  drawRoute(path) {
    this.routeC?.removeAll(true);
    if (!path || path.length < 2) return;
    const pts = [];
    for (const loc of path) {
      const info = this.slotXY[loc];
      if (!info) return;
      let sx, sy;
      // 多数地点（可建厂的城/镇）用 slots 平均中心；市场标记城市等只有 point，直接取之
      if (info.slots && info.slots.length) {
        sx = 0; sy = 0;
        for (const s of info.slots) { sx += s.x; sy += s.y; }
        sx /= info.slots.length; sy /= info.slots.length;
      } else if (Array.isArray(info.point) && info.point.length >= 2) {
        sx = info.point[0]; sy = info.point[1];
      } else {
        return;
      }
      pts.push({ x: sx, y: sy });
    }
    const g = this.add.graphics();
    const green = 0x00ff88;
    g.lineStyle(8, green, 1.0);
    g.beginPath();
    g.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
    g.strokePath();
    g.fillStyle(green, 1);
    g.fillCircle(pts[0].x, pts[0].y, 12);
    g.fillCircle(pts[pts.length - 1].x, pts[pts.length - 1].y, 12);
    // 外发光描边：让绿色路线在复杂地图底图上更醒目
    const glow = this.add.graphics();
    glow.lineStyle(14, green, 0.28);
    glow.beginPath();
    glow.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) glow.lineTo(pts[i].x, pts[i].y);
    glow.strokePath();
    this.routeC.add(glow);
    this.routeC.add(g);
  }

  /** 把相机对准某个地点（点击右侧列表时用）。地点可带 slots（城/镇）或 point（市场标记城市）。 */
  focusLocation(locId) {
    const info = this.slotXY[locId];
    if (!info) return;
    let x, y;
    if (info.slots && info.slots.length) { x = info.slots[0].x; y = info.slots[0].y; }
    else if (Array.isArray(info.point) && info.point.length >= 2) { x = info.point[0]; y = info.point[1]; }
    else return;
    this.cameras.main.pan(x, y, 350, 'Sine.easeInOut');
  }

  // ---------------- 悬浮提示 ----------------

  _showTip(text) {
    this.tipText.setText(text).setVisible(true);
    this._placeTip(this.input.activePointer);
  }

  _hideTip() { this.tipText.setVisible(false); }

  _placeTip(p) {
    const cam = this.cameras.main;
    const z = cam.zoom || 1;
    const cx = cam.width / 2, cy = cam.height / 2;
    const sx = p.x + 18, sy = p.y + 18;
    this.tipText.setPosition(cx + (sx - cx) / z, cy + (sy - cy) / z).setScale(1 / z);
  }

  /** 牌库 / 远方市场轨：玩家视角下恒显的地图元素（随地图平移）。 */
  _renderMarkers() {
    this.markC?.removeAll(true);
    const st = this.state;
    if (!st) return;
    const imgFit = (key, cx, cy, w, h) => {
      const img = this.add.image(cx, cy, key).setOrigin(0.5);
      const src = this.textures.get(key).getSourceImage();
      img.setScale(w / (src.width || w), h / (src.height || h));
      this.markC.add(img);
    };

    // 手牌抽牌库（地图左上）
    const hd = this.regions.hand_deck;
    if (hd?.center && this.textures.exists('hand_card_back')) {
      const [cx, cy] = hd.center; const [w, h] = hd.size || [215, 300];
      imgFit('hand_card_back', cx, cy, w, h);
      this._countBadge(cx, cy - h / 2 - 2, st.deckRemaining ?? 0, '抽牌堆');
    }
    // 远方市场牌库（面朝下抽牌堆）
    const fm = this.regions.foreign_market_deck;
    if (fm?.center && this.textures.exists('remote_market_card_back')) {
      const [cx, cy] = fm.center; const [w, h] = fm.size || [198, 243];
      imgFit('remote_market_card_back', cx, cy, w, h);
      this._countBadge(cx, cy - h / 2 - 2, st.remoteMarketDeck?.remaining ?? 0, '远方市场牌库');
    }
    // 远方市场弃牌堆（计数 + 顶牌值）
    const fd = this.regions.foreign_market_discard;
    if (fd?.center) {
      const [cx, cy] = fd.center; const [w, h] = fd.size || [198, 244];
      const drawn = st.remoteMarketDeck?.drawn || [];
      const box = this.add.rectangle(cx, cy, w, h, 0x000000, 0.12)
        .setStrokeStyle(2, 0xffffff, 0.22);
      this.markC.add(box);
      if (drawn.length) {
        const top = drawn[drawn.length - 1];
        const t = this.add.text(cx, cy, String(top), {
          fontSize: '40px', color: '#ffd479', fontFamily: 'Microsoft YaHei, sans-serif', fontStyle: 'bold',
        }).setOrigin(0.5);
        this.markC.add(t);
      }
      this._countBadge(cx, cy + h / 2 + 2, drawn.length, '远方市场弃牌堆');
    }
    // 远方市场轨 + 标记（沿蛇形轨的 9 个格位 + 当前位置 pawn）
    const tr = this.regions.foreign_market_track;
    if (tr?.positions?.length) {
      tr.positions.forEach((pt, i) => {
        const dot = this.add.circle(pt[0], pt[1], 9, 0x000000, 0.5)
          .setStrokeStyle(2, i === tr.end_index ? 0xff5555 : 0xffffff, i === tr.end_index ? 1 : 0.7);
        this.markC.add(dot);
      });
      const idx = Phaser.Math.Clamp(st.remoteCottonTrack ?? 0, 0, tr.positions.length - 1);
      const p = tr.positions[idx];
      if (p) {
        const pawn = this.add.circle(p[0], p[1], 13, 0xffd479, 1).setStrokeStyle(3, 0x000000, 0.85);
        this.markC.add(pawn);
        this._countBadge(p[0], p[1] - 16, idx, '远方市场轨');
      }
    }
  }

  /** 分数轨 / 收入轨：金色回环 + 每个玩家的分数标记(累计循环)与收入标记(夹尽头)。
   *  坐标来自 score_track.json（顺时针回环，100 格，pos 落于主图像素空间）。
   *  收入标记 pos = incomePos（引擎已 clamp[0,99]，到尽头即停）；分数标记 pos = total%100 回绕累加。 */
  _renderTrack() {
    if (!this.trackC) return;
    this.trackC.removeAll(true);
    const tr = this.scoreTrack;
    if (!tr || !tr.positions || tr.positions.length !== 100) return;
    const pos = tr.positions;
    const N = pos.length;

    // 1) 轨道回环（金色）+ 每格刻度点
    const g = this.add.graphics();
    g.lineStyle(6, 0xffd479, 0.8);
    g.beginPath();
    g.moveTo(pos[0].x, pos[0].y);
    for (let i = 1; i < N; i++) g.lineTo(pos[i].x, pos[i].y);
    g.lineTo(pos[0].x, pos[0].y);
    g.strokePath();
    g.fillStyle(0xffffff, 0.85);
    for (let i = 0; i < N; i++) g.fillCircle(pos[i].x, pos[i].y, 3);
    this.trackC.add(g);

    const players = this.state.players || [];
    const n = Math.max(1, players.length);
    players.forEach((p, i) => {
      const color = PLAYER_HEX[p.color] ?? 0xffffff;
      const ang = (i / n) * Math.PI * 2;
      const ox = Math.cos(ang) * 9, oy = Math.sin(ang) * 9; // 同格多玩家按色微偏
      // 收入标记（实心圆盘 + 白描边；夹在尽头，incomePos 已由引擎 clamp[0,99]）
      const incPos = Phaser.Math.Clamp(p.incomePos ?? 0, 0, N - 1);
      const ip = pos[incPos];
      const incNum = (this.incomeTrack && Array.isArray(this.incomeTrack.positions))
        ? this.incomeTrack.positions[incPos] : null;
      this._trackMarker(`${p.id}:income`, ip.x + ox, ip.y + oy, color, p.color, false,
        incNum == null ? '¥' : String(incNum), `${p.name} 收入（${incNum == null ? '?' : incNum}）`);
      // 分数标记（循环累加：total%100 回绕；不清空）
      const sc = (this.state.scores && this.state.scores[p.id]) ? (this.state.scores[p.id].total || 0) : 0;
      const scPos = ((sc % 100) + 100) % 100;
      const sp = pos[scPos];
      this._trackMarker(`${p.id}:score`, sp.x - ox, sp.y - oy, color, p.color, true,
        String(sc), `${p.name} 分数（${sc}）`);
    });
  }

  /** 单个轨道标记：score=正六边形矢量（玩家色填充+白描边）；income=彩色圆点图片；带数值文字；位置变化时补间"跑动"。 */
  _trackMarker(key, x, y, color, colorName, isScore, label, tip) {
    const prev = (this._trackPrev && this._trackPrev[key]) || null;
    const cont = this.add.container(prev ? prev.x : x, prev ? prev.y : y);
    cont.name = key;
    const r = 14;
    const texKey = `score_${colorName}`;
    if (!isScore && this.textures.exists(texKey)) {
      // 收入标记使用彩色圆点图片（截图裁出的圆形点）
      const img = this.add.image(0, 0, texKey).setOrigin(0.5);
      const src = this.textures.get(texKey).getSourceImage();
      const size = r * 2;
      const s = size / Math.max(src.width || size, src.height || size);
      img.setScale(s);
      cont.add(img);
    } else if (isScore) {
      // 分数标记：正六边形矢量（玩家色填充 + 白描边），更清晰美观
      const g = this.add.graphics();
      const verts = [];
      for (let k = 0; k < 6; k++) {
        const a = -Math.PI / 2 + k * (Math.PI / 3); // 尖顶朝上
        verts.push(new Phaser.Math.Vector2(Math.cos(a) * r, Math.sin(a) * r));
      }
      g.fillStyle(color, 1);
      g.lineStyle(2.5, 0xffffff, 0.95);
      g.beginPath();
      g.moveTo(verts[0].x, verts[0].y);
      for (let k = 1; k < 6; k++) g.lineTo(verts[k].x, verts[k].y);
      g.closePath();
      g.fillPath();
      g.strokePath();
      cont.add(g);
    } else {
      // 兜底（正常不走：income 无图片时画空心环）
      const dot = this.add.circle(0, 0, r, color, 0.28).setStrokeStyle(3, 0xffffff, 1);
      cont.add(dot);
    }
    if (label != null && label !== '') {
      const t = this.add.text(0, 0, label, {
        fontSize: '13px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
        fontStyle: 'bold', stroke: '#000000', strokeThickness: 3,
      }).setOrigin(0.5);
      cont.add(t);
    }
    if (prev && (prev.x !== x || prev.y !== y)) {
      this.tweens.add({ targets: cont, x, y, duration: 420, ease: 'Sine.easeInOut' });
    }
    const hit = this.add.zone(0, 0, r * 2 + 6, r * 2 + 6).setInteractive({ useHandCursor: true });
    hit.on('pointerover', () => this._showTip(tip));
    hit.on('pointerout', () => this._hideTip());
    cont.add(hit);
    this.trackC.add(cont);
    this._trackPrev = this._trackPrev || {};
    this._trackPrev[key] = { x, y };
  }

  /** 地图上文字徽标（带半透明底，压在牌库/轨上方）。 */
  _countBadge(x, y, n, label) {
    const t = this.add.text(x, y, `${label} ${n}`, {
      fontSize: '14px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif', fontStyle: 'bold',
      backgroundColor: 'rgba(0,0,0,0.72)', padding: { x: 5, y: 3 },
    }).setOrigin(0.5, 1);
    this.markC.add(t);
  }

  /** 图例：地点槽位允许的产业（?identifiers=show 时叠加，便于校验数据） */
  debugSlots() {
    for (const [locId, loc] of Object.entries(this.slotXY)) {
      (loc.slots || []).forEach((s, i) => {
        const cn = (s.types || []).map((t) => SLOT_TYPE_CN[t] || t).join('/');
        const txt = this.add.text(s.x, s.y, `${i + 1}\n${cn}`, {
          fontSize: '14px', color: '#ffffff', align: 'center',
          backgroundColor: 'rgba(0,0,0,0.55)',
        }).setOrigin(0.5);
        this.baseC.add(txt);
      });
    }
  }
}
