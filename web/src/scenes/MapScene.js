import Phaser from 'phaser';
import { enableCameraPanZoom, addMapHint } from '../utils/cameraControl.js';
import AssetLoader from '../utils/AssetLoader.js';
import boardState from '../state/boardState.js';

/**
 * 地图场景：加载扫描版图 + map_points.json 坐标 → 画可拖动建筑标记 / 城市点。
 * - 标记模式（默认）：仅对「有建筑槽位」的城市，在每个槽位像素坐标处画一个可拖动彩色方块
 *   （以像素坐标为中点，允许单独拖动每一个方块；每个方块右下角带缩放手柄可单独等比缩放）。
 *   无建筑槽位的特殊城市地点不显示。
 * - 城市点模式：所有城市画中心圆点（旧逻辑）。
 * - 城市名称不显示（用户要求）。
 */

// 标记方块默认尺寸（以像素坐标标记作为中点）。数据层任意两槽位最小间距=72，故<72即互不重叠。
const DEFAULT_MARKER_SIZE = 56;
const MIN_MARKER_SIZE = 16;
const MAX_MARKER_SIZE = 220;
const MARKER_ALPHA = 0.5;

// 建筑类型 → 颜色（易辨识、与游戏资源配色一致）
const TYPE_COLOR = {
  cotton: 0xf4ecd8,   // 棉 米白
  coal: 0x2b2b2b,     // 煤 深灰（近黑）
  iron: 0xff9f40,     // 铁 橙
  port: 0x4ea3ff,     // 港口 蓝
  shipyard: 0x35c4b8, // 造船厂 青
};
const TYPE_BORDER = {
  cotton: 0x8a7d4a,
  coal: 0xffffff,
  iron: 0x7a3d00,
  port: 0x0b3a66,
  shipyard: 0x0a4a44,
};
const TYPE_LEGEND = [
  ['cotton', '棉'],
  ['coal', '煤'],
  ['iron', '铁'],
  ['port', '港'],
  ['shipyard', '船'],
];

export default class MapScene extends Phaser.Scene {
  constructor() {
    super('MapScene');
    this.mapFailed = false;
    this.points = null;       // 城市中心 {cityId:[x,y]}（城市点模式用）
    this.slots = null;        // 建筑槽位 {cityId:[{types,x,y,size?},...]}（仅含槽位城市）
    this.mapPoints = null;    // 原始 map_points.json（拖动/缩放后用于导出）
    this.linkPoints = null;   // 连接槽位数据 {links:[{id,cities,x,y,angle,era},...]}
    this.showBuildings = true; // 默认：标记模式
    this.cityGfx = null;
    this.markerObjs = [];     // 建筑槽位交互标记
    this.linkObjs = [];       // 连接槽位渲染标记（独立数组，不参与建筑拖动/撤销）
    this.domEls = [];
    this.__drag = null;
    this.__resize = null;
    this.__depthTop = 10;
    this.__dirty = false;
    this.__history = [];   // 撤销栈：每项 {cid, idx, before:{x,y,size}}
    this.__initial = null; // 初始快照（重置用）：{cid:[{x,y,size},...]}
    this.assets = null;    // AssetLoader 统一加载器
  }

  preload() {
    this.load.image('map', 'assets/map/main_map.jpg');
    this.load.once('loaderror', (file) => {
      if (file && file.key === 'map') this.mapFailed = true;
    });
  }

