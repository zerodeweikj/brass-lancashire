import Phaser from 'phaser';
import AssetLoader from '../utils/AssetLoader.js';

/**
 * 地图校准工具：把扫描版图上的「建筑槽位 / 无槽位城市点」映射成图片原始像素坐标。
 *
 * 交互重做版（2026-08-06）：
 *  - 不再依赖 per-object setInteractive，所有输入走全局 pointer 事件 + 坐标命中，
 *    避免多相机下对象可见性与输入检测不同步的问题。
 *  - 有 slots 的城市映射每个建筑槽位（绿点）；无 slots 城市映射城市点（蓝点）。
 *  - 误点修正：点击已放置的绿/蓝点即可删除，重新点击地图落点；也保留「清空全部」。
 *  - 落点视觉反馈更明显（大点 + 标签 + 状态文字 + 自动跳下一槽位）。
 *
 * 缩放安全版（2026-08-06 二次修复）：
 *  - 核心模型：地图图片 x/scaleX/scaleY 定死，缩放/拖动只改变相机（视窗）。
 *    屏幕→世界用相机直接数学换算 scroll + s/zoom（不依赖相机矩阵，避开事件回调里的
 *    矩阵过期问题）；世界→原图像素用固定的 mapImg 变换。任意 zoom / scroll 下都能精确映射。
 *  - 滚轮缩放以鼠标为中心（直接数学）、拖拽平移 ÷ zoom、落点换算、标记命中半径 ÷ zoom。
 *  - localStorage 旧格式/脏数据在加载时校验迁移，_place 双层防御，杜绝
 *    "Cannot set properties of undefined" 崩溃。
 *  - 新增「⟲ 重置视图」按钮（缩放/平移迷路时一键回初始视角）。
 */
const LS_KEY = 'lancashire_map_points';
const PANEL_RATIO = 0.32; // 右侧面板占屏宽比例
const GAP = 14;

const TYPE_CN = { cotton: '棉花', coal: '煤', iron: '铁', port: '港口', shipyard: '造船' };
const MARKER_HIT_RADIUS = 14; // 点击附近多大范围算命中已落点

function slotTypeLabel(types) {
  if (!types || !types.length) return '城市点';
  if (typeof types === 'string') return types;
  return types.map((t) => TYPE_CN[t] || t).join('/');
}

export default class MapCalibrateScene extends Phaser.Scene {
  constructor() {
    super('MapCalibrateScene');
    this.points = {};       // cityId -> { slots: [[x,y]|null,...], point?: [x,y] }
    this.currentCity = null;
    this.currentSlot = null; // number = 槽位下标；null = 城市点（无槽位城市）
    this.mapFailed = false;
    this.labels = {};       // marker id -> Text
    this.assets = null;     // AssetLoader
  }

  preload() {
    this.load.image('map', 'assets/map/main_map.jpg');
    this.load.once('loaderror', (file) => {
      if (file && file.key === 'map') this.mapFailed = true;
    });
  }

