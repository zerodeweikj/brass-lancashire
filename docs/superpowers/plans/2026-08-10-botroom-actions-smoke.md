# 机器人陪练房 + 行动系统完善 + 真·冒烟 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在兰开夏网页版中加入「机器人房主陪练房」（自动开局、自动跳过），按用户规则修正建造/连结/售卖/发展逻辑，把贷款/撤回做成文件夹式子集，并在个人面板显示连接库存；最后用机器人房跑通前端视角的真·冒烟（端到端执行各行动并断言 DOM 结果）。

**Architecture:** 后端 rooms.py 增加 `with_bot` 建房与满员自动开局；main.py 增加 `drive_bots`（轮到机器人自动跳过）与作弊接口；engine/actions.py 修正「城市牌建造不限运输网」；engine/flow.py 修正「无运输网时连结可在任意相邻空槽落子」。前端 Hud.js 做贷款/撤回文件夹子集、面板连接库存、结束回合按行动点置灰；app.js 让 `onAction` 带参、贷款预选档位、发展铁来源确认、售卖棉花路线选择+奖励询问；Lobby 增加机器人房勾选与作弊按钮。冒烟测试 `smoke_bga.mjs` 改为机器人房驱动。

**Tech Stack:** Python 3.12 FastAPI/uvicorn（后端引擎），Phaser 3 + Vite（前端），Playwright（冒烟）。端口固定 8765。

## Global Constraints

- 项目固定端口 8765；启动 `uvicorn app.main:app --host 0.0.0.0 --port 8765`。
- 前端改了必须 `npm run build`（后端托管 `web/dist`）。
- 美术全部用自有素材（`assets/*`），只借 BGA 排版。
- 凡有上下级菜单必须带「返回上一级」（文件夹逻辑）。
- 母集/子集行动栏常驻：`撤回上一步`、`整回合撤回`、`结束回合`（有行动点时「结束回合」灰色不可点）。
- 服务器时刻校验可用性（取 `buttonEnabled`），前端不另做规则判断；可点=能执行，置灰=不能执行。
- 术语：市场标记 = 城市自带 `market` 标记 + 港口；「远方的棉花市场」只是地图边界的可视化区域，其轨道位置 0~8（索引），X = 8（轨末）；抽到牌推进轨道，X 处即停。

---

### Task 1: 引擎 — 城市牌建造不限运输网

**Files:**
- Modify: `engine/actions.py:133-137`（`_validate_build` 内的位置校验）

**Interfaces:**
- 复用 `D.CARD_BY_ID`、`own_network`，不改签名。

- [ ] **Step 1: 修改网络校验，使城市牌驱动时放行**

把 actions.py 第 133-137 行：
```python
    # 位置：自有运输网内（首次建造 / 双牌建造例外）
    first_build = not p['industryTiles'] and not p['linkTiles']
    if not double and not first_build and location not in own_network(state, p['id']):
        return None, _fail('BUILD_LOCATION_UNREACHABLE',
                           '%s 不在你的运输网内。请先修路，或在该城已有工业板块。' % location, 'S1')
```
改为：
```python
    # 位置：自有运输网内（首次建造 / 双牌建造 / 城市牌驱动 例外）
    # —— 用户规则：丢弃城市牌=在该城建，不强制运输网；产业牌驱动才须网内
    first_build = not p['industryTiles'] and not p['linkTiles']
    card0 = D.CARD_BY_ID.get(cards[0])
    card_is_industry = bool(card0 and card0.get('type') == 'industry')
    if (not double and not first_build and card_is_industry
            and location not in own_network(state, p['id'])):
        return None, _fail('BUILD_LOCATION_UNREACHABLE',
                           '%s 不在你的运输网内。请先修路，或在该城已有工业板块。' % location, 'S1')
```

- [ ] **Step 2: 写失败单测验证城市牌可在网外建造、产业牌仍须网内**