  async create() {
    this.cameras.main.setBackgroundColor('#10151c');

    // 统一加载所有游戏素材（tiles/cards/links/markers）
    this.assets = new AssetLoader(this);
    await this.assets.init();

    // 共享状态：公开落盘建筑列表（跨玩家/跨场景持久），用于地图视图也显示已建造建筑
    await boardState.ensureInit();
    window.__boardState = boardState;

    // 加载坐标数据：map_points.json 提供 points(城市中心) 与 slots(建筑槽位)
    this.mapPoints = await this._loadMapPoints();
    this.points = (this.mapPoints && this.mapPoints.points) || this._deriveCentroids(this.mapPoints && this.mapPoints.locations);
    this.slots = this._collectSlots(this.mapPoints && this.mapPoints.locations);
    this.linkPoints = await this._loadLinkPoints();
    this._snapshotInitial(); // 记录初始坐标/尺寸（重置用）
    // locations.json 提供 名称 / 市场标记 / 相邻关系
    this.locations = await (await fetch('data/locations.json')).json();

    if (this.mapFailed) {
      this.add.text(40, 40, '未找到扫描图：请把图片放到 web/public/assets/map/main_map.jpg', {
        fontSize: '18px', color: '#ff6b6b', fontFamily: 'Microsoft YaHei',
      });
      this.add.text(40, 80, '标好坐标后：把 map_points.json 放入 web/public/data/ 并刷新', {
        fontSize: '14px', color: '#9fb4c7', fontFamily: 'Microsoft YaHei',
      });
      return;
    }

    const map = this.add.image(0, 0, 'map').setOrigin(0);
    this.cameras.main.setBounds(0, 0, map.width, map.height);
    this.cameras.main.setZoom(Math.min(this.scale.width / map.width, this.scale.height / map.height));
    this.cameras.main.centerOn(map.width / 2, map.height / 2);

    // 缩放 + 平移（滚轮缩放 / 按住拖动）。点在标记方块或缩放手柄上时不平移。
    this.pan = enableCameraPanZoom(this, { minZoom: 0.25, maxZoom: 8 });
    addMapHint(this, ' · 右上角切换「标记 / 城市点」 · 拖动方块移动 · 拖右下角手柄缩放');

    this.cityGfx = this.add.graphics();
    this._drawCities();
    this._drawToggle();
    this._drawSaveButton();
    this._drawLegend();
    this._drawHint();

    // 公开游戏面板上的已建造建筑：始终渲染，跨玩家/跨场景持久（世界坐标直接落点）
    this._renderPlaced();

    // 拖动标记 / 缩放方块（场景级 pointermove / pointerup）
    this.input.on('pointermove', (p) => {
      if (this.__resize) {
        const wp = this.cameras.main.getWorldPoint(p.x, p.y);
        const c = this.__resize.c;
        const dist = Math.hypot(wp.x - c.x, wp.y - c.y);
        let newSize = this.__resize.startSize * (dist / this.__resize.startDist);
        newSize = Phaser.Math.Clamp(newSize, MIN_MARKER_SIZE, MAX_MARKER_SIZE);
        this._applyMarkerSize(c, newSize); // 等比修改：宽高同比例
        this._markDirty();
        return;
      }
      if (!this.__drag) return;
      const wp = this.cameras.main.getWorldPoint(p.x, p.y);
      const c = this.__drag.container;
      c.x = wp.x + this.__drag.ox;
      c.y = wp.y + this.__drag.oy;
      this.__drag.slot.x = c.x;   // 实时写回底层坐标（以方块中点为像素坐标）
      this.__drag.slot.y = c.y;
      this._markDirty();
    });
    const commitUp = () => {
      if (this.__drag) {
        const d = this.__drag, c = d.container, b = d.before;
        if (b && (Math.abs(b.x - c.x) > 0.5 || Math.abs(b.y - c.y) > 0.5 || Math.abs(b.size - c.__size) > 0.5)) {
          this.__history.push({ cid: c.__city, idx: c.__slotIdx, before: { ...b } });
        }
        this.__drag = null;
      }
      if (this.__resize) {
        const r = this.__resize, c = r.c, b = r.before;
        if (b && Math.abs(b.size - c.__size) > 0.5) {
          this.__history.push({ cid: c.__city, idx: c.__slotIdx, before: { ...b } });
        }
        this.__resize = null;
      }
      this._updateUndoBtn();
    };
    this.input.on('pointerup', commitUp);
    this.input.on('pointerupoutside', commitUp);

    // 场景关闭时清理 DOM 覆盖层
    this.events.once('shutdown', () => this._cleanDom());
    this.events.once('destroy', () => this._cleanDom());
  }

