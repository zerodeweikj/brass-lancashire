# -*- coding: utf-8 -*-
"""游戏状态：初始化 + 派生计算（收入数 / 自有运输网 / 按钮 enabled / 手牌可选集合）

状态为纯 dict，与 schema/game_state.schema.json 对齐，可直接 json.dumps 做 schema 校验。
"""
import copy
from . import data as D

MIN_LINK_TILES = 14
START_MONEY = 30
START_INCOME_POS = 10  # 数值 0 所在格


def new_player(pid, color, hand, money=START_MONEY, income_pos=START_INCOME_POS):
    return {
        'id': pid, 'color': color, 'money': money, 'hand': list(hand),
        'incomePos': income_pos,
        'industryTiles': [],
        'linkTiles': [],
        'remainingLinks': MIN_LINK_TILES,
        'minBuildLevel': {'iron': 1, 'coal': 1, 'shipyard': 0, 'port': 1, 'cotton': 1},
        'spentThisRound': 0,
    }


def normalize_state(state):
    """修复 JSON 往返造成的键类型退化（就地修改并返回同一对象）。

    json.dumps 会把 dict 的 int 键写成字符串，读回来后 `mat` 变成
    {'1': 2} 而不是 {1: 2}，导致 mat_lowest() 返回字符串、tile_def() 查不到定义。
    服务器每次从 SQLite 读状态后必须过一遍本函数（含 undoStack 里的历史快照）。
    """
    if not isinstance(state, dict):
        return state
    for p in state.get('players') or []:
        mat = p.get('mat')
        if isinstance(mat, dict):
            for key, levels in mat.items():
                if isinstance(levels, dict):
                    mat[key] = {int(lv): cnt for lv, cnt in levels.items()}
        mbl = p.get('minBuildLevel')
        if isinstance(mbl, dict):
            p['minBuildLevel'] = {k: int(v) for k, v in mbl.items()}
    for snap in state.get('undoStack') or []:
        normalize_state(snap)
    return state


def create_initial_state(player_specs, game_id='local_test', phase='canal', round_no=2):
    """player_specs: [(pid, color, hand, money), ...]（手牌为 card id 列表）"""
    players = []
    for spec in player_specs:
        pid, color, hand = spec[0], spec[1], spec[2]
        money = spec[3] if len(spec) > 3 else START_MONEY
        players.append(new_player(pid, color, hand, money))
    state = {
        'gameId': game_id,
        'phase': phase,
        'round': round_no,
        'currentPlayer': players[0]['id'],
        'actionPoints': 2,
        'buttonEnabled': {'build': False, 'road': False, 'develop': False, 'sell': False,
                          'loan': False, 'skip': False, 'doubleBuild': False, 'undo': False},
        'selectableCards': [],
        'undoStack': [],
        'turnOrder': [p['id'] for p in players],
        'spentThisRound': {p['id']: 0 for p in players},
        'drawPile': [], 'discardPile': [], 'discardedTiles': [],
        'remoteMarketDeck': {'cards': [], 'drawn': []},
        'remoteCottonTrack': 0,
        'coalMarket': {'price1': 2, 'price2': 2, 'price3': 2, 'price4': 2},
        'ironMarket': {'price1': 2, 'price2': 2, 'price3': 2, 'price4': 2},
        'generalSupply': {'coal': 0, 'iron': 0},
        'scores': {p['id']: {'canal': 0, 'rail': 0, 'total': 0} for p in players},
        'gameOver': False,
        'version': 0,
        'players': players,
    }
    return state


# ---------------- 派生计算 ----------------

def get_player(state, pid):
    for p in state['players']:
        if p['id'] == pid:
            return p
    raise KeyError(pid)


def own_network(state, pid):
    """自有运输网 = 玩家所有工业板块所在地点 ∪ 通过自有连结板块连通的闭包（大纲 4.2）。

    图遍历：从自有工业板块所在地点出发，沿【自己的】连结板块扩展。
    注：建造地点校验用此网；煤消耗/出售的「相连」用全网共享路网（见 shared_network）。
    """
    p = get_player(state, pid)
    nodes = {t['location'] for t in p['industryTiles']}
    adj = {}
    for lk in p['linkTiles']:
        a, b = lk['endpoints']
        adj.setdefault(a, set()).add(b)
        adj.setdefault(b, set()).add(a)
    visited = set(nodes)
    stack = list(nodes)
    while stack:
        cur = stack.pop()
        for nb in adj.get(cur, set()):
            if nb not in visited:
                visited.add(nb)
                stack.append(nb)
    return visited