  async create() {
    try {
      this.locations = await (await fetch('data/locations.json')).json();
      const saved = localStorage.getItem(LS_KEY);
      // 校验并迁移旧格式数据：任何不符合 slots/point 结构的条目直接丢弃，防止 _place 崩溃
      if (saved) this.points = this._validatePoints(JSON.parse(saved));
      // 加载现有 map_points.json 的 regions（远方市场轨等区域坐标），导出时原样保留，
      // 避免校准导出整文件覆盖导致区域数据丢失。
      try {
        const mp = await (await fetch('data/map_points.json')).json();
        this.regions = mp.regions || {};
      } catch { this.regions = {}; }
    } catch (e) {
      console.error('[calibrate] 初始化失败', e);
      this.add.text(20, 20, '初始化失败: ' + e.message, {
        fontSize: '18px', color: '#ff6b6b', fontFamily: 'Microsoft YaHei',
      });
      return;
    }

    if (this.mapFailed) {
      this.add.text(20, 20, '未找到扫描图：请把图片放到 web/public/assets/map/main_map.jpg 后刷新', {
        fontSize: '18px', color: '#ff6b6b', fontFamily: 'Microsoft YaHei',
      });
      return;
    }

    // 统一加载所有游戏素材（不阻塞已有地图显示，失败自动降级为占位图）
    this.assets = new AssetLoader(this);
    await this.assets.init();

    this.panelX = Math.round(this.scale.width * (1 - PANEL_RATIO));

    // ---------- 地图 ----------
    const map = this.add.image(0, 0, 'map').setOrigin(0);
    const maxW = this.panelX - GAP * 2;
    const maxH = this.scale.height - GAP * 2;
    let dispW = maxW;
    let dispH = dispW * (map.height / map.width);
    if (dispH > maxH) {
      dispH = maxH;
      dispW = dispH * (map.width / map.height);
    }
    map.setDisplaySize(dispW, dispH);
    map.setPosition((this.panelX - dispW) / 2, (this.scale.height - dispH) / 2);
    this.mapImg = map;

    // ---------- 相机 ----------
    const mapCam = this.cameras.main;
    mapCam.setBackgroundColor('#10151c');
    // 不设 setBounds：自由平移缩放（配合「重置视图」按钮恢复）。
    // 初始 scroll(0,0)：世界坐标 = 屏幕坐标，地图恰好落在 GAP 位置。
    mapCam.setZoom(1);
    mapCam.setScroll(0, 0);

    // UI 相机：固定渲染 HUD
    const uiCam = this.cameras.add(0, 0, this.scale.width, this.scale.height);
    uiCam.setName('ui');
    this.uiCam = uiCam;

    // 标记图层（跟随地图相机）
    this.markers = this.add.graphics();
    this.uiCam.ignore([this.mapImg, this.markers]);

    // ---------- HUD（全部归 mapCam 忽略，uiCam 渲染） ----------
    this.hud = [];
    const hud = (o) => {
      this.hud.push(o);
      mapCam.ignore(o);
      return o;
    };

    // 左上角提示
    hud(this.add.text(16, 14, '🖱 滚轮缩放 · 按住拖动平移 · 点击绿/蓝点可删除重标', {
      fontSize: '13px', color: '#c9d4e0', fontFamily: 'Microsoft YaHei',
      backgroundColor: 'rgba(16,21,28,0.75)', padding: { x: 8, y: 4 },
    }).setDepth(100));

    // 右侧面板背景
    hud(this.add.rectangle(this.panelX, 0, this.scale.width - this.panelX, this.scale.height, 0x1c2430)
      .setOrigin(0).setDepth(5));
    hud(this.add.text(this.panelX + 16, 12, '地图校准 · 建筑槽位', {
      fontSize: '18px', color: '#e8d5a3', fontFamily: 'Microsoft YaHei', fontStyle: 'bold',
    }).setDepth(6));
    // 重置视图按钮（面板标题右侧）：缩放/平移迷路时一键回初始视角
    hud(this.add.text(this.panelX + 262, 14, '⟲ 重置视图', {
      fontSize: '13px', color: '#9fd6ff', backgroundColor: '#223140', padding: { x: 10, y: 5 },
      fontFamily: 'Microsoft YaHei',
    }).setDepth(6));
    this.resetBtnBox = new Phaser.Geom.Rectangle(this.panelX + 252, 8, 150, 34);
    this.statusText = hud(this.add.text(this.panelX + 16, 40, '', {
      fontSize: '13px', color: '#9fb4c7', fontFamily: 'Microsoft YaHei',
    }).setDepth(6));
    hud(this.add.text(this.panelX + 16, 60, '● 绿 = 建筑槽位   ● 蓝 = 无槽位城市点', {
      fontSize: '12px', color: '#7e8ea0', fontFamily: 'Microsoft YaHei',
    }).setDepth(6));

    // 城市列表（仅静态文本，点击命中走全局坐标计算）
    this.listY = 86;
    this.itemH = 18;
    this.cityItems = {};
    this.locations.forEach((loc, i) => {
      const y = this.listY + i * this.itemH;
      const txt = hud(this.add.text(this.panelX + 16, y, '', {
        fontSize: '13px', color: '#c9d4e0', fontFamily: 'Microsoft YaHei',
      }).setDepth(6));
      this.cityItems[loc.id] = { text: txt, baseY: y };
    });

    // 当前城市槽位明细
    this.slotDetailY = this.listY + this.locations.length * this.itemH + 8;
    this.slotLines = [];

    // 底部按钮
    const exportY = 648;
    const clearY = 688;
    hud(this.add.text(this.panelX + 16, exportY, '⬇ 导出 map_points.json', {
      fontSize: '15px', color: '#10151c', backgroundColor: '#7ee0a3', padding: { x: 12, y: 8 },
      fontFamily: 'Microsoft YaHei', fontStyle: 'bold',
    }).setDepth(6));
    hud(this.add.text(this.panelX + 16, clearY, '🗑 清空全部', {
      fontSize: '13px', color: '#ff9b9b', backgroundColor: '#2a1f24', padding: { x: 10, y: 6 },
      fontFamily: 'Microsoft YaHei',
    }).setDepth(6));
    this.exportBtnBox = new Phaser.Geom.Rectangle(this.panelX, exportY - 4, 260, 38);
    this.clearBtnBox = new Phaser.Geom.Rectangle(this.panelX, clearY - 4, 120, 32);

    this._bindInput();
    this._redrawMarkers();
    this._updateStatus();
    this._buildSlotDetail();

    // 默认选中第一个未完成的城市
    this._advanceCity();
  }

