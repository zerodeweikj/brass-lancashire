# 个人面板板块显示 + HUD 布局重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 0 级造船厂（占位板块）出现在玩家个人面板；把面板槽位重排成均布的 5 列 4 行；把 HUD 改成手牌横排顶部、地图下移、玩家面板留在右侧。

**Architecture:** 引擎侧（Task 1）放行造船厂 0 级进 mat；前端数据侧（Task 2）改 player_board.json 的 19 个槽位坐标；前端布局侧（Task 3）改 CSS + GameScene.fitCamera，把手牌横排放到顶部。两个层面互不依赖、各自带测试。

**Tech Stack:** Python 3.12（后端测试 `server\.venv\Scripts\python.exe`）、Phaser 3 + Vite（前端，命令 `npm run build`）、Playwright（冒烟）。

## Global Constraints

- 端口 8765（项目后端固定）。沙箱构建时 `NODE_OPTIONS` 注入 safe-delete shim 会拦 Vite 清空 `dist`；`web/vite.config.js` 已设 `build.emptyOutDir: false`，直接 `npm run build` 即可（不要 `env -u NODE_OPTIONS`，会弄坏子进程 node）。
- 项目根 `D:\zhuoyou\lancashire` 不是 git 仓库（工作树无 .git），不要 `git commit`/`git add`，每任务末尾直接验证即可。
- 静态数据读路径（前端）：`fetch('data/player_board.json')` 等，vite build 把 `public/data/*` 拷到 `dist/data/`。
- 后端测试以纯断言脚本形式运行（`tests/test_*.py` 用 `check()` 累计），用 `server\.venv\Scripts\python.exe` 跑（无 pytest）。
- 玩家面板关键字段：渲染用 `boardState.getStock(color, tileId) > 0`（实际是 Hud.js 第 294 行 `p.mat[key]?.[level] > 0`）；槽位坐标来自 `web/public/data/player_board.json`。

---

### Task 1: 0 级造船厂入 mat（引擎）

**Files:**
- Modify: `engine/mechanics.py:23-36`（`build_mat()`）
- Modify: `tests/test_build_rules.py`（新增 shipyard_0 断言）

**Interfaces:**
- Produces: `engine.mechanics.build_mat() -> dict` 现在对造船厂 `level==0` 返回 `{'shipyard': {0: 2, 1: 2, 2: 2}, ...}`（每玩家）。

- [ ] **Step 1: 在 test_build_rules.py 加 shipyard_0 失败断言**

在 `tests/test_build_rules.py` 末尾（最后一个 `check(...)` 之后、`print('=====...')` 之前）追加：

```python
def test_shipyard_lvl0_in_mat():
    """造船厂 0 级是占位板块（不能建造），但必须出现在玩家的 mat 里，否则面板上看不到。"""
    from engine import mechanics as M
    mat = M.build_mat()
    check('造船厂 0 级进 mat（占位板块）', mat.get('shipyard', {}).get(0, 0) == 2,
          'mat.shipyard[0]=%s（期望 2）' % mat.get('shipyard', {}).get(0))
    # 其他造船厂等级也照旧
    check('造船厂 1 级仍进 mat', mat.get('shipyard', {}).get(1, 0) == 2)
    check('造船厂 2 级仍进 mat', mat.get('shipyard', {}).get(2, 0) == 2)

test_shipyard_lvl0_in_mat()
```

- [ ] **Step 2: 运行测试，确认 shipyard_0 失败**

Run: `cd /d/zhuoyou/lancashire && server/.venv/Scripts/python.exe tests/test_build_rules.py 2>&1 | tail -20`
Expected: 输出含 `[FAIL] 造船厂 0 级进 mat（占位板块）  -- mat.shipyard[0]=0（期望 2）`（其他造船厂等级 PASS）。

- [ ] **Step 3: 修 `build_mat()` 过滤逻辑**

将 `engine/mechanics.py` 的 `build_mat()`：

```python
def build_mat():
    mat = {k: {} for k in IND_KEYS}
    for t in D.INDUSTRY_TILES:
        if t['level'] < 1 or not t.get('per_player'):
            continue
        if t['era'] in ('—', '无法建造'):
            continue
        key = IND_CN2KEY[t['industry']]
        mat[key][t['level']] = mat[key].get(t['level'], 0) + t['per_player']
    return mat
```

改为：

