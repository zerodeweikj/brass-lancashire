# -*- coding: utf-8 -*-
"""底层机制层。

覆盖：玩家面板（个人板块库）、板块实例查询、翻面与收入轨、
煤/铁的取用（就近免费 → 市场兜底）、资源市场买入/放入换钱。

规则依据：PRD 第 4/5/7 章 + data/industry_tiles.json（数值以 json 为准）。
"""
from . import data as D
from .state import get_player

MIN_POS = 0                       # 收入轨最左格 = 收入数 -10
MAX_POS = D.INCOME_TRACK['max_pos']

IND_KEYS = ['iron', 'coal', 'shipyard', 'port', 'cotton']
IND_CN2KEY = {'铁厂': 'iron', '煤厂': 'coal', '造船厂': 'shipyard', '港口': 'port', '棉花厂': 'cotton'}
IND_KEY2CN = {v: k for k, v in IND_CN2KEY.items()}
SLOT2CN = {'iron': '铁厂', 'coal': '煤厂', 'shipyard': '造船厂', 'port': '港口', 'cotton': '棉花厂'}


# ---------------- 玩家面板（个人板块库） ----------------

def build_mat():
    """按 industry_tiles.json 的 per_player 生成一名玩家的个人板块库。

    结构：{industryKey: {level: 剩余张数}}。
    造船厂 0 级是占位板块：只能「发展」弃掉，不能建造但要在面板上显示，因此进库。
    """
    mat = {k: {} for k in IND_KEYS}
    for t in D.INDUSTRY_TILES:
        if not t.get('per_player'):
            continue
        if t['era'] == '—':
            continue
        if t['level'] == 0 and t['industry'] != '造船厂':
            continue
        key = IND_CN2KEY[t['industry']]
        mat[key][t['level']] = mat[key].get(t['level'], 0) + t['per_player']
    return mat


def mat_lowest(p, key):
    """该产业当前最低可建等级；库空返回 None。"""
    lv = [l for l, c in p['mat'][key].items() if c > 0]
    return min(lv) if lv else None


def mat_count(p, key=None):
    """面板剩余板块数（key 为 None 时统计全部产业）。"""
    if key:
        return sum(p['mat'][key].values())
    return sum(sum(v.values()) for v in p['mat'].values())


def sync_min_build_level(p):
    """由个人板块库派生 minBuildLevel（库空记 99，表示该产业已建完）。"""
    for k in IND_KEYS:
        lo = mat_lowest(p, k)
        p['minBuildLevel'][k] = lo if lo is not None else 99


def mat_take(p, key, level):
    """从面板取走 1 张指定等级板块，并同步最低可建等级。"""
    p['mat'][key][level] -= 1
    sync_min_build_level(p)


def mat_put_back(p, key, level):
    p['mat'][key][level] = p['mat'][key].get(level, 0) + 1
    sync_min_build_level(p)


# ---------------- 板块定义与翻面 ----------------

def tile_def_by_building(building_id, level):
    for t in D.INDUSTRY_TILES:
        if t['building_id'] == building_id and t['level'] == level:
            return t
    return None


def industry_of(tile):
    d = tile_def_by_building(tile['buildingId'], tile['level'])
    return d['industry'] if d else None


def move_income(state, player_id, delta):
    """收入轨移动 delta（正=右移/收入增，负=左退）。夹紧 [0, max_pos]。"""
    p = get_player(state, player_id)
    p['incomePos'] = max(MIN_POS, min(MAX_POS, p['incomePos'] + delta))


def income_of(p):
    return D.income_number(p['incomePos'])


def flip_tile(state, tile):
    """翻面：标记 flipped 并按 flip_income 推进其拥有者的收入轨。"""
    if tile.get('flipped'):
        return
    d = tile_def_by_building(tile['buildingId'], tile['level'])
    tile['flipped'] = True
    if d and d.get('flip_income'):
        move_income(state, tile['owner'], d['flip_income'])


# ---------------- 共享路网与煤源 ----------------

def _shared_adj(state):
    adj = {}
    for p in state['players']:
        for lk in p['linkTiles']:
            a, b = lk['endpoints']
            adj.setdefault(a, set()).add(b)
            adj.setdefault(b, set()).add(a)
    return adj


def _bfs_dist(state, start):
    """共享路网（所有玩家连结板块）从 start 出发的 BFS 距离（含 start=0）。

    start 可为单个地点 id，也可为多个地点（如铁路连结的两个端点，取最近者）。
    """
    adj = _shared_adj(state)
    starts = [start] if isinstance(start, str) else list(start)
    dist = {s: 0 for s in starts}
    queue = list(starts)
    head = 0
    while head < len(queue):
        c = queue[head]
        head += 1
        for nb in sorted(adj.get(c, ())):
            if nb not in dist:
                dist[nb] = dist[c] + 1
                queue.append(nb)
    return dist


