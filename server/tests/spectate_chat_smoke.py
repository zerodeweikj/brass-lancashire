# -*- coding: utf-8 -*-
"""观战 + 房间聊天 冒烟（进程内 TestClient，不需要起服务）。

覆盖：
  1. 观战鉴权：游客 401；密码房错/对密码；同账号幂等；座位玩家不可观战
  2. 观战视角：所有手牌仅数量（hand=[]）、无合法着法、isMyTurn=False、viewerId=None
  3. 观战者不可行动（action/end-turn 403）
  4. 观众上限 MAX_SPECTATORS=20（直接调 rooms.spectate_room 绕过注册限流）
  5. 聊天：玩家/观众身份与标识、空消息 400、超长 422、无效 token 403、限流 429、rev 广播
  6. 离开观战：spectate/leave 后 state 403；掉线观众被 gc 清理

注意：对局库重定向临时文件；账号库沿用本地 server/auth.db（唯一用户名，结尾注销清理）。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))            # server/tests
SERVER = os.path.dirname(HERE)                                # server/
ROOT = os.path.dirname(SERVER)                                # repo root
sys.path.insert(0, ROOT)
sys.path.insert(0, SERVER)
sys.stdout.reconfigure(encoding='utf-8')

from fastapi.testclient import TestClient  # noqa: E402
from app import db  # noqa: E402

db.DB_PATH = os.path.join(HERE, '_spectate_test.db')
if os.path.exists(db.DB_PATH):
    os.remove(db.DB_PATH)

from app import rooms  # noqa: E402
from app.main import app  # noqa: E402

client = TestClient(app)
ok = True
suffix = f'{int(time.time()) % 100000:05d}'
U_A, U_B, U_C = 'V' + suffix, 'W' + suffix, 'X' + suffix
PW = 'abc123'


def expect(label, cond, extra=''):
    global ok
    if not cond:
        ok = False
    print(f"[{'OK ' if cond else 'BAD'}] {label}" + (f'  -> {extra}' if not cond else ''))


def call(method, path, body=None, token=None):
    headers = {}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if body is not None:
        r = client.request(method, path, json=body, headers=headers)
    else:
        r = client.request(method, path, headers=headers)
    try:
        return r.status_code, r.json()
    except Exception:
        return r.status_code, None


def reg(uname):
    return call('POST', '/api/auth/register', {
        'username': uname, 'password': PW,
        'answers': [
            {'qid': 'q_father', 'answer': '王伟'},
            {'qid': 'q_mother', 'answer': '李娜'},
            {'qid': 'q_school', 'answer': '实验一小'},
        ],
    })


# ---------------- 0. 账号与房间 ----------------
expect('spectate 未登录 401', call('POST', '/api/rooms/AAAAAA/spectate', {})[0] == 401)
rA, rB, rC = reg(U_A), reg(U_B), reg(U_C)
expect(f'register x3', rA[0] == 200 and rB[0] == 200 and rC[0] == 200,
       (rA[0], rB[0], rC[0]))
if not (rA[0] == rB[0] == rC[0] == 200):
    print('\nRESULT: FAIL（注册失败）')
    raise SystemExit(1)
tokA, tokB, tokC = rA[1]['token'], rB[1]['token'], rC[1]['token']

r = call('POST', '/api/rooms', {'roomName': '观战房', 'playerName': 'A'}, token=tokA)
expect('create room1(A)', r[0] == 200)
room1, seatA = r[1]['room']['roomId'], r[1]['token']
r = call('POST', f'/api/rooms/{room1}/join', {'playerName': 'B'}, token=tokB)
expect('join room1(B)', r[0] == 200)
seatB = r[1]['token']
r = call('POST', f'/api/rooms/{room1}/start', {'token': seatA})
expect('start room1', r[0] == 200)

r = call('POST', '/api/rooms', {'roomName': '密码房', 'playerName': 'A2', 'password': 'pw123'},
         token=tokA)
expect('create room2(密码房)', r[0] == 200)
room2 = r[1]['room']['roomId']

# ---------------- 1. 观战鉴权与幂等 ----------------
r = call('POST', f'/api/rooms/{room1}/spectate', {}, token=tokC)
expect('C 观战 room1', r[0] == 200 and r[1]['room'].get('iAmSpectator') is True, r[0])
spec_tok = r[1]['token'] if r[0] == 200 else ''
expect('观众席 1 人（昵称为账号名，注册时归一小写）',
       r[0] == 200 and len(r[1]['room']['spectators']) == 1
       and r[1]['room']['spectators'][0]['name'] == U_C.lower(),
       r[1]['room'].get('spectators') if r[0] == 200 else '')
expect('观众席不含座位 token', all('token' not in sp for sp in (r[1]['room']['spectators'] if r[0] == 200 else [{}])))

r = call('POST', f'/api/rooms/{room1}/spectate', {}, token=tokC)
expect('重复观战幂等（同 token）', r[0] == 200 and r[1]['token'] == spec_tok)

expect('错密码 400', call('POST', f'/api/rooms/{room2}/spectate', {'password': 'bad'}, token=tokC)[0] == 400)
r = call('POST', f'/api/rooms/{room2}/spectate', {'password': 'pw123'}, token=tokC)
expect('对密码 200', r[0] == 200)
spec_tok2 = r[1]['token'] if r[0] == 200 else ''

r = call('POST', f'/api/rooms/{room1}/spectate', {}, token=tokA)
expect('座位玩家不可观战', r[0] == 400, r)

# ---------------- 2. 观战视角 ----------------
r = client.get(f'/api/rooms/{room1}/state?token={spec_tok}&wait=0')
expect('观众 state 200', r.status_code == 200)
v = r.json()
st = v['state']
expect('state 非空（对局进行中）', st is not None)
expect('viewerId=None 且 isMyTurn=False', st['viewerId'] is None and st['isMyTurn'] is False)
expect('所有手牌仅数量（hand=[]）',
       all(p['hand'] == [] and p['handCount'] > 0 for p in st['players']),
       [(p['id'], p.get('handCount')) for p in st['players']])
expect('无合法着法',
       st['legalBuilds'] == [] and st['legalLinks'] == [] and st['selectableCards'] == []
       and st['sellables'] == [] and st['undoAvailable'] is False)
expect('buttonEnabled 全 False', not any((st.get('buttonEnabled') or {}).values()))
expect('抽牌堆内容不外泄', 'drawPile' not in st and 'undoStack' not in st)
expect('room 带观众与聊天字段',
       isinstance(v['room'].get('spectators'), list) and isinstance(v['room'].get('chatMsgs'), list))

r2 = client.get(f'/api/rooms/{room1}/state?token={seatA}&wait=0')
mine = next((p for p in r2.json()['state']['players'] if p['id'] == r2.json()['state']['viewerId']), None)
expect('对照：玩家仍可见自己手牌', mine is not None and len(mine['hand']) > 0)

# ---------------- 3. 观众不可行动 ----------------
expect('观众 action 403', call('POST', f'/api/rooms/{room1}/action',
       {'token': spec_tok, 'action': {'type': 'autoSkip'}})[0] == 403)
expect('观众 end-turn 403', call('POST', f'/api/rooms/{room1}/end-turn', {'token': spec_tok})[0] == 403)

# ---------------- 4. 聊天 ----------------
rev_before = v['rev']
r = call('POST', f'/api/rooms/{room1}/chat', {'token': seatA, 'text': '大家好'})
expect('玩家发言', r[0] == 200, r)
r = call('POST', f'/api/rooms/{room1}/chat', {'token': spec_tok, 'text': '围观中'})
expect('观众发言', r[0] == 200, r)
expect('无效 token 发言 403', call('POST', f'/api/rooms/{room1}/chat', {'token': 'nope', 'text': 'hi'})[0] == 403)
expect('空消息 400', call('POST', f'/api/rooms/{room1}/chat', {'token': seatA, 'text': '  '})[0] == 400)
expect('超长 422', call('POST', f'/api/rooms/{room1}/chat', {'token': seatA, 'text': 'x' * 250})[0] == 422)

r = client.get(f'/api/rooms/{room1}/state?token={seatA}&since={rev_before}&wait=0').json()
expect('发言触发 rev 广播（changed）', r['rev'] != rev_before and r['changed'] is True, r.get('rev'))
msgs = r['room']['chatMsgs']
expect('聊天内容落库（玩家/观众标识）',
       len(msgs) == 2 and msgs[0]['role'] == 'player' and msgs[0]['from'] == 'A'
       and msgs[1]['role'] == 'spectator' and msgs[1]['from'] == U_C.lower(), msgs)

# 限流：chat bucket 8/10s（同 IP 已用 2 条有效+若干失败不计……rate_limit 先计数后校验，故再发 6 条后第 9 条 429）
last = None
for i in range(7):
    last = call('POST', f'/api/rooms/{room1}/chat', {'token': seatA, 'text': f'刷屏{i}'})
expect('聊天限流 429（8 条/10s）', last[0] == 429, last)

# ---------------- 5. 观众上限 20 ----------------
r = call('POST', '/api/rooms', {'roomName': '上限房', 'playerName': 'cap'}, token=tokA)
room3 = r[1]['room']['roomId']
for i in range(rooms.MAX_SPECTATORS):
    fake = {'id': 900000 + i, 'username': 'sp%02d' % i, 'displayName': '观众%02d' % i}
    rm, tk, err = rooms.spectate_room(room3, fake)
    assert err is None, err
expect('满 20 人后第 21 人 400',
       call('POST', f'/api/rooms/{room3}/spectate', {}, token=tokC)[0] == 400)

# ---------------- 6. 离开与 gc ----------------
expect('leave 观战', call('POST', f'/api/rooms/{room1}/spectate/leave', {'token': spec_tok})[0] == 200)
r = client.get(f'/api/rooms/{room1}/state?token={spec_tok}&wait=0')
expect('离开后 state 403', r.status_code == 403, r.status_code)
r = client.get(f'/api/rooms/{room1}/state?token={seatA}&wait=0').json()
expect('离开后观众席清空', r['room']['spectators'] == [])

rm2 = db.load_room(room2)
for sp in rm2['spectators']:
    sp['lastSeen'] = time.time() - rooms.STALE_SECS - 1
db.save_room(room2, rm2)
rooms.gc_rooms()
expect('掉线观众被 gc 清理', db.load_room(room2).get('spectators', None) == [],
       db.load_room(room2).get('spectators'))

# ---------------- 清理 ----------------
for t in (tokA, tokB, tokC):
    call('POST', '/api/auth/delete-account', {'password': PW}, token=t)
try:
    os.remove(db.DB_PATH)
except OSError:
    pass

print(f'\nRESULT: {"PASS" if ok else "FAIL"}   (users: {U_A}, {U_B}, {U_C})')
raise SystemExit(0 if ok else 1)
