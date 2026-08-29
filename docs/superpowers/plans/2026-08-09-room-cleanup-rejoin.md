# 房间清理与无审批重连 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 清掉历史遗留房间；让"最后一个玩家离开/全员掉线"的房间自动解散；掉线刷新后凭本地 token 自动重连，无需房主同意。

**Architecture:** 房间数据存 SQLite（`server/lancashire.db` 的 `rooms` 表）。现有 `leave_room` 已能在"显式离开且清空"时删房间，但玩家直接关标签页不会触发 leave，且没有清理掉线座位的机制 → 房间堆积。修复方案：(1) 新增 `gc_rooms()` 在列出房间时清理掉线座位/空房间；(2) 进行中对局**保留**掉线者座位（其 token 仍可用于重连），只有全员掉线才整间清掉；(3) 前端离开提示文案改为如实说明"重连无需房主"。

**Tech Stack:** FastAPI + SQLite（服务端）；原生 JS 前端（大厅/会话）。无新增依赖。

## Global Constraints

- 房间唯一权威在服务端，客户端只持 token（PRD 12.1 服务器权威）。
- `join_room` 对 `status != 'lobby'` 保持拦截（保护引擎对局完整性：新建座位会破坏 engine 的 P1..P4 映射），重连走 token 自动恢复而非大厅加入。
- 进行中对局不得因单人或部分人掉线而删除房间或座位（否则破坏重连与引擎状态）。
- 前端改完必须 `npm run build` 重建 `web/dist`；后端改完必须重启 uvicorn 才生效。

---

### Task 1: db.py 增加 delete_game

**Files:**
- Modify: `server/app/db.py`（在 `delete_room` 之后新增 `delete_game`）

**Interfaces:**
- Produces: `db.delete_game(game_id: str) -> None`，供 `rooms.gc_rooms` 在清理废弃对局时调用。

- [ ] **Step 1: 在 `delete_room` 函数后追加 `delete_game`**

```python
def delete_game(game_id):
    """删除某局对局状态（房间被解散且已无人在场时调用）。"""
    with _lock:
        conn = _connect()
        try:
            conn.execute('DELETE FROM games WHERE game_id=?', (game_id,))
            conn.commit()
        finally:
            conn.close()
```

- [ ] **Step 2: 语法校验**

Run: `cd D:\zhuoyou\lancashire && node --check server/app/db.py` 不可用于 py；改用 Python 导入校验：
`cd D:\zhuoyou\lancashire/server && D:/zhuoyou/lancashire/server/.venv/Scripts/python.exe -c "import app.db as d; print('delete_game' in dir(d))"`
Expected: 输出 `True`

- [ ] **Step 3: Commit**（本任务不单独提交，随 Task 3 一起提交）

---

### Task 2: rooms.py 增加 gc_rooms 掉线清理

**Files:**
- Modify: `server/app/rooms.py`（在模块常量区加 `STALE_SECS`，在房间生命周期区加 `gc_rooms`）

**Interfaces:**
- Consumes: `db.list_rooms()`、`db.save_room(room_id, room)`、`db.delete_room(room_id)`、`db.delete_game(game_id)`（Task 1 产出）
- Produces: `rooms.gc_rooms() -> None`，供 `main.py` 的 `GET /api/rooms` 调用

- [ ] **Step 1: 在 `MAX_SEATS = 4` 下方新增常量**

```python
STALE_SECS = 90  # 座位 lastSeen 超过此时长判定为掉线离开
```

- [ ] **Step 2: 在 `leave_room` 之后新增 `gc_rooms`**

```python
def gc_rooms():
    """清理僵尸房间（列出房间时调用）：
    - lobby：踢出掉线座位，若无人则删房间；
    - playing/finished：仅当全员掉线才删房间+对局；否则保留掉线者座位
      （其 token 仍可用于刷新重连，避免破坏引擎 P1..P4 映射）。
    """
    with _lock:
        for room in db.list_rooms():
            room_id = room['roomId']
            seats = room.get('seats', [])
            alive = [s for s in seats
                     if time.time() - s.get('lastSeen', 0) < STALE_SECS]
            if len(alive) == len(seats):
                continue  # 无掉线者，跳过
            if not alive:
                # 全员掉线 -> 房间废弃，连同对局一起清
                db.delete_room(room_id)
                if room.get('gameId'):
                    db.delete_game(room['gameId'])
                continue
            if room['status'] == 'lobby':
                for i, s in enumerate(alive):
                    s['index'], s['color'], s['playerId'] = i, COLORS[i], 'P%d' % (i + 1)
                if room['hostToken'] not in {s['token'] for s in alive}:
                    room['hostToken'] = alive[0]['token']
                room['seats'] = alive
                room['rev'] += 1
                db.save_room(room_id, room)
            # playing/finished：保留掉线座位不动，重连靠 token
```

