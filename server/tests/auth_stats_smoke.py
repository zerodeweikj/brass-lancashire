# -*- coding: utf-8 -*-
"""战绩统计 + 房间头像注入 冒烟（进程内 TestClient，不需要起服务）。

覆盖：
  1. /api/auth/me/stats 鉴权（未登录 401）与新账号空态
  2. 房间视图注入登录玩家头像（room_view seats / public_room players / 机器人空头像）
  3. 终局写战绩：伪造终局态调 _record_results，验证 rank/score/player_count 落库与幂等
  4. restart 重置 resultsRecorded（重开新局可再记）
  5. 删号级联清战绩

注意：对局库重定向到临时文件（不碰真实 lancashire.db）；
账号库沿用本地 server/auth.db（测试账号唯一命名，结束时注销清理）。
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

# 测试用独立对局库，避免污染真实对局
db.DB_PATH = os.path.join(HERE, '_stats_test.db')
if os.path.exists(db.DB_PATH):
    os.remove(db.DB_PATH)

from app import auth_db  # noqa: E402
from app.main import app, _record_results  # noqa: E402

client = TestClient(app)
ok = True
suffix = f'{int(time.time()) % 100000:05d}'
U_A, U_B = 'S' + suffix, 'T' + suffix
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


# ---------------- 1. stats 鉴权 + 空态 ----------------
expect('stats 未登录 401', call('GET', '/api/auth/me/stats')[0] == 401)
rA, rB = reg(U_A), reg(U_B)
expect(f'register({U_A})', rA[0] == 200)
expect(f'register({U_B})', rB[0] == 200)
if rA[0] != 200 or rB[0] != 200:
    print('\nRESULT: FAIL（注册失败）')
    raise SystemExit(1)
tokA, tokB = rA[1]['token'], rB[1]['token']
uidA, uidB = rA[1]['user']['id'], rB[1]['user']['id']

st = call('GET', '/api/auth/me/stats', token=tokA)
expect('stats 新账号空态', st[0] == 200 and st[1]['total'] == 0 and st[1]['recent'] == [], st)

# ---------------- 2. 房间视图注入头像 ----------------
r = call('PUT', '/api/auth/me', {'displayName': '统计君', 'avatar': '🐼'}, token=tokA)
expect('改资料设头像', r[0] == 200 and r[1]['user']['avatar'] == '🐼')

r = call('POST', '/api/rooms', {'roomName': '战绩房', 'playerName': 'A'}, token=tokA)
expect('create(A)', r[0] == 200)
room_id = r[1]['room']['roomId']
room_token_A = r[1]['token']
expect('登录玩家座位带账号头像', r[1]['room']['seats'][0].get('avatar') == '🐼',
       r[1]['room']['seats'][0])

r = call('GET', '/api/rooms')
mine = next((rm for rm in r[1]['rooms'] if rm['roomId'] == room_id), None)
expect('大厅列表同样带头像', bool(mine) and mine['players'][0].get('avatar') == '🐼')

r = call('POST', '/api/rooms', {'roomName': '游客房', 'playerName': 'guest'})
expect('游客座位头像为空', r[0] == 200 and r[1]['room']['seats'][0].get('avatar') == '')

r = call('POST', '/api/rooms', {'roomName': '陪练房', 'playerName': 'me', 'withBot': True}, token=tokB)
bot_seats = r[1]['room']['seats'] if r[0] == 200 else []
expect('机器人座位头像为空（前端兜底 🤖）',
       r[0] == 200 and bot_seats[0].get('isBot') and bot_seats[0].get('avatar') == '')

# ---------------- 3. 终局写战绩（伪造终局态） ----------------
r = call('POST', f'/api/rooms/{room_id}/join', {'playerName': 'B'}, token=tokB)
expect('join(B)', r[0] == 200)
r = call('POST', f'/api/rooms/{room_id}/start', {'token': room_token_A})
expect('start(A)', r[0] == 200)

room = db.load_room(room_id)
st = db.load_game(room['gameId'])
st['gameOver'] = True
st['ranking'] = ['P2', 'P1']                       # B 胜
st['scores'] = {'P1': {'total': 100}, 'P2': {'total': 130}}
db.save_game(room['gameId'], st)

_record_results(room, st)
db.save_room(room_id, room)

stA = call('GET', '/api/auth/me/stats', token=tokA)
rec = stA[1]['recent'][0] if stA[1]['recent'] else {}
expect('A 战绩落库（第2名/100分/2人）',
       stA[1]['total'] == 1 and rec.get('rank') == 2 and rec.get('score') == 100
       and rec.get('playerCount') == 2 and rec.get('won') is False, stA[1])
stB = call('GET', '/api/auth/me/stats', token=tokB)
recB = stB[1]['recent'][0] if stB[1]['recent'] else {}
expect('B 战绩落库（第1名/130分/胜）',
       stB[1]['total'] == 1 and recB.get('rank') == 1 and recB.get('score') == 130
       and recB.get('won') is True and stB[1]['wins'] == 1 and stB[1]['winRate'] == 100.0, stB[1])
expect('B 平均名次 1.0', stB[1]['avgRank'] == 1.0, stB[1])
expect('B 最高分 130', stB[1]['bestScore'] == 130, stB[1])

# 幂等：同局重复调用不重复记
_record_results(room, st)
stA2 = call('GET', '/api/auth/me/stats', token=tokA)
expect('同局重复结算不重复记', stA2[1]['total'] == 1, stA2[1])

# ---------------- 4. restart 重置标志 ----------------
r = call('POST', f'/api/rooms/{room_id}/restart', {'token': room_token_A})
expect('restart', r[0] == 200)
room2 = db.load_room(room_id)
expect('restart 重置 resultsRecorded', not room2.get('resultsRecorded'), room2.get('resultsRecorded'))

# ---------------- 5. 删号级联清战绩 ----------------
expect('delete(B)', call('POST', '/api/auth/delete-account', {'password': PW}, token=tokB)[0] == 200)
expect('删号级联清战绩', auth_db.get_user_stats(uidB)['total'] == 0)
expect('清理(A)', call('POST', '/api/auth/delete-account', {'password': PW}, token=tokA)[0] == 200)

# 清理临时对局库
try:
    os.remove(db.DB_PATH)
except OSError:
    pass

print(f'\nRESULT: {"PASS" if ok else "FAIL"}   (users: {U_A}, {U_B})')
raise SystemExit(0 if ok else 1)