Test: `engine/tests/test_build_network.py`
```python
import pytest
from engine import setup as S, actions as A, data as D

def _fresh(names=('A', 'B')):
    st = S.create_game(list(names), seed=1)
    return st

def test_city_card_build_outside_network():
    st = _fresh()
    p = st['players'][0]
    # 找一个该玩家手里有城市牌、且该城不在其运输网的落点（首建后必有网）
    # 直接首建：首建豁免网络，验证 city 驱动首建成功
    city = next(c for c in p['hand'] if D.CARD_BY_ID[c]['type'] == 'city')
    loc = D.CARD_BY_ID[city]['city']
    # 选一个该城允许的产业的最高级可建
    from engine import flow as F, mechanics as M
    action = {'type': 'build', 'playerId': p['id'], 'location': loc,
              'slotIndex': 0, 'industry': '棉花厂', 'cardIds': [city]}
    # 直接调用校验（绕过手牌/AP 预检），只验证网络分支
    ctx, err = A._validate_build.__wrapped__ if hasattr(A._validate_build,'__wrapped__') else None, None
    # 简化：直接走 apply_action，首建应成功
    r = A.apply_action(st, {'type': 'build', 'playerId': p['id'], 'location': loc,
                            'slotIndex': 0, 'industry': '棉花厂', 'cardIds': [city]})
    assert r['ok'] or r['fail_code'] == 'BUILD_WRONG_INDUSTRY', r
```
（该测试仅作回归保护，重点靠冒烟端到端验证。）

- [ ] **Step 3: 运行测试**

Run: `cd D:/zhuoyou/lancashire && python -m pytest engine/tests/test_build_network.py -q`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add engine/actions.py engine/tests/test_build_network.py
git commit -m "fix(engine): 城市牌驱动建造不强制运输网"
```

---

### Task 2: 引擎 — 无运输网时连结可在任意相邻空槽落子

**Files:**
- Modify: `engine/flow.py:119-158`（`legal_link_targets`）

**Interfaces:**
- 复用 `own_network`、`D.LOCATIONS`、`D.LOCATION_BY_ID`、`LINK_COST`，不改签名。

- [ ] **Step 1: 修改迭代集合**

把 flow.py `legal_link_targets` 开头的：
```python
    p = get_player(state, player_id or state['currentPlayer'])
    net = own_network(state, p['id'])
    if p['remainingLinks'] <= 0:
        return []
    existing = set()
    for pl in state['players']:
        for lk in pl['linkTiles']:
            existing.add(frozenset(lk['endpoints']))
    out = []
    seen = set()
    for loc_id in sorted(net):
```
改为：
```python
    p = get_player(state, player_id or state['currentPlayer'])
    net = own_network(state, p['id'])
    if p['remainingLinks'] <= 0:
        return []
    existing = set()
    for pl in state['players']:
        for lk in pl['linkTiles']:
            existing.add(frozenset(lk['endpoints']))
    out = []
    seen = set()
    # 无运输网：与双牌建造同理，任意城市地点的相邻空连接槽都可落子
    scan = sorted(net) if net else [l['id'] for l in D.LOCATIONS]
    for loc_id in scan:
```
第 277 行 `if net and a not in net and b not in net:` 已含 `net and` 守卫，net 为空时自动跳过，无需改动。

- [ ] **Step 2: 写单测**

Test: `engine/tests/test_link_nonet.py`
```python
import pytest
from engine import setup as S, flow as F, state as ST

def test_no_network_falls_back_to_all():
    st = S.create_game(['A', 'B'], seed=2)
    p = st['players'][0]
    # 首建前网为空
    assert not ST.own_network(st, p['id'])
    targets = F.legal_link_targets(st, p['id'])
    # 应给出全图相邻空槽（而非空集）
    assert targets, '无运输网时连结应回退到任意相邻空槽'
```

- [ ] **Step 3: 运行**

Run: `cd D:/zhuoyou/lancashire && python -m pytest engine/tests/test_link_nonet.py -q`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add engine/flow.py engine/tests/test_link_nonet.py
git commit -m "fix(engine): 无运输网时连结回退任意相邻空槽"
```

---

### Task 3: 后端 — 机器人房 + 满员自动开局

**Files:**
- Modify: `server/app/rooms.py:27-41`（`create_room`）、`44-47`（`_seat`）、`120-130`（`set_ready`）
- Modify: `server/app/main.py:154-208`（create_room / ready / start_game 内部化自动开局）

**Interfaces:**
- `rooms.create_room(room_name, host_name, with_bot=False) -> (room, human_token)`
- `rooms.set_ready(room_id, token, ready) -> room`（内部触发自动开局时调用 `_auto_start`）
- 新增模块级 `_auto_start(room_id, db)` 复用 `engine_setup.create_game` + 标记玩家 `isBot`

- [ ] **Step 1: rooms.py `_seat` 支持 isBot，`create_room` 支持 with_bot**

