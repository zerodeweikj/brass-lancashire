import Phaser from 'phaser';
import AssetLoader from '../utils/AssetLoader.js';
import { enableCameraPanZoom, addMapHint } from '../utils/cameraControl.js';
import { fitIntoSlot, slotScale } from '../utils/fit.js';
import boardState from '../state/boardState.js';
import {
  buildForeignMarketDeck, shuffleDeck, drawForeignMarketCard,
  stepsFromValue, nextTrackIndex, isMarketLocked, renderForeignMarketFront,
} from '../utils/foreignMarket.js';

/**
 * 合并场景：游戏主图版（左）+ 玩家面板（右）并排展示。
 *
 * 坐标保证不丢失 / 不错位的关键：
 *   - 地图内容画进 mapC 容器（位置 0,0），其内部坐标 = map_points.json 原始像素坐标；
 *   - 玩家面板内容画进 pbC 容器（位置 MAP_W+GAP, 0），其内部坐标 = player_board.json 原始像素坐标；
 *   - 两个容器顶边都对齐世界 y=0（顶边平行），中间留 GAP 空隙。
 * 容器只做整体平移，局部坐标原样保留，因此所有正方形位置、连接线、槽位都与单独场景完全一致。
 *
 * 本场景为只读验收视图：游戏版图与玩家面板的建筑槽位（正面贴图）均为校准/结构标识，
 * 默认隐藏（玩家只见扫描印刷图 + 功能性元素），URL 加 ?identifiers=show 才显示。
 * 玩家面板的产业板块永不翻面。
 */

// 固定底图尺寸（与扫描图一致）
const MAP_W = 1936, MAP_H = 1936;
const PB_W = 1417, PB_H = 960;
const GAP = 160; // 两块底图之间的空隙（世界像素）
const TOP_PAD = 90; // 顶部预留给 HUD 的空间（世界像素），面板整体下移避免 HUD 遮住游戏面板

// 只读标记方块尺寸（沿用 MapScene 标记模式默认值）
const DEFAULT_MARKER_SIZE = 56;
const MARKER_ALPHA = 0.5;

const TYPE_COLOR = {
  cotton: 0xf4ecd8, iron: 0xff9f40, coal: 0x2b2b2b, port: 0x4ea3ff, shipyard: 0x35c4b8,
};
const TYPE_BORDER = {
  cotton: 0x8a7d4a, iron: 0x7a3d00, coal: 0xffffff, port: 0x0b3a66,   shipyard: 0x0a4a44,
};

// 标识隐藏约定（2026-08-08 实测）：玩家视图默认隐藏所有校准/结构标识（游戏版图建筑槽位、连接槽位、
// 连接线、得分轨、远方市场轨框、市场方块、占位框、回合顺位槽位，以及玩家面板建筑槽位/产业正面占位），
// 仅显示扫描印刷图 + 功能性元素（牌库牌背、手牌弃牌托盘、动态弃牌牌）。
// 实现方式：直接「按需绘制」——标识符的绘制函数仅在 URL 含 ?identifiers=show 时调用，
// 不依赖 depth 分层（容器内角点 depth 排序不可靠，已弃用）。功能性元素恒绘制并置 _funcZ。
// 调试：?identifiers=show 可让标识浮出，用于校准/验收。
const Z_FUNC = 200;

// 右侧 4 个玩家面板：每个缩小版常驻（映射 BGA「Players panels」）。
const PANEL_SCALE = 0.30; // 1417×960 → 约 425×288 显示
const PANEL_GAP = 14;     // 面板纵向间距（世界像素）

export default class CombinedScene extends Phaser.Scene {
  constructor() {
    super('CombinedScene');
  }

  preload() {
    this.load.image('map', 'assets/map/main_map.jpg');
    this.load.image('player_board', 'assets/player_board.jpg');
    this.load.image('turn_order_slot', 'assets/markers/turn_order_slot.jpg');
    // 玩家默认头像（每色第一张作为默认头像，游戏大厅接入后可由用户上传覆盖；方形源图）
    this.load.image('red_avatar', 'assets/avatars/red_avatar_1.jpg');
    this.load.image('yellow_avatar', 'assets/avatars/yellow_avatar_1.jpg');
    this.load.image('white_avatar', 'assets/avatars/white_avatar_1.png');
    this.load.image('purple_avatar', 'assets/avatars/purple_avatar_1.jpg');
    this.load.image('hand_discard_area', 'assets/markers/hand_discard_area.jpg');
    this.load.image('hand_card_back', 'assets/markers/hand_card_back.jpg');
    this.load.image('remote_market_card_back', 'assets/markers/remote_market_card_back.png');
  }