def shared_network(state, start):
    """全网共享路网连通分量（煤消耗 / 出售「相连」判断用）：所有玩家的连结板块视为自己的。"""
    adj = {}
    for p in state['players']:
        for lk in p['linkTiles']:
            a, b = lk['endpoints']
            adj.setdefault(a, set()).add(b)
            adj.setdefault(b, set()).add(a)
    visited = {start}
    stack = [start]
    while stack:
        cur = stack.pop()
        for nb in adj.get(cur, set()):
            if nb not in visited:
                visited.add(nb)
                stack.append(nb)
    return visited


def _adjacent(state, loc_a, loc_b):
    """两地点在当前时代是否相邻（运河/铁路时代各一份相邻表）"""
    loc = D.LOCATION_BY_ID.get(loc_a)
    if not loc:
        return False
    return loc_b in (loc['canal_adj'] if state['phase'] == 'canal' else loc['rail_adj'])


def min_cost_for_build(state, industry, level):
    """该等级建造成本（金钱部分；煤/铁部分在资源校验处理）"""
    t = D.tile_def(industry, level)
    return t['cost'] if t else {}


# ---------------- 第一层：按钮 enabled（建造 + 基础） ----------------

def compute_buttons(state):
    """服务器在玩家回合开始时计算 8 按钮 enabled（PRD 13.4）。

    本阶段实现建造（build）的完整第一层；road/develop/sell/loan/skip 按公式给出基础判定，
    细节校验留待对应行动落地时补全。
    """
    p = get_player(state, state['currentPlayer'])
    hand = p['hand']
    phase = state['phase']
    money = p['money']
    net = own_network(state, p['id'])
    min_lv = p['minBuildLevel']['coal']

    # ---- 建造（示例产业：煤厂）第一层 ----
    build = False
    if hand:
        industry_cards = {c for c in hand if D.CARD_BY_ID.get(c, {}).get('type') == 'industry'}
        city_cards = {c for c in hand if D.CARD_BY_ID.get(c, {}).get('type') == 'city'}
        has_coal_ind = any(D.CARD_BY_ID.get(c, {}).get('industry') == '煤厂' for c in industry_cards)
        # 运输网内有含煤槽位且未被占的地点 + 手牌有其城市牌
        has_slot = False
        has_city = False
        for loc_id in net:
            loc = D.LOCATION_BY_ID.get(loc_id)
            if not loc or not loc['slots']:
                continue
            if not any('coal' in s for s in loc['slots']):
                continue
            # 运河时代每地点最多 1 板块；铁路时代不限
            occupied = any(t['location'] == loc_id for t in p['industryTiles']) if phase == 'canal' else False
            if occupied:
                continue
            has_slot = True
            if any(D.CARD_BY_ID.get(c, {}).get('city') == loc_id for c in city_cards):
                has_city = True
        # 时代：煤厂 1 级仅运河时代；铁路时代须最低可建等级 ≥2（否则只能建 1 级 → 不可建）
        era_ok = (phase == 'canal') or (min_lv >= 2)
        # 供给：最低可建等级有牌（1~4 级定义存在）
        supply_ok = min_lv <= 4
        # 钱：最低可建等级的最低金钱成本
        tile = D.tile_def('煤厂', min_lv if min_lv >= 1 else 1)
        money_ok = money >= tile['cost'].get('money', 0) if tile else False
        build = has_coal_ind and has_slot and has_city and era_ok and supply_ok and money_ok

    buttons = {
        'build': build,
        'road': len(hand) >= 1,
        'develop': len(hand) >= 1 and p['minBuildLevel']['coal'] <= 4,
        'sell': False,  # 无未翻面连标记棉花厂（后续行动落地）
        'loan': len(hand) >= 1,
        'skip': len(hand) >= 1,
        'doubleBuild': len(hand) >= 2,
        'undo': len(state['undoStack']) > 0,
    }
    return buttons


def compute_selectable_cards(state):
    """当前玩家可选手牌集合（建造场景：可作为城市牌或煤厂产业牌的手牌）"""
    p = get_player(state, state['currentPlayer'])
    out = []
    for c in p['hand']:
        card = D.CARD_BY_ID.get(c)
        if not card:
            continue
        if card['type'] == 'industry' and card['industry'] == '煤厂':
            out.append(c)
        elif card['type'] == 'city':
            loc = D.LOCATION_BY_ID.get(card['city'])
            if loc and any('coal' in s for s in loc['slots']):
                out.append(c)
    return out
