# -*- coding: utf-8 -*-
"""机器人陪练房后端契约测试（打真 HTTP 接口）。

前置：先起服务（默认 http://127.0.0.1:8766）。
用法： python tests/test_bot_room.py [base_url]

覆盖：
  · 创建 withBot 房 → 座位 0 是机器人且已准备、房主权交给人类
  · 人类点准备 → 满员自动开局（无需手动点开始）
  · 机器人回合被服务端自动跳过 → 返回时永远轮到人类
  · 机器人 token 不外泄
  · /cheat 加钱 / 加行动点仅陪练房可用
  · 结束回合后依然回到人类（机器人自动走完）
"""
import json
import sys
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8766').rstrip('/')
RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- %s' % detail) if detail and not cond else ''))


def req(method, path, body=None, expect_error=False):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(BASE + path, data=data, method=method,
                               headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(r, timeout=15) as resp:
            return json.loads(resp.read().decode()), resp.status
    except urllib.error.HTTPError as e:
        if expect_error:
            return json.loads(e.read().decode() or '{}'), e.code
        raise


# ---------- 1. 建房 ----------
res, _ = req('POST', '/api/rooms', {'roomName': '冒烟陪练房', 'playerName': '人类',
                                    'withBot': True})
token = res['token']
room = res['room']
rid = room['roomId']
check('1.1 建房返回 bot 标记', room.get('bot') is True, json.dumps(room, ensure_ascii=False))
check('1.2 座位数 = 2（机器人 + 人类）', len(room['seats']) == 2, str(len(room['seats'])))
check('1.3 座位 0 是机器人且已准备',
      room['seats'][0].get('isBot') and room['seats'][0]['ready'], str(room['seats'][0]))
check('1.4 人类在座位 1 且未准备',
      room['seats'][1]['isMe'] and not room['seats'][1]['ready'], str(room['seats'][1]))
check('1.5 机器人房把开局权交给人类（isHost=True）', room['isHost'] is True)
check('1.6 响应里不含任何 token 字段（除自己的）',
      'token' not in json.dumps(room), json.dumps(room, ensure_ascii=False)[:200])
check('1.7 房间状态仍是 lobby', room['status'] == 'lobby')

# ---------- 2. 准备 → 自动开局 ----------
res, _ = req('POST', '/api/rooms/%s/ready' % rid, {'token': token, 'ready': True})
check('2.1 人类准备后房间自动进入 playing', res['room']['status'] == 'playing',
      res['room']['status'])
st = res.get('state')
check('2.2 ready 响应直接带回对局状态', st is not None)
me = res['room']['myPlayerId']
check('2.3 开局后轮到人类（机器人回合已被自动跳过）',
      st and st['currentPlayer'] == me, 'cur=%s me=%s' % (st and st.get('currentPlayer'), me))
check('2.4 视角里看不到机器人手牌',
      all(not p['hand'] for p in st['players'] if p['id'] != me))

# ---------- 3. 作弊补给 ----------
money0 = next(p['money'] for p in st['players'] if p['id'] == me)
ap0 = st['actionPoints']
res, _ = req('POST', '/api/rooms/%s/cheat' % rid,
             {'token': token, 'money': 50, 'actionPoints': 1})
st = res['state']
money1 = next(p['money'] for p in st['players'] if p['id'] == me)
check('3.1 加钱生效', money1 == money0 + 50, '%d -> %d' % (money0, money1))
check('3.2 加行动点生效', st['actionPoints'] == ap0 + 1, '%d -> %d' % (ap0, st['actionPoints']))
check('3.3 补给后仍是自己的回合', st['currentPlayer'] == me)

# 普通房不允许作弊
res2, _ = req('POST', '/api/rooms', {'roomName': '普通房', 'playerName': '甲'})
r2, code = req('POST', '/api/rooms/%s/cheat' % res2['room']['roomId'],
               {'token': res2['token'], 'money': 10}, expect_error=True)
check('3.4 普通房 /cheat → 403', code == 403, 'code=%s' % code)
req('POST', '/api/rooms/%s/leave' % res2['room']['roomId'], {'token': res2['token']})

# ---------- 4. 行动后机器人自动接管 ----------
# 人类把行动点耗光（跳过），然后结束回合 → 应自动转回人类
guard = 0
while st['actionPoints'] > 0 and guard < 10:
    guard += 1
    hand = next(p['hand'] for p in st['players'] if p['id'] == me)
    res, _ = req('POST', '/api/rooms/%s/action' % rid,
                 {'token': token, 'action': {'type': 'skip', 'cardId': hand[0]}})
    check('4.%d 跳过行动执行成功' % guard, res['result']['ok'], json.dumps(res['result'], ensure_ascii=False))
    st = res['state']

res, _ = req('POST', '/api/rooms/%s/end-turn' % rid, {'token': token})
st = res['state']
check('4.9 结束回合后仍轮到人类（机器人已自动走完）',
      st['currentPlayer'] == me or st.get('gameOver'),
      'cur=%s me=%s' % (st['currentPlayer'], me))
check('4.10 机器人确实动过（日志含跳过或回合推进）',
      any('跳过' in e.get('text', '') for e in st.get('log', [])),
      json.dumps(st.get('log', [])[-4:], ensure_ascii=False))

# ---------- 清理 ----------
req('POST', '/api/rooms/%s/leave' % rid, {'token': token})

passed = sum(1 for _, c in RESULTS if c)
total = len(RESULTS)
print('\n===== 结果: %d/%d 通过 =====' % (passed, total))
if passed < total:
    for name, c in RESULTS:
        if not c:
            print('  FAILED: %s' % name)
    sys.exit(1)
print('全部通过 ✅')
