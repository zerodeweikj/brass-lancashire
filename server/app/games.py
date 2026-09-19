# -*- coding: utf-8 -*-
"""游戏清单（games manifest）单一数据源。

平台壳只认这里的清单，不认识任何具体游戏。
新增游戏 = 在 data/games.json 加一条 + 前端放资源目录，平台代码零改动。
"""
import json
import os

_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'games.json'
)


def list_games():
    with open(_PATH, encoding='utf-8') as f:
        return json.load(f)


def get_game(game_id):
    return next((g for g in list_games() if g['gameId'] == game_id), None)