  // ---------- 数据辅助 ----------
  _loc(cityId) { return this.locations.find((l) => l.id === cityId); }

  _isCityDone(loc) {
    const p = this.points[loc.id];
    if (!p) return false;
    if (loc.slots.length === 0) return Array.isArray(p.point);
    return loc.slots.every((_, i) => Array.isArray(p.slots && p.slots[i]));
  }

  _placedCount() {
    let n = 0;
    for (const loc of this.locations) {
      const p = this.points[loc.id];
      if (!p) continue;
      if (loc.slots.length === 0) { if (Array.isArray(p.point)) n++; }
      else { loc.slots.forEach((_, i) => { if (Array.isArray(p.slots && p.slots[i])) n++; }); }
    }
    return n;
  }

  _totalCount() {
    return this.locations.reduce((s, l) => s + (l.slots.length || 1), 0);
  }

  // ---------- 交互：全部走全局 pointer 事件 ----------
  // 关键：用【实时】canvas 包围盒把 client 像素换算成游戏坐标，不信任 Phaser
  // scaleManager 缓存的 canvasBounds。真实浏览器里 FIT 缩放 + 居中后，Phaser 缓存的
  // 画布位置可能过期（布局延迟/滚动条/扩展等），导致 pointer.x 整体偏移（点击落点偏左/偏右）。
  // 每次事件直接 getBoundingClientRect() 取最新位置，绝对准确，跨浏览器一致。
  _freshGame(pointer) {
    const ev = pointer.event;
    if (ev && typeof ev.clientX === 'number') {
      const rect = this.game.canvas.getBoundingClientRect();
      const gs = this.scale.gameSize; // 基准分辨率（1280×720），与 FIT 缩放无关
      return {
        x: (ev.clientX - rect.left) * (gs.width / rect.width),
        y: (ev.clientY - rect.top) * (gs.height / rect.height),
      };
    }
    return { x: pointer.x, y: pointer.y };
  }

  _bindInput() {
    const cam = this.cameras.main;
    const inMap = (gx) => gx < this.panelX;
    // 拖动阈值（游戏像素）：按下后位移超过此值才开始平移；点击判定看相机是否真动过
    const PAN_THRESHOLD = 12;
    const panState = { down: false, canPan: false, startX: 0, startY: 0, scrollX: 0, scrollY: 0 };

    // 屏蔽浏览器右键菜单
    this.game.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    this.input.on('pointerdown', (pointer) => {
      const { x: gx, y: gy } = this._freshGame(pointer);
      if (pointer.button !== 0) return; // 仅左键启动
      panState.down = true;
      panState.canPan = inMap(gx); // 只有从地图区域开始的拖动才平移
      panState.startX = gx;
      panState.startY = gy;
      panState.scrollX = cam.scrollX;
      panState.scrollY = cam.scrollY;
    });

    this.input.on('pointermove', (pointer) => {
      if (!panState.down || !panState.canPan) return;
      const { x: gx, y: gy } = this._freshGame(pointer);
      const dx = gx - panState.startX;
      const dy = gy - panState.startY;
      if (Math.hypot(dx, dy) <= PAN_THRESHOLD) return;
      // 屏幕位移 ÷ zoom = 世界位移（任意缩放级别下拖拽距离都正确）
      cam.scrollX = panState.scrollX - dx / cam.zoom;
      cam.scrollY = panState.scrollY - dy / cam.zoom;
    });

    this.input.on('pointerup', (pointer) => {
      try {
        // 相机真的被推动过 = 平移结束，不当点击；真实点击即便有抖动，相机不动，必落点
        const scrolled = cam.scrollX !== panState.scrollX || cam.scrollY !== panState.scrollY;
        panState.down = false;
        if (scrolled) return;

        const { x: gx, y: gy } = this._freshGame(pointer);
        // 右键地图：删除最近落点
        if (pointer.button === 2 && inMap(gx)) {
          this._tryDeleteMarkerAtScreen(gx, gy);
          return;
        }
        if (pointer.button !== 0) return;

        if (!inMap(gx)) {
          this._handlePanelClick(gx, gy);
          return;
        }
        this._handleMapClick(gx, gy);
      } catch (e) {
        console.error('[calibrate] pointerup 异常', e);
        this._fatal('交互异常: ' + e.message);
      }
    });

    this.input.on('pointerupoutside', () => { panState.down = false; });

    // 滚轮缩放（以鼠标位置为中心）：直接数学换算，不依赖 getWorldPoint 相机矩阵缓存。
    // 任意 zoom：屏幕点(gx,gy) 对应世界点 = scroll + s/zoom；改 zoom 后保持该世界点不动。
    this.input.on('wheel', (pointer, _over, _dX, dY) => {
      const { x: gx, y: gy } = this._freshGame(pointer);
      if (!inMap(gx)) return;
      const factor = dY < 0 ? 1.15 : 1 / 1.15;
      const z = Phaser.Math.Clamp(cam.zoom * factor, 0.2, 10);
      const wx = cam.scrollX + gx / cam.zoom;
      const wy = cam.scrollY + gy / cam.zoom;
      cam.setZoom(z);
      cam.scrollX = wx - gx / z;
      cam.scrollY = wy - gy / z;
    });
  }

  // 全局错误浮层：任何运行时报错直接显示在画面上，避免静默卡死
  _fatal(msg) {
    if (this._fatalText) { this._fatalText.setText('⚠ ' + msg); return; }
    this._fatalText = this.add.text(this.scale.width / 2, 8, '⚠ ' + msg, {
      fontSize: '14px', color: '#ff6b6b', backgroundColor: '#3a0d0d',
      padding: { x: 10, y: 6 }, fontFamily: 'Microsoft YaHei',
    }).setOrigin(0.5, 0).setScrollFactor(0).setDepth(999);
    if (this.uiCam) this.uiCam.ignore(this._fatalText);
  }

  _handlePanelClick(x, y) {
    // 重置视图按钮
    if (this.resetBtnBox && this.resetBtnBox.contains(x, y)) { this._resetView(); return; }

    // 城市列表命中
    if (y >= this.listY && y < this.listY + this.locations.length * this.itemH) {
      const idx = Math.floor((y - this.listY) / this.itemH);
      const loc = this.locations[idx];
      if (loc) this._selectCity(loc.id, null);
      return;
    }

    // 槽位明细命中（当前城市展开后才有）
    const loc = this.currentCity ? this._loc(this.currentCity) : null;
    if (loc && y >= this.slotDetailY + this.itemH) {
      const rowH = 19;
      let rowY = this.slotDetailY + this.itemH;
      if (loc.slots.length === 0) {
        if (y >= rowY && y < rowY + rowH) this._selectCity(loc.id, null);
      } else {
        for (let i = 0; i < loc.slots.length; i++) {
          if (y >= rowY && y < rowY + rowH) { this._selectCity(loc.id, i); return; }
          rowY += rowH;
        }
      }
    }

    // 按钮命中
    if (this.exportBtnBox.contains(x, y)) this._export();
    if (this.clearBtnBox.contains(x, y)) this._clearAll();
  }

  _resetView() {
    const cam = this.cameras.main;
    cam.setZoom(1);
    cam.setScroll(0, 0);
    this.statusText.setText('视图已重置（缩放 1.0 · 回到初始位置）');
  }

  // 屏幕坐标 → 世界坐标（直接数学换算，避免 getWorldPoint 依赖的旧相机矩阵缓存）
  _screenToWorld(sx, sy) {
    const cam = this.cameras.main;
    return { x: cam.scrollX + sx / cam.zoom, y: cam.scrollY + sy / cam.zoom };
  }

