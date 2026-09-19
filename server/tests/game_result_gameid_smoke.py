# -*- coding: utf-8 -*-
"""game_results.game_id 契约冒烟（进程内）：
- 终局 _record_results 写入的战绩带房间 gameId
- get_user_stats 的 recent 项回传 gameId
- game_results 表存在 game_id 列（幂等迁移后）
账号库用真实 server/auth.db（唯一用户名，结尾注销清理）。
"""
import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.dirname(HERE)
sys.path.insert(0, SERVER)
sys.stdout.reconfigure(encoding='utf-8')

os.environ.pop('DATABASE_URL', None)
from app import db, auth_db  # noqa: E402
db.DB_PATH = os.path.join(tempfile.mkdtemp(), 't.db')
from fastapi.testclient import TestClient  # noqa: E402
from app.main import app, _record_results  # noqa: E402

c = TestClient(app)
auth_db.init_auth_db()

UN = 'G' + str(int(time.time()))[-5:]
r = c.post('/api/auth/register', json={
    'username': UN, 'password': 'abc12345', 'nickname': '战绩G',
    'answers': [{'qid': 'q_father', 'answer': 'a'},
                {'qid': 'q_mother', 'answer': 'b'},
                {'qid': 'q_school', 'answer': 'c'}]})
assert r.status_code == 200, r.text
uid = r.json()['user']['id']

# 伪造一个带 gameId 的终局房间
room = {
    'roomId': 'T' + str(int(time.time()))[-5:], 'name': 't', 'status': 'playing',
    'gameId': 'brass', 'rev': 1, 'createdAt': time.time(), 'password': '',
    'seats': [{'index': 0, 'token': 'tok1', 'name': 'A', 'color': 'red',
               'playerId': 'P1', 'ready': True, 'userId': uid, 'lastSeen': time.time()}],
}
st = {'gameOver': True, 'ranking': ['P1'], 'scores': {'P1': {'total': 99}},
      'players': [{'id': 'P1'}]}
_record_results(room, st)

stats = auth_db.get_user_stats(uid)
assert stats['total'] == 1, stats
assert stats['recent'][0]['gameId'] == 'brass', stats['recent'][0]

# 直接查表确认列存在
from sqlalchemy import text
with auth_db._get_engine().begin() as conn:
    rows = conn.execute(text('SELECT game_id FROM game_results WHERE user_id = :u'),
                        {'u': uid}).fetchall()
assert rows and rows[0][0] == 'brass', rows

auth_db.delete_user(uid)
print('PASS game_results game_id')
