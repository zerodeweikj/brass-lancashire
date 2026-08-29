# Player Panel Hover Tooltip + WASD/方向键相机 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立玩家面板总览页（`?scene=panels`）上，移除静态的「已建/库存」文字与 ×N 角标，改为鼠标悬停板块时在光标旁显示剩余数量（数量=0 的板块不绘制、不提示、不响应悬停）；并给相机增加 WASD / 方向键平移，所有场景共享。

**Architecture:** `PlayerPanelsScene` 已按 `boardState.getStock` 渲染 4 个面板；本次只改它的文字/角标绘制，悬停提示沿用已有 handler。相机平移集中在 `enableCameraPanZoom`，GameScene / CombinedScene / PlayerPanelsScene 全部受益。CombinedScene 面板上的「已建 N」文本一并移除以保持一致。

**Tech Stack:** Phaser 3 + Vite + 原生 JS；验证用 Playwright 无头浏览器。

## Global Constraints

- 端口 8765；后端 uvicorn；前端改动必须 `npm run build` 重建 `web/dist` 后才生效。
- 已建造板块只在公开游戏地图（GameScene / CombinedScene），绝不在玩家面板。
- 面板库存来自 `boardState.getStock(color, tileId)`（per_player，每位玩家初始 37 块：12 棉花 / 8 港口 / 6 造船厂 / 4 铁厂 / 7 煤厂）。
- 库存 = 0 的板块：不绘制、不显示提示、不响应悬停（露出底图）。
- 「玩家面板」仅指独立总览页 `?scene=panels`；不在 GameScene 内嵌底部停靠面板（用户已确认「只要独立总览页」）。

---

### Task 1: 给 `enableCameraPanZoom` 增加 WASD / 方向键平移

**Files:**
- Modify: `web/src/utils/cameraControl.js`

**Interfaces:**
- 消费：Phaser 场景的 `scene.input.keyboard`、`scene.cameras.main`、`scene.events`
- 产出：无新导出；平移在 `update` 帧循环内生效，所有调用方（GameScene / CombinedScene / PlayerPanelsScene）自动获得

- [ ] **Step 1: 在 `enableCameraPanZoom` 末尾（返回对象之前）插入键盘平移逻辑**

在 `return { isPanning, setZoom }` 之前加入：

```js
  // 键盘平移：WASD / 方向键。每帧轮询按住状态，屏幕像素速度换算成世界位移（随 zoom 缩放，手感一致）。
  let keys = null;
  const kb = scene.input.keyboard;
  if (kb) {
    keys = kb.addKeys({
      up: Phaser.Input.Keyboard.KeyCodes.W,
      down: Phaser.Input.Keyboard.KeyCodes.S,
      left: Phaser.Input.Keyboard.KeyCodes.A,
      right: Phaser.Input.Keyboard.KeyCodes.D,
      up2: Phaser.Input.Keyboard.KeyCodes.UP,
      down2: Phaser.Input.Keyboard.KeyCodes.DOWN,
      left2: Phaser.Input.Keyboard.KeyCodes.LEFT,
      right2: Phaser.Input.Keyboard.KeyCodes.RIGHT,
    });
  }
  const PAN_SPEED = 14; // 屏幕像素/帧
  const onUpdate = () => {
    if (!keys) return;
    // 输入框聚焦时不抢键（避免影响 DOM 文本输入）
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')) return;
    let dx = 0, dy = 0;
    if (keys.left.isDown || keys.left2.isDown) dx -= 1;
    if (keys.right.isDown || keys.right2.isDown) dx += 1;
    if (keys.up.isDown || keys.up2.isDown) dy -= 1;
    if (keys.down.isDown || keys.down2.isDown) dy += 1;
    if (dx === 0 && dy === 0) return;
    const z = cam.zoom || 1;
    cam.scrollX += dx * PAN_SPEED / z;
    cam.scrollY += dy * PAN_SPEED / z;
  };
  scene.events.on('update', onUpdate);
  // 场景关闭时移除监听，避免重复进入时叠加
  scene.events.once('shutdown', () => scene.events.off('update', onUpdate));
```

- [ ] **Step 2: 本地语法自检**

Run: `cd /d/zhuoyou/lancashire && node --check web/src/utils/cameraControl.js`
Expected: 无报错输出（exit 0）

- [ ] **Step 3: 提交**

```bash
git add web/src/utils/cameraControl.js
git commit -m "feat(camera): 增加 WASD / 方向键平移"
```

---

### Task 2: PlayerPanelsScene 移除「已建/库存」文本与 ×N 角标，悬停显示剩余数量

**Files:**
- Modify: `web/src/scenes/PlayerPanelsScene.js`

**Interfaces:**
- 消费：`boardState.getStock(color, tileId)`、`this.__tip`（屏幕固定提示文本）
- 产出：面板只画板块图（count>0）；悬停时 `__tip` 显示「`<颜色>方 · <产业名> 剩余 <n>`」

- [ ] **Step 1: 删除「已建/库存」文本块**

将 `_buildOnePanel` 中第 160–170 行（从 `// 颜色名标签 + 公开信息` 到 `});` 整块）替换为只保留颜色名标签，不显示任何数字提示：