  _handleMapClick(sx, sy) {
    if (!this.currentCity || this.currentSlot === undefined) {
      this.statusText.setText('请先在城市列表选择一个城市/槽位');
      return;
    }
    // 地图图片是定死的，缩放/拖动只动相机。屏幕→世界用相机直接数学换算（不依赖相机矩阵缓存）。
    const wp = this._screenToWorld(sx, sy);
    const origX = Math.round((wp.x - this.mapImg.x) / this.mapImg.scaleX);
    const origY = Math.round((wp.y - this.mapImg.y) / this.mapImg.scaleY);

    // 如果点中已落点，删除它（方便重标）
    if (this._deleteNearestMarker(wp.x, wp.y)) return;

    // 点在地图图片外（深色背景区）→ 不落点并提示
    if (origX < 0 || origY < 0 || origX > this.mapImg.width || origY > this.mapImg.height) {
      this.statusText.setText('请点击地图图片范围内（当前点在图片外）');
      return;
    }

    this._place(origX, origY);
  }

  _place(origX, origY) {
    const loc = this._loc(this.currentCity);
    let entry = this.points[this.currentCity];
    // 防御旧格式/脏数据：必须是普通对象（旧版本可能存的是数组或 {x,y}）
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) entry = null;

    if (loc.slots.length === 0) {
      if (!entry) entry = {};
      entry.point = [origX, origY];
    } else {
      if (!entry || !Array.isArray(entry.slots)) entry = { slots: [] };
      entry.slots[this.currentSlot] = [origX, origY];
    }
    this.points[this.currentCity] = entry;