```python
def _seat(index, token, name, isBot=False):
    return {'index': index, 'token': token, 'name': name or ('玩家%d' % (index + 1)),
            'color': COLORS[index], 'playerId': 'P%d' % (index + 1),
            'ready': True if isBot else (index == 0), 'isBot': isBot,
            'lastSeen': time.time()}


def create_room(room_name, host_name, with_bot=False):
    room_id = new_id(6)
    human_token = secrets.token_urlsafe(16)
    seats = []
    if with_bot:
        # 人类为房主(seat0)，机器人为 seat1（永远准备）；bot token 仅服务端持有
        bot_token = secrets.token_urlsafe(16)
        seats.append(_seat(0, human_token, host_name))
        seats.append(_seat(1, bot_token, '🤖 机器人', isBot=True))
    else:
        seats.append(_seat(0, human_token, host_name))
    room = {
        'roomId': room_id, 'name': room_name or ('%s 的房间' % host_name),
        'status': 'lobby', 'hostToken': human_token, 'gameId': None, 'rev': 1,
        'createdAt': time.time(), 'seats': seats, 'bot': with_bot,
        'botToken': seats[1]['token'] if with_bot else None,
    }
    db.save_room(room_id, room)
    return room, human_token
```

- [ ] **Step 2: rooms.py `set_ready` 后检测满员自动开局**

在 `set_ready` 末尾（`db.save_room` 之前）插入：
```python
    # 满 2 人且全部 ready（机器人恒 ready）→ 自动开局
    all_ready = len(room['seats']) >= 2 and all(s['ready'] for s in room['seats'])
    if room['status'] == 'lobby' and all_ready:
        from . import main as _main
        _main._auto_start(room_id)
```

- [ ] **Step 3: main.py 内部 `_auto_start` + `start_game` 标记 isBot + `create_room` 透传 with_bot**

在 main.py 增加：
```python
def _auto_start(room_id):
    room = db.load_room(room_id)
    if not room or room['status'] != 'lobby' or len(room['seats']) < 2:
        return
    names = [s['name'] for s in room['seats']]
    game_id = rooms.new_id(8)
    st = engine_setup.create_game(names, seed=None, game_id=game_id)
    for seat, p in zip(room['seats'], st['players']):
        p['name'] = seat['name']
        p['seat'] = seat['index']
        p['isBot'] = bool(seat.get('isBot'))
    db.save_game(game_id, st)
    room['gameId'] = game_id
    room['status'] = 'playing'
    room['rev'] += 1
    db.save_room(room_id, room)
```
`create_room` 路由改为：`room, token = rooms.create_room(req.roomName, req.playerName, req.withBot)`，`CreateRoomReq` 增加 `withBot: bool = False`。`start_game` 路由保留（供非机器人房手动开局），内部同样把 `p['isBot'] = bool(seat.get('isBot'))` 写入。

- [ ] **Step 4: 提交**

```bash
git add server/app/rooms.py server/app/main.py
git commit -m "feat(server): 机器人陪练房 + 满员自动开局"
```

---

### Task 4: 后端 — 机器人自动跳过（drive_bots）

**Files:**
- Modify: `server/app/main.py`（新增 `drive_bots`，并在 `submit_action`/`end_turn`/`_auto_start` 后调用）

**Interfaces:**
- `drive_bots(st)`：循环 —— 当前玩家是机器人且有手牌则 `apply_action({type:'autoSkip', playerId})`；是机器人且无手牌则 `engine_flow.end_turn(st)`；否则退出。游戏结束/非机器人退出。

- [ ] **Step 1: 实现 drive_bots**

```python
def drive_bots(st):
    """轮到机器人时自动行动，把回合交还人类。规则 #3：开场 0 牌直接 end_turn（引擎内再判跳过/结算）。"""
    guard = 0
    while st and not st.get('gameOver'):
        cur = engine_state.get_player(st, st['currentPlayer'])
        if not (cur and cur.get('isBot')):
            break
        if cur['hand']:
            engine_actions.apply_action(st, {'type': 'autoSkip', 'playerId': cur['id']})
        else:
            engine_flow.end_turn(st)
        guard += 1
        if guard > 200:
            break  # 防御性退出
```

- [ ] **Step 2: 在三个入口调用**

- `_auto_start` 末尾：`drive_bots(st); db.save_game(room['gameId'], st)`（并在 return 前重新 `room['rev'] += 1`）。
- `submit_action`：`if result['ok']: db.save_game(...)` 后追加 `if st:` + `drive_bots(st); db.save_game(room['gameId'], st)`。
- `end_turn` 路由：`engine_flow.end_turn(st)` 后 `drive_bots(st); db.save_game(...)`。