```js
    // 颜色名标签（不显示 已建/库存 数字；剩余数量改由悬停显示）
    this.add.text(P.x + 170 * s, P.y + 52 * s, `${COL_NAME[P.color]}方 · 玩家面板`, {
      fontSize: '30px', color: '#ffffff', fontFamily: 'Microsoft YaHei, sans-serif',
      fontStyle: 'bold', backgroundColor: 'rgba(0,0,0,0.55)', padding: { x: 8, y: 4 },
    });
```

- [ ] **Step 2: 删除 ×N 角标块**

将 `_buildOnePanel` 中第 190–196 行 `if (n > 1) { ... }` 整块删除（count>1 不再画角标，数量只靠悬停提示显示）。

- [ ] **Step 3: 精简悬停提示文案**

将 `_onTileOver` 中 `this.__tip.setText(...)` 改为：

```js
    this.__tip.setText(`${COL_NAME[color]}方 · ${name} 剩余 ${n}`);
```

（此时 `n > 0` 已保证，因为 count=0 的板块根本未绘制 → 无交互对象 → 不会触发悬停，满足「0 不启动悬停」）

- [ ] **Step 4: 本地语法自检**

Run: `cd /d/zhuoyou/lancashire && node --check web/src/scenes/PlayerPanelsScene.js`
Expected: 无报错输出

- [ ] **Step 5: 提交**

```bash
git add web/src/scenes/PlayerPanelsScene.js
git commit -m "feat(panels): 移除已建/库存文字与×N角标，悬停显示剩余数量"
```

---

### Task 3: CombinedScene 移除面板「已建 N」文本（一致性）

**Files:**
- Modify: `web/src/scenes/CombinedScene.js`

**Interfaces:**
- 消费：`boardState.builtBy(color)`（仅在被删文本中使用）
- 产出：右侧 4 面板不再显示「已建 N」文字；座席面板的悬停提示（`_onPbOver`）保留

- [ ] **Step 1: 删除 builtText 及其来源**

在 `_buildPlayerPanels` 中删除 `const built = boardState.builtBy(color);`（约第 732 行）以及其后创建 `builtText` 的两行（`const builtText = this.add.text(...)` 与 `objs.push(label, builtText);`），改为只 `objs.push(label);`。

- [ ] **Step 2: 本地语法自检**

Run: `cd /d/zhuoyou/lancashire && node --check web/src/scenes/CombinedScene.js`
Expected: 无报错输出

- [ ] **Step 3: 提交**

```bash
git add web/src/scenes/CombinedScene.js
git commit -m "fix(combined): 移除面板已建文本，遵循悬停显示规则"
```

---

### Task 4: 重建前端并验证

**Files:**
- Build: `web/dist`（由 `web/src` 重建）
- Test: `web/tests/smoke_panels.mjs`

**Interfaces:**
- 消费：已改的 PlayerPanelsScene / cameraControl / CombinedScene
- 产出：可加载的 `?scene=panels` 总览页，满足下方验证清单

- [ ] **Step 1: 重建**

Run: `cd /d/zhuoyou/lancashire/web && npm run build 2>&1 | tail -20`
Expected: 构建成功，无 error

- [ ] **Step 2: 启动后端**

Run（后台）:
```bash
cd /d/zhuoyou/lancashire/server && D:/zhuoyou/lancashire/server/.venv/Scripts/python.exe -m uvicorn app.main:app --host 0.0.0.0 --port 8765 > /d/zhuoyou/lancashire/server/.uvicorn.log 2>&1
```
Expected: 端口 8765 监听；`/api/health` 返回 `engine:ready`

- [ ] **Step 3: 扩展冒烟测试，覆盖三项新行为**

在 `web/tests/smoke_panels.mjs` 中保留原有「4 面板 + 库存计数」校验，新增：

1. 场景内文本对象中**不含**「已建」「库存」「×」字样（验证静态提示已移除）；
2. 悬停某块有库存的板块 → `scene.__tip.visible === true` 且文本含「剩余」；
3. 相机键盘平移：记录 `cam.scrollX`，向 window 派发 `keydown {key:'d', keyCode:68}` 并等待 ~250ms 后，再派发 `keyup`，断言 `cam.scrollX` 发生变化；再对方向键 `ArrowRight` 复测一次。

- [ ] **Step 4: 运行冒烟测试**

Run: `cd /d/zhuoyou/lancashire/web && NODE_PATH=D:/zhuoyou/lancashire/web/node_modules node tests/smoke_panels.mjs 2>&1 | tail -40`
Expected: 所有断言 PASS，无控制台 error（历史遗留 `card_back`/`marker` 404 不计入）

- [ ] **Step 5: 截图人工对照**

Run 中已 `screenshot('tests/panels_smoke.png')`；确认 4 面板无数字角标、无「已建/库存」文字，悬停出现光标旁提示。

- [ ] **Step 6: 停后端、提交**

停止 uvicorn；`git add web/dist web/tests/smoke_panels.mjs && git commit -m "build: 重建并验证面板悬停提示与 WASD 相机"`
