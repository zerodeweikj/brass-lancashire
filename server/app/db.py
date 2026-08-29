# -*- coding: utf-8 -*-
"""SQLite 存储：对局状态 + 联机房间。

表结构：
  games(game_id TEXT PRIMARY KEY, state_json TEXT, created_at TEXT, updated_at TEXT)
  rooms(room_id TEXT PRIMARY KEY, room_json TEXT, created_at TEXT, updated_at TEXT)
无头服务器为唯一权威（PRD 12.1）：状态整体读改写，客户端只提交行动意图。
"""
import datetime
import json
import os
import sqlite3
import threading

DB_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'lancashire.db')
_lock = threading.RLock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    game_id    TEXT PRIMARY KEY,
    state_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rooms (
    room_id    TEXT PRIMARY KEY,
    room_json  TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _lock:
        conn = _connect()
        try:
            conn.executescript(_SCHEMA)
            conn.commit()
        finally:
            conn.close()


def _save(table, key_col, key, payload):
    now = _now()
    col = 'state_json' if table == 'games' else 'room_json'
    with _lock:
        conn = _connect()
        try:
            conn.execute(
                'INSERT INTO %s(%s, %s, created_at, updated_at) VALUES(?,?,?,?) '
                'ON CONFLICT(%s) DO UPDATE SET %s=excluded.%s, updated_at=excluded.updated_at'
                % (table, key_col, col, key_col, col, col),
                (key, json.dumps(payload, ensure_ascii=False), now, now),
            )
            conn.commit()
        finally:
            conn.close()


def _load(table, key_col, key):
    col = 'state_json' if table == 'games' else 'room_json'
    with _lock:
        conn = _connect()
        try:
            row = conn.execute('SELECT %s AS payload FROM %s WHERE %s=?' % (col, table, key_col),
                               (key,)).fetchone()
            return json.loads(row['payload']) if row else None
        finally:
            conn.close()


def save_game(game_id, state):
    _save('games', 'game_id', game_id, state)


def load_game(game_id):
    return _load('games', 'game_id', game_id)


def save_room(room_id, room):
    _save('rooms', 'room_id', room_id, room)


def load_room(room_id):
    return _load('rooms', 'room_id', room_id)


def delete_room(room_id):
    with _lock:
        conn = _connect()
        try:
            conn.execute('DELETE FROM rooms WHERE room_id=?', (room_id,))
            conn.commit()
        finally:
            conn.close()


def delete_game(game_id):
    """删除某局对局状态（房间被解散且已无人在场时调用）。"""
    with _lock:
        conn = _connect()
        try:
            conn.execute('DELETE FROM games WHERE game_id=?', (game_id,))
            conn.commit()
        finally:
            conn.close()


def list_rooms():
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute('SELECT room_json FROM rooms ORDER BY updated_at DESC').fetchall()
            return [json.loads(r['room_json']) for r in rows]
        finally:
            conn.close()


def list_games():
    with _lock:
        conn = _connect()
        try:
            rows = conn.execute('SELECT game_id, updated_at FROM games ORDER BY updated_at DESC').fetchall()
            return [dict(r) for r in rows]
        finally:
            conn.close()
