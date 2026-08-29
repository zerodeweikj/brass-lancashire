import Phaser from 'phaser';
import AssetLoader from '../utils/AssetLoader.js';
import { enableCameraPanZoom } from '../utils/cameraControl.js';
import boardState from '../state/boardState.js';

/**
 * 玩家个人面板场景：渲染面板底图 + 19 个产业板块槽位。
 *
 * 坐标约定：
 * - player_board.json 里的 x/y 是槽位中心，单位是面板底图自身像素。
 * - 面板底图尺寸 1417x960，直接作为背景图左上角对齐 (0,0)。
 * - 产业板块 tile 按 slotSize 86 缩放后居中放在槽位中心。
 */
export default class PlayerBoardScene extends Phaser.Scene {
  constructor() {
    super('PlayerBoardScene');
  }

  preload() {
    this.load.image('player_board', 'assets/player_board.jpg');
  }

  async create() {
    this.cameras.main.setBackgroundColor('#10151c');

    // 标识隐藏开关：玩家视图默认隐藏所有建筑槽位占位（URL 含 ?identifiers=show 才显示，用于校准/验收）。
    this.hideIdentifiers = new URLSearchParams(location.search).get('identifiers') !== 'show';

    // 当前玩家颜色（决定面板产业板块配色）：?color=red/yellow/white/purple，默认 white（验收视角）
    this.playerColor = new URLSearchParams(location.search).get('color') || 'white';

    // 1. 读取玩家面板数据（含槽位坐标与底图尺寸）
    const res = await fetch('data/player_board.json');
    if (!res.ok) throw new Error('player_board.json 加载失败');
    this.pb = await res.json();

    // 2. 初始化统一资源加载器（预加载 tiles/cards/links/markers）
    this.assets = new AssetLoader(this);
    await this.assets.init();
    this.assets.defaultColor = this.playerColor;

    // 3. 绘制底图
    this.add.image(0, 0, 'player_board').setOrigin(0, 0);

    // 面板顶部显示当前玩家颜色（便于核对配色）
    const colorName = { red: '红', yellow: '黄', white: '白', purple: '紫' }[this.playerColor] || this.playerColor;
    this._topLabel = this.add.text(12, 12, `玩家面板 · ${colorName}方`, {
      fontSize: '22px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 8, y: 4 },
    }).setScrollFactor(0).setDepth(500);

    // 4. 相机缩放：完整显示面板底图并留边距
    const bgW = this.pb.size?.width || 1417;
    const bgH = this.pb.size?.height || 960;
    const zoom = Math.min(this.scale.width / bgW, this.scale.height / bgH) * 0.95;
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(bgW / 2, bgH / 2);
    enableCameraPanZoom(this);

    // 4.5 初始化跨场景共享状态（每玩家私有库存 + 公开落盘建筑列表）。
    // 共享状态保证：个人面板库存私有（切色互不干扰），公开游戏面板上的建筑跨玩家持久。
    await boardState.ensureInit();
    this.industryMap = boardState.industryMap || {};
    window.__boardState = boardState; // 调试/测试用

    // 槽位悬停提示（仿远方市场牌库机制）：跟随鼠标显示"剩余数量 N"，数量为0不显示
    this.__slotTip = this.add.text(0, 0, '', {
      fontSize: '16px', color: '#ffffff',
      fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.75)', padding: { x: 8, y: 4 },
    }).setScrollFactor(0).setDepth(1001).setVisible(false);
    this.input.on('pointermove', (p) => {
      if (this.__slotTip && this.__slotTip.visible) this.__slotTip.setPosition(p.x + 16, p.y + 16);
    });

    // 5. 放置产业板块（玩家面板永不翻面，只显示正面）；
    //    建筑槽位占位默认隐藏（玩家只见印刷面板底图），?identifiers=show 才显示用于校准。
    //    放入 tileContainer 便于切换玩家颜色时整组重建。
    this.tileContainer = this.add.container(0, 0);
    this._buildTiles();

    // 6. 返回按钮
    this.add.text(20, 20, '← 返回', {
      fontSize: '18px',
      color: '#e8d5a3',
      fontFamily: 'Microsoft YaHei, sans-serif',
      backgroundColor: 'rgba(0,0,0,0.5)',
      padding: { x: 10, y: 6 },
    })
      .setScrollFactor(0)
      .setInteractive({ useHandCursor: true })
      .on('pointerdown', () => this.scene.start('BootScene'));

