// 远方市场牌库：构建 / 洗牌 / 抽牌（无放回）+ 程序化正面贴图（占位，扫描图到位后可切换）。
//
// 随机性约定：
//  - 牌库是「值数组」，构建后 Fisher–Yates 洗牌，抽牌 = pop 一张（无放回，符合"抽中不塞回"）。
//  - rng 可注入（默认 Math.random），便于将来接引擎或在测试里用固定种子复现。
//  - 抽出的牌值 = 额外奖励标记要走的步数（绝对值），方向朝轨终点（只进不退）。
//  - 该模块是纯函数 + 贴图工具，前端占位用；将来整段逻辑可平移到 Python 引擎作权威随机源。

import { slotScale, fitIntoSlot } from './fit.js';

export function stepsFromValue(value) {
  return Math.abs(value);
}

export function buildForeignMarketDeck(composition, playerCount) {
  const comp = composition[String(playerCount)] || composition['4'];
  const deck = [];
  for (const [vStr, n] of Object.entries(comp)) {
    const v = parseInt(vStr, 10);
    for (let i = 0; i < n; i++) deck.push(v);
  }
  return deck;
}

// Fisher–Yates 原地洗牌。rng() 返回 [0,1)。
export function shuffleDeck(deck, rng = Math.random) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = deck[i];
    deck[i] = deck[j];
    deck[j] = tmp;
  }
  return deck;
}

// 抽顶牌（无放回）。返回牌值，空库返回 null。
export function drawForeignMarketCard(deck) {
  if (!deck || deck.length === 0) return null;
  return deck.pop();
}

// 远端市场轨下一步索引：朝终点(endIndex)方向走 steps 步，不回退，越界夹紧。
export function nextTrackIndex(current, steps, endIndex) {
  const v = current + steps;
  if (v < 0) return 0;
  if (v > endIndex) return endIndex;
  return v;
}

// 远端市场标记是否处于 X（终点）位置：处于 X 时任何人无法获取额外奖励，
// 即出售行动中「翻远方市场牌」这一步骤被禁止。
export function isMarketLocked(trackIndex, endIndex) {
  return trackIndex >= endIndex;
}

// ===================== 程序化正面贴图（占位） =====================
const FRONT_W = 198, FRONT_H = 244;
const VALUE_COLOR = {
  '0': 0x2f8f5b, '-1': 0x1f7a8c, '-2': 0xc77d2e, '-3': 0xc0432b, '-4': 0x8e1f1f,
};

// 文件名安全基名：负值用 negN（避免文件名出现负号）。
function frontBaseName(value) {
  return value < 0 ? 'neg' + (-value) : String(value);
}

// 生成（并缓存）某值的卡片背景纹理：米色圆角卡 + 按值着色的描边/顶条。
function ensureForeignMarketFrontBg(scene, value) {
  const key = 'fm_front_bg_' + frontBaseName(value);
  if (scene.textures.exists(key)) return key;
  const color = VALUE_COLOR[String(value)] ?? 0x444441;
  const g = scene.add.graphics();
  g.fillStyle(0xf3ead2, 1);
  g.fillRoundedRect(0, 0, FRONT_W, FRONT_H, 14);
  g.fillStyle(color, 0.25);
  g.fillRoundedRect(14, 14, FRONT_W - 28, 30, 6);
  g.lineStyle(5, color, 1);
  g.strokeRoundedRect(3, 3, FRONT_W - 6, FRONT_H - 6, 12);
  g.generateTexture(key, FRONT_W, FRONT_H);
  g.destroy();
  return key;
}

// 在 container 的 (x,y) 处渲染一张正面，返回创建的 GameObject 数组。
// 扫描图优先：约定文件 assets/markers/foreign_market_front_{base}.(jpg|png) 存在即用之；
// 否则程序化占位（背景 + 居中数值文字）。两种分支都走统一 fitIntoSlot/slotScale 缩放。
// mode 固定 'stretch'（用户定案：其余槽位用 stretch，宁可拉长后改尺寸，不容留白）。
export function renderForeignMarketFront(scene, container, x, y, w, h, value) {
  const objs = [];
  const mode = 'stretch';
  const scannedKey = 'foreign_market_front_' + frontBaseName(value);

  if (scene.textures.exists(scannedKey)) {
    objs.push(fitIntoSlot(scene, container, scannedKey, x, y, w, h, mode));
    return objs;
  }

  // 程序化占位：背景纹理(198×244) + 居中数值，统一按 stretch 缩放到槽位尺寸。
  const bgKey = ensureForeignMarketFrontBg(scene, value);
  const [sx, sy] = slotScale(scene, bgKey, w, h, mode);
  const img = scene.add.image(x, y, bgKey).setOrigin(0.5).setScale(sx, sy);
  container.add(img);
  objs.push(img);

  const colorHex = '#' + (VALUE_COLOR[String(value)] ?? 0x444441).toString(16).padStart(6, '0');
  const label = (value === 0) ? '0' : String(value);
  const t = scene.add.text(x, y, label, {
    fontSize: '76px',
    fontFamily: 'Microsoft YaHei, sans-serif',
    color: colorHex,
    fontStyle: 'bold',
  }).setOrigin(0.5).setScale(sx, sy);
  container.add(t);
  objs.push(t);

  return objs;
}