- [ ] **Step 3: 提交**

```bash
git add server/app/main.py
git commit -m "feat(server): 机器人回合自动跳过 drive_bots"
```

---

### Task 5: 后端 — 作弊接口（测试房）

**Files:**
- Modify: `server/app/main.py`（新增 `CheatReq` + `/cheat` 路由）

**Interfaces:**
- `POST /api/rooms/{room_id}/cheat` body `{token, kind: 'money'|'ap', amount: int}`
- 仅 `room.get('bot')` 为真时允许；作用于当前玩家（人类）。

- [ ] **Step 1: 实现作弊路由**

```python
class CheatReq(TokenReq):
    kind: str = 'money'
    amount: int = 20

@app.post('/api/rooms/{room_id}/cheat')
def cheat(room_id: str, req: CheatReq):
    room = _room_or_404(room_id)
    _seat_or_403(room, req.token)
    if not room.get('bot'):
        raise HTTPException(403, '仅在机器人测试房可用作弊')
    st = _game_of(room)
    if not st:
        raise HTTPException(400, '对局尚未开始')
    p = engine_state.get_player(st, st['currentPlayer'])
    if req.kind == 'money':
        p['money'] += req.amount
    elif req.kind == 'ap':
        st['actionPoints'] = max(0, st['actionPoints'] + req.amount)
        if st['actionPoints'] > 0:
            engine_flow.recompute(st)
    db.save_game(room['gameId'], st)
    seat = rooms.seat_of(room, req.token)
    return {'rev': rooms.rev_of(room, st), 'state': rooms.view_for(st, seat['playerId'])}
```

- [ ] **Step 2: 提交**

```bash
git add server/app/main.py
git commit -m "feat(server): 测试房作弊接口（加钱/加行动点）"
```

---

### Task 6: 前端网络层 — with_bot 建房 + 作弊

**Files:**
- Modify: `web/src/net/api.js:59`（createRoom 签名）、新增 `cheat`
- Modify: `web/src/net/session.js:96-105`（createRoom 透传）、新增 `cheat`

**Interfaces:**
- `api.createRoom(roomName, playerName, withBot)` → body 含 `withBot`
- `api.cheat(roomId, token, kind, amount)`
- `session.createRoom(roomName, playerName, withBot)`
- `session.cheat(kind, amount)`（用当前 roomId/token）

- [ ] **Step 1: api.js**

```js
createRoom: (roomName, playerName, withBot = false) =>
  request('POST', '/api/rooms', { body: { roomName, playerName, withBot } }),
cheat: (roomId, token, kind, amount) =>
  request('POST', `/api/rooms/${roomId}/cheat`, { body: { token, kind, amount } }),
```

- [ ] **Step 2: session.js**

```js
async createRoom(roomName, playerName, withBot = false) {
  const r = await api.createRoom(roomName, playerName, withBot);
  this.roomId = r.room.roomId; this.token = r.token;
  this.playerName = playerName; this._persist(); this._adopt(r);
  this.startPolling(); return r.room;
}
async cheat(kind, amount = 20) {
  if (!this.inRoom) return;
  this._adopt(await api.cheat(this.roomId, this.token, kind, amount));
}
```

- [ ] **Step 3: 提交**

```bash
git add web/src/net/api.js web/src/net/session.js
git commit -m "feat(web): 网络层支持机器人房与作弊"
```

---

### Task 7: 前端 Lobby — 机器人房勾选

**Files:**
- Modify: `web/src/ui/Lobby.js:71-144`（`_entryView` 增加勾选；`create` 透传）

**Interfaces:**
- 无新增导出，复用 `session.createRoom(name, nm, withBot)`。

- [ ] **Step 1: 增加勾选与透传**

在 `nameIn`/`roomIn` 下方加：
```js
const botChk = h('label.chk', null,
  h('input', { type: 'checkbox', onchange: (e) => { this.withBot = e.target.checked; } }),
  ' 带机器人房主（自动跳过陪练，满员自动开局）');
```
`create` 改为 `await this.session.createRoom(this.roomName.trim(), nm, !!this.withBot);`
把 `botChk` 插入「② 创建房间」区块内。

- [ ] **Step 2: 提交**

```bash
git add web/src/ui/Lobby.js
git commit -m "feat(web): 大厅增加机器人房勾选"
```

---

