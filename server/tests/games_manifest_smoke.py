# -*- coding: utf-8 -*-
# games manifest 契约冒烟（进程内 TestClient）
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
r = c.get('/api/games')
assert r.status_code == 200, r.status_code
games = r.json()['games']
assert len(games) >= 2, '至少 brass + loveletter(coming)，实际 %d' % len(games)

brass = next(g for g in games if g['gameId'] == 'brass')
for k in ['gameId', 'name', 'cover', 'minPlayers', 'maxPlayers', 'duration',
          'weight', 'tagline', 'tags', 'status', 'transition']:
    assert k in brass, 'brass 缺字段 ' + k
assert brass['status'] == 'available', brass['status']
assert brass['cover'].startswith('/games/brass/'), brass['cover']
assert brass['minPlayers'] == 2 and brass['maxPlayers'] == 4
tr = brass['transition']
assert tr['template'] == 'coverPush', tr
assert tr['duration'] > 0 and tr['accent'].startswith('#'), tr

ll = next(g for g in games if g['gameId'] == 'loveletter')
assert ll['status'] == 'coming', ll['status']

print('PASS games manifest (%d games)' % len(games))