  async create() {
    this.cameras.main.setBackgroundColor('#10151c');

    // 标识隐藏开关：玩家视图默认隐藏所有校准/结构标识（URL 含 ?identifiers=show 才显示，用于校准/验收）。
    this.hideIdentifiers = new URLSearchParams(location.search).get('identifiers') !== 'show';
    this._funcZ = Z_FUNC; // 功能性元素统一置顶深度

    // 当前玩家颜色（决定右方面板产业板块配色）：?color=red/yellow/white/purple，默认 white（验收视角）
    this.playerColor = new URLSearchParams(location.search).get('color') || 'white';

    // 统一加载所有游戏素材（tiles/cards/links/markers）
    this.assets = new AssetLoader(this);
    await this.assets.init();
    this.assets.defaultColor = this.playerColor;

    // 初始化跨场景共享状态：每玩家私有库存 + 公开落盘建筑列表（跨玩家/跨场景持久）
    await boardState.ensureInit();
    this.industryMap = boardState.industryMap || {};
    window.__boardState = boardState; // 调试/测试用
    window.__scene = this;            // 调试/测试用（面板/座席切换等）

    // 远方市场正面扫描图：若存在则加载（HEAD 探测，无则不加载，保持程序化占位）。
    // 不放进 manifest，避免缺图时生成占位方块盖掉程序化卡。
    await this._ensureForeignMarketFronts();

    // 加载坐标数据
    const mapPoints = await (await fetch('data/map_points.json')).json();
    this.regions = mapPoints.regions || {};
    this.locations = await (await fetch('data/locations.json')).json();
    const pb = await (await fetch('data/player_board.json')).json();
    this.pb = pb;
    let linkPoints = null;
    try {
      const r = await fetch('data/link_points.json');
      if (r.ok) linkPoints = await r.json();
    } catch { /* 无连接槽位数据则跳过 */ }
    const scoreTrack = await (await fetch('data/score_track.json')).json();
    let boardLayout = null;
    try {
      const r = await fetch('data/board_layout.json');
      if (r.ok) boardLayout = await r.json();
    } catch { /* 无地图外元素布局则跳过 */ }
    this.boardLayout = boardLayout || {};

    // 远方市场牌库：加载构成（按人数）→ 构建值数组 → Fisher-Yates 洗牌（无放回）。
    // 随机源默认 Math.random；将来接引擎时改为引擎下发的权威随机序。
    let fmComposition = { '4': { '0': 2, '-1': 2, '-2': 4, '-3': 3, '-4': 1 } };
    try {
      const r = await fetch('data/foreign_market_deck.json');
      if (r.ok) fmComposition = (await r.json()).by_player_count;
    } catch { /* 用默认构成 */ }
    const fmPlayers = parseInt(new URLSearchParams(location.search).get('players') || '4', 10);
    this.fmComposition = fmComposition;
    this.fmPlayerCount = fmPlayers;
    this.fmDeck = shuffleDeck(buildForeignMarketDeck(fmComposition, fmPlayers));
    this.fmDiscard = [];
    this.fmTrackIndex = 0;
    this.fmTrackEnd = this.regions?.foreign_market_track?.end_index ?? 8;
    this.__fmObjs = [];

    const points = (mapPoints && mapPoints.points) || this._deriveCentroids(mapPoints && mapPoints.locations);
    const slots = this._collectSlots(mapPoints && mapPoints.locations);
    // 标识是否显示：玩家视图默认隐藏（?identifiers=show 才显示，用于校准/验收）
    const showId = !this.hideIdentifiers;

    // ===== 两个容器：局部坐标 = 原始数据坐标，整体平移不影响内部位置 =====
    const mapC = this.add.container(0, TOP_PAD);
    const pbC = this.add.container(MAP_W + GAP, TOP_PAD);
    this.__mapC = mapC;
    this.__pbC = pbC;

    // ---------- 游戏主图版（左） ----------
    // 扫描底图始终最先绘制（depth 0）。功能性元素（deck 牌背等）后续以 _funcZ 浮于其上。
    // 所有校准/结构标识（建筑槽位、连接槽位、连接线、得分轨、各类框）仅在 showId 时绘制。
    mapC.add(this.add.image(0, 0, 'map').setOrigin(0, 0).setDepth(0));
    // 连接线已删除（无实际用途）。
    if (showId) {
      this._createMarkersInto(mapC, slots);          // 建筑槽位
      if (linkPoints) this._createLinkMarkersInto(mapC, linkPoints); // 连接槽位
      this._drawScoreTrack(mapC, scoreTrack);        // 得分轨
    }
    this._drawRegionsInto(mapC, showId);             // 内部再按 showId 细分功能/标识
    this._drawTurnOrderTrack(mapC);                  // 回合顺位槽位（功能元素：玩家头像 + 当前行动者发光，始终可见）
    this._drawBoardLayoutInto(mapC);                 // 功能性（手牌弃牌托盘），始终显示

    // 远方市场：弃牌堆顶牌正面 + 轨标记（功能性，恒显）
    this._renderForeignMarket();

    // ===== 调试按钮（已注释，真实游戏中不存在） =====
    // 远方市场是玩家执行「售卖」行动时选择是否翻牌获得额外奖励才触发的，
    // 由真实行动逻辑驱动，不需要这两个测试按钮；方法 _fmDraw/_fmNextPhase 保留备用。
    /*
    // 调试：翻牌库顶牌（验证随机抽牌 + 轨联动）。屏幕固定左下角，只显示动作文案。
    this.__fmBtn = this.add.text(20, this.scale.height - 44,
      '翻牌库顶牌', {
        fontSize: '18px', color: '#e8d5a3',
        fontFamily: 'Microsoft YaHei, sans-serif',
        backgroundColor: 'rgba(0,0,0,0.6)', padding: { x: 10, y: 6 },
      })
      .setScrollFactor(0).setDepth(200)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._fmDraw());

    // 调试：下一阶段（模拟运河时代→铁路时代切换），验证远方市场是否重置
    // （弃牌堆洗回牌库、重新洗牌、轨归零、标记恢复金色可翻）。
    this.__fmPhaseBtn = this.add.text(20, this.scale.height - 88,
      '下一阶段（重置远方市场）', {
        fontSize: '18px', color: '#9fd3ff',
        fontFamily: 'Microsoft YaHei, sans-serif',
        backgroundColor: 'rgba(0,0,0,0.6)', padding: { x: 10, y: 6 },
      })
      .setScrollFactor(0).setDepth(200)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this._fmNextPhase());
    */

    // 牌库剩余张数：鼠标移到牌库槽位区域时才在鼠标旁显示「剩余张数 N」。
    this.__deckTip = this.add.text(0, 0, '', {
      fontSize: '16px', color: '#ffffff',
      fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.7)', padding: { x: 8, y: 4 },
    }).setScrollFactor(0).setDepth(300).setVisible(false);

    const deckReg = this.regions?.foreign_market_deck;
    if (deckReg && deckReg.center && deckReg.size) {
      const [cx, cy] = deckReg.center;
      const [w, h] = deckReg.size;
      const zone = this.add.zone(cx, cy, w, h).setOrigin(0.5);
      mapC.add(zone);
      zone.setInteractive({ useHandCursor: true });
      zone.on('pointerover', () => this._showDeckTip(true));
      zone.on('pointerout', () => this._showDeckTip(false));
    }
    this.input.on('pointermove', (p) => {
      if (this.__deckTip && this.__deckTip.visible) {
        this.__deckTip.setPosition(p.x + 16, p.y + 16);
      }
    });

    // ---------- 右侧 4 个玩家面板（常驻，按回合顺位排列） ----------
    // 每个面板 = 缩小版 player_board + 该玩家头像 + 颜色标签（剩余数量由悬停显示）。
    // 本机座席(this.playerColor)面板额外渲染 19 槽位私有库存 + 悬停提示；其余面板只显公开信息。
    // 非当前行动者面板叠灰色遮罩，当前行动者面板亮边框（映射 BGA disablePlayerPanel）。
    // 点击任意面板切换本机查看座席（替代原切色 HUD 按钮）。
    this._buildPlayerPanels();

    // ---------- 公开游戏面板（左）上的已建造建筑：始终渲染、跨玩家持久 ----------
    this._renderPlaced();

    // ---------- 右侧个人面板调试 HUD（贴边固定，不受缩放/平移影响） ----------
    this._createPersonalHUD();

    // ---------- 手牌区（屏幕固定：底部圆形按钮 + 手牌横排 + 悬停滚轮放大查看） ----------
    this._createHandArea();

    // ---------- 手牌弃牌堆 ----------
    // 已移至「个人面板正下方空区域」，位置由 board_layout.json 的 hand_discard.center 定义，
    // 由 _drawBoardLayoutInto 统一绘制（此处无需再画）。

    // ---------- 标题标签（世界坐标，随相机平移） ----------
    this.add.text(MAP_W / 2, TOP_PAD - 40, '游戏版图', {
      fontSize: '30px', color: '#e8d5a3', fontFamily: 'Microsoft YaHei',
    }).setOrigin(0.5);
    this.add.text(this.__pbC.x + PB_W * PANEL_SCALE / 2, TOP_PAD - 40, '玩家面板 ×4（点击切换查看）', {
      fontSize: '30px', color: '#e8d5a3', fontFamily: 'Microsoft YaHei',
    }).setOrigin(0.5);

    // ---------- 相机：完整框住合并区域，顶边平行，支持平移/缩放 ----------
    const totalW = MAP_W + GAP + PB_W;
    const totalH = Math.max(MAP_H, PB_H) + TOP_PAD;
    // 左边界放宽：手牌抽牌库等地图外元素位于 world x<0（游戏版图左侧），
    // 允许 scrollX 为负以把它们纳入可视范围；不改变其他内容坐标。
    const L_BOUND = 450;
    this.cameras.main.setBounds(-L_BOUND, 0, totalW + L_BOUND, totalH);
    const fit = Math.min(this.scale.width / totalW, this.scale.height / totalH) * 0.98;
    this.cameras.main.setZoom(fit);
    this.cameras.main.centerOn(totalW / 2, totalH / 2);
    enableCameraPanZoom(this, { minZoom: 0.05, maxZoom: 8 });

