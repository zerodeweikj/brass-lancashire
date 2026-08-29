# -*- coding: utf-8 -*-
"""对局初始化：牌库构建、发牌、回合顺位、远方市场牌库、玩家面板。

规则依据：PRD 第 9 章（牌库与手牌）、7.3（远方市场牌库）、2.1（首轮 1 行动点）。
牌张数可被 data/deck_composition.json 覆盖（便于按官方牌表校准）。
"""
import json
import os
import random

from . import data as D
from . import mechanics as M
from .state import create_initial_state, START_MONEY

COLORS = ['red', 'yellow', 'white', 'purple']
HAND_LIMIT = 8

# 无建筑槽位的特殊地点不发城市牌（PRD 9.1）
SPECIAL_NO_CARD = {'THEMIDLANDS', 'NORTHWICH', 'SOUTHPORT', 'BLACKPOOL', 'SCOTLAND', 'YORKSHIRE'}

# 牌库张数兜底表（权威来源：《兰开夏手牌牌库.xlsx》备注列，另见 data/deck_composition.json）。
# 合计：4人 64 张 / 3人 53 张 / 2人 39 张 —— 对应 PRD 2.1「4/3/2 人各约 8/9/10 轮」。
_CITY_COUNTS = {
    # card_id:               (4人, 3人, 2人)
    'city_manchester':          (4, 4, 4),
    'city_macclesfield':        (2, 2, 2),
    'city_ellesmereport':       (1, 1, 1),
    'city_stockport':           (2, 2, 2),
    'city_birkenhead':          (2, 2, 2),
    'city_liverpool':           (4, 3, 3),
    'city_preston':             (3, 3, 3),
    'city_fleetwood':           (1, 1, 0),
    'city_lancaster':           (3, 2, 0),
    'city_blackburn':           (2, 2, 0),
    'city_barrow-in-furness':   (2, 2, 0),
    'city_bolton':              (2, 2, 2),
    'city_burnley':             (2, 0, 0),
    'city_wigan':               (2, 2, 2),
    'city_bury':                (1, 1, 1),
    'city_colne':               (2, 0, 0),
    'city_rochdale':            (2, 2, 2),
    'city_oldham':              (2, 2, 2),
    'city_warringtonandruncorn': (2, 2, 2),
    'ind_building_001':         (3, 3, 3),   # 铁厂
    'ind_building_002':         (4, 3, 2),   # 煤厂
    'ind_building_003':         (3, 3, 3),   # 造船厂
    'ind_building_004':         (5, 4, 3),   # 港口
    'ind_building_005':         (8, 5, 0),   # 棉花厂
}
_COL = {4: 0, 3: 1, 2: 2}
DEFAULT_DECK = {n: {cid: cnt[_COL[n]] for cid, cnt in _CITY_COUNTS.items() if cnt[_COL[n]]}
                for n in (2, 3, 4)}

# 远方市场牌库构成（PRD 7.3；合计 4人11 / 3人9 / 2人7）
REMOTE_MARKET_COMP = {
    4: {0: 2, -1: 2, -2: 3, -3: 3, -4: 1},
    3: {0: 1, -1: 1, -2: 3, -3: 3, -4: 1},
    2: {0: 0, -1: 1, -2: 2, -3: 3, -4: 1},
}
# 远方的棉花市场轨初始值（PRD 7.2）
# 单一数据源（2026-08-11 用户规定）：从 web/public/data/map_points.json 的
# regions.foreign_market_track 读取 values/end_index（与前端蛇形渲染共用同一份映射）。
# 读取失败（文件缺失/损坏）回退内置默认值，保证引擎仍可启动。
try:
    _FM_TRACK = D.remote_market_track()
    REMOTE_TRACK = [int(v) for v in _FM_TRACK['values']]
    REMOTE_TRACK_END = int(_FM_TRACK['end_index'])
except Exception:  # noqa: BLE001
    REMOTE_TRACK = [3, 3, 2, 2, 1, 1, 0, 0, 0]
    REMOTE_TRACK_END = 8

_DECK_OVERRIDE_PATH = os.path.join(D.DATA_DIR, 'deck_composition.json')


def deck_composition(n):
    """取本人数的牌库构成 {card_id: 张数}；data/deck_composition.json 优先。"""
    if os.path.exists(_DECK_OVERRIDE_PATH):
        with open(_DECK_OVERRIDE_PATH, encoding='utf-8') as f:
            conf = json.load(f).get(str(n)) or {}
        comp = {k: int(v) for k, v in conf.items()
                if not k.startswith('_') and int(v) > 0 and k in D.CARD_BY_ID}
        if comp:
            return comp
    return dict(DEFAULT_DECK[n])


def build_deck(n, rng):
    """构建本时代抽牌堆（含产业牌与城市牌）。"""
    deck = []
    for cid, cnt in sorted(deck_composition(n).items()):
        deck += [cid] * cnt
    rng.shuffle(deck)
    return deck


def build_remote_market_deck(n, rng):
    cards = []
    for v, c in sorted(REMOTE_MARKET_COMP[n].items()):
        cards += [v] * c
    rng.shuffle(cards)
    return cards


def create_game(player_names, phase='canal', seed=None, game_id='local'):
    """创建一局完整初始状态。player_names: 玩家名列表（2~4）。"""
    names = list(player_names)[:4]
    while len(names) < 2:
        names.append('P%d' % (len(names) + 1))
    n = len(names)
    rng = random.Random(seed)

    # 引擎内部固定用 P1..Pn 作为稳定 id，玩家昵称另存 name（可重名、可含中文）
    specs = [('P%d' % (i + 1), COLORS[i], [], START_MONEY) for i in range(n)]
    st = create_initial_state(specs, game_id=game_id, phase=phase, round_no=1)
    for i, p in enumerate(st['players']):
        p['name'] = names[i]
        p['seat'] = i
    st['playerCount'] = n
    st['seed'] = seed
    st['handLimit'] = HAND_LIMIT
    st['roundState'] = 'PLAYING'
    st['inScoring'] = False
    st['gameOver'] = False
    st['log'] = []

    # 市场：1~4 钱档各 2 单位满仓（PRD 7.1）
    st['coalMarket'] = {'price1': 2, 'price2': 2, 'price3': 2, 'price4': 2}
    st['ironMarket'] = {'price1': 2, 'price2': 2, 'price3': 2, 'price4': 2}

    # 远方棉花市场
    st['remoteTrackValues'] = list(REMOTE_TRACK)
    st['remoteTrackEnd'] = REMOTE_TRACK_END
    st['remoteCottonTrack'] = 0
    st['remoteMarketDeck'] = {'cards': build_remote_market_deck(n, rng), 'drawn': []}

    # 玩家面板 + 发牌
    deck = build_deck(n, rng)
    st['drawPile'] = deck
    st['discardPile'] = []
    st['discardedTiles'] = []
    for p in st['players']:
        p['mat'] = M.build_mat()
        M.sync_min_build_level(p)
        p['hand'] = [st['drawPile'].pop() for _ in range(min(HAND_LIMIT, len(st['drawPile'])))]
    st['deckRemaining'] = len(st['drawPile'])

    # 回合顺位：随机
    order = [p['id'] for p in st['players']]
    rng.shuffle(order)
    st['turnOrder'] = order
    st['currentPlayer'] = order[0]
    st['spentThisRound'] = {pid: 0 for pid in order}
    st['actionPoints'] = 1 if phase == 'canal' else 2  # 运河时代首轮每人 1 点
    st['undoStack'] = []
    st['version'] = 0

    from . import flow
    flow.recompute(st)
    return st