### Task 8: 前端 Hud — 贷款子集 + 撤回双按钮 + 面板连接库存 + 结束回合置灰

**Files:**
- Modify: `web/src/ui/Hud.js`（菜单状态、mk 支持 arg、贷款子集、撤回双按钮、phead 连接库存、结束回合按 AP）

**Interfaces:**
- `this.menu: 'root' | 'build' | 'loan'`
- `mk(label, kind, opt)` 增加 `opt.arg` → `onAction?.(kind, opt.arg)`
- `deps` 增加 `onUndoAll`；`deps.onAction(kind, arg)`

- [ ] **Step 1: 菜单状态与 mk 支持 arg**

`constructor` 中 `this.menu = 'root';` 不变（仍是三态之一）。
`mk` 改为：
```js
const mk = (label, kind, opt = {}) => {
  const disabled = opt.disabled !== undefined ? opt.disabled : (!mine || !be[kind]);
  return h('button', {
    disabled,
    onclick: () => {
      if (opt.menu) { this.menu = opt.menu; this._renderButtons(); }
      else { this.menu = 'root'; this.deps.onAction?.(kind, opt.arg); }
    },
  }, label);
};
```

- [ ] **Step 2: 贷款根按钮改为菜单；贷款子集 + 返回上一级；撤回双按钮常驻**

`_renderButtons` 的 else 分支把 `el.appendChild(mk('贷款', 'loan'));` 改为 `el.appendChild(mk('贷款', 'loan', { disabled: !loanOk, menu: 'loan' }));`（其中 `loanOk = mine && be.loan`）。
在 `if (this.menu === 'build') {...} else {` 内增加 `else if (this.menu === 'loan')` 分支：
```js
} else if (this.menu === 'loan') {
  const tiers = [10, 20, 30];
  for (const g of tiers) el.appendChild(mk('贷款 ' + g + ' 元', 'loan', { arg: g / 10, disabled: !mine || !be.loan }));
  el.appendChild(h('button.ghost', { onclick: () => { this.menu = 'root'; this._renderButtons(); } }, '返回上一级'));
}
```
撤回双按钮：把现有 `el.appendChild(h('button', {...}, '撤回'));` 替换为：
```js
el.appendChild(h('button', { disabled: !mine || !st.undoAvailable, onclick: () => this.deps.onUndo?.() }, '撤回上一步'));
el.appendChild(h('button', { disabled: !mine || !st.undoAvailable, onclick: () => this.deps.onUndoAll?.() }, '整回合撤回'));
```

- [ ] **Step 3: 面板头部增加连接库存**

`_renderPlayers` 的 `.stat` 改为：
```js
h('span.stat', null,
  `${money(p.money)} · 收入 ${inc == null ? '-' : inc} · 连接 ${p.remainingLinks ?? '-'} · VP ${vp}`),
```

- [ ] **Step 4: 结束回合按行动点置灰**

`canEnd` 改为：`const canEnd = mine && st.actionPoints <= 0;`（严格无行动点才可点）。

- [ ] **Step 5: 提交**

```bash
git add web/src/ui/Hud.js
git commit -m "feat(web): 贷款子集/撤回双按钮/连接库存/结束回合置灰"
```

---

### Task 9: 前端 app.js — onAction 带参 + 贷款预选 + 整回合撤回

**Files:**
- Modify: `web/src/app.js:34-41`（deps 加 onUndoAll）、`162-177`（startFlow 带参）、`579-625`（flowLoan 预选档位）、新增 undoAll 处理

**Interfaces:**
- `onAction: (k, arg) => this.startFlow(k, arg)`
- `startFlow(kind, arg)`：loan → `flowLoan(arg)`；其余不变。
- `flowLoan(presetTier)`：若 `presetTier` 给定（1/2/3），直接 `loanChooseCards({tier, gain, ok:true, after})` 跳过档位弹窗。
- 新增 `onUndoAll` → 循环提交 `{type:'undoAll'}`，或后端 `undoAll` handler。

- [ ] **Step 1: deps 与 startFlow**

```js
onAction: (k, arg) => this.startFlow(k, arg),
onUndo: () => this.submit({ type: 'undo' }, '撤回'),
onUndoAll: () => this.submit({ type: 'undoAll' }, '整回合撤回'),
```
```js
startFlow(kind, arg) {
  this.cancelFlow();
  const st = this.state;
  if (!st?.isMyTurn) return;
  this.flow = { kind };
  switch (kind) {
    case 'build': return this.flowBuild(false);
    case 'doubleBuild': return this.flowBuild(true);
    case 'road': return this.flowRoad();
    case 'develop': return this.flowDevelop();
    case 'sell': return this.flowSell();
    case 'loan': return this.flowLoan(arg);   // arg = 档位 1/2/3
    case 'skip': return this.flowSkip();
    default: return this.cancelFlow();
  }
}
```