    // HUD 改为屏幕固定，永远在屏幕左上角，不会随地图平移/缩放而盖住游戏面板。
    // addMapHint 已按用户要求屏蔽（返回 null），此处判空保护，不影响其他逻辑。
    const hint = addMapHint(this, ' · 游戏版图(左) 玩家面板(右) 顶边平行 · 拖动平移 滚轮缩放');
    if (hint) hint.setScrollFactor(0).setDepth(200);
  }

  // ===================== 数据辅助（与 MapScene 一致） =====================
  _deriveCentroids(locations) {
    const pts = {};
    if (locations && typeof locations === 'object') {
      for (const [cid, loc] of Object.entries(locations)) {
        if (loc.point) { pts[cid] = loc.point; continue; }
        if (Array.isArray(loc.slots) && loc.slots.length) {
          const arr = loc.slots.map((s) => [s.x, s.y]).filter((q) => q[0] != null);
          if (arr.length) {
            pts[cid] = [
              Math.round(arr.reduce((s, q) => s + q[0], 0) / arr.length),
              Math.round(arr.reduce((s, q) => s + q[1], 0) / arr.length),
            ];
          }
        }
      }
    }
    return pts;
  }

  _collectSlots(locations) {
    const m = {};
    if (locations && typeof locations === 'object') {
      for (const [cid, loc] of Object.entries(locations)) {
        if (loc.slots && loc.slots.length) m[cid] = loc.slots;
      }
    }
    return m;
  }

  // ===================== 绘制（只读，移植 MapScene） =====================
  _linkColor(era) {
    if (era === 'rail') return 0x5a5a5a;
    if (era === 'canal') return 0xa67c52;
    return 0x4caf50;
  }

  _drawSplitMarker(g, types, size) {
    const h = size / 2;
    const c0 = TYPE_COLOR[types[0]] ?? 0x7ee0a3;
    const c1 = TYPE_COLOR[types[1]] ?? 0xff9f40;
    g.fillStyle(c0, MARKER_ALPHA);
    g.fillTriangle(-h, -h, -h, h, h, h);
    // 右半（上右三角）
    g.fillStyle(c1, MARKER_ALPHA);
    g.fillTriangle(-h, -h, h, -h, h, h);
    // 对角线
    g.lineStyle(3, 0xffffff, 0.95);
    g.lineBetween(-h, -h, h, h);
    // 外框
    g.lineStyle(3, 0xffffff, 0.85);
    g.strokeRect(-h, -h, size, size);
  }

  _createMarkersInto(container, slots) {
    for (const [cid, slotList] of Object.entries(slots || {})) {
      slotList.forEach((s) => {
        const types = (s.types && s.types.length) ? s.types : ['cotton'];
        const isMulti = types.length > 1;
        const type = types[0];
        const color = TYPE_COLOR[type] ?? 0x7ee0a3;
        const border = TYPE_BORDER[type] ?? 0xffffff;
        const size = s.size || DEFAULT_MARKER_SIZE;
        const half = size / 2;

        const c = this.add.container(s.x, s.y);
        if (isMulti) {
          const gx = this.add.graphics();
          this._drawSplitMarker(gx, types, size);
          c.add(gx);
        } else {
          const r = this.add.rectangle(0, 0, size, size, color, MARKER_ALPHA);
          r.setStrokeStyle(3, border, 1);
          c.add(r);
        }
        // 中心十字准星
        const ch = this.add.graphics();
        ch.lineStyle(2, 0xffffff, 0.95);
        ch.lineBetween(-14, 0, 14, 0);
        ch.lineBetween(0, -14, 0, 14);
        c.add(ch);
        container.add(c);
      });
    }
  }

  _createLinkMarkersInto(container, data) {
    const links = data.links || [];
    const w = data.slotWidth || 20;
    const h = data.slotHeight || 94;
    for (const lk of links) {
      const c = this.add.container(lk.x, lk.y);
      const g = this.add.graphics();
      const color = this._linkColor(lk.era);
      g.fillStyle(color, 0.65);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.lineStyle(2, 0xffffff, 0.9);
      g.strokeRect(-w / 2, -h / 2, w, h);
      c.add(g);
      const ch = this.add.graphics();
      ch.lineStyle(2, 0xffffff, 0.95);
      ch.lineBetween(-8, 0, 8, 0);
      ch.lineBetween(0, -8, 0, 8);
      c.add(ch);
      c.setAngle(lk.angle || 0);
      container.add(c);
    }
  }

  // ===================== 得分轨道（0~99 回绕） =====================
  /**
   * 在游戏主图版容器内绘制得分轨道回环，并放置演示玩家标记验证回绕逻辑。
   * 轨道坐标来自 score_track.json（游戏面板像素空间，落于 __mapC 零错位）。
   * 落点规则：pos = ((total % 100) + 100) % 100 —— 超过 99 绕回 0，不丢位置。
   */
  _drawScoreTrack(container, track) {
    if (!track || !Array.isArray(track.positions) || track.positions.length !== 100) return;
    const pos = track.positions;
    const N = pos.length;

    // 1) 轨道连线（金色回环，99→0 闭合）
    const g = this.add.graphics();
    g.lineStyle(6, 0xffd479, 0.85);
    g.beginPath();
    g.moveTo(pos[0].x, pos[0].y);
    for (let i = 1; i < N; i++) g.lineTo(pos[i].x, pos[i].y);
    g.lineTo(pos[0].x, pos[0].y);
    g.strokePath();
    // 每格刻度点
    g.fillStyle(0xffffff, 0.9);
    for (let i = 0; i < N; i++) g.fillCircle(pos[i].x, pos[i].y, 3);
    container.add(g);

    // 2) 提示类元素（索引标签 / 角点强调 / 演示玩家标记与总分文字）已按用户要求清理，
    //    轨道只保留金色回环线 + 每格白色刻度点，不显示任何数字/文字/演示圆点。
  }

  // ===================== 区域映射（map_points.json 的 regions） =====================
  /**
   * 绘制 map_points.json 中 regions 记录的游戏主图版区域。
   * 默认（玩家视图）只绘制「功能性」元素（kind=rect_image 的图片槽位，如牌库牌背 / 手牌牌库）。
   * 其余校准/结构标识（远方市场轨框、回合顺位槽位、市场方块、占位框）仅在 showId 时绘制。
   * @param {Phaser.GameObjects.Container} container
   * @param {boolean} showId 是否显示校准/结构标识（?identifiers=show）
   */
  _drawRegionsInto(container, showId) {
    // —— 以下为校准/结构标识：仅在 showId 时绘制（玩家视图隐藏） ——
    if (showId) {
      // 远方的棉花市场轨：9 个蛇形格位框（白边，终点 X 格红边 + 红叉）
      const fm = this.regions?.foreign_market_track;
      if (fm && Array.isArray(fm.positions) && fm.positions.length) {
        const size = 40; // 格位框边长（行内格间距约 44px，40 不重叠）
        for (let i = 0; i < fm.positions.length; i++) {
          const [x, y] = fm.positions[i];
          const isEnd = i === fm.end_index;
          const r = this.add.rectangle(x, y, size, size, 0xffffff, 0.0)
            .setStrokeStyle(3, isEnd ? 0xff6b6b : 0xffffff, 0.9);
          container.add(r);
          if (isEnd) {
            const g = this.add.graphics();
            g.lineStyle(3, 0xff6b6b, 0.95);
            g.lineBetween(x - 9, y - 9, x + 9, y + 9);
            g.lineBetween(x + 9, y - 9, x - 9, y + 9);
            container.add(g);
          }
        }
      }

      // 回合顺位槽位：木纹圆 + 玩家头像 + 当前行动者发光
      // —— 已提升为功能元素，由 _drawTurnOrderTrack 独立绘制（始终可见），不在此处重复画。

      // 煤/铁市场（kind=market）：商品方块
      for (const [key, reg] of Object.entries(this.regions || {})) {
        if (reg && reg.kind === 'market' && reg.positions) {
          const mSize = 34;
          const color = reg.color ?? 0xffffff;
          for (const pts of Object.values(reg.positions)) {
            pts.forEach(([x, y]) => {
              const r = this.add.rectangle(x, y, mSize, mSize, color, 0.95)
                .setStrokeStyle(2, 0xffffff, 0.9);
              container.add(r);
            });
          }
        }
      }

      // 长方形占位框（kind=rect，且未显式 frame:false）：白边框
      for (const [key, reg] of Object.entries(this.regions || {})) {
        if (reg && reg.kind === 'rect' && reg.center && reg.size && reg.frame !== false) {
          const r = this.add.rectangle(reg.center[0], reg.center[1], reg.size[0], reg.size[1], 0xffffff, 0.0)
            .setStrokeStyle(3, 0xffffff, 0.9)
            .setAngle(reg.angle || 0);
          container.add(r);
        }
      }
    }

    // 长方形图片槽位（kind=rect_image）：中心点 + 宽高 + 角度 + image，如手牌抽牌库。
    // 图片按 size 缩放填充；未加载成功时 Phaser 自动留空（白板），不会崩。
    for (const [key, reg] of Object.entries(this.regions || {})) {
      if (reg && reg.kind === 'rect_image' && reg.center && reg.size && reg.image) {
        const [cx, cy] = reg.center;
        const [w, h] = reg.size;
        const texKey = reg.image.split('/').pop().replace(/\.[^.]+$/, '');
        if (!this.textures.exists(texKey)) continue; // preload 未加载则跳过（不应发生）
        const img = fitIntoSlot(this, container, texKey, cx, cy, w, h, 'stretch').setDepth(this._funcZ);
        img.setAngle(reg.angle || 0);
        // 手牌抽牌库：持有引用，供"剩余 0 张时隐藏图片只留地图底图"用
        if (key === 'hand_deck') this.__handDeckImg = img;
      }
    }
  }

  // ===================== 回合顺位轨（功能元素，始终可见） =====================
  /**
   * 在地图上绘制回合顺位槽位：木纹圆（cover）+ 玩家头像 + 当前行动者蓝色圆环。
   * - 测试环境默认顺序：红/黄/白/紫（将来由引擎 income 排序决定）。
   * - 头像来自 `assets/avatars/{color}_avatar_1.*`，游戏大厅接入后允许玩家上传覆盖。
   * - 头像与圆形遮罩放在【场景层（世界坐标）】：Phaser 限制「Container 子对象不能 setMask」，
   *   若头像留在容器内则遮罩不生效；槽位木纹圆留在容器内（无需遮罩）。
   */
  _drawTurnOrderTrack(container) {
    const to = this.regions?.turn_order_track;
    if (!to || !Array.isArray(to.positions) || !to.positions.length) return;
    const slotD = 170;
    const avatarD = 118;
    const order = boardState.playerOrder;
    order.forEach((color, idx) => {
      if (!to.positions[idx]) return;
      const [lx, ly] = to.positions[idx];
      // 容器局部坐标 → 世界坐标（头像/遮罩放场景层需要世界坐标）
      const wx = container.x + lx;
      const wy = container.y + ly;
      // 1) 槽位木纹圆（容器内，cover 裁边）
      fitIntoSlot(this, container, 'turn_order_slot', lx, ly, slotD, slotD, 'cover').setDepth(this._funcZ);
      // 2) 当前行动者标识：蓝色描边圆环（场景层，浮于头像外侧）
      if (idx === boardState.currentPlayerIdx) {
        const ring = this.add.graphics();
        ring.lineStyle(6, 0x4ea3ff, 1);
        ring.strokeCircle(wx, wy, avatarD / 2 + 5);
        ring.setDepth(this._funcZ + 2);
      }
      // 3) 玩家头像（方形源图，场景层）+ 圆形遮罩：遮罩圆直径=头像边长，圆内显示、圆外遮挡
      const texKey = `${color}_avatar`;
      if (this.textures.exists(texKey)) {
        const [sx] = slotScale(this, texKey, avatarD, avatarD, 'cover');
        const img = this.add.image(wx, wy, texKey).setOrigin(0.5).setScale(sx).setDepth(this._funcZ + 1);
        const maskG = this.add.graphics();
        maskG.fillStyle(0xffffff, 1);
        maskG.fillCircle(wx, wy, avatarD / 2);
        maskG.setVisible(false); // 遮罩几何不参与渲染，仅作 mask
        img.setMask(maskG.createGeometryMask());
      }
    });
  }

  // ===================== 地图外元素（board_layout.json） =====================
  /**
   * 绘制地图外元素（手牌弃牌堆等，不进 regions——它们不在地图上）。
   * kind=rect_image：按 center/size/angle 渲染一张图片（如弃牌堆区域图 218×300）。
   */
  _drawBoardLayoutInto(container) {
    for (const [key, item] of Object.entries(this.boardLayout || {})) {
      if (!item || item.kind !== 'rect_image' || !item.center || !item.size) continue;
      const [cx, cy] = item.center;
      const [w, h] = item.size;
      // item.image 是 web 路径（e.g. assets/.../foo.jpg），纹理 key 取文件名（去扩展名）
      const texKey = (item.image || 'hand_discard_area').split('/').pop().replace(/\.[^.]+$/, '');
      const img = fitIntoSlot(this, container, texKey, cx, cy, w, h, 'stretch').setDepth(this._funcZ);
      img.setAngle(item.angle || 0);
    }
  }

  // ===================== 远方市场（随机抽牌 / 弃牌堆正面 / 轨标记） =====================
  /**
   * 运行时加载远方市场正面扫描图（若存在）：对 5 个值(0/-1/-2/-3/-4)逐个 HEAD 探测
   * assets/markers/foreign_market_front_{base}.(jpg|jpeg|png)，存在才注册进纹理缓存。
   * 因此：用户未提供图时完全不加载 → renderForeignMarketFront 回退程序化占位（不破图）；
   * 提供图后刷新即自动启用真实正面。不放进 manifest，避免缺图占位方块盖掉程序化卡。
   */
  async _ensureForeignMarketFronts() {
    const fronts = [0, -1, -2, -3, -4];
    const toLoad = [];
    for (const v of fronts) {
      const base = 'foreign_market_front_' + (v < 0 ? 'neg' + (-v) : v);
      let url = null;
      for (const ext of ['jpg', 'jpeg', 'png']) {
        const u = `assets/markers/${base}.${ext}`;
        try {
          // 注意：Vite dev server 对缺失文件也会用 SPA 回退返回 200(text/html)，
          // 所以必须校验 Content-Type 以 image/ 开头，否则会误判 jpg 存在。
          const r = await fetch(u, { method: 'HEAD' });
          const ct = r.headers.get('content-type') || '';
          if (r.ok && ct.startsWith('image/')) { url = u; break; }
        } catch { /* 继续试下一扩展名 */ }
      }
      if (url) toLoad.push([base, url]);
    }
    if (toLoad.length === 0) return; // 无扫描图，保持程序化占位
    for (const [key, url] of toLoad) this.load.image(key, url);
    await new Promise((resolve) => {
      this.load.once('complete', resolve);
      this.load.start();
    });
  }

  /**
   * 渲染远方市场动态元素（功能性，恒显，不受 ?identifiers 影响）：
   *  - 弃牌堆：仅最顶那张正面（程序化占位；扫描图 assets/markers/foreign_market_front_{base} 到位后自动切换）。
   *  - 远端市场轨：当前位置金色圆点（额外奖励标记走到的位置；X 位变红表示锁定）。
   * 每次抽牌后调用本方法重绘；先销毁上一帧动态对象避免堆积。
   */
  _renderForeignMarket() {
    const mapC = this.__mapC;
    if (!mapC) return;
    if (this.__fmObjs) this.__fmObjs.forEach((o) => o.destroy());
    this.__fmObjs = [];

    const discReg = this.regions?.foreign_market_discard;
    const track = this.regions?.foreign_market_track;

    // 弃牌堆顶牌正面
    if (discReg && discReg.center && discReg.size && this.fmDiscard.length > 0) {
      const top = this.fmDiscard[this.fmDiscard.length - 1];
      const objs = renderForeignMarketFront(
        this, mapC, discReg.center[0], discReg.center[1], discReg.size[0], discReg.size[1], top,
      );
      objs.forEach((o) => { o.setDepth(this._funcZ); this.__fmObjs.push(o); });
    }

    // 远端市场轨标记（当前位置，不显示数值）。
    // 处于 X（终点）时改红色，直观表示「锁死·不可翻远方牌」。
    if (track && Array.isArray(track.positions) && this.fmTrackIndex < track.positions.length) {
      const [mx, my] = track.positions[this.fmTrackIndex];
      const locked = isMarketLocked(this.fmTrackIndex, this.fmTrackEnd);
      const dot = this.add.circle(mx, my, 14, locked ? 0xe23b3b : 0xffd479, 0.95)
        .setStrokeStyle(3, locked ? 0x7a1414 : 0x8a6d1f, 1).setDepth(this._funcZ);
      mapC.add(dot);
      this.__fmObjs.push(dot);
    }
  }

  // 鼠标悬停牌库槽位时显示浮动提示（仅悬停时可见，跟随鼠标）。
  // 标记处于 X（终点）时显示「禁翻」规则提示，否则显示「剩余张数 N」。
  _showDeckTip(show) {
    if (!this.__deckTip) return;
    if (show) {
      this.__deckTip.setText(this._deckTipText());
      const p = this.input.activePointer;
      this.__deckTip.setPosition(p.x + 16, p.y + 16).setVisible(true);
    } else {
      this.__deckTip.setVisible(false);
    }
  }

  // 牌库悬停提示文案：标记锁于 X → 规则提示；否则 → 剩余张数。
  _deckTipText() {
    if (isMarketLocked(this.fmTrackIndex, this.fmTrackEnd)) {
      return '标记已停于X·不可翻远方牌';
    }
    return `剩余张数 ${this.fmDeck.length}`;
  }

  // 调试抽牌：从洗好的牌库 pop 一张 → 进弃牌堆 → 轨按绝对值前进 → 重绘。
  // 规则：标记处于 X（终点）时，任何人无法获取额外奖励，禁止翻远方市场牌。
  _fmDraw() {
    if (isMarketLocked(this.fmTrackIndex, this.fmTrackEnd)) {
      if (this.__fmBtn) this.__fmBtn.setText('标记已停于X·禁翻远方牌');
      if (this.__deckTip && this.__deckTip.visible) this.__deckTip.setText(this._deckTipText());
      return;
    }
    const v = drawForeignMarketCard(this.fmDeck);
    if (v === null) {
      if (this.__fmBtn) this.__fmBtn.setText('牌库已空（刷新重置）');
      if (this.__deckTip && this.__deckTip.visible) this.__deckTip.setText('剩余张数 0');
      return;
    }
    this.fmDiscard.push(v);
    this.fmTrackIndex = nextTrackIndex(this.fmTrackIndex, stepsFromValue(v), this.fmTrackEnd);
    this._renderForeignMarket();
    if (isMarketLocked(this.fmTrackIndex, this.fmTrackEnd)) {
      if (this.__fmBtn) this.__fmBtn.setText('标记已停于X·禁翻远方牌');
    } else {
      if (this.__fmBtn) this.__fmBtn.setText('翻牌库顶牌');
    }
    if (this.__deckTip && this.__deckTip.visible) this.__deckTip.setText(this._deckTipText());
  }

  // 调试：模拟时代切换（运河→铁路）。远方市场重置：弃牌堆洗回牌库、重新洗牌、
  // 轨归零、标记恢复金色（可翻）。对应规则「运河时代计分后铁路时代开始前洗回」。
  _fmNextPhase() {
    const combined = [...this.fmDeck, ...this.fmDiscard];
    this.fmDeck = shuffleDeck(combined);
    this.fmDiscard = [];
    this.fmTrackIndex = 0;
    this._renderForeignMarket();
    if (this.__fmBtn) this.__fmBtn.setText('翻牌库顶牌');
    if (this.__deckTip && this.__deckTip.visible) this.__deckTip.setText(this._deckTipText());
  }

  // ===================== 右侧 4 个玩家面板（映射 BGA Players panels） =====================
  /**
   * 在右侧（pbC 区域）竖排常驻 4 个缩小版玩家面板，按 boardState.playerOrder 排列。
   * - 每个面板 = 缩小版 player_board 底图 + 该玩家头像(圆形遮罩) + 颜色标签（剩余数量由悬停显示）。
   * - 本机座席(this.playerColor)面板额外渲染 19 槽位私有库存 + 悬停提示；其余面板只显公开信息、槽位不渲染。
   * - 非当前行动者(idx !== currentPlayerIdx)面板叠半透明灰遮罩，当前行动者面板加蓝色亮边框。
   * - 点击任意面板底图切换本机查看座席（替代原切色 HUD 按钮）。
   * 每次切换座席 / 回合顺位变化后整体重建（面板为静态验收视图，重建成本低）。
   */
  _buildPlayerPanels() {
    if (this.__panels) for (const p of this.__panels) p.objs.forEach((o) => o.destroy());
    this.__panels = [];
    const order = boardState.playerOrder;
    const scale = PANEL_SCALE;
    const pw = PB_W * scale, ph = PB_H * scale;
    const baseX = this.__pbC.x, baseY = this.__pbC.y;
    const showId = !this.hideIdentifiers;
    const NAME = { red: '红', yellow: '黄', white: '白', purple: '紫' };
    const slotSize = this.pb?.slotSize || 86;

    order.forEach((color, idx) => {
      const px = baseX, py = baseY + idx * (ph + PANEL_GAP);
      const isSeat = color === this.playerColor;
      const isCurrent = idx === boardState.currentPlayerIdx;
      const objs = [];

      // 1) 底图（可点击切换座席）
      const bg = this.add.image(px, py, 'player_board').setOrigin(0, 0).setScale(scale).setDepth(10);
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerdown', () => this._setPlayerColor(color));
      objs.push(bg);

      // 2) 座席面板：渲染 19 槽位私有库存 + 悬停提示（其余面板槽位不渲染）
      if (isSeat) {
        for (const slot of this.pb?.slots || []) {
          const key = this.assets.getTile(slot.tile_id);
          if (!this.textures.exists(key)) continue;
          const wx = px + slot.x * scale, wy = py + slot.y * scale;
          const img = this.add.image(wx, wy, key).setOrigin(0.5).setDepth(20);
          const src = this.textures.get(key).getSourceImage();
          const maxDim = Math.max(src.width || slotSize, src.height || slotSize);
          img.setScale((slotSize / maxDim) * scale);
          img.setInteractive({ useHandCursor: true });
          img.on('pointerover', () => this._onPbOver(slot.tile_id));
          img.on('pointerout', () => this._onPbOut());
          objs.push(img);
          if (showId && slot.placeholder) {
            objs.push(this.add.rectangle(wx, wy, slotSize * scale, slotSize * scale, 0x35c4b8, 0.15).setDepth(21));
          }
        }
      }

      // 3) 头像（场景层圆形遮罩 —— Container 子对象不能 setMask，故放场景层）
      const avSize = 150 * scale;
      const avX = px + 70 * scale, avY = py + 70 * scale;
      const avTex = `${color}_avatar`;
      if (this.textures.exists(avTex)) {
        const [sx] = slotScale(this, avTex, avSize, avSize, 'cover');
        const av = this.add.image(avX, avY, avTex).setOrigin(0.5).setScale(sx).setDepth(30);
        const mg = this.add.graphics();
        mg.fillStyle(0xffffff, 1);
        mg.fillCircle(avX, avY, avSize / 2);
        mg.setVisible(false);
        av.setMask(mg.createGeometryMask());
        objs.push(av, mg);
      }

      // 4) 颜色标签（不显示 已建 数字；剩余数量改由悬停显示）
      const colorName = NAME[color] || color;
      const label = this.add.text(px + 230 * scale, py + 55 * scale,
        isSeat ? `${colorName}方（查看中）` : `${colorName}方`, {
          fontSize: '26px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
          fontStyle: 'bold', backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 6, y: 3 },
        }).setDepth(40);
      objs.push(label);

      // 5) 非当前行动者：半透明灰遮罩；当前行动者：蓝色亮边框（映射 BGA disablePlayerPanel / enablePlayerPanel）
      if (!isCurrent) {
        objs.push(this.add.rectangle(px + pw / 2, py + ph / 2, pw, ph, 0x000000, 0.5).setDepth(50));
      } else {
        objs.push(this.add.rectangle(px + pw / 2, py + ph / 2, pw, ph, 0x000000, 0)
          .setStrokeStyle(4, 0x4ea3ff, 1).setDepth(50));
      }

      this.__panels.push({ color, x: px, y: py, scale, objs });
    });
  }

  // 公开游戏面板（地图）上的已建造建筑：始终渲染，跨玩家/跨场景持久。
  _renderPlaced() {
    const mapC = this.__mapC;
    if (!mapC) return;
    if (this.__placedObjs) this.__placedObjs.forEach((o) => o.destroy());
    this.__placedObjs = [];
    const size = 80;
    for (const b of boardState.placed) {
      const key = `${b.color}_${b.tileId}`;
      if (!this.textures.exists(key)) continue; // 缺图跳过（待扫描图到位）
      const img = this.add.image(b.x, b.y, key).setOrigin(0.5);
      const src = this.textures.get(key).getSourceImage();
      const maxDim = Math.max(src.width || size, src.height || size);
      img.setScale(size / maxDim);
      img.setDepth(400); // 浮于校准标识之上，公开板建筑=功能元素，始终可见
      mapC.add(img);
      this.__placedObjs.push(img);
    }
  }

  // ---------- 个人面板悬停提示（仿远方市场牌库机制） ----------
  _onPbOver(tileId) {
    const n = boardState.getStock(this.playerColor, tileId);
    if (n == null || n <= 0) { this.__pbTip?.setVisible(false); return; }
    this.__pbTip.setText(this._pbTipText(tileId));
    const p = this.input.activePointer;
    this.__pbTip.setPosition(p.x + 16, p.y + 16).setVisible(true);
  }
  _onPbOut() {
    this.__pbTip?.setVisible(false);
  }
  _pbTipText(tileId) {
    const n = boardState.getStock(this.playerColor, tileId) ?? 0;
    const info = this.industryMap?.[tileId];
    const name = info ? `${info.industry}${info.level}` : tileId;
    return `${name} 剩余数量 ${n}`;
  }

  // ===================== 个人面板 HUD（贴边固定：查看座席标签 + 悬停提示） =====================
  _createPersonalHUD() {
    const colorName = { red: '红', yellow: '黄', white: '白', purple: '紫' }[this.playerColor] || this.playerColor;
    // 查看座席标签（屏幕固定，右上角）：提示当前查看的是哪一方，点面板可切换
    this.__pbLabel = this.add.text(0, 0, `查看座席 · ${colorName}方（点击面板切换）`, {
      fontSize: '20px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 8, y: 4 },
    }).setScrollFactor(0).setDepth(2000);
    this.__pbLabelFrac = { fx: 0.86, fy: 0.03 };

    // 悬停提示（屏幕固定，跟随鼠标）
    this.__pbTip = this.add.text(0, 0, '', {
      fontSize: '16px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.75)', padding: { x: 8, y: 4 },
    }).setScrollFactor(0).setDepth(2001).setVisible(false);
    this.input.on('pointermove', (p) => {
      if (this.__pbTip && this.__pbTip.visible) this.__pbTip.setPosition(p.x + 16, p.y + 16);
    });

    this._positionHUD();
  }

  /** 切换本机查看座席（仅影响右侧面板库存显示，左侧公开游戏面板建筑不受影响）。 */
  _setPlayerColor(color) {
    if (color === this.playerColor) return;
    this.playerColor = color;
    this.assets.defaultColor = color;
    const colorName = { red: '红', yellow: '黄', white: '白', purple: '紫' }[color] || color;
    this.__pbLabel?.setText(`查看座席 · ${colorName}方（点击面板切换）`);
    this._buildPlayerPanels();
  }

  /** 每帧把 HUD 贴到屏幕固定位置并抵消主相机 zoom 对 scrollFactor(0) 元素的中心缩放。 */
  _positionHUD() {
    // 防抖：create() 是 async，update() 可能在 create 完成前先跑（HUD 尚未创建），此时直接跳过
    if (!this.__pbLabelFrac) return;
    const cam = this.cameras.main;
    const z = cam.zoom || 1;
    const cx = cam.width / 2, cy = cam.height / 2;
    const place = (obj, fx, fy) => {
      if (!obj) return;
      const sx = cam.width * fx, sy = cam.height * fy;
      obj.setPosition(cx + (sx - cx) / z, cy + (sy - cy) / z).setScale(1 / z);
    };
    place(this.__pbLabel, this.__pbLabelFrac.fx, this.__pbLabelFrac.fy);
  }

  // ===================== 手牌区（屏幕固定：按钮 / 手牌横排 / 放大查看） =====================
  /**
   * 卡牌游戏式手牌区（炉石/影之诗风格）：
   * - 底部中央一个【圆形按钮】（无文字，手牌图形图标），点击展开/收起手牌；
   * - 展开态：手牌横排重叠于按钮上方（demo 数据，程序化占位卡）；
   * - 放大查看：悬停某张牌 + 滚轮上滑 → 该牌固定 2.2 倍居中屏幕、背景半透明遮罩压暗；
   *   退出 = 滚轮下滑 / 点击遮罩 / ESC（移开鼠标不退出）。
   * 全部元素 scrollFactor(0) 屏幕固定，容器原点=屏幕中心，每帧 _positionHandArea 定位。
   */
  _createHandArea() {
    this.handC = this.add.container(0, 0).setScrollFactor(0).setDepth(3000);

    // demo 手牌数据（真实手牌等后端接通后替换；img=assets/cards/ 真实卡牌图 key）
    this.demoHand = [
      { id: 'MANCHESTER', name: '曼彻斯特', type: '城市牌', img: 'city_MANCHESTER' },
      { id: 'LIVERPOOL', name: '利物浦', type: '城市牌', img: 'city_LIVERPOOL' },
      { id: 'colliery', name: '煤厂', type: '产业牌', img: 'ind_colliery' },
      { id: 'BIRKENHEAD', name: '伯肯黑德', type: '城市牌', img: 'city_BIRKENHEAD' },
      { id: 'cotton', name: '棉花厂', type: '产业牌', img: 'ind_cotton' },
      { id: 'OLDHAM', name: '奥尔德姆', type: '城市牌', img: 'city_OLDHAM' },
      { id: 'ironworks', name: '铁厂', type: '产业牌', img: 'ind_ironworks' },
      { id: 'BURY', name: '伯里', type: '城市牌', img: 'city_BURY' },
    ];
    this.__handOpen = false;      // 手牌区是否展开
    this.__zoomIdx = -1;          // 当前放大查看的手牌下标（-1 = 未放大）
    this.__hoverIdx = -1;         // 当前悬停的手牌下标
    this.__suppressMapWheel = false; // 手牌交互/放大时禁用地图滚轮缩放（供 cameraControl 判断）
    this.__cardW = 96;            // 手牌显示宽度（屏幕像素）
    this.__cardH = 134;           // 手牌显示高度（= 218:300 比例）
    this.__overlap = 46;          // 相邻手牌重叠量

    // --- 圆形手牌按钮（无文字，用 3 张迷你叠卡图标） ---
    this.handBtn = this.add.container(0, 0);
    this.handBtn.add(this.add.circle(0, 0, 34, 0x2b3a55, 0.95).setStrokeStyle(3, 0x5a7ba8, 1));
    for (let i = 0; i < 3; i++) {
      const mc = this.add.rectangle((i - 1) * 10, i === 1 ? -3 : 0, 20, 28,
        i === 1 ? 0x4a5f7a : 0x223046, 1)
        .setStrokeStyle(1.5, 0xffffff, 0.75).setAngle((i - 1) * 9);
      this.handBtn.add(mc);
    }
    this.handBtn.setSize(68, 68);
    this.handC.add(this.handBtn);

    // --- 手牌卡（展开时显示） ---
    this.handCards = this.add.container(0, 0);
    this.handC.add(this.handCards);
    this._buildHandCards();

    // --- 放大查看层：遮罩 + 放大卡 ---
    this.zoomLayer = this.add.container(0, 0).setDepth(3050);
    this.zoomLayer.setVisible(false);
    this.handC.add(this.zoomLayer);

    this.zoomMask = this.add.rectangle(0, 0, 1, 1, 0x000000, 0.65);
    this.zoomLayer.add(this.zoomMask);

    this.zoomCard = this.add.container(0, 0);
    this.zoomLayer.add(this.zoomCard);

    // --- 交互（命中改场景级手动：容器内对象 Phaser 命中会错位） ---
    this.input.on('wheel', (pointer, objs, dx, dy) => this._onWheel(pointer, dy));
    // ESC：优先退出弃牌查看，其次退出手牌放大（Phaser 3.90 的 keydown-ESC 特定事件不触发，用通用 keydown）
    this.input.keyboard.on('keydown', (e) => {
      if (e.keyCode === 27 || e.key === 'Escape') {
        if (this.__discardViewOpen) this._closeDiscardView();
        else this._hideZoom();
      }
    });
    this.input.on('pointerdown', (p) => this._onHandPointerDown(p));
    this.input.on('pointermove', (p) => this._onHandPointerMove(p));

    // --- 弃牌堆查看层 + 手牌抽牌库悬停提示（公共弃牌堆查看） ---
    this._createDeckUI();

    this._positionHandArea();
  }

  /** 展开/收起手牌区。 */
  _toggleHand() {
    this.__handOpen = !this.__handOpen;
    this.handCards.setVisible(this.__handOpen);
    if (!this.__handOpen) this._hideZoom();
    else this.__suppressMapWheel = false;
  }

  /** 构建手牌卡（真实卡牌图：assets/cards/ 的 city_* / ind_*）。 */
  _buildHandCards() {
    this.handCards.removeAll(true);
    this.__cardObjs = [];
    const n = this.demoHand.length;
    this.demoHand.forEach((card, i) => {
      const x = (i - (n - 1) / 2) * (this.__cardW - this.__overlap);
      const y = 0;
      const cc = this.add.container(x, y);
      const texKey = card.img;
      if (this.textures.exists(texKey)) {
        // 真实卡牌图：按 __cardW 等比缩放（218×300 源图 → 96×134）
        const img = this.add.image(0, 0, texKey).setOrigin(0.5);
        const src = this.textures.get(texKey).getSourceImage();
        const scale = this.__cardW / (src.width || 218);
        img.setScale(scale);
        cc.add(img);
      } else {
        // 兜底占位（不应发生）：色块 + 牌名
        cc.add(this.add.rectangle(0, 0, this.__cardW, this.__cardH, 0x8b6914, 1)
          .setStrokeStyle(2.5, 0xffffff, 0.92));
        cc.add(this.add.text(0, 0, card.name, {
          fontSize: '17px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif', fontStyle: 'bold',
        }).setOrigin(0.5));
      }
      cc.setSize(this.__cardW, this.__cardH);
      this.handCards.add(cc);
      this.__cardObjs.push(cc);
    });
    this.handCards.setVisible(this.__handOpen);
  }

  /** 滚轮：上滑优先级——悬停手牌→放大手牌；否则悬停弃牌堆→打开弃牌查看；放大/查看态滚轮无动作。 */
  _onWheel(pointer, dy) {
    if (this.__zoomIdx >= 0 || this.__discardViewOpen) return;
    // 优先级：悬停手牌 → 放大；悬停弃牌堆 → 打开弃牌查看
    if (dy < 0) {
      if (this.__handOpen && this.__hoverIdx >= 0) this._showZoom(this.__hoverIdx);
      else if (this.__hoverDiscard) this._openDiscardView();
    }
  }

  /** 放大查看：该牌固定 2.2 倍居中屏幕，背景遮罩压暗。 */
  _showZoom(idx) {
    if (idx < 0 || idx >= this.__cardObjs.length) return;
    this.__zoomIdx = idx;
    // 重建放大卡内容（该牌的放大版，用真实卡牌图）
    this.zoomCard.removeAll(true);
    const card = this.demoHand[idx];
    const w = this.__cardW * 2.2, h = this.__cardH * 2.2;
    const texKey = card.img;
    if (this.textures.exists(texKey)) {
      const img = this.add.image(0, 0, texKey).setOrigin(0.5);
      const src = this.textures.get(texKey).getSourceImage();
      const scale = w / (src.width || 218);
      img.setScale(scale);
      this.zoomCard.add(img);
    } else {
      this.zoomCard.add(this.add.rectangle(0, 0, w, h, 0x8b6914, 1).setStrokeStyle(4, 0xffffff, 1));
      this.zoomCard.add(this.add.text(0, 0, card.name, {
        fontSize: '34px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif', fontStyle: 'bold',
      }).setOrigin(0.5));
    }
    this.zoomLayer.setVisible(true);
    // 放大态：滚轮只用于手牌（下滑退出），地图滚轮缩放禁用
    this.__suppressMapWheel = true;
  }

  /** 退出放大查看。 */
  _hideZoom() {
    if (this.__zoomIdx < 0) return;
    this.__zoomIdx = -1;
    this.zoomLayer.setVisible(false);
    // 退出后不立即恢复地图滚轮：保持抑制直到鼠标移开手牌交互区（由 _onHandPointerMove 恢复）
    this.__suppressMapWheel = true;
  }

  /** 每帧把手牌区定位到屏幕中心（scrollFactor(0) + zoom 补偿）。 */
  _positionHandArea() {
    if (!this.handC) return;
    const cam = this.cameras.main;
    const z = cam.zoom || 1;
    const cx = cam.width / 2, cy = cam.height / 2;
    // 容器原点 = 屏幕中心
    this.handC.setPosition(cx, cy).setScale(1 / z);
    // 元素相对屏幕中心的偏移（屏幕像素）
    const btnY = cam.height / 2 - 44;
    this.handBtn.setPosition(0, btnY);
    // 手牌横排中心在按钮上方
    this.handCards.setPosition(0, btnY - 26 - this.__cardH / 2);
    // 放大层：遮罩铺满屏幕、放大卡居中
    this.zoomMask.setSize(cam.width, cam.height);
    this.zoomCard.setPosition(0, 0);
    // 弃牌查看层：遮罩铺满屏幕、弃牌牌列居中
    if (this.discardMask) this.discardMask.setSize(cam.width, cam.height);
    if (this.discardRow) this.discardRow.setPosition(0, 0);
    // 手动命中用的屏幕坐标（容器原点=屏幕中心，setScale(1/z) 使局部偏移=屏幕像素）
    this.__btnScreen = { x: cx, y: cy + btnY };
    this.__cardHit = [];
    for (let i = 0; i < this.__cardObjs.length; i++) {
      this.__cardHit.push({
        x: cx + this.handCards.x + this.__cardObjs[i].x,
        y: cy + this.handCards.y + this.__cardObjs[i].y,
        w: this.__cardW, h: this.__cardH,
      });
    }
    // 手牌抽牌库悬停提示：绝对跟随鼠标（屏幕坐标）+ 抵消相机 zoom，任何缩放/移动下大小位置固定
    if (this.__handDeckTip && this.__handDeckTip.visible) {
      const p = this.input.activePointer;
      const tx = p.x + 20, ty = p.y + 20;
      this.__handDeckTip.setPosition(cx + (tx - cx) / z, cy + (ty - cy) / z).setScale(1 / z);
    }
  }

  /** 场景级 pointerdown 手动命中（绕开容器内对象命中错位）。 */
  _onHandPointerDown(p) {
    // 弃牌查看态：整屏为遮罩，任意点击 = 点击遮罩 → 退出
    if (this.__discardViewOpen) { this._closeDiscardView(); return; }
    // 放大态：整屏为遮罩，任意点击 = 点击遮罩 → 退出
    if (this.__zoomIdx >= 0) { this._hideZoom(); return; }
    // 圆形手牌按钮
    const b = this.__btnScreen;
    if (b && Math.hypot(p.x - b.x, p.y - b.y) <= 34) { this._toggleHand(); return; }
    // 手牌卡（展开态）：点击选中（供后续行动系统使用）
    if (this.__handOpen) {
      for (let i = 0; i < this.__cardHit.length; i++) {
        const c = this.__cardHit[i];
        if (Math.abs(p.x - c.x) <= c.w / 2 && Math.abs(p.y - c.y) <= c.h / 2) {
          this.__selectedIdx = i;
          return;
        }
      }
    }
  }

  /** 场景级 pointermove 手动维护悬停手牌下标 + 弃牌堆/手牌抽牌库命中 + 滚轮抑制。 */
  _onHandPointerMove(p) {
    // 世界坐标命中：弃牌堆（个人面板下方）、手牌抽牌库（地图左侧手牌背面）
    const cam = this.cameras.main;
    const wp = cam.getWorldPoint(p.x, p.y);
    const d = this.__discardRect, hd = this.__handDeckRect;
    this.__hoverDiscard = !!d && Math.abs(wp.x - d.cx) <= d.hw && Math.abs(wp.y - d.cy) <= d.hh;
    this.__hoverHandDeck = !!hd && Math.abs(wp.x - hd.cx) <= hd.hw && Math.abs(wp.y - hd.cy) <= hd.hh;
    this._updateDeckTips(p);
    if (!this.__handOpen) {
      this.__hoverIdx = -1;
      this.__suppressMapWheel = this.__zoomIdx >= 0 || this.__discardViewOpen || this.__hoverDiscard;
      return;
    }
    let hit = -1;
    for (let i = 0; i < this.__cardHit.length; i++) {
      const c = this.__cardHit[i];
      if (Math.abs(p.x - c.x) <= c.w / 2 && Math.abs(p.y - c.y) <= c.h / 2) { hit = i; break; }
    }
    this.__hoverIdx = hit;
    // 地图滚轮仅在鼠标完全离开「手牌交互区」后恢复。
    // 交互区 = 手牌卡行 + 圆形按钮 + 放大卡区域（退出放大后鼠标停在放大卡位置也保持抑制，避免误触）。
    const cx = cam.width / 2, cy = cam.height / 2;
    const b = this.__btnScreen;
    const inBtn = !!b && Math.hypot(p.x - b.x, p.y - b.y) <= 34;
    const zoomW = this.__cardW * 2.2, zoomH = this.__cardH * 2.2;
    const inZoomCard = Math.abs(p.x - cx) <= zoomW / 2 && Math.abs(p.y - cy) <= zoomH / 2;
    const inHandZone = hit >= 0 || inBtn || inZoomCard;
    this.__suppressMapWheel = this.__zoomIdx >= 0 || this.__discardViewOpen || (this.__handOpen && inHandZone) || this.__hoverDiscard;
  }

  // ===================== 公共弃牌堆查看 + 手牌抽牌库悬停提示 =====================
  /**
   * 弃牌堆=公共区域：玩家消耗的牌集中放置。
   * - 悬停手牌抽牌库 → 提示「手牌抽牌库 剩余张数 N」；
   * - 悬停弃牌堆（个人面板下方）+ 滚轮上滑 → 弃牌牌列居中排列（从左到右，游戏王式）+ 背景遮罩；
   *   退出 = 点遮罩 / ESC；查看态抑制地图滚轮（不破坏既有功能）。
   */
  async _createDeckUI() {
    // demo 弃牌（真实消耗由后端接管后替换）
    this.demoDiscard = ['city_MANCHESTER', 'ind_colliery', 'city_LIVERPOOL', 'ind_cotton', 'city_OLDHAM', 'ind_port'];
    // 加载弃牌 + 手牌 demo 全部真实卡牌图（assets/cards/ 已就位），加载完重建手牌卡
    const need = new Set([...this.demoDiscard, ...(this.demoHand || []).map((c) => c.img)]);
    const toLoad = [...need].filter((k) => !this.textures.exists(k));
    for (const k of toLoad) this.load.image(k, `assets/cards/${k}.jpg`);
    if (toLoad.length) {
      await new Promise((res) => { this.load.once('complete', res); this.load.start(); });
      this._buildHandCards(); // 真实图就绪 → 重建手牌卡（原占位重建为真实图）
    }

    // 弃牌堆 / 手牌抽牌库的世界区域（mapC 偏移已含在坐标里）
    this.__discardRect = { cx: 2804, cy: 1280, hw: 109, hh: 150 };
    this.__handDeckRect = { cx: 249, cy: 375, hw: 107, hh: 150 };
    this.__hoverDiscard = false;
    this.__hoverHandDeck = false;
    this.__discardViewOpen = false;
    this.__handDeckTipN = 24; // demo：手牌抽牌库剩余张数（后端接管后替换）

    // 弃牌查看层（scrollFactor(0)，放 handC 内统一缩放/深度）
    this.discardLayer = this.add.container(0, 0).setDepth(3100).setVisible(false);
    this.discardMask = this.add.rectangle(0, 0, 1, 1, 0x000000, 0.65);
    this.discardLayer.add(this.discardMask);
    this.discardRow = this.add.container(0, 0);
    this.discardLayer.add(this.discardRow);
    this.handC.add(this.discardLayer);

    // 手牌抽牌库悬停提示（屏幕固定，跟随鼠标；字号加大；不随相机缩放/移动而变）
    this.__handDeckTip = this.add.text(0, 0, '', {
      fontSize: '24px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
      fontStyle: 'bold',
      backgroundColor: 'rgba(0,0,0,0.8)', padding: { x: 12, y: 8 },
    }).setScrollFactor(0).setDepth(3200).setVisible(false);
  }

  /** 弃牌牌列：从左到右居中排列（游戏王式）。 */
  _buildDiscardRow() {
    this.discardRow.removeAll(true);
    const n = this.demoDiscard.length;
    const cardW = 118, gap = 10;
    this.demoDiscard.forEach((key, i) => {
      if (!this.textures.exists(key)) return;
      const x = (i - (n - 1) / 2) * (cardW + gap);
      const img = this.add.image(x, 0, key).setOrigin(0.5);
      const src = this.textures.get(key).getSourceImage();
      img.setScale(cardW / (src.width || 218));
      this.discardRow.add(img);
    });
  }

  /** 打开弃牌堆查看。 */
  _openDiscardView() {
    this.__discardViewOpen = true;
    this._buildDiscardRow();
    this.discardLayer.setVisible(true);
    this.__suppressMapWheel = true;
  }

  /** 退出弃牌堆查看（点遮罩 / ESC）。退出后保持抑制，直到鼠标离开弃牌堆区域（由 pointermove 恢复）。 */
  _closeDiscardView() {
    if (!this.__discardViewOpen) return;
    this.__discardViewOpen = false;
    this.discardLayer.setVisible(false);
    this.__suppressMapWheel = true;
  }

  /** 悬停手牌抽牌库 → 提示剩余张数（跟随鼠标；不随相机缩放/移动而变）。 */
  _updateDeckTips(p) {
    if (!this.__handDeckTip) return;
    this._syncHandDeckVisibility();
    if (this.__handDeckTipN <= 0) return; // 无牌时不显示提示（同步方法已隐藏）
    if (this.__hoverHandDeck) {
      this.__handDeckTip.setText(`手牌抽牌库 剩余张数 ${this.__handDeckTipN}`)
        .setPosition(p.x + 20, p.y + 20).setVisible(true);
    } else if (this.__handDeckTip.visible) {
      this.__handDeckTip.setVisible(false);
    }
  }

  /**
   * 抽牌库剩余张数同步：剩余 ≤0 时隐藏抽牌库图片（槽位只留地图底图）与提示；
   * 恢复 >0 时重新显示。常驻方法（每帧 update 调用），不依赖 hover 事件。
   */
  _syncHandDeckVisibility() {
    if (!this.__handDeckImg) return;
    const empty = this.__handDeckTipN <= 0;
    if (this.__handDeckImg.visible === empty) this.__handDeckImg.setVisible(!empty);
    if (empty && this.__handDeckTip && this.__handDeckTip.visible) this.__handDeckTip.setVisible(false);
  }

  /** 每帧刷新 HUD 固定位置（不影响任何世界对象）。 */
  update() {
    this._positionHUD();
    this._positionHandArea();
    this._syncHandDeckVisibility();
  }

}