- [ ] **Step 3: 语法校验**

Run: `cd D:\zhuoyou\lancashire/server && D:/zhuoyou/lancashire/server/.venv/Scripts/python.exe -m py_compile app/rooms.py && echo OK`
Expected: 输出 `OK`

- [ ] **Step 4: Commit**（随 Task 3 一起提交）

---

### Task 3: main.py 在列表接口接入 gc_rooms

**Files:**
- Modify: `server/app/main.py`（`@app.get('/api/rooms')` 的 `list_rooms` 函数体内首行调用 `rooms.gc_rooms()`）

**Interfaces:**
- Consumes: `rooms.gc_rooms()`（Task 2 产出）

- [ ] **Step 1: 修改 `list_rooms` 端点**

```python
@app.get('/api/rooms')
def list_rooms():
    rooms.gc_rooms()   # 列出前清理掉线/空房间，大厅永不显示僵尸房
    return {'rooms': [rooms.public_room(r) for r in db.list_rooms()]}
```

- [ ] **Step 2: 语法校验**

Run: `cd D:\zhuoyou\lancashire/server && D:/zhuoyou/lancashire/server/.venv/Scripts/python.exe -m py_compile app/main.py && echo OK`
Expected: 输出 `OK`

- [ ] **Step 3: Commit**（随 Task 4 一起提交）

---

### Task 4: 前端离开提示文案如实化

**Files:**
- Modify: `web/src/app.js`（`leave()` 内的 `confirm(...)` 文案）

**Interfaces:**
- 仅文案修改，无接口变更。

- [ ] **Step 1: 修改 `app.js:120` 的 confirm 文案**

将：
```js
if (!confirm('确定离开房间吗？对局进度会保留在服务器上，重新加入需要房主重开。')) return;
```
改为：
```js
if (!confirm('确定离开房间吗？对局进度会保留在服务器上；若只是意外断线或刷新页面，重开本页会凭本地身份自动回到本局（无需房主同意）。主动离开则会释放你的座位。')) return;
```

- [ ] **Step 2: 语法校验**

Run: `cd D:\zhuoyou\lancashire && node --check web/src/app.js && echo OK`
Expected: 输出 `OK`

- [ ] **Step 3: 重建前端**

Run: `cd D:\zhuoyou\lancashire/web && npm run build 2>&1 | tail -6`
Expected: 构建成功，无报错

- [ ] **Step 4: Commit**

```bash
git add server/app/db.py server/app/rooms.py server/app/main.py web/src/app.js
git commit -m "feat: 房间空置自动解散 + 掉线重连无需房主"
```

---

### Task 5: 一次性清空历史房间 + 重启 + 验证

**Files:**
- 数据操作：`server/lancashire.db`（清空 `rooms` 表，先备份）
- 验证脚本（临时）：`server/tests/smoke_rooms.py`

**Interfaces:**
- Consumes: 已部署的新后端（`/api/rooms` 已含 gc）

- [ ] **Step 1: 备份并清空 rooms 表**

Run（在 server 目录下，用项目 venv）：
```bash
cd D:\zhuoyou\lancashire/server
D:/zhuoyou/lancashire/server/.venv/Scripts/python.exe - <<'PY'
import shutil, sqlite3, os
DB='lancashire.db'
shutil.copy(DB, DB+'.bak')  # 备份，便于回滚
conn=sqlite3.connect(DB)
n=conn.execute('SELECT COUNT(*) FROM rooms').fetchone()[0]
conn.execute('DELETE FROM rooms')
conn.commit(); conn.close()
print('cleared rooms:', n, '-> remaining:', 0)
PY
```
Expected: 输出 `cleared rooms: <N> -> remaining: 0`

- [ ] **Step 2: 重启后端以加载新代码**

杀掉旧 uvicorn 进程后重新拉起（见执行阶段命令），确认 `GET /api/health` 返回 `engine:ready`。

- [ ] **Step 3: 验证空列表 + 离开即删 + 掉线清理**

Run: `cd D:\zhuoyou\lancashire/server && D:/zhuoyou/lancashire/server/.venv/Scripts/python.exe tests/smoke_rooms.py`
脚本逻辑：
  1. `GET /api/rooms` → `rooms` 为空列表。
  2. `POST /api/rooms`（建房）→ 拿到 `roomId`+`token`；`GET /api/rooms` → 含该房。
  3. `POST /api/rooms/{id}/leave` → `GET /api/rooms` → 该房已消失（最后一人离开即删）。
  4. 直接 UPDATE 该房某座位的 `lastSeen` 为很早时间（模拟掉线）→ `GET /api/rooms` 触发 gc → 该房消失。
Expected: 全部断言通过，无残留房间。

- [ ] **Step 4: 收尾**

删除临时 `tests/smoke_rooms.py`（或保留）。记录到工作日志。