```python
def build_mat():
    """按 industry_tiles.json 的 per_player 生成一名玩家的个人板块库。

    结构：{industryKey: {level: 剩余张数}}；
    造船厂 0 级是占位板块：只能「发展」弃掉，不能建造但要在面板上显示，因此进库。
    """
    mat = {k: {} for k in IND_KEYS}
    for t in D.INDUSTRY_TILES:
        if not t.get('per_player'):
            continue
        if t['era'] == '—':
            continue
        if t['level'] == 0 and t['industry'] != '造船厂':
            continue
        key = IND_CN2KEY[t['industry']]
        mat[key][t['level']] = mat[key].get(t['level'], 0) + t['per_player']
    return mat
```

- [ ] **Step 4: 重新跑 test_build_rules，确认全绿**

Run: `cd /d/zhuoyou/lancashire && server/.venv/Scripts/python.exe tests/test_build_rules.py 2>&1 | tail -10`
Expected: 含 `[PASS] 造船厂 0 级进 mat（占位板块）`，全 PASS，无 FAIL。

- [ ] **Step 5: 回归 — 跑后端契约 + 自走**

Run:
```
cd /d/zhuoyou/lancashire && server/.venv/Scripts/python.exe tests/test_bot_room.py http://127.0.0.1:8765 2>&1 | tail -3
server/.venv/Scripts/python.exe tests/selfplay.py 6 2>&1 | tail -2
```
Expected: `27/27 通过` + `6/6 局正常终局`。

---

### Task 2: 重排 player_board.json 槽位坐标

**Files:**
- Modify: `web/public/data/player_board.json`（19 个槽位的 x/y）
- （产物由 Hud.js renderBoard 自动按 `s.x * scale` / `s.y * scale` 渲染，scale = panelW/boardW = 286/1417 ≈ 0.202）

**Interfaces:**
- Consumes: Hud.js 不动；现有 renderBoard 逻辑直接吃新坐标。

- [ ] **Step 1: 改写 player_board.json 的 slots 数组**

把 `web/public/data/player_board.json` 整个文件覆盖为：

```json
{
  "slotSize": 86,
  "background": "assets/player_board.jpg",
  "size": { "width": 1417, "height": 960 },
  "note": "玩家个人面板上的产业板块槽位；坐标为玩家面板底图自身像素空间（与游戏主地图 1936x1936 无关）。个人面板上的产业板块永远不翻面，翻面仅发生在游戏主图版已建建筑上。面板底图尺寸 1417x960。槽位 y=80-740 占满面板纵向、5 列 x=170/440/710/980/1250 横向均布（scale=0.202 渲染约 286×194）。造船厂只有 L0/L1/L2。",
  "slots": [
    { "slot_id": "pb_cotton_1", "tile_id": "cotton_1", "x": 170, "y": 740 },
    { "slot_id": "pb_cotton_2", "tile_id": "cotton_2", "x": 170, "y": 520 },
    { "slot_id": "pb_cotton_3", "tile_id": "cotton_3", "x": 170, "y": 300 },
    { "slot_id": "pb_cotton_4", "tile_id": "cotton_4", "x": 170, "y": 80 },

    { "slot_id": "pb_port_1", "tile_id": "port_1", "x": 440, "y": 740 },
    { "slot_id": "pb_port_2", "tile_id": "port_2", "x": 440, "y": 520 },
    { "slot_id": "pb_port_3", "tile_id": "port_3", "x": 440, "y": 300 },
    { "slot_id": "pb_port_4", "tile_id": "port_4", "x": 440, "y": 80 },

    { "slot_id": "pb_shipyard_0", "tile_id": "shipyard_0", "x": 710, "y": 80, "placeholder": true },
    { "slot_id": "pb_shipyard_1", "tile_id": "shipyard_1", "x": 710, "y": 300 },
    { "slot_id": "pb_shipyard_2", "tile_id": "shipyard_2", "x": 710, "y": 520 },

    { "slot_id": "pb_ironworks_1", "tile_id": "ironworks_1", "x": 980, "y": 740 },
    { "slot_id": "pb_ironworks_2", "tile_id": "ironworks_2", "x": 980, "y": 520 },
    { "slot_id": "pb_ironworks_3", "tile_id": "ironworks_3", "x": 980, "y": 300 },
    { "slot_id": "pb_ironworks_4", "tile_id": "ironworks_4", "x": 980, "y": 80 },

    { "slot_id": "pb_colliery_1", "tile_id": "colliery_1", "x": 1250, "y": 740 },
    { "slot_id": "pb_colliery_2", "tile_id": "colliery_2", "x": 1250, "y": 520 },
    { "slot_id": "pb_colliery_3", "tile_id": "colliery_3", "x": 1250, "y": 300 },
    { "slot_id": "pb_colliery_4", "tile_id": "colliery_4", "x": 1250, "y": 80 }
  ]
}
```

