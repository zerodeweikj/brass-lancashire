# 个人面板板块显示与 HUD 布局重构

> 状态：设计稿（2026-08-10）。用户已逐节确认通过。
> 范围：单页游戏内三个相关修复——0 级造船厂面板显示、面板插槽重排、手牌/地图布局重组。

## 背景

玩家截图反馈（2026-08-09 晚）：

1. 个人面板上的板块都集中在右下角。
2. 0 级造船厂在个人面板上看不到。
3. 手牌应该在顶部一行，地图放在下面。

根因分析：

- **0 级造船厂**：`engine/mechanics.py::build_mat()` 用 `if t['level'] < 1` 一刀切过滤 0 级板块，导致 `mat['shipyard'][0]` 从未被填。`industry_tiles.json` 给 `shipyard_0` 写了 `per_player:2`、`note: "占位板块..."`、`era: "无法建造"`。`player_board.json` 给了 `pb_shipyard_0` 槽位（x=710, y=750, `placeholder:true`）和 4 个颜色的 jpg 都齐全。链条只断了引擎 mat 初始化这一步。
- **板块偏右下**：玩家面板宽 286px（`panelW=286`），1417×960 底图缩到约 286×194（scale ≈ 0.202），每个板块渲染 ~17×17px。槽位 y=220-750 只占面板纵向 44-151px，顶部 43px 全空；x=158-1253 还算横向均匀。
- **布局**：当前 `#handpanel` 浮在地图左上角（top:8, left:8, width:372px），与 `#rightcol`(300px) 一起瓜分地图两侧。用户希望手牌横排顶部、地图下移，玩家面板保留在右侧。

## 设计

### 设计 1：0 级造船厂入 mat

**文件**：`engine/mechanics.py`（第 23-36 行 `build_mat()`）。

只对「造船厂」放行 level=0，其他仍走 `level < 1` 过滤；`era == '—'` 过滤保留（过滤 industry_tiles 标记为"无此等级板块"的项）。

```python
def build_mat():
    mat = {k: {} for k in IND_KEYS}
    for t in D.INDUSTRY_TILES:
        if not t.get('per_player'):
            continue
        if t['era'] == '—':
            continue
        # shipyard level 0 是占位板块：只能用「发展」弃掉，不能建造但要在面板上显示
        if t['level'] == 0 and t['industry'] != '造船厂':
            continue
        key = IND_CN2KEY[t['industry']]
        mat[key][t['level']] = mat[key].get(t['level'], 0) + t['per_player']
    return mat
```

行为：每个玩家 `mat['shipyard'][0] = 2`，Hud.js 的 renderBoard 在 `pb_shipyard_0` 槽位渲染两张 0 级造船厂（叠放同槽位，顺序与其他等级一致）。`sync_min_build_level` 已经会把 shipyard min 算成 0（不影响建造规则）。

### 设计 2：重排个人面板槽位坐标

**文件**：`web/public/data/player_board.json`。

保持 `panelW=286`，scale=0.202 不变。槽位从原本 y=220-750（只占面板中下段）改为 y=80-740（占满面板纵向）。横向保持 5 列均匀。

**5 列（横向均匀）**：

| 产业 | 旧 x | 新 x |
|---|---|---|
| cotton | 158 | 170 |
| port | 431 | 440 |
| shipyard | 709 | 710 |
| ironworks | 981 | 980 |
| colliery | 1253 | 1250 |

**4 行（纵向均匀）**：

| 等级 | 旧 y | 新 y |
|---|---|---|
| L4 | 220 | 80 |
| L3 | 400 | 300 |
| L2 | 565 | 520 |
| L1 | 740 | 740 |
| L0 shipyard（占位） | 750 | 80 |

造船厂只有 L0/L1/L2 三个槽位（industry_tiles 给 level 3/4 标了"无此等级板块"，per_player:null），不参与 L4/L3 行。新坐标让每行间间距 ~220 板像素 → 渲染后 ~44px，5 列间间距 ~270 → ~55px。

**注意**：槽位坐标与底图 `player_board.jpg` 中的视觉分区不再严格对齐。这是设计 1+2 的副作用（也要 0 级造船厂塞进 L4 行）。底图本身没有强列分隔线，是一块完整的画布加静态栏目文字，因此浮动板块位置变化不会造成明显的视觉错位。

### 设计 3：HUD 布局重组

**文件**：`web/src/ui/style.css`、`web/src/scenes/GameScene.js::fitCamera`。

手牌横排顶部、地图下移、玩家面板保持右侧不动。

**CSS**：

```css
/* topbar 不变（顶部 8px 高度 ~50px） */
#topbar { position: absolute; top: 8px; left: 8px; right: 8px; ... }

/* 手牌面板改为横排：顶栏下方、玩家面板左侧 */
#handpanel {
  position: absolute;
  top: 66px; left: 8px; right: 316px;   /* 316 = 玩家面板 300 + 右 8 + 间隔 8 */
  height: 110px;
  padding: 6px 10px;
  pointer-events: none;
}
#handpanel .cards {
  display: flex; gap: 6px;
  align-items: center;
  min-height: 80px;
  flex-wrap: nowrap;
  overflow-x: auto;
}
#handpanel .hcard { width: 52px; height: 72px; }
#handpanel .hd { ... }

/* 玩家面板列起始位置上移对齐手牌顶部 */
#rightcol {
  position: absolute;
  top: 66px; right: 8px; bottom: 8px;
  width: 300px;
}
```

**GameScene.fitCamera()**：

```js
fitCamera() {
  const cam = this.cameras.main;
  const W = this.scale.width, H = this.scale.height;
  const insetL = 10;
  const insetR = 312;   // 玩家面板 300 + 间隔 12
  const insetT = 184;   // 顶栏 58 + 手牌行 118 (含上下间隔) + 间隔 8
  const insetB = 12;
  ...
}
```

**新布局示意**：

```
┌──────────────────────────────┬───────────┐
│ topbar (~58px)               │           │
├──────────────────────────────┤ 玩家面板 │
│ 手牌横排 (66→176, 110px)     │  + 日志   │
├──────────────────────────────┤  (300px)  │
│                              │           │
│      游戏地图                │           │
│      (176 → bottom)           │           │
└──────────────────────────────┴───────────┘
```

## 数据流

- 设计 1 仅改后端引擎初始化，前端不动（Hud 已按 `mat[key][level] > 0` 渲染）。
- 设计 2 仅改前端 JSON 数据，槽位坐标渲染按 `s.x * scale` / `s.y * scale` 直接生效。
- 设计 3 改 CSS + 摄像机 fit 偏移，不影响状态层。

## 错误处理

无新错误路径。设计 1 不引入新校验；shipyard_0 mat=2 时玩家既不能建造也不能发展丢弃（规则未变），只是显示。设计 2/3 纯布局调整。

## 测试

- 机器人房冒烟（`web/tests/smoke_bga.mjs`）保持 16/16 全绿。
- 玩家面板独立页（`web/tests/smoke_panels.mjs` + 浏览器打开 `?scene=panels`）目测：
  - 4 个 2×2 面板都能看到 0 级造船厂图标。
  - 板块均布在面板 4 行 × 5 列。
- 后端契约 `tests/test_bot_room.py` 27/27、`tests/test_build_rules.py` 19/19、`tests/selfplay.py` 6 局 0 失败回归。
- 浏览器手动验证：新布局下手牌顶部横排可点击，地图可拖动、点击槽位，玩家面板与地图互不遮挡。