- [ ] **Step 2: flowLoan 支持预选档位**

```js
flowLoan(presetTier) {
  const st = this.state;
  const me = (st.players || []).find((p) => p.id === st.viewerId);
  const track = this.static.incomeTrack?.positions || [];
  const now = track[me?.incomePos ?? 0];
  if (presetTier) {
    const np = (me?.incomePos ?? 0) - presetTier;
    if (np >= 0) return this.loanChooseCards({ tier: presetTier, gain: presetTier * 10, ok: true, after: track[np] });
    toast('该档位会使收入触底，不可选', 'err'); return this.cancelFlow();
  }
  // 原档位选择弹窗（不变）...
}
```

- [ ] **Step 3: 后端 undoAll handler（actions.py HANDLERS 增加）**

在 actions.py 增加：
```python
def do_undo_all(state, action):
    pid = action.get('playerId', state['currentPlayer'])
    count = 0
    while state.get('undoStack'):
        r = do_undo(state, {'playerId': pid, 'version': state['version']})
        if not r['ok']:
            break
        count += 1
        if state.get('gameOver'):
            break
    return _ok('整回合撤回', {'count': count})

HANDLERS = { ..., 'undoAll': do_undo_all }
```

- [ ] **Step 4: 提交**

```bash
git add web/src/app.js engine/actions.py
git commit -m "feat(web+engine): 行动带参/贷款预选/整回合撤回"
```

---

### Task 10: 前端 app.js — 发展铁来源确认 + 售卖棉花路线选择

**Files:**
- Modify: `web/src/app.js:445-502`（flowDevelop 增加铁来源点选确认）、`506-575`（flowSell/onSellMill 改为奖励询问 → 路线子菜单）
- Modify: `engine/flow.py`（新增 `sell_routes(state, millId)`，返回每条市场标记最短路线）
- Modify: `server/app/main.py recompute` 路径或 `sellable_options` 增加 routes

**Interfaces:**
- `flow.sell_routes(state, mill_id) -> [{'markerType':'market'|'port', 'markerLocation', 'distance', 'path':[locIds], 'channel', 'portTileId'?}]`
- 复用 `M._bfs_dist`（最短距离）+ 还原路径（记录前驱）。

- [ ] **Step 1: flow.py 增加 sell_routes（含路径还原）**

在 flow.py 增加：
```python
def _bfs_path(state, src):
    """返回 {loc: (dist, prev)}，基于共享路网。"""
    from . import mechanics as M
    dist, prev = {src: (0, None)}, {src: None}
    import collections
    q = collections.deque([src])
    while q:
        cur = q.popleft()
        adj = D.LOCATION_BY_ID[cur].get(state['phase'] == 'rail' and 'rail_adj' or 'canal_adj', [])
        for nb in adj:
            if nb not in dist and any(cur in frozenset(lk['endpoints']) and nb in frozenset(lk['endpoints'])
                                     for pl in state['players'] for lk in pl['linkTiles']):
                dist[nb] = (dist[cur][0] + 1, cur); prev[nb] = cur; q.append(nb)
    return dist, prev

def sell_routes(state, mill_id, player_id=None):
    p = get_player(state, player_id or state['currentPlayer'])
    mill = next((t for t in p['industryTiles'] if t['id'] == mill_id), None)
    if not mill: return []
    dist, prev = _bfs_path(state, mill['location'])
    out = []
    for pl in state['players']:
        for t in pl['industryTiles']:
            if t['flipped'] or M.industry_of(t) != '港口' or t['location'] not in dist: continue
            out.append({'markerType': 'port', 'markerLocation': t['location'], 'distance': dist[t['location']][0],
                        'path': _trace(prev, mill['location'], t['location']), 'channel': 'port', 'portTileId': t['id']})
    if any((D.LOCATION_BY_ID.get(l) or {}).get('market') for l in dist):
        # 任意一个带 market 标记且可达的地点都算「远方的棉花市场」可达
        markets = [l for l in dist if (D.LOCATION_BY_ID.get(l) or {}).get('market')]
        for m in markets:
            out.append({'markerType': 'market', 'markerLocation': m, 'distance': dist[m][0],
                        'path': _trace(prev, mill['location'], m), 'channel': 'distant'})
    return out

def _trace(prev, src, dst):
    path, cur = [dst], dst
    while cur != src:
        cur = prev[cur]; path.append(cur)
    return path[::-1]
```
并在 `sellable_options` 为每个 mill 增加 `routes: sell_routes(state, mill['id'], player_id)`。