注意：造船厂 0 级槽位的 `placeholder:true` 保留（Hud.js 当前不读这个字段，渲染逻辑与 L1/L2 一致；保留字段以便将来想做区分渲染时不用改数据）。

- [ ] **Step 2: 构建前端（让 JSON 拷贝进 dist）**

Run: `cd /d/zhuoyou/lancashire/web && npm run build 2>&1 | tail -10`
Expected: `✓ built in X.XXs`，dist/assets/index-*.js 重新生成（hash 可能变化）。

- [ ] **Step 3: 验证 dist 里有新 JSON**

Run: `grep -c '"x": 170, "y": 740' /d/zhuoyou/lancashire/web/dist/data/player_board.json`
Expected: `1`

- [ ] **Step 4: 跑机器人房冒烟，确认面板/手牌基础结构仍 PASS**

Run: `cd /d/zhuoyou/lancashire/web && node tests/smoke_bga.mjs http://127.0.0.1:8765 2>&1 | tail -6`
Expected: `CHECKS: 16  FAIL: 0`，REAL ERRORS: none。

- [ ] **Step 5: 浏览器打开 `?scene=panels` 目测板块均布 + 0 级造船厂可见**

Run: 浏览器访问 `http://127.0.0.1:8765/?scene=panels`，进入玩家面板独立总览页，验证：
- 每个 2×2 面板上 5 列（cotton/port/shipyard/ironworks/colliery）4 行（L4 在最上、L1 在最下），板块图均布。
- shipyard 列顶部能看到 `shipyard_0`（0 级造船厂，标注 "占位"），每个玩家应该有 2 张（叠放）。
- 没出现 404 关键资源。

如有问题，调整对应坐标重跑 Step 2-5。

---

### Task 3: HUD 布局重组（CSS + GameScene.fitCamera）

**Files:**
- Modify: `web/src/ui/style.css`（`#handpanel` 改成横排顶部；`#rightcol` 上移；卡片尺寸微缩）
- Modify: `web/src/scenes/GameScene.js:96-110`（`fitCamera()` 的 insetT 加大）

**Interfaces:**
- Consumes: Hud.js mount 顺序不变（top → hand → right），仍按顺序 append 到 `#ui`。

- [ ] **Step 1: 改 style.css 的 `#handpanel` 块**

把 `web/src/ui/style.css` 第 96-116 行（`/* 手牌面板 */` 段）整体替换为：

```css
/* ---------------- 手牌面板（顶部横排，占顶栏到玩家面板之间整条横向） ---------------- */

#handpanel {
  position: absolute;
  top: 66px; left: 8px; right: 316px;   /* 316 = 玩家面板 300 + 右 8 + 间隔 8 */
  height: 110px;
  padding: 6px 10px 7px;
  pointer-events: none;               /* 仅卡片接收事件，下方地图仍可点击 */
}
#handpanel .hd { font-weight: 700; font-size: 13px; color: var(--muted); margin-bottom: 4px; }
#handpanel .cards {
  display: flex; gap: 6px;
  align-items: center; min-height: 80px;
  flex-wrap: nowrap;                  /* 不换行；溢出时走横向滚动 */
  overflow-x: auto;
}
#handpanel .hcard {
  width: 52px; height: 72px; border-radius: 7px; overflow: hidden;
  border: 1px solid var(--line); background: #1b2430; pointer-events: auto;
  cursor: pointer; flex: 0 0 auto;
  box-shadow: 0 4px 12px rgba(0,0,0,.4);
}
#handpanel .hcard img { width: 100%; height: 100%; object-fit: cover; display: block; }
#handpanel .hcard .fallback { font-size: 11px; padding: 4px; text-align: center; }
#handpanel .note { color: var(--muted); font-size: 12.5px; align-self: center; }
#handpanel .foot { color: var(--muted); font-size: 11.5px; margin-top: 3px; }
```