    // 7. 颜色调试 HUD：白/黄/紫/红 四按钮固定贴右边界，切换玩家配色视角
    this._createColorDebugHUD();
  }

  /**
   * 重建玩家面板产业板块（玩家面板永不翻面，只显示正面）。
   * 切换玩家颜色后调用，整组销毁并用新配色重绘。
   */
  _buildTiles() {
    this.tileContainer.removeAll(true);
    // 产业板块正面属功能性元素，始终渲染（玩家面板永不翻面）；
    // 仅"建筑槽位占位高亮"这类摆位辅助受 ?identifiers=show 控制（默认隐藏）。
    for (const slot of this.pb.slots || []) {
      const key = this.assets.getTile(slot.tile_id);
      if (!this.textures.exists(key)) continue; // 理论上 AssetLoader 会生成占位，防万一

      const img = this.add.image(slot.x, slot.y, key).setOrigin(0.5);

      // 按 slotSize 统一缩放（扫描图应已对齐全级棉纺厂尺寸）
      const source = this.textures.get(key).getSourceImage();
      const maxDim = Math.max(source.width || 86, source.height || 86);
      const scale = (this.pb.slotSize || 86) / maxDim;
      img.setScale(scale);

      // 悬停提示（槽位始终可交互，不影响其它模块）
      img.setInteractive({ useHandCursor: true });
      img.on('pointerover', () => this._onSlotOver(slot.tile_id));
      img.on('pointerout', () => this._onSlotOut());
      this.tileContainer.add(img);

      // placeholder 槽位高亮提示仅校准视图(?identifiers=show)显示
      if (slot.placeholder && !this.hideIdentifiers) {
        const ph = this.add.rectangle(slot.x, slot.y, this.pb.slotSize, this.pb.slotSize, 0x35c4b8, 0.15);
        this.tileContainer.add(ph);
      }
    }
  }

  /**
   * 颜色调试 HUD：4 个色块按钮（白/黄/紫/红），固定贴屏幕右边界垂直居中。
   * 使用 setScrollFactor(0) 脱离相机滚动，并在 update 中按主相机 zoom 做反向缩放与位置补偿，
   * 保证无论缩放还是平移视角，按钮都恒定贴在玩家视角右侧紧贴右边界。
   */
  _createColorDebugHUD() {
    const colors = [
      { key: 'white', name: '白', hex: 0xf2f2f2 },
      { key: 'yellow', name: '黄', hex: 0xffd23f },
      { key: 'purple', name: '紫', hex: 0x9b6dd6 },
      { key: 'red', name: '红', hex: 0xe8503a },
    ];
    this.__hudButtons = [];
    const btnW = 56, gap = 12;
    const n = colors.length;
    colors.forEach((c, i) => {
      // 视觉元素：scrollFactor(0)，每帧由 _positionHUD 定位到屏幕目标坐标
      const rect = this.add.rectangle(0, 0, btnW, btnW, c.hex, 1)
        .setStrokeStyle(3, 0x10151c, 0.9).setScrollFactor(0).setDepth(1000);
      const label = this.add.text(0, 0, c.name, {
        fontSize: '22px', color: '#10151c', fontFamily: 'Microsoft YaHei, sans-serif', fontStyle: 'bold',
      }).setOrigin(0.5).setScrollFactor(0).setDepth(1001);
      this.__hudButtons.push({ key: c.key, idx: i, total: n, w: btnW, gap, rect, label, sx: 0, sy: 0 });
    });
    // 命中检测：不用 Phaser 容器 zone（scrollFactor(0) 容器内子对象命中区域会错位），
    // 改为场景级 pointerdown 按「屏幕坐标」手动判断，保证任何缩放/平移下都可靠。
    this.input.on('pointerdown', (p) => {
      for (const b of this.__hudButtons || []) {
        const hw = b.w / 2;
        if (Math.abs(p.x - b.sx) <= hw && Math.abs(p.y - b.sy) <= hw) {
          this._setPlayerColor(b.key);
          return;
        }
      }
    });
    this._positionHUD();
  }

  /** 每帧把 HUD 贴到屏幕右边界垂直居中，并抵消主相机 zoom 对 scrollFactor(0) 元素的中心缩放。 */
  _positionHUD() {
    if (!this.__hudButtons) return;
    const cam = this.cameras.main;
    const z = cam.zoom || 1;
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const margin = 16;
    for (const b of this.__hudButtons) {
      // 屏幕目标坐标：最右按钮贴右边界垂直居中，其余向左等距排开（与 zoom 无关）
      const sx = cam.width - margin - b.w / 2 - (b.w + b.gap) * (b.total - 1 - b.idx);
      const sy = cy;
      b.sx = sx; b.sy = sy; // 命中检测用（Phaser pointer 屏幕坐标）
      // 主相机 zoom 会把 scrollFactor(0) 元素以屏幕中心为原点缩放，故反算世界坐标抵消
      const wx = cx + (sx - cx) / z;
      const wy = cy + (sy - cy) / z;
      b.rect.setPosition(wx, wy).setScale(1 / z);
      b.label.setPosition(wx, wy).setScale(1 / z);
    }
  }

  /** 切换当前玩家颜色并刷新面板产业板块配色。 */
  _setPlayerColor(color) {
    if (color === this.playerColor) return;
    this.playerColor = color;
    this.assets.defaultColor = color;
    const colorName = { red: '红', yellow: '黄', white: '白', purple: '紫' }[color] || color;
    this._topLabel?.setText(`玩家面板 · ${colorName}方`);
    this._buildTiles();
  }

  // ---------- 槽位悬停提示（仿远方市场牌库机制） ----------
  _onSlotOver(tileId) {
    const n = boardState.getStock(this.playerColor, tileId);
    if (n == null || n <= 0) { this.__slotTip.setVisible(false); return; } // 数量为0不显示
    this.__slotTip.setText(this._slotTipText(tileId));
    const p = this.input.activePointer;
    this.__slotTip.setPosition(p.x + 16, p.y + 16).setVisible(true);
  }
  _onSlotOut() {
    this.__slotTip.setVisible(false);
  }

  _slotTipText(tileId) {
    const n = boardState.getStock(this.playerColor, tileId) ?? 0;
    const info = this.industryMap?.[tileId];
    const name = info ? `${info.industry}${info.level}` : tileId;
    return `${name} 剩余数量 ${n}`;
  }

  /** 每帧刷新 HUD 固定位置（不影响任何世界对象）。 */
  update() {
    this._positionHUD();
  }
}