def connected_to_market(state, location):
    """location 是否经共享路网连到带市场标记的地点（自身带标记也算）。
    市场标记 = 版图 market 标记 或【任何玩家】的【任意港口板块】（翻面/未翻面都有市场标记属性，
    2026-08-11 用户规定）所在城市（市场标记共用）。"""
    for lid in _bfs_dist(state, location):
        loc = D.LOCATION_BY_ID.get(lid)
        if loc and loc.get('market'):
            return True
        for p in state['players']:
            if any(t['location'] == lid and industry_of(t) == '港口'
                   for t in p['industryTiles']):
                return True
    return False


def coal_sources(state, location):
    """从 location 经共享路网可达、未翻面且板上有煤的煤厂，按距离升序。

    返回 [(tile, dist), ...]；同距离按地点 id 稳定排序，供前端手动选源。
    """
    dist = _bfs_dist(state, location)
    srcs = []
    for p in state['players']:
        for t in p['industryTiles']:
            if t['flipped'] or t.get('boardResources', 0) <= 0:
                continue
            d = tile_def_by_building(t['buildingId'], t['level'])
            if not d or d['produce'] is None or d['produce']['type'] != 'coal':
                continue
            dd = dist.get(t['location'])
            if dd is not None:
                srcs.append((t, dd))
    srcs.sort(key=lambda x: (x[1], x[0]['location'], x[0]['id']))
    return srcs


def coal_available(state, location):
    return sum(t.get('boardResources', 0) for t, _ in coal_sources(state, location))


def iron_sources(state):
    """场上所有未翻面且板上有铁的铁厂（铁无位置限制，任意玩家均可取）。"""
    out = []
    for p in state['players']:
        for t in p['industryTiles']:
            if t['flipped'] or t.get('boardResources', 0) <= 0:
                continue
            d = tile_def_by_building(t['buildingId'], t['level'])
            if not d or d['produce'] is None or d['produce']['type'] != 'iron':
                continue
            out.append(t)
    out.sort(key=lambda t: t['id'])
    return out


def iron_available(state):
    return sum(t.get('boardResources', 0) for t in iron_sources(state))


# ---------------- 资源市场 ----------------

TIERS = (1, 2, 3, 4)
TIER_CAP = 2          # 1~4 钱档各 2 单位
OVERFLOW_PRICE = 5    # 5 钱档视为无限供应


def market_buy_cost(state, resource, amount):
    """预算从市场买 amount 单位的总价（不改状态）。"""
    if amount <= 0:
        return 0
    m = state[resource + 'Market']
    cost, got = 0, 0
    for price in TIERS:
        take = min(m['price%d' % price], amount - got)
        if take > 0:
            cost += take * price
            got += take
        if got >= amount:
            return cost
    return cost + (amount - got) * OVERFLOW_PRICE


def buy_from_market(state, resource, amount, player_id):
    """从最低单价档依次买入 amount 单位；扣钱并计入本轮花销。返回总价。"""
    p = get_player(state, player_id)
    m = state[resource + 'Market']
    cost, got = 0, 0
    for price in TIERS:
        take = min(m['price%d' % price], amount - got)
        if take > 0:
            m['price%d' % price] -= take
            cost += take * price
            got += take
        if got >= amount:
            break
    if got < amount:
        cost += (amount - got) * OVERFLOW_PRICE
    p['money'] -= cost
    p['spentThisRound'] += cost
    state['spentThisRound'][player_id] = state['spentThisRound'].get(player_id, 0) + cost
    return cost


def market_free_slots(state, resource):
    m = state[resource + 'Market']
    return sum(TIER_CAP - m['price%d' % t] for t in TIERS)


def supplement_budget(state, resource, amount):
    """预算：按【最高价优先】把 amount 单位资源放入市场空槽，返回 (可放入数, 可得钱)。只读不改状态。

    2026-08-11 用户规定：建造铁/煤厂后让玩家选择是否补市场；补入按高价档先填
    （如空槽 3/2/2/1/1，补 4 铁 = 3+2+2+1 = 8 钱），留不下多少补多少。
    """
    m = state[resource + 'Market']
    put, gain = 0, 0
    for price in reversed(TIERS):
        space = TIER_CAP - m['price%d' % price]
        take = min(space, amount - put)
        if take > 0:
            put += take
            gain += take * price
        if put >= amount:
            break
    return put, gain


def sell_to_market(state, resource, amount, player_id):
    """把 amount 单位资源放入市场空缺换钱（最高价档优先回填）。返回 (放入数, 收钱)。"""
    p = get_player(state, player_id)
    m = state[resource + 'Market']
    put, gain = 0, 0
    for price in reversed(TIERS):
        space = TIER_CAP - m['price%d' % price]
        take = min(space, amount - put)
        if take > 0:
            m['price%d' % price] += take
            put += take
            gain += take * price
        if put >= amount:
            break
    p['money'] += gain
    return put, gain