- [ ] **Step 2: 改 style.css 的 `#rightcol` 块**

把 `web/src/ui/style.css` 第 118-127 行（`/* 右侧栏 */` 段）的 `#rightcol` 那块：

```css
#rightcol {
  position: absolute;
  top: 8px; right: 8px; bottom: 8px;
  width: 300px;
  ...
}
```

改为：

```css
#rightcol {
  position: absolute;
  top: 66px; right: 8px; bottom: 8px;     /* 起始位置对齐手牌顶部 */
  width: 300px;
  ...
}
```

其余 `.ppanels` / `#plog` 等保持不变。

- [ ] **Step 3: 改 GameScene.fitCamera() 的 insetT**

把 `web/src/scenes/GameScene.js` 第 96-110 行：

```js
fitCamera() {
  const cam = this.cameras.main;
  const W = this.scale.width, H = this.scale.height;
  const insetL = 10;   // 左侧手牌面板悬浮覆盖，版图左缘留白
  const insetR = 312;  // 右侧玩家面板栏宽度 + 边距
  const insetT = 58;   // 顶部行动条
  const insetB = 12;
  ...
}
```

改为：

```js
fitCamera() {
  const cam = this.cameras.main;
  const W = this.scale.width, H = this.scale.height;
  const insetL = 10;   // 左侧版图留白
  const insetR = 312;  // 右侧玩家面板栏宽度 + 边距
  const insetT = 184;  // 顶部行动条 58 + 手牌横排 118（含上下间隔）+ 间隔 8
  const insetB = 12;
  ...
}
```

- [ ] **Step 4: 构建前端**

Run: `cd /d/zhuoyou/lancashire/web && npm run build 2>&1 | tail -10`
Expected: `✓ built in X.XXs`，新 bundle hash 与 Task 2 末尾可能不同（CSS 改了）。

- [ ] **Step 5: 跑机器人房冒烟，确保 HUD 挂载 + 16/16 不退化**

Run: `cd /d/zhuoyou/lancashire/web && node tests/smoke_bga.mjs http://127.0.0.1:8765 2>&1 | tail -6`
Expected: `CHECKS: 16  FAIL: 0`，REAL ERRORS: none。

- [ ] **Step 6: 浏览器目测新布局 + 截屏验证**

Run:
1. 浏览器访问 `http://127.0.0.1:8765/`，在大厅建房（可不勾选机器人房，2 人手动开局也行）。
2. 进入对局后，目测：
   - 顶部第 1 行 = 行动条；第 2 行 = 手牌横排（一排卡牌，左到右，溢出可横滚）。
   - 玩家面板在右侧、起点与手牌同行。
   - 地图在底部，行走点击槽位正常，不被手牌面板遮挡。
3. 用 Playwright 截屏保存到 `web/tests/bga_smoke.png`（smoke 已截，但布局变了，重跑确认图也是新的）：
   `cd /d/zhuoyou/lancashire/web && node tests/smoke_bga.mjs http://127.0.0.1:8765 2>&1 | tail -3`

- [ ] **Step 7: 后端契约回归（确保后端不动还是好的）**

Run: `cd /d/zhuoyou/lancashire && server/.venv/Scripts/python.exe tests/test_bot_room.py http://127.0.0.1:8765 2>&1 | tail -3`
Expected: `27/27 通过`。

---

## 自审

- **覆盖**：spec 3 个设计 → Task 1（shipyard_0 入库）+ Task 2（槽位坐标）+ Task 3（CSS + fitCamera）。
- **占位符**：无 TBD/TODO，每步都有具体代码或命令。
- **类型一致**：Task 2 的 `pb_shipyard_0` 槽位 prefix='shipyard' / lv='0' 与 Hud.js `s.tile_id.split('_')` 解析逻辑一致；Hud.js 的 SLOT2MAT['shipyard']='shipyard' 与 build_mat 的 mat key 'shipyard' 一致。
- **测试**：Task 1 用引擎单测；Task 2/3 用机器人房冒烟（16/16 已稳定）。
- **回归**：每个 Task 末尾都跑相关回归（build_rules / bot_room / selfplay / smoke）。

## 执行方式

采用 inline 执行（executing-plans）：T1 → T3 顺序推进，每 Task 末尾跑对应测试/冒烟验证。用户已逐节确认通过 spec，无需再确认即开工。