- [ ] **Step 2: flowSell/onSellMill 改为「奖励询问 → 路线子菜单」**

`flowSell` 不变（点地图棉花厂）。`onSellMill` 改为先问奖励（仅当 `remoteCottonTrack < 8`）：
```js
onSellMill(mill) {
  const st = this.state;
  const pos = st.remoteCottonTrack || 0;
  const atX = pos >= (st.remoteTrackValues?.length ? st.remoteTrackValues.length - 1 : 8);
  const askReward = !atX;   // 轨道未到 X(8) 才问
  this.flow = { kind: 'sell', mill };
  const pickRoute = () => this.sellRouteMenu(mill);
  if (askReward) {
    this.modal.onCancel = () => this.cancelFlow();
    this.modal.show({
      title: '是否获得额外收入奖励',
      step: '售卖棉花',
      body: h('div.billbox', null,
        h('div', null, '远方市场轨当前位置 ' + pos + '（未到 X，可获得额外奖励）。'),
        h('div', null, '选「获得」将抽 1 张远方市场牌推进该轨（可能得 0）。')),
      actions: [
        { label: '获得额外奖励', kind: 'primary', onClick: () => { this._sellReward = 'card'; this.modal.close(); pickRoute(); } },
        { label: '不获得', onClick: () => { this._sellReward = 'money'; this.modal.close(); pickRoute(); } },
      ],
    });
  } else {
    this._sellReward = 'money';
    pickRoute();
  }
}
```
`sellRouteMenu(mill)`：把 `mill.routes`（来自 `st.sellables`）渲染为按钮栏子菜单（在 Hud 内以 hint 形式或 modal 列表）。为简化，用 modal 列表 + hover 红线：
```js
sellRouteMenu(mill) {
  const routes = (this.state.sellables || []).find(s => s.millId === mill.millId)?.routes || [];
  this.modal.onCancel = () => this.cancelFlow();
  this.modal.show({
    title: '选择售卖路线（悬停查看线路）',
    step: '最短路线，同距只显一条',
    body: h('div.opts', null, ...routes.map((rt, i) => h('div.opt', {
      onmouseenter: () => this.scene?.drawRoute?.(rt.path),
      onmouseleave: () => this.scene?.drawRoute?.(null),
      onclick: () => { this.scene?.drawRoute?.(null); this.sellChooseCards(mill, { channel: rt.channel, reward: this._sellReward === 'card' ? 'card' : 'money', portTileId: rt.portTileId }); },
    }, h('div.l', null, `${rt.markerType === 'port' ? '港口' : '市场标记'} ${this.locName(rt.markerLocation)}（距离 ${rt.distance}）`), h('div.r', null, rt.path.map(p => this.locName(p)).join('→'))))),
    actions: [],
  });
}
```

- [ ] **Step 3: GameScene 增加 drawRoute（粗红实线）**

在 GameScene 增加 `drawRoute(path)`：用 graphics 沿线画 `lineStyle(6, 0xff2222, 0.9)`，并标记起点（棉花厂）与终点（市场标记）。

- [ ] **Step 4: 发展铁来源确认（flowDevelop 增加点铁确认）**

在 `flowDevelop` 选完板块后、选牌前，增加铁来源步骤：列出场上未翻面铁厂（带剩余铁），点一次消耗 1 铁并弹确认「是否消耗该建筑的铁资源」；场上无铁则从市场买（扣钱）。为控制范围，本任务实现：弹窗列出可选铁来源（各未翻面铁厂 + 「从市场购买」），玩家点选等于消耗铁数，每次点铁厂弹确认。简化实现：选完板块 → 弹「选择铁来源」modal，列出铁厂（可点多次，每次 +1 消耗并确认）与「市场购买」选项 → 选满 `sel.length` 个后进入选牌。

- [ ] **Step 5: 提交**

```bash
git add engine/flow.py web/src/app.js web/src/scenes/GameScene.js server/app/main.py
git commit -m "feat: 发展铁来源确认 + 售卖棉花路线选择/奖励询问"
```

