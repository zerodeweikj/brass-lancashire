/**
 * AssetLoader — 统一资产加载器
 *
 * 职责：
 *   1. 读取 asset_manifest.json（ID → 图片路径映射）
 *   2. 批量预加载所有 tiles/cards/links/markers 图片
 *   3. 为加载失败的图片生成彩色占位方块（运行时不会空引用崩溃）
 *   4. 提供按 ID 查询 Phaser texture key 的方法
 *
 * 用法：
 *   const assets = new AssetLoader(this);      // this = Phaser.Scene
 *   await assets.init();
 *   this.add.image(x, y, assets.getTile('colliery_1'));
 *   this.add.image(x, y, assets.getCard('city_manchester'));
 *   this.add.image(x, y, assets.getCardBack());
 */

// ---- 占位颜色：每种产业/卡牌类型用不同底色，缺图时一眼能认 ----
const PLACEHOLDER_COLORS = {
  colliery: 0x2b2b2b,   // 煤厂 深灰
  ironworks: 0xff9f40,  // 铁厂 橙
  cotton: 0xf4ecd8, // 棉花厂 米白
  port: 0x4ea3ff,        // 港口 蓝
  shipyard: 0x35c4b8,    // 造船厂 青
  city: 0x8b6914,        // 城市卡 棕色
  ind: 0xc0392b,         // 产业卡 红棕
  link: 0x7f8c8d,        // 连结 灰
  marker: 0xe74c3c,      // 标记 红
  default: 0x555555,
};

function pickColor(key) {
  // 去掉背面/颜色前缀后再匹配产业类型
  const k = key.replace(/^back_/, '').replace(/^(red|yellow|white|purple)_/, '');
  for (const [prefix, c] of Object.entries(PLACEHOLDER_COLORS)) {
    if (k.startsWith(prefix)) return c;
  }
  return PLACEHOLDER_COLORS.default;
}

function makePlaceholderTexture(scene, key, color) {
  if (scene.textures.exists(key)) return;
  const gfx = scene.make.graphics({ add: false });
  gfx.fillStyle(color, 0.5);
  gfx.fillRect(0, 0, 86, 86);
  gfx.lineStyle(2, color, 0.8);
  gfx.strokeRect(1, 1, 84, 84);
  gfx.generateTexture(key, 86, 86);
  gfx.destroy();
}

export default class AssetLoader {
  constructor(scene) {
    this.scene = scene;
    this.manifest = null;
    this._loaded = false;
    this._missing = new Set();
    this.defaultColor = 'white'; // 当前玩家颜色（红/黄/白/紫），决定产业板块取图；默认白（验收视角）
  }

  /**
   * 初始化：拉取 manifest → 批量注册图片 → 启动加载
   */
  async init() {
    // 1. 拉 manifest
    try {
      const res = await fetch('data/asset_manifest.json');
      if (!res.ok) throw new Error(`manifest 加载失败 HTTP ${res.status}`);
      this.manifest = await res.json();
    } catch (e) {
      console.warn('[AssetLoader] 无法加载 manifest，将全部使用占位图', e.message);
      this.manifest = { tiles: {}, tileBacks: {}, cards: {}, cardBack: '', links: {}, markers: {} };
      this._loaded = true;
      return;
    }

    const load = this.scene.load;

    // 2. 收集所有 (textureKey, 实际路径)
    //    manifest 里的路径已含真实扩展名，直接注册即可；
    //    个别缺图（如 card_back / player_* 标记）由 loaderror → 占位方块兜底，
    //    不再逐个 HEAD 探测扩展名（178 个资源少了 178 次额外往返，启动快很多）。
    const entries = [];
    for (const [id, path] of Object.entries(this.manifest.tiles || {}))
      entries.push([id, path]);
    // 背面：键为 tile_id（每个建筑每等级独立背面），texture key = back_{tile_id}
    for (const [tileId, path] of Object.entries(this.manifest.tileBacks || {}))
      entries.push([`back_${tileId}`, path]);
    for (const [id, path] of Object.entries(this.manifest.cards || {}))
      entries.push([id, path]);
    if (this.manifest.cardBack) entries.push(['card_back', this.manifest.cardBack]);
    for (const [type, path] of Object.entries(this.manifest.links || {}))
      entries.push([`link_${type}`, path]);
    for (const [color, path] of Object.entries(this.manifest.markers || {}))
      entries.push([`marker_${color}`, path]);

    for (const [key, url] of entries) load.image(key, url);

    // 3. 监听错误 + 启动
    load.on('loaderror', (file) => {
      this._missing.add(file.key);
    });

    // 启动加载（Phaser 3 允许在 create() 里手动 start）
    return new Promise((resolve) => {
      load.once('complete', () => {
        this._loaded = true;
        this._generatePlaceholders();
        resolve();
      });
      load.start();
    });
  }