# ---------------- 煤/铁的支付（就近免费 → 市场兜底） ----------------

def resource_bill(state, location, coal_need=0, iron_need=0):
    """预算一次建造/修路的资源账单（只读，不改状态）。

    location 为煤源判定基准（可传两个端点的列表）。煤、铁分属两个独立市场，互不影响价格。
    返回 {'ok','reason','coalFree','coalBuy','coalCost','ironFree','ironBuy','ironCost','extraMoney'}
    """
    b = {'ok': True, 'reason': None, 'coalFree': 0, 'coalBuy': 0, 'coalCost': 0,
         'ironFree': 0, 'ironBuy': 0, 'ironCost': 0, 'extraMoney': 0}
    if coal_need > 0:
        free = min(coal_available(state, location), coal_need)
        buy = coal_need - free
        b['coalFree'], b['coalBuy'] = free, buy
        if buy > 0:
            if not connected_to_market(state, location):
                b['ok'] = False
                b['reason'] = 'COAL_NO_MARKET'
            else:
                b['coalCost'] = market_buy_cost(state, 'coal', buy)
    if iron_need > 0:
        free = min(iron_available(state), iron_need)
        buy = iron_need - free
        b['ironFree'], b['ironBuy'] = free, buy
        if buy > 0:
            b['ironCost'] = market_buy_cost(state, 'iron', buy)
    b['extraMoney'] = b['coalCost'] + b['ironCost']
    return b


def total_cost(state, location, cost):
    """板块/连结成本 → 玩家实际需要的总金钱；不可行返回 (None, bill)。"""
    bill = resource_bill(state, location, cost.get('coal', 0), cost.get('iron', 0))
    if not bill['ok']:
        return None, bill
    return (cost.get('money', 0) or 0) + bill['extraMoney'], bill


def can_pay_coal(state, location, amount, player):
    """是否付得起 amount 煤（免费煤源 + 市场兜底，需连市场标记才能买）。"""
    free = min(coal_available(state, location), amount)
    need = amount - free
    if need <= 0:
        return True
    if not connected_to_market(state, location):
        return False
    return player['money'] >= market_buy_cost(state, 'coal', need)


def can_pay_iron(state, amount, player):
    free = min(iron_available(state), amount)
    need = amount - free
    if need <= 0:
        return True
    return player['money'] >= market_buy_cost(state, 'iron', need)


def pay_coal(state, location, amount, player_id, preferred=None):
    """支付煤：优先 preferred 指定的煤厂 id 列表，其余按最近优先；不足则市场买。

    返回 {'free': n, 'bought': n, 'cost': money, 'from': [tileId,...]}
    """
    used, need, from_ids = 0, amount, []
    order = []
    if preferred:
        by_id = {t['id']: (t, d) for t, d in coal_sources(state, location)}
        for tid in preferred:
            if tid in by_id:
                order.append(by_id[tid][0])
    while need > 0:
        tile = None
        if order:
            tile = order[0]
            if tile.get('boardResources', 0) <= 0 or tile.get('flipped'):
                order.pop(0)
                continue
        else:
            srcs = coal_sources(state, location)
            if srcs:
                tile = srcs[0][0]
        if tile is None:
            break
        take = min(tile['boardResources'], need)
        tile['boardResources'] -= take
        used += take
        need -= take
        from_ids.append(tile['id'])
        if tile['boardResources'] <= 0:
            flip_tile(state, tile)
            if order and order[0] is tile:
                order.pop(0)
    cost = buy_from_market(state, 'coal', need, player_id) if need > 0 else 0
    return {'free': used, 'bought': need, 'cost': cost, 'from': from_ids}


def pay_iron(state, amount, player_id, preferred=None):
    """支付铁：铁无位置限制，任意未翻面铁厂免费取；不足则市场买。"""
    used, need, from_ids = 0, amount, []
    order = []
    if preferred:
        by_id = {t['id']: t for t in iron_sources(state)}
        order = [by_id[i] for i in preferred if i in by_id]
    while need > 0:
        tile = None
        if order:
            tile = order[0]
            if tile.get('boardResources', 0) <= 0 or tile.get('flipped'):
                order.pop(0)
                continue
        else:
            srcs = iron_sources(state)
            if srcs:
                tile = srcs[0]
        if tile is None:
            break
        take = min(tile['boardResources'], need)
        tile['boardResources'] -= take
        used += take
        need -= take
        from_ids.append(tile['id'])
        if tile['boardResources'] <= 0:
            flip_tile(state, tile)
            if order and order[0] is tile:
                order.pop(0)
    cost = buy_from_market(state, 'iron', need, player_id) if need > 0 else 0
    return {'free': used, 'bought': need, 'cost': cost, 'from': from_ids}
