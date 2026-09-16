# -*- coding: utf-8 -*-
"""房间 <-> 账号绑定集成测试（可重复运行）。

要点：
  - 每次运行用「时间戳后缀」生成唯一用户名（3-7 位规则内），避免固定用户名
    二次运行撞 409「用户名已被注册」——原先写死 RoomC3，只有配合
    `rm -f auth.db && uvicorn ...` 才能重跑，很脆弱。
  - 结束前清理自建账号，避免本地库无限堆积。
  - 每个环节都做真断言（原先 ok 恒为 True，等于没断言）。
"""
import json
import time
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:8799'

ok = True
suffix = f'{int(time.time()) % 100000:05d}'   # 5 位数字，配首字母共 6 位
U_A, U_B = 'A' + suffix, 'B' + suffix
PW = 'abc123'


def call(method, path, body=None, token=None):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode())
        except Exception:
            payload = None
        return e.code, payload


def expect(label, res, want):
    """真断言：状态码不在预期内即判失败。"""
    global ok
    wants = (want,) if isinstance(want, int) else tuple(want)
    code = res[0]
    good = code in wants
    if not good:
        ok = False
    brief = json.dumps(res[1], ensure_ascii=False)[:120] if res[1] else ''
    print(f"[{'OK ' if good else 'BAD'}] {label} -> {code} (want {wants}) {brief}")
    return res


# ---------------- 两个账号 ----------------

def reg(uname):
    return call('POST', '/api/auth/register', {
        'username': uname, 'password': PW,
        'answers': [
            {'qid': 'q_father', 'answer': '王伟'},
            {'qid': 'q_mother', 'answer': '李娜'},
            {'qid': 'q_school', 'answer': '实验一小'},
        ],
    })


rA = reg(U_A)
rB = reg(U_B)
expect(f'register({U_A})', rA, 200)
expect(f'register({U_B})', rB, 200)
if rA[0] != 200 or rB[0] != 200:
    print('\nRESULT: FAIL（注册失败，后续跳过）')
    raise SystemExit(1)
tokA, tokB = rA[1]['token'], rB[1]['token']

# ---------------- A 建房（带 auth） ----------------
r = call('POST', '/api/rooms', {'roomName': 'A房', 'playerName': 'A'}, token=tokA)
expect('create(A)', r, 200)
room_id = r[1]['room']['roomId']
room_token_A = r[1]['token']

# recover-room 成功 => 座位已绑 userId
r = call('POST', '/api/auth/recover-room', {'roomId': room_id}, token=tokA)
expect('recover-room(A)', r, 200)
if r[0] == 200:
    got = r[1].get('token')
    expect('recover-room(A) 返回同一房令牌', (200, {'token': got}), 200)
    if got != room_token_A:
        ok = False
        print('[BAD] 房令牌不一致')

# A 重复入同一房 -> 400 防重复占座
r = call('POST', '/api/rooms/' + room_id + '/join', {'playerName': 'A2'}, token=tokA)
expect('join-dup(A) 防重复占座', r, 400)

# B 入房（带 auth）
r = call('POST', '/api/rooms/' + room_id + '/join', {'playerName': 'B'}, token=tokB)
expect('join(B)', r, 200)
room_token_B = r[1].get('token') if r[0] == 200 else None

r = call('POST', '/api/auth/recover-room', {'roomId': room_id}, token=tokB)
expect('recover-room(B)', r, 200)

# ---------------- 游客建房再登录绑定 ----------------
r = call('POST', '/api/rooms', {'roomName': '游客房', 'playerName': 'guest'})   # 无 auth
expect('create(guest)', r, 200)
g_room = r[1]['room']['roomId']
g_token = r[1]['token']

# 游客 recover-room -> 401（未登录）
expect('recover-room(guest,noauth)', call('POST', '/api/auth/recover-room', {'roomId': g_room}), 401)

# 用 A 登录后绑定该游客座位
r = call('POST', '/api/auth/bind-room', {'roomId': g_room, 'roomToken': g_token}, token=tokA)
expect('bind-room(A)', r, 200)
expect('recover-room(A)after-bind',
       call('POST', '/api/auth/recover-room', {'roomId': g_room}, token=tokA), 200)

# 无效房令牌绑定 -> 403
expect('bind-room(bad token)',
       call('POST', '/api/auth/bind-room', {'roomId': g_room, 'roomToken': 'bogus'}, token=tokA), 403)

# ---------------- 删号 B：座位保留但 userId 清空 ----------------
expect('delete(B)', call('POST', '/api/auth/delete-account', {'password': PW}, token=tokB), 200)
# B 的会话随账号删除而失效 -> 401（若房间已不存在才是 404）
expect('recover-room(B)after-del',
       call('POST', '/api/auth/recover-room', {'roomId': room_id}, token=tokB), (401, 404))

# A 仍在房，且座位没有被删掉（删号只解绑不移除座位）
r = call('POST', '/api/auth/recover-room', {'roomId': room_id}, token=tokA)
expect('recover-room(A)still', r, 200)
if r[0] == 200:
    seats = r[1].get('room', {}).get('seats') or []
    print(f"     A 房座位数 = {len(seats)}（期望 2：B 的座位应保留）")
    if len(seats) != 2:
        ok = False
        print('[BAD] 删号后座位数不对')

# ---------------- 清理 ----------------
expect('cleanup(A)', call('POST', '/api/auth/delete-account', {'password': PW}, token=tokA), 200)

print(f'\nRESULT: {"PASS" if ok else "FAIL"}   (users: {U_A}, {U_B})')
raise SystemExit(0 if ok else 1)
