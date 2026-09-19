# -*- coding: utf-8 -*-
"""房间 gameId 契约冒烟（进程内 TestClient）：
- 建房默认 gameId='brass'；显式传 brass 也可以
- 传 status!=available 的游戏（loveletter/coming）→ 400
- 传不存在的游戏 → 400
- room_view 与房间列表（public_room）都下发 gameId
"""
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)
sys.stdout.reconfigure(encoding='utf-8')

os.environ.pop('DATABASE_URL', None)
from app import db  # noqa: E402
db.DB_PATH = os.path.join(tempfile.mkdtemp(), 't.db')
from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

c = TestClient(app)

# 默认建房 → brass
r = c.post('/api/rooms', json={'roomName': '默认房', 'playerName': '阿甲'})
assert r.status_code == 200, r.text
room = r.json()['room']
assert room['gameId'] == 'brass', room.get('gameId')
rid = room['roomId']

# 房间列表也下发 gameId
r2 = c.get('/api/rooms')
pub = next(x for x in r2.json()['rooms'] if x['roomId'] == rid)
assert pub['gameId'] == 'brass', pub

# 显式 brass
r3 = c.post('/api/rooms', json={'roomName': '显式房', 'playerName': '阿乙', 'gameId': 'brass'})
assert r3.status_code == 200, r3.text

# coming 状态的游戏不可建房
r4 = c.post('/api/rooms', json={'roomName': '', 'playerName': '阿丙', 'gameId': 'loveletter'})
assert r4.status_code == 400, r4.status_code

# 不存在的游戏
r5 = c.post('/api/rooms', json={'roomName': '', 'playerName': '阿丁', 'gameId': 'xxx'})
assert r5.status_code == 400, r5.status_code

print('PASS room gameId')
