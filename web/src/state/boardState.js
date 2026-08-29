/**
 * 跨场景共享游戏状态（页面内单例，跨场景持久）。
 *
 * 数据模型（与真实 Brass 一致）：
 *  - stock[color][tileId]：每个玩家「个人面板」的私有库存（建造 −1，其他人看不到）。
 *  - placed[]：所有已建造、落在「公开游戏面板（地图）」上的建筑，每条 { color, tileId, x, y }。
 *              这是公开信息，任何玩家都能看到，且不会因切换到某个玩家的个人面板而消失。
 *
 * 注意：本单例仅在「同一次页面加载」内持久；刷新页面会重置（真实游戏由后端权威状态接管）。
 * 调试期足够验证「个人面板私有 / 游戏面板公开且跨玩家持久」的分离。
 */

const COLORS = ['red', 'yellow', 'white', 'purple'];

class BoardState {
  constructor() {
    this._init = null;          // ensureInit 的 promise（防重复初始化）
    this.baseStock = {};        // tileId -> 起始持有数（来自 industry_tiles.json 的 per_player）
    this.industryMap = {};      // tileId -> { industry, level }（用于提示文案）
    this.stock = null;          // { red:{}, yellow:{}, white:{}, purple:{} }
    this.placed = [];           // 公开游戏面板上的已建造建筑
    this.mapSlots = [];         // 地图可落点坐标 [{ x, y, types }]（来自 map_points.json）
    this._nextSlot = 0;         // 落盘时轮转取用的槽位下标
    this.playerOrder = [...COLORS];  // 颜色数组，回合顺位 / 面板排列共用（将来由引擎 turnOrder 映射）
    this.currentPlayerIdx = 0;       // 当前行动者在 playerOrder 中的下标
  }

  /** 懒加载基础数据（industry_tiles.json / map_points.json），并初始化每玩家库存。 */
  ensureInit() {
    if (this._init) return this._init;
    this._init = (async () => {
      // 1) 产业定义 → 起始库存 + 提示用名称
      try {
        const r = await fetch('data/industry_tiles.json');
        if (r.ok) {
          const tiles = await r.json();
          for (const t of tiles) {
            if (!t.tile_id) continue;
            this.industryMap[t.tile_id] = { industry: t.industry || '', level: t.level ?? 0 };
            if (typeof t.per_player === 'number') this.baseStock[t.tile_id] = t.per_player;
          }
        }
      } catch { /* 缺文件则用空库存 */ }

      // 2) 地图落点坐标 → 建造时可轮转取用
      try {
        const r = await fetch('data/map_points.json');
        if (r.ok) {
          const mp = await r.json();
          const locs = mp.locations || {};
          for (const L of Object.values(locs)) {
            for (const s of (L.slots || [])) {
              if (s.x != null && s.y != null) {
                this.mapSlots.push({ x: s.x, y: s.y, types: s.types || [] });
              }
            }
          }
        }
      } catch { /* 无地图数据则落盘到中心 */ }

      // 3) 初始化每玩家独立库存
      this._resetStock();
    })();
    return this._init;
  }

  _resetStock() {
    this.stock = { red: {}, yellow: {}, white: {}, purple: {} };
    for (const c of COLORS) {
      for (const [tid, n] of Object.entries(this.baseStock)) this.stock[c][tid] = n;
    }
  }

  /** 读取某玩家某板块的剩余库存（私人）。 */
  getStock(color, tileId) {
    return this.stock?.[color]?.[tileId] ?? 0;
  }

  /**
   * 建造：该玩家该板块库存 −1（私人库存减少），并把建筑落到公开游戏面板（地图）的下一可用槽位。
   * 返回 true 表示成功（库存>0 才允许建造）。
   */
  build(color, tileId) {
    const s = this.stock?.[color];
    if (!s || s[tileId] == null || s[tileId] <= 0) return false;
    s[tileId] -= 1;

    const slot = this.mapSlots.length
      ? this.mapSlots[this._nextSlot % this.mapSlots.length]
      : { x: 960, y: 960 };
    this._nextSlot += 1;
    this.placed.push({ color, tileId, x: slot.x, y: slot.y, slotIndex: this._nextSlot - 1 });
    return true;
  }

  /** 重置（调试用）：清空公开板、库存回到初始。 */
  reset() {
    this.placed = [];
    this._nextSlot = 0;
    if (this.stock) this._resetStock();
  }

  /**
   * 设置回合顺位（同时驱动面板排列顺序与回合顺位轨）。
   * 兼容两种入参：['red',...] 颜色数组，或引擎 [{id,color},...] 形式。
   * @param {string[] | Array<{id:any,color:string}>} order
   * @param {number} currentIdx 当前行动者下标（默认 0）
   */
  setPlayerOrder(order, currentIdx = 0) {
    let colors = null;
    if (Array.isArray(order) && order.length) {
      if (typeof order[0] === 'string') {
        colors = order.filter((c) => COLORS.includes(c));
      } else {
        colors = order.map((p) => p.color || p.player_color).filter((c) => COLORS.includes(c));
      }
    }
    if (colors && colors.length) this.playerOrder = colors;
    const idx = parseInt(currentIdx, 10);
    this.currentPlayerIdx = Math.max(0, Math.min(this.playerOrder.length - 1, Number.isFinite(idx) ? idx : 0));
  }

  /** 当前行动者颜色（getter）。 */
  get currentPlayerColor() { return this.playerOrder[this.currentPlayerIdx]; }

  /** 公开统计：placed[] 中该玩家已建建筑数量（公开信息，任何人可见）。 */
  builtBy(color) {
    if (!this.placed || !this.placed.length) return 0;
    let n = 0;
    for (const b of this.placed) if (b.color === color) n += 1;
    return n;
  }
}

const instance = new BoardState();
export default instance;
export { BoardState, COLORS };