  /**
   * HEAD 探测扩展名：依次尝试 jpg → jpeg → png；
   * 都不存在则返回 .jpg（加载失败由占位图兜底，不崩）。
   * 注意：Vite dev server 对缺失文件会用 SPA 回退返回 200(text/html)，
   * 故必须校验 Content-Type 以 image/ 开头，否则会误判已删除/不存在的文件存在。
   */
  async _resolveUrl(base) {
    for (const ext of ['jpg', 'jpeg', 'png']) {
      const url = `${base}.${ext}`;
      try {
        const res = await fetch(url, { method: 'HEAD' });
        const ct = res.headers.get('content-type') || '';
        if (res.ok && ct.startsWith('image/')) return url;
      } catch (e) { /* 网络错误，继续尝试下一扩展名 */ }
    }
    return `${base}.jpg`;
  }

  /**
   * 为所有加载失败的纹理生成占位方块
   */
  _generatePlaceholders() {
    for (const key of this._missing) {
      for (const id of this._allExpectedKeys()) {
        if (id === key) {
          makePlaceholderTexture(this.scene, key, pickColor(key));
          break;
        }
      }
    }
    // 批量检查：manifest 里有但纹理缓存里没有的也补上（网络完全不可达的情况）
    for (const id of this._allExpectedKeys()) {
      if (!this.scene.textures.exists(id)) {
        makePlaceholderTexture(this.scene, id, pickColor(id));
      }
    }
  }

  /** 收集所有 manifest 中声明的 texture key */
  _allExpectedKeys() {
    const keys = [];
    if (this.manifest.tiles) keys.push(...Object.keys(this.manifest.tiles));
    if (this.manifest.tileBacks) keys.push(...Object.keys(this.manifest.tileBacks).map((tileId) => `back_${tileId}`));
    if (this.manifest.cards) keys.push(...Object.keys(this.manifest.cards));
    if (this.manifest.cardBack) keys.push('card_back');
    if (this.manifest.links) keys.push(...Object.keys(this.manifest.links).map((t) => `link_${t}`));
    if (this.manifest.markers) keys.push(...Object.keys(this.manifest.markers).map((c) => `marker_${c}`));
    return keys;
  }

  // ======================== 查询 API ========================

  /**
   * 产业板块正面 texture key（按玩家颜色取图）。
   * 颜色不同 → 图不同（红/黄/白/紫各一套扫描图）。
   */
  getTile(tileId, color = this.defaultColor) {
    return `${color}_${tileId}`;
  }

  /**
   * 产业板块背面 texture key（按玩家颜色取图）。
   * manifest 中 tileBacks 的 key 为 {color}_{tile_id}，对应纹理 key = back_{color}_{tile_id}；
   * shipyard_0 无独立背面，回退到正面。
   */
  getTileBack(tileId, color = this.defaultColor) {
    const texKey = `back_${color}_${tileId}`;
    if (this.manifest?.tileBacks?.[`${color}_${tileId}`]) return texKey;
    return `${color}_${tileId}`; // 无独立背面（如 shipyard_0）→ 用正面图
  }

  /** 卡牌正面 texture key */
  getCard(cardId) {
    return cardId;
  }

  /** 卡牌背面 texture key */
  getCardBack() {
    return 'card_back';
  }

  /** 连结板块 texture key */
  getLink(type) {
    return `link_${type}`;
  }

  /** 标记物 texture key */
  getMarker(color) {
    return `marker_${color}`;
  }

  /** 检查某个 tile 的纹理是否已加载（或已有占位） */
  hasTile(tileId, color = this.defaultColor) {
    return this.scene.textures.exists(`${color}_${tileId}`);
  }

  /** 是否就绪 */
  get loaded() {
    return this._loaded;
  }
}