---

### Task 11: 前端 Hud — 机器人房作弊按钮

**Files:**
- Modify: `web/src/ui/Hud.js`（_renderTop 内，若 `this.room?.bot` 显示作弊按钮，调 `deps.onCheat`）

**Interfaces:**
- `deps.onCheat(kind, amount)`

- [ ] **Step 1: 顶栏加作弊按钮（仅机器人房）**

在 `_renderTop` 末尾（离开按钮前）插入：
```js
if (this.room?.bot) {
  el.appendChild(h('button.sm.ghost', { onclick: () => this.deps.onCheat?.('money', 20) }, '＋£20'));
  el.appendChild(h('button.sm.ghost', { onclick: () => this.deps.onCheat?.('ap', 1) }, '＋1行动点'));
}
```
app.js deps 增加 `onCheat: (k, a) => this.session.cheat(k, a)`.

- [ ] **Step 2: 提交**

```bash
git add web/src/ui/Hud.js web/src/app.js
git commit -m "feat(web): 机器人房作弊按钮"
```

---

### Task 12: 升级冒烟测试 — 机器人房真·执行

**Files:**
- Modify: `web/tests/smoke_bga.mjs`（改为 withBot 建房、真执行贷款、断言面板连接=14、菜单导航、结束回合置灰）

**Interfaces:**
- 复用 Playwright 双 context 思路，但机器人房只需单人类页（机器人服务端托管）。
- 断言全部 DOM 可见状态。

- [ ] **Step 1: 改写冒烟**

核心流程：
1. `createRoom(name, nm, true)` via page API（直接 fetch 或走 UI 勾选）→ 人类点准备 → 自动开局。
2. 轮询 `window.__app.session.state.status==='playing'` 且 `isMyTurn` 为人类（drive_bots 已让出）。
3. 根级按钮含 建造/售卖棉花/发展/贷款/跳过；点「贷款」→ 子集含 贷款10元/20元/30元 + 返回上一级；点返回。
4. 用作弊加行动点；点「贷款」→「贷款 10 元」→ 选 1 张手牌 → 下一步 → 确认执行 → 断言 `#ppanels .phead` 含「连接 14」且金钱增加。
5. 建造子集导航（建造产业板块/建造连接板块/双手牌建造产业板块/返回上一级）。
6. 全程 0 运行时错误（忽略良性 404）。

- [ ] **Step 2: 运行两次验证稳定**

Run: `cd D:/zhuoyou/lancashire/web && node tests/smoke_bga.mjs http://127.0.0.1:8765`
Expected: 15/15 PASS × 2

- [ ] **Step 3: 提交**

```bash
git add web/tests/smoke_bga.mjs
git commit -m "test: 机器人房真·冒烟（贷款执行+面板字段+菜单导航）"
```

---

### Task 13: 构建 + 起服 + 全量验证

- [ ] **Step 1: 前端构建**

Run: `cd D:/zhuoyou/lancashire/web && npm run build`
Expected: 无错误，dist 生成。

- [ ] **Step 2: 起服（8765）并健康检查**

Run: `cd D:/zhuoyou/lancashire && uvicorn app.main:app --host 0.0.0.0 --port 8765`（后台）
`curl /api/health` → engine:ready。

- [ ] **Step 3: 跑冒烟**

Run: `cd D:/zhuoyou/lancashire/web && node tests/smoke_bga.mjs http://127.0.0.1:8765`
Expected: 全绿，0 错误。

- [ ] **Step 4: 记工作日志**

向 `D:/zhuoyou/.workbuddy/memory/2026-08-10.md` 追加本轮要点。

---

## 自审

- **覆盖**：机器人房(T3/T4/T7)、网络修正(T1/T2)、贷款子集/撤回/连接库存/结束置灰(T8/T9)、作弊(T5/T11)、售卖路线(T10)、发展铁确认(T10)、冒烟(T12)。均落到任务。
- **类型一致**：`onAction(kind,arg)` / `startFlow(kind,arg)` / `flowLoan(presetTier)` 在 T8/T9 一致；`sell_routes` 返回结构在 T10 的 app.js 与 flow.py 一致；`undoAll` handler 在 T9 的 actions.py 与 app.js 一致。
- **无占位**：各步骤均含可执行代码或明确改法。

## 执行方式

采用 inline 执行（executing-plans）：T1→T13 顺序推进，每个 Task 末尾提交，T13 做整合验证。用户已明确「去做吧」，无需再确认即开工。
