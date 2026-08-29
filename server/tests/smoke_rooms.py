# -*- coding: utf-8 -*-
"""房间清理与重连行为冒烟验证。

直接打本地 8765 接口，验证：
  1) 清空后房间列表为空
  2) 最后一人离开 -> 房间被删
  3) 全员掉线（lastSeen 过期）-> 列出时 gc 把房间删掉
"""
import json
import sys
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:8765'

sys.path.insert(0, '.')
from app import db  # noqa: E402

failures = []


def check(name, cond, extra=''):
    print(('PASS' if cond else 'FAIL') + '  ' + name + (('  (' + extra + ')') if extra else ''))
    if not cond:
        failures.append(name)


def get(path):
    with urllib.request.urlopen(BASE + path, timeout=5) as r:
        return json.loads(r.read())


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data,
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read())


# 1) 清空后应为空
rooms_now = get('/api/rooms')['rooms']
check('初始列表为空（已清空历史房间）', len(rooms_now) == 0, 'count=%d' % len(rooms_now))

# 2) 建房 -> 列表含该房 -> 最后一人离开 -> 房间消失
r1 = post('/api/rooms', {'roomName': '', 'playerName': 'smoke1'})
id1 = r1['room']['roomId']
tok1 = r1['token']
listed = get('/api/rooms')['rooms']
check('建房后列表含该房', any(x['roomId'] == id1 for x in listed), id1)

post('/api/rooms/%s/leave' % id1, {'token': tok1})
listed = get('/api/rooms')['rooms']
check('最后一人离开后房间被删', not any(x['roomId'] == id1 for x in listed))

# 3) 全员掉线 -> gc 删除
r2 = post('/api/rooms', {'roomName': '', 'playerName': 'smoke2'})
id2 = r2['room']['roomId']
tok2 = r2['token']
# 直接把该房所有座位的 lastSeen 改成很早，模拟全员掉线
room = db.load_room(id2)
for s in room['seats']:
    s['lastSeen'] = 0
db.save_room(id2, room)
# 触发列表（内部 gc_rooms）
listed = get('/api/rooms')['rooms']
check('全员掉线后房间被 gc 清除', not any(x['roomId'] == id2 for x in listed))

print('\n=== %s ===' % ('ALL PASS' if not failures else ('FAILURES: ' + ', '.join(failures))))
sys.exit(1 if failures else 0)