    this._save();
    this._redrawMarkers();
    this._updateStatus();
    this._buildSlotDetail();
    this._advanceCity();
  }

  _tryDeleteMarkerAtScreen(sx, sy) {
    const wp = this._screenToWorld(sx, sy);
    return this._deleteNearestMarker(wp.x, wp.y);
  }

  _deleteNearestMarker(wx, wy) {
    let bestKey = null;
    let bestDist = Infinity;
    // 命中阈值：屏幕 14px ÷ zoom = 世界距离；下限 12 世界单位（保证点标记本体必命中）
    const threshold = Math.max(MARKER_HIT_RADIUS / this.cameras.main.zoom, 12);
    for (const loc of this.locations) {
      const p = this.points[loc.id];
      if (!p) continue;
      const collect = (ox, oy, key) => {
        if (!Array.isArray(ox) || ox.length < 2) return;
        const mx = this.mapImg.x + ox[0] * this.mapImg.scaleX;
        const my = this.mapImg.y + ox[1] * this.mapImg.scaleY;
        const d = Math.hypot(mx - wx, my - wy);
        if (d < bestDist && d < threshold) { bestDist = d; bestKey = key; }
      };
      if (loc.slots.length === 0) collect(p.point, 0, `${loc.id}#p`);
      else loc.slots.forEach((_, i) => collect(p.slots && p.slots[i], i, `${loc.id}#${i}`));
    }
    if (!bestKey) return false;
    const [cityId, suffix] = bestKey.split('#');
    if (!this.points[cityId]) return true;
    if (suffix === 'p') delete this.points[cityId].point;
    else this.points[cityId].slots[parseInt(suffix, 10)] = null;
    this._save();
    this._redrawMarkers();
    this._updateStatus();
    this._buildSlotDetail();
    return true;
  }

  // ---------- 选择逻辑 ----------
  _selectCity(cityId, slotIndex) {
    const loc = this._loc(cityId);
    if (!loc) return;
    this.currentCity = cityId;
    if (slotIndex !== null && slotIndex !== undefined) {
      this.currentSlot = slotIndex;
    } else if (loc.slots.length === 0) {
      this.currentSlot = null;
    } else {
      const p = this.points[cityId];
      const idx = loc.slots.findIndex((_, i) => !(p && Array.isArray(p.slots && p.slots[i])));
      this.currentSlot = idx >= 0 ? idx : 0;
    }
    this._updateStatus();
    this._buildSlotDetail();
  }

  _advanceCity() {
    if (this.currentCity) {
      const loc = this._loc(this.currentCity);
      const p = this.points[this.currentCity];
      if (loc.slots.length) {
        const idx = loc.slots.findIndex((_, i) => !(p && Array.isArray(p.slots && p.slots[i])));
        if (idx >= 0) { this.currentSlot = idx; this._updateStatus(); this._buildSlotDetail(); return; }
      } else if (!Array.isArray(p && p.point)) {
        this.currentSlot = null; this._updateStatus(); this._buildSlotDetail(); return;
      }
    }
    const next = this.locations.find((l) => !this._isCityDone(l));
    if (!next) { this.currentCity = null; this.currentSlot = undefined; this._updateStatus(); this._buildSlotDetail(); return; }
    this._selectCity(next.id, null);
  }

  _clearAll() {
    this.points = {};
    this.currentCity = null;
    this.currentSlot = undefined;
    this._save();
    this._redrawMarkers();
    this._updateStatus();
    this._buildSlotDetail();
    this._advanceCity();
  }

  _save() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.points)); }
    catch (e) { console.warn('[calibrate] 保存失败', e); }
  }

  // 校验/迁移 localStorage 数据：旧格式（数组、{x,y}、多余字段）一律丢弃，
  // 只保留与当前 locations.slots 结构匹配的合法落点，防止 _place 崩溃。
  _validatePoints(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    const isXY = (v) => Array.isArray(v) && v.length === 2 && isFinite(v[0]) && isFinite(v[1]);
    for (const loc of this.locations) {
      const p = raw[loc.id];
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      if (loc.slots.length === 0) {
        if (isXY(p.point)) out[loc.id] = { point: [Math.round(p.point[0]), Math.round(p.point[1])] };
      } else if (Array.isArray(p.slots)) {
        const slots = loc.slots.map((_, i) => (isXY(p.slots[i]) ? [Math.round(p.slots[i][0]), Math.round(p.slots[i][1])] : null));
        if (slots.some((s) => s)) out[loc.id] = { slots };
      }
    }
    return out;
  }

  // ---------- 渲染 ----------
  _redrawMarkers() {
    this.markers.clear();
    const { x, y, scaleX, scaleY } = this.mapImg;
    const alive = new Set();
    for (const loc of this.locations) {
      const p = this.points[loc.id];
      if (!p) continue;
      if (loc.slots.length === 0) {
        if (!Array.isArray(p.point)) continue;
        const [ox, oy] = p.point;
        const wx = x + ox * scaleX, wy = y + oy * scaleY;
        this._drawMarker(wx, wy, 10, 0x4ea1ff);
        this._ensureLabel(`${loc.id}#p`, wx + 14, wy - 7, loc.name, '#bcd8ff');
        alive.add(`${loc.id}#p`);
      } else {
        loc.slots.forEach((_, i) => {
          const pt = p.slots && p.slots[i];
          if (!Array.isArray(pt)) return;
          const [ox, oy] = pt;
          const wx = x + ox * scaleX, wy = y + oy * scaleY;
          this._drawMarker(wx, wy, 9, 0x7ee0a3);
          this._ensureLabel(`${loc.id}#${i}`, wx + 13, wy - 6, `${loc.name}·${i + 1}`, '#d6ffe8');
          alive.add(`${loc.id}#${i}`);
        });
      }
    }
    for (const key of Object.keys(this.labels)) {
      if (!alive.has(key)) { this.labels[key].destroy(); delete this.labels[key]; }
    }
  }

  _drawMarker(wx, wy, r, color) {
    // 外圈
    this.markers.lineStyle(2, 0xffffff, 0.9).strokeCircle(wx, wy, r + 3);
    // 实心
    this.markers.fillStyle(color, 1).fillCircle(wx, wy, r);
    // 中心点
    this.markers.fillStyle(0x10151c, 1).fillCircle(wx, wy, 3);
  }

  _ensureLabel(key, wx, wy, text, color) {
    let label = this.labels[key];
    if (!label) {
      label = this.add.text(wx, wy, text, {
        fontSize: '12px', color, fontFamily: 'Microsoft YaHei',
        backgroundColor: 'rgba(16,21,28,0.72)', padding: { x: 4, y: 2 },
      }).setDepth(2);
      this.uiCam.ignore(label);
      this.labels[key] = label;
    }
    label.setPosition(wx, wy);
  }

  _updateStatus() {
    const total = this._totalCount();
    const done = this._placedCount();
    const cur = this.currentCity ? this._loc(this.currentCity) : null;
    let curStr = '（已全部完成）';
    if (cur) {
      curStr = cur.slots.length === 0
        ? `${cur.name}（城市点）→ 在地图上点击落点`
        : `${cur.name} · 槽位${this.currentSlot + 1} → 在地图上点击落点`;
    }
    this.statusText.setText(`已标 ${done}/${total} 点 | 当前: ${curStr}`);

    for (const loc of this.locations) {
      const item = this.cityItems[loc.id];
      const isCur = this.currentCity === loc.id;
      const isDone = this._isCityDone(loc);
      const need = loc.slots.length || 1;
      const have = (() => {
        const p = this.points[loc.id]; if (!p) return 0;
        if (loc.slots.length === 0) return Array.isArray(p.point) ? 1 : 0;
        return loc.slots.filter((_, i) => Array.isArray(p.slots && p.slots[i])).length;
      })();
      item.text.setText(`${isDone ? '✓' : '·'} ${loc.name} ${have}/${need}`);
      item.text.setColor(isCur ? '#ffd479' : (isDone ? '#7ee0a3' : '#c9d4e0'));
      if (isCur) item.text.setFontStyle('bold'); else item.text.setFontStyle('normal');
    }
  }

  _buildSlotDetail() {
    this.slotLines.forEach((o) => o.destroy());
    this.slotLines = [];
    const addHud = (o) => { this.slotLines.push(o); this.cameras.main.ignore(o); return o; };

    const loc = this.currentCity ? this._loc(this.currentCity) : null;
    if (!loc) return;
    const p = this.points[loc.id] || {};
    const h = 19;
    let y = this.slotDetailY;
    const title = addHud(this.add.text(this.panelX + 16, y, `— ${loc.name} —`, {
      fontSize: '13px', color: '#e8d5a3', fontFamily: 'Microsoft YaHei', fontStyle: 'bold',
    }).setDepth(6));
    y += h;

    if (loc.slots.length === 0) {
      const placed = Array.isArray(p.point);
      const marker = placed ? '✓' : '▶';
      addHud(this.add.text(this.panelX + 24, y,
        `${marker} 城市点`, {
          fontSize: '12px', color: placed ? '#7ee0a3' : '#ffd479', fontFamily: 'Microsoft YaHei',
        }).setDepth(6));
    } else {
      loc.slots.forEach((types, i) => {
        const placed = Array.isArray(p.slots && p.slots[i]);
        const isCur = this.currentCity === loc.id && this.currentSlot === i;
        const marker = placed ? '✓' : (isCur ? '▶' : '○');
        addHud(this.add.text(this.panelX + 24, y,
          `${marker} 槽位${i + 1}：${slotTypeLabel(types)}`, {
            fontSize: '12px',
            color: isCur ? '#ffd479' : (placed ? '#7ee0a3' : '#c9d4e0'),
            fontFamily: 'Microsoft YaHei',
            fontStyle: isCur ? 'bold' : 'normal',
          }).setDepth(6));
        y += h;
      });
    }
  }

  _export() {
    const missing = this.locations.filter((l) => !this._isCityDone(l)).map((l) => l.name);
    if (missing.length) {
      this.statusText.setText(`还有 ${missing.length} 城未完成：${missing.join('、')}`);
      return;
    }
    const locations = {};
    const points = {}; // 同时导出 points：给 MapScene 直接读取（每城一个中心坐标）
    for (const loc of this.locations) {
      const p = this.points[loc.id];
      if (loc.slots.length === 0) {
        locations[loc.id] = { point: p.point };
        points[loc.id] = p.point;
      } else {
        locations[loc.id] = {
          slots: loc.slots.map((types, i) => ({ types, x: p.slots[i][0], y: p.slots[i][1] })),
        };
        // 有槽位城市：取所有槽位坐标的质心作为该城在地图上的中心位置
        const pts = loc.slots.map((_, i) => p.slots[i]).filter((q) => Array.isArray(q));
        if (pts.length) {
          const cx = Math.round(pts.reduce((s, q) => s + q[0], 0) / pts.length);
          const cy = Math.round(pts.reduce((s, q) => s + q[1], 0) / pts.length);
          points[loc.id] = [cx, cy];
        }
      }
    }
    const out = { map: 'main_map.jpg', locations, points, regions: this.regions || {} };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'map_points.json';
    a.click();
    URL.revokeObjectURL(a.href);
    this.statusText.setText('已导出 map_points.json → 放入 web/public/data/ 即可被地图场景读取');
  }
}