  async _loadMapPoints() {
    try {
      const res = await fetch('data/map_points.json');
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

  async _loadLinkPoints() {
    try {
      const res = await fetch('data/link_points.json');
      if (!res.ok) return null;
      return await res.json();
    } catch {
      return null;
    }
  }

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
        if (loc.slots && loc.slots.length) m[cid] = loc.slots; // 仅含槽位城市
      }
    }
    return m;
  }

  // 公开游戏面板上的已建造建筑：始终渲染，跨玩家/跨场景持久（世界坐标直接落点）
  _renderPlaced() {
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
      img.setDepth(400); // 浮于校准标识之上，始终可见
      this.__placedObjs.push(img);
    }
  }

  _clearMarkers() {
    this.markerObjs.forEach((c) => c.destroy());
    this.markerObjs = [];
    this._clearLinkMarkers();
  }

  _clearLinkMarkers() {
    this.linkObjs.forEach((c) => c.destroy());
    this.linkObjs = [];
  }

  // 连接槽位颜色：按时代区分（浅色边框便于在版图上识别）
  _linkColor(era) {
    if (era === 'rail') return 0x5a5a5a;       // 铁路 灰
    if (era === 'canal') return 0xa67c52;      // 运河 棕
    return 0x4caf50;                           // 双时代 绿（与铁路灰、运河棕及建筑色均区分）
  }

  _createLinkMarkers() {
    const data = this.linkPoints || {};
    const links = data.links || [];
    const w = data.slotWidth || 20;
    const h = data.slotHeight || 94;
    for (const lk of links) {
      const c = this.add.container(lk.x, lk.y);
      const g = this.add.graphics();
      const color = this._linkColor(lk.era);
      // 以中心为原点绘制竖直长条，再整体旋转 angle 度
      g.fillStyle(color, 0.65);
      g.fillRect(-w / 2, -h / 2, w, h);
      g.lineStyle(2, 0xffffff, 0.9);
      g.strokeRect(-w / 2, -h / 2, w, h);
      c.add(g);
      // 中心十字准星
      const ch = this.add.graphics();
      ch.lineStyle(2, 0xffffff, 0.95);
      ch.lineBetween(-8, 0, 8, 0);
      ch.lineBetween(0, -8, 0, 8);
      c.add(ch);
      c.setAngle(lk.angle || 0);
      c.setSize(w, h);
      // 命中区用稍大的矩形（不精确旋转，仅防止拖拽相机时误触）
      c.setInteractive(new Phaser.Geom.Rectangle(-w, -h, w * 2, h * 2), Phaser.Geom.Rectangle.Contains);
      c.__isMarker = true; // 悬停/点击时不平移相机
      c.__linkId = lk.id;
      c.__linkData = lk;
      c.setDepth(5);
      this.linkObjs.push(c);
    }
  }

  // 等比修改方块尺寸：宽高同比例，并更新手柄位置与命中区
  _applyMarkerSize(c, size) {
    const half = size / 2;
    c.__size = size;
    if (c.__gfx) {
      c.__gfx.clear();
      this._drawSplitMarker(c.__gfx, c.__types, size);
    }
    if (c.__rect) c.__rect.setSize(size, size);
    if (c.input && c.input.hitArea) c.input.hitArea.setTo(-half, -half, size, size);
    if (c.__handle) {
      c.__handle.setPosition(half, half);
      c.__handle.input.hitArea.setTo(-8, -8, 16, 16);
    }
    if (c.__slot) c.__slot.size = Math.round(size); // 写回底层，随保存导出
  }

  // 多类型槽位：对角线将正方形分两半，左(下左三角)=types[0] 色，右(上右三角)=types[1] 色
  _drawSplitMarker(g, types, size) {
    const h = size / 2;
    const c0 = TYPE_COLOR[types[0]] ?? 0x7ee0a3;
    const c1 = TYPE_COLOR[types[1]] ?? 0xff9f40;
    // 左半（下左三角）
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

  _createMarkers() {
    const handleSize = 16;
    for (const [cid, slotList] of Object.entries(this.slots || {})) {
      slotList.forEach((s, i) => {
        const types = (s.types && s.types.length) ? s.types : ['cotton'];
        const isMulti = types.length > 1;
        const type = types[0];
        const color = TYPE_COLOR[type] ?? 0x7ee0a3;
        const border = TYPE_BORDER[type] ?? 0xffffff;
        const size = s.size || DEFAULT_MARKER_SIZE;
        const half = size / 2;

        const c = this.add.container(s.x, s.y);
        // 主方块：多类型槽位画「对角线双色」，单类型画纯色
        if (isMulti) {
          const gx = this.add.graphics();
          this._drawSplitMarker(gx, types, size);
          c.add(gx);
          c.__gfx = gx;
          c.__types = types;
        } else {
          const r = this.add.rectangle(0, 0, size, size, color, MARKER_ALPHA);
          r.setStrokeStyle(3, border, 1);
          c.add(r);
          c.__rect = r;
        }
        // 中心十字准星，便于对齐到精确像素坐标
        const ch = this.add.graphics();
        ch.lineStyle(2, 0xffffff, 0.95);
        ch.lineBetween(-14, 0, 14, 0);
        ch.lineBetween(0, -14, 0, 14);
        c.add(ch);
        // 右下角缩放手柄（可单独等比缩放该方块）
        const h = this.add.rectangle(half, half, handleSize, handleSize, 0xffffff, 1);
        h.setStrokeStyle(2, 0x000000, 1);
        c.add(h);

        c.setSize(size, size);
        c.setInteractive(new Phaser.Geom.Rectangle(-half, -half, size, size), Phaser.Geom.Rectangle.Contains);
        c.__isMarker = true;
        c.__city = cid;
        c.__slotIdx = i;
        c.__slot = s;       // 直接引用底层坐标对象，拖动时实时写回
        c.__type = type;
        c.__size = size;
        c.__handle = h;
        c.setDepth(10 + i);

        // 拖动方块本体 → 移动坐标
        c.on('pointerdown', (p) => {
          if (this.__resize) return; // 正在缩放时不移动
          const wp = this.cameras.main.getWorldPoint(p.x, p.y);
          c.setDepth(++this.__depthTop); // 抓取的方块置顶，便于从重叠中抽出
          this.__drag = { container: c, slot: s, ox: c.x - wp.x, oy: c.y - wp.y,
            before: { x: c.x, y: c.y, size: c.__size } };
        });

        // 缩放手柄：等比修改尺寸
        h.setInteractive(new Phaser.Geom.Rectangle(-handleSize / 2, -handleSize / 2, handleSize, handleSize), Phaser.Geom.Rectangle.Contains);
        h.__isMarker = true; // 标记后相机不平移
        h.on('pointerdown', (p) => {
          const wp = this.cameras.main.getWorldPoint(p.x, p.y);
          const dist = Math.hypot(wp.x - c.x, wp.y - c.y) || 1;
          this.__drag = null;
          this.__resize = { c, startSize: c.__size, startDist: dist, before: { x: c.x, y: c.y, size: c.__size } };
        });

        this.markerObjs.push(c);
      });
    }
  }

  _drawCities() {
    this._clearMarkers();
    this.cityGfx.clear();

    if (this.showBuildings) {
      // 仅对「有建筑槽位」的城市画可拖动标记；无槽位特殊城市忽略
      this._createMarkers();
      // 同时渲染连接板块槽位（非交互，仅作位置示意）
      this._createLinkMarkers();
    } else {
      // 城市点模式：所有城市画中心圆点
      for (const loc of this.locations) {
        const pt = this.points?.[loc.id];
        if (!pt) continue;
        const [x, y] = pt;
        this.cityGfx.fillStyle(loc.market ? 0xffd479 : 0x7ee0a3, 0.95).fillCircle(x, y, 9);
        this.cityGfx.lineStyle(2, 0x10151c, 1).strokeCircle(x, y, 9);
      }
    }
  }

  _drawToggle() {
    const el = document.createElement('button');
    el.id = 'map-mode-toggle';
    el.style.cssText =
      'position:fixed;top:12px;right:12px;z-index:9999;padding:8px 14px;' +
      "font:14px/1.2 'Microsoft YaHei';background:#9fb4c7;color:#0b0f14;" +
      'border:none;border-radius:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);';
    const update = () => {
      el.textContent = this.showBuildings
        ? '显示模式：标记（点击切城市点）'
        : '显示模式：城市点（点击切标记）';
    };
    update();
    el.onclick = () => {
      this.showBuildings = !this.showBuildings;
      update();
      this._drawCities();
    };
    document.body.appendChild(el);
    this.domEls.push(el);
  }

  _drawSaveButton() {
    const wrap = document.createElement('div');
    wrap.id = 'map-save-wrap';
    wrap.style.cssText = 'position:fixed;top:54px;right:12px;z-index:9999;display:flex;gap:8px;align-items:center;';

    const save = document.createElement('button');
    save.textContent = '保存位置';
    save.style.cssText =
      'padding:8px 14px;font:14px/1.2 \'Microsoft YaHei\';background:#7ee0a3;color:#0b0f14;' +
      'border:none;border-radius:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);';
    const dirty = document.createElement('span');
    dirty.style.cssText = 'align-self:center;font:13px/1.2 \'Microsoft YaHei\';color:#ffd479;';
    dirty.textContent = '';
    save.onclick = () => {
      try {
        const blob = new Blob([JSON.stringify(this.mapPoints, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'map_points.json';
        a.click();
        URL.revokeObjectURL(url);
        this.__dirty = false;
        dirty.textContent = '已导出 ✓';
      } catch (e) {
        dirty.textContent = '导出失败: ' + e.message;
      }
    };
    wrap.appendChild(save);

    const undo = document.createElement('button');
    undo.textContent = '撤回上一步';
    undo.id = 'map-undo-btn';
    undo.style.cssText =
      'padding:8px 14px;font:14px/1.2 \'Microsoft YaHei\';background:#9fb4c7;color:#0b0f14;' +
      'border:none;border-radius:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);';
    undo.onclick = () => { this._undo(); dirty.textContent = this.__history.length ? '● 已改动，记得保存' : '已撤回 ✓'; };
    wrap.appendChild(undo);
    this.__undoBtn = undo;

    const reset = document.createElement('button');
    reset.textContent = '重置';
    reset.id = 'map-reset-btn';
    reset.style.cssText =
      'padding:8px 14px;font:14px/1.2 \'Microsoft YaHei\';background:#e07a7a;color:#0b0f14;' +
      'border:none;border-radius:6px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.4);';
    reset.onclick = () => { this._reset(); dirty.textContent = '已重置 ✓'; };
    wrap.appendChild(reset);

    wrap.appendChild(dirty);
    document.body.appendChild(wrap);
    this.domEls.push(wrap);
    this.__dirtyEl = dirty;
    this._updateUndoBtn();
  }

  _markDirty() {
    if (this.__dirtyEl && !this.__dirty) {
      this.__dirty = true;
      this.__dirtyEl.textContent = '● 已改动，记得保存';
    }
  }

  // 记录每个槽位加载时的初始坐标/尺寸（重置用）
  _snapshotInitial() {
    this.__initial = {};
    for (const [cid, list] of Object.entries(this.slots || {})) {
      this.__initial[cid] = list.map((s) => ({ x: s.x, y: s.y, size: s.size || DEFAULT_MARKER_SIZE }));
    }
  }

  // 撤回上一步：弹出栈顶历史，把该方块还原到改动前的坐标/尺寸
  _undo() {
    const h = this.__history.pop();
    if (!h) return false;
    const c = this.markerObjs.find((o) => o.__city === h.cid && o.__slotIdx === h.idx);
    if (!c) return false;
    c.x = h.before.x; c.y = h.before.y;
    c.__slot.x = h.before.x; c.__slot.y = h.before.y;
    this._applyMarkerSize(c, h.before.size);
    this._markDirty();
    this._updateUndoBtn();
    return true;
  }

  // 重置：所有方块回到初始坐标/尺寸，并清空撤销栈
  _reset() {
    for (const c of this.markerObjs) {
      const init = this.__initial?.[c.__city]?.[c.__slotIdx];
      if (!init) continue;
      c.x = init.x; c.y = init.y;
      c.__slot.x = init.x; c.__slot.y = init.y;
      this._applyMarkerSize(c, init.size);
    }
    this.__history = [];
    this._markDirty();
    this._updateUndoBtn();
  }

  _updateUndoBtn() {
    if (this.__undoBtn) this.__undoBtn.disabled = this.__history.length === 0;
  }

  _drawLegend() {
    const wrap = document.createElement('div');
    wrap.id = 'map-legend';
    const items = TYPE_LEGEND.map(([k, label]) => {
      const c = '#' + TYPE_COLOR[k].toString(16).padStart(6, '0');
      return `<span style="display:inline-flex;align-items:center;margin-right:12px;">
        <span style="display:inline-block;width:11px;height:11px;background:${c};border:1px solid #e6edf3;margin-right:5px;"></span>${label}</span>`;
    }).join('');
    const linkItems = [
      ['canal', '运河连接', '#a67c52'],
      ['rail', '铁路连接', '#5a5a5a'],
      ['both', '双时代连接', '#4caf50'],
    ].map(([_, label, c]) => `<span style="display:inline-flex;align-items:center;margin-right:12px;">
      <span style="display:inline-block;width:20px;height:8px;background:${c};border:1px solid #e6edf3;margin-right:5px;"></span>${label}</span>`).join('');
    wrap.innerHTML =
      `<div style="position:fixed;left:12px;bottom:12px;z-index:9999;padding:8px 12px;
        font:12px/1.6 'Microsoft YaHei';background:rgba(16,21,28,.8);color:#e6edf3;
        border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.4);">建筑类型：${items}
        <br><span style="color:#9fd6ff;">对角线双色方块=该槽位可建两种产业（左/右两半分别为两色）</span>
        <br><span style="color:#ffd479;">白方块手柄=拖右下角缩放该方块</span>
        <br>连接槽位：${linkItems}</div>`;
    document.body.appendChild(wrap);
    this.domEls.push(wrap);
  }

  _drawHint() {
    const nSlots = this.slots ? Object.keys(this.slots).length : 0;
    this.add.text(16, 44,
      `已加载 ${this.points ? Object.keys(this.points).length : 0} 城坐标 · ${nSlots} 城有建筑（标记模式可拖动/缩放）`,
      {
        fontSize: '14px', color: '#9fb4c7', fontFamily: 'Microsoft YaHei',
        backgroundColor: 'rgba(16,21,28,0.75)', padding: { x: 8, y: 4 },
      }).setDepth(100);
  }

  _cleanDom() {
    this.domEls.forEach((el) => el && el.remove());
    this.domEls = [];
  }
}
