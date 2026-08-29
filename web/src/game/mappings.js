/**
 * 引擎数据 ↔ 前端素材/文案的映射表。
 * 引擎内部用中文产业名与 UPPERCASE 地点 ID，素材文件名用英文前缀，这里统一转换。
 */

/** 中文产业名 → 板块素材前缀（assets/tiles/{color}_{prefix}_{level}.jpg）。 */
export const IND_ASSET = {
  铁厂: 'ironworks',
  煤厂: 'colliery',
  造船厂: 'shipyard',
  港口: 'port',
  棉花厂: 'cotton',
};

/** 引擎 locations.json 槽位里的英文类型 → 中文产业名。 */
export const SLOT_TYPE_CN = {
  iron: '铁厂',
  coal: '煤厂',
  shipyard: '造船厂',
  port: '港口',
  cotton: '棉花厂',
};

/** 中文产业名 → 玩家面板 mat 的键。 */
export const IND_MAT_KEY = {
  铁厂: 'iron',
  煤厂: 'coal',
  造船厂: 'shipyard',
  港口: 'port',
  棉花厂: 'cotton',
};

export const MAT_KEY_CN = Object.fromEntries(
  Object.entries(IND_MAT_KEY).map(([cn, k]) => [k, cn]),
);

/** 产业配色（高亮 / 图例 / 缺图占位）。 */
export const IND_COLOR = {
  铁厂: 0xff9f40,
  煤厂: 0x3a3a3a,
  造船厂: 0x35c4b8,
  港口: 0x4ea3ff,
  棉花厂: 0xf4ecd8,
};

export const PLAYER_HEX = {
  red: 0xd94f4f, yellow: 0xe8c341, white: 0xe9e9e9, purple: 0x9b6bd6,
};

export const PLAYER_CSS = {
  red: '#d94f4f', yellow: '#e8c341', white: '#e9e9e9', purple: '#9b6bd6',
};

export const PLAYER_CN = { red: '红', yellow: '黄', white: '白', purple: '紫' };

/** 板块正面素材 key：{color}_{prefix}_{level}。 */
export function tileTexKey(color, industry, level) {
  const p = IND_ASSET[industry];
  return p ? `${color}_${p}_${level}` : null;
}

/** 板块背面素材 key（AssetLoader 注册为 back_{color}_{tile_id}）。 */
export function tileBackKey(color, industry, level) {
  const p = IND_ASSET[industry];
  return p ? `back_${color}_${p}_${level}` : null;
}

/** 手牌素材 key = 卡牌 id（asset_manifest.cards 已按 id 建索引）。 */
export function cardTexKey(cardId) {
  return cardId;
}

/** 行动中文名。 */
export const ACTION_CN = {
  build: '建造',
  road: '修路',
  develop: '发展',
  sell: '出售',
  loan: '贷款',
  skip: '跳过',
  doubleBuild: '双牌建造',
  undo: '撤回',
};

/** 失败码 → 该回到哪一步重选（对齐 PRD retry_target）。 */
export const RETRY_STEP = { S0: 'action', S1: 'card', S2: 'target', S3: 'resource', S4: 'confirm' };

/** 地点 ID → 展示名（中文名由 locations.json 的 name 提供，这里只做兜底美化）。 */
export function prettyLoc(id, locName) {
  if (locName) return locName;
  return String(id || '').replace(/([A-Z])([A-Z]+)/g, (_, a, b) => a + b.toLowerCase());
}
