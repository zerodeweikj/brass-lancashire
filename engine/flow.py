# -*- coding: utf-8 -*-
"""回合 / 轮次 / 时代流转、收入结算、计分、按钮重算（服务端权威）。

规则依据：PRD 2.1/2.2（回合与时代）、5.1（收入数决定每小轮金钱增减）、
8.1~8.3（计分与平局）、13.4/13.7（按钮 enabled 公式）。
"""
import random

from . import data as D
from . import mechanics as M
from .state import get_player, own_network

HAND_LIMIT = 8
LINK_TILES_PER_PLAYER = 14

# 连结成本（PRD 6.6 / 5.2）：运河 +3 钱；铁路×1 = +5 钱 +1 煤；铁路×2 = +15 钱 +2 煤
LINK_COST = {
    'canal': {'money': 3, 'coal': 0},
    'rail': {'money': 5, 'coal': 1},
    'rail2': {'money': 15, 'coal': 2},
}


def log(state, text):
    state.setdefault('log', []).append({'round': state['round'], 'phase': state['phase'], 'text': text})
    state['log'] = state['log'][-200:]


# ---------------- 第一层谓词（PRD 13.7） ----------------

def _slot_industries(loc):
    out = set()
    for slot in loc.get('slots') or []:
        for s in slot:
            if s in M.SLOT2CN:
                out.add(M.SLOT2CN[s])
    return out


def buildable_level(state, p, industry_cn):
    """该玩家此刻可建的等级（面板最低等级，且符合时代）；不可建返回 None。

    资格判定统一交给 D.tile_buildable()，与 do_build / validate_build 同源，
    避免地图高亮与实际校验结论不一致（曾因此让 0 级造船厂占位块可被建造）。
    """
    key = M.IND_CN2KEY[industry_cn]
    lv = M.mat_lowest(p, key)
    if lv is None:
        return None
    ok, _code, _msg = D.tile_buildable(D.tile_def(industry_cn, lv), state['phase'])
    return lv if ok else None


def slot_free(state, location, slot_index):
    """该地点该槽位是否空闲。"""
    for pl in state['players']:
        for t in pl['industryTiles']:
            if t['location'] == location and t.get('slotIndex') == slot_index:
                return False
    return True


def allowed_slots(state, loc_id, industry_cn):
    """该产业在此地点的合法落位槽位号列表。

    官方补充规则（《兰开夏手牌牌库.xlsx》表尾）：若存在「仅限该建筑种类」的空槽位，
    必须优先占用它；否则才可放进兼容多种建筑的空槽位；两者皆无则该地点不可建此产业。
    """
    loc = D.LOCATION_BY_ID.get(loc_id)
    if not loc or not loc.get('slots'):
        return []
    key = M.IND_CN2KEY.get(industry_cn)
    free = [i for i, slot in enumerate(loc['slots'])
            if key in slot and slot_free(state, loc_id, i)]
    dedicated = [i for i in free if len(loc['slots'][i]) == 1]
    return dedicated or free


def legal_build_targets(state, player_id=None, ignore_network=False):
    """列出当前玩家所有合法建造落点。

    返回 [{'location','slotIndex','industry','level','cost'}...]
    ignore_network=True 用于双牌建造 / 地点牌突破运输网限制（PRD 3.2）。
    """
    p = get_player(state, player_id or state['currentPlayer'])
    net = own_network(state, p['id'])
    first_build = not p['industryTiles'] and not p['linkTiles']
    free_net = bool(ignore_network or first_build)
    # 城市牌驱动：地点由牌面锁定，不查运输网 —— 手上每张城市牌都额外解锁其所属城市（PRD 3.2）
    city_card_locs = set()
    if not free_net:
        for cid in p['hand']:
            c = D.CARD_BY_ID.get(cid)
            if c and c.get('type') == 'city' and c.get('city'):
                city_card_locs.add(c['city'])
    out = []
    for loc in D.LOCATIONS:
        loc_id = loc['id']
        if not loc.get('slots'):
            continue
        if loc.get('rail_only') and state['phase'] != 'rail':
            continue
        # 位置：自有运输网内 / 首建 / 双牌 / 手上持有该城市牌
        net_ok = free_net or loc_id in net
        if not (net_ok or loc_id in city_card_locs):
            continue
        # 运河时代每地点每人最多 1 个工业板块
        if state['phase'] == 'canal' and any(t['location'] == loc_id for t in p['industryTiles']):
            continue
        for ind in sorted(_slot_industries(loc)):
            lv = buildable_level(state, p, ind)
            if lv is None:
                continue
            td = D.tile_def(ind, lv)
            cost = td['cost'] or {}
            # 总价必须含「从市场补买煤/铁」的钱，否则前端高亮的落点会付不起（PRD 14.3 S4 预览消耗）
            total, bill = M.total_cost(state, loc_id, cost)
            if total is None or p['money'] < total:
                continue
            for idx in allowed_slots(state, loc_id, ind):
                out.append({'location': loc_id, 'slotIndex': idx, 'industry': ind,
                            'level': lv, 'cost': cost, 'totalMoney': total, 'bill': bill,
                            # netOk=False 表示此落点只能由该城市牌驱动（产业牌会被后端拒绝）
                            'netOk': bool(net_ok)})
    return out


def market_locations(state):
    """有市场标记的地点（2026-08-11 用户规定，市场标记共用）：
    ① 版图自带 market 标记的城市；② 任何玩家的【任意港口板块】所在城市（翻面/未翻面都有市场标记属性）。"""
    out = set()
    for loc in D.LOCATIONS:
        if loc.get('market'):
            out.add(loc['id'])
    for p in state['players']:
        for t in p['industryTiles']:
            if M.industry_of(t) == '港口':
                out.add(t['location'])
    return out


def legal_link_targets(state, player_id=None):
    """列出合法连结位置 [{'from','to','type','money','coal'}...]。"""
    p = get_player(state, player_id or state['currentPlayer'])
    net = own_network(state, p['id'])
    if p['remainingLinks'] <= 0:
        return []
    existing = set()
    for pl in state['players']:
        for lk in pl['linkTiles']:
            existing.add(frozenset(lk['endpoints']))
    out = []
    seen = set()
    # 连结只能建在自有运输网内城市的相邻空连结槽；
    # 玩家尚无任何运输网时：运河任意地点（首建惯例）；铁路时代从【有市场标记的城市】起步
    # （自带 market 标记 或 任何玩家的港口板块所在城市——市场标记共用，2026-08-11 用户规定）
    if net:
        scan = sorted(net)
    elif state['phase'] == 'rail':
        scan = sorted(market_locations(state))
    else:
        scan = [l['id'] for l in D.LOCATIONS]
    for loc_id in scan:
        loc = D.LOCATION_BY_ID.get(loc_id)
        if not loc:
            continue
        adj = loc['canal_adj'] if state['phase'] == 'canal' else loc['rail_adj']
        for nb in adj:
            key = frozenset((loc_id, nb))
            if key in existing or key in seen:
                continue
            nbl = D.LOCATION_BY_ID.get(nb)
            if not nbl:
                continue
            if state['phase'] == 'canal' and (loc.get('rail_only') or nbl.get('rail_only')):
                continue
            seen.add(key)
            if state['phase'] == 'canal':
                if p['money'] < LINK_COST['canal']['money']:
                    continue
                out.append({'from': loc_id, 'to': nb, 'type': 'canal', 'money': 3, 'coal': 0,
                            'totalMoney': 3, 'bill': None})
                continue
            # 铁路：煤可取自连结任一端所在的共享路网（PRD 14.4 S3 同 14.3）
            total, bill = M.total_cost(state, [loc_id, nb], LINK_COST['rail'])
            if total is None or p['money'] < total:
                continue
            out.append({'from': loc_id, 'to': nb, 'type': 'rail', 'money': 5, 'coal': 1,
                        'totalMoney': total, 'bill': bill})
    return out


def exists_valid_build(state):
    return bool(legal_build_targets(state))


def exists_valid_link(state):
    return bool(legal_link_targets(state))


def afford_link(state):
    """legal_link_targets 已内置成本过滤，这里只需判断是否还有可选项。"""
    return bool(legal_link_targets(state))


def has_discardable_low_tile(state):
    """发展前提：面板仍有板块，且铁来源成立（PRD 6.4/13.4）。"""
    p = get_player(state, state['currentPlayer'])
    if M.mat_count(p) <= 0:
        return False
    return M.iron_available(state) > 0 or p['money'] >= M.market_buy_cost(state, 'iron', 1)


def sellable_mills(state, player_id=None):
    """未翻面且经共享路网与市场标记相连的棉花厂。"""
    p = get_player(state, player_id or state['currentPlayer'])
    out = []
    for t in p['industryTiles']:
        if t['flipped'] or M.industry_of(t) != '棉花厂':
            continue
        if M.connected_to_market(state, t['location']):
            out.append(t)
    return out


def has_connected_cotton_mill(state):
    return bool(sellable_mills(state))


def loan_allowed(state):
    p = get_player(state, state['currentPlayer'])
    if M.income_of(p) <= -10:
        return False
    if state['phase'] == 'rail' and state['deckRemaining'] <= 2 * len(state['players']):
        return False
    return True


def recompute(state):
    """服务端计算 8 按钮 enabled + 手牌可选集合（PRD 13.7）。"""
    if state.get('gameOver'):
        state['buttonEnabled'] = {k: False for k in
                                  ('build', 'road', 'develop', 'sell', 'loan', 'skip', 'doubleBuild', 'undo')}
        state['selectableCards'] = []
        return state['buttonEnabled']
    if state.get('pendingForeclose'):
        # 强制拆板抵债期间：只允许点击地图板块，禁用一切常规行动按钮
        state['buttonEnabled'] = {k: False for k in
                                  ('build', 'road', 'develop', 'sell', 'loan', 'skip', 'doubleBuild', 'undo')}
        state['selectableCards'] = []
        return state['buttonEnabled']
    p = get_player(state, state['currentPlayer'])
    hand = len(p['hand'])
    cur = (state.get('roundState') == 'PLAYING' and not state.get('inScoring')
           and state.get('actionPoints', 0) > 0)
    can_build = cur and exists_valid_build(state)
    out = {
        'build': bool(cur and hand >= 1 and can_build),
        'road': bool(cur and hand >= 1 and exists_valid_link(state) and afford_link(state)),
        'develop': bool(cur and hand >= 1 and has_discardable_low_tile(state)),
        'sell': bool(cur and hand >= 1 and has_connected_cotton_mill(state)),
        'loan': bool(cur and hand >= 1 and loan_allowed(state)),
        'skip': bool(cur and hand >= 1),
        'doubleBuild': bool(cur and hand >= 2 and state.get('actionPoints', 0) >= 2 and can_build),
        'undo': bool(state.get('roundState') == 'PLAYING' and not state.get('inScoring')
                     and len(state.get('undoStack', [])) > 0),
    }
    state['buttonEnabled'] = out
    state['selectableCards'] = list(p['hand'])   # 六行动均可用任意手牌驱动（建造另有牌型校验）
    state['legalBuilds'] = legal_build_targets(state)
    # 双牌建造可突破运输网限制（PRD 3.2 / 6.5），落点集合与普通建造不同，单独下发
    state['legalDoubleBuilds'] = (legal_build_targets(state, ignore_network=True)
                                  if out['doubleBuild'] else [])
    state['legalLinks'] = legal_link_targets(state)
    state['sellables'] = sellable_options(state)
    # 远方的棉花市场轨：位置到达末位 X 时不再询问「是否获得额外收入奖励」
    track = state.get('remoteTrackValues') or []
    pos = state.get('remoteCottonTrack', 0)
    state['remoteTrackEnd'] = max(0, len(track) - 1)
    state['remoteBonusAvailable'] = bool(
        track and pos < len(track) - 1 and (state.get('remoteMarketDeck') or {}).get('cards'))
    # 发展用：场上可取的铁（未翻面铁厂），以及从市场买 1 铁的价格
    state['ironSources'] = [{'tileId': t['id'], 'location': t['location'], 'owner': t['owner'],
                             'level': t['level'], 'remaining': t['boardResources']}
                            for t in M.iron_sources(state)]
    # 修路用：场上可取煤（未翻面煤厂）；pay_coal 会按道路端点城市就近过滤
    coal_tiles = []
    for _p in state['players']:
        for _t in _p.get('industryTiles', []):
            if _t.get('resourceType') == 'coal' and not _t.get('flipped') and _t.get('boardResources', 0) > 0:
                coal_tiles.append({'tileId': _t['id'], 'location': _t['location'],
                                   'owner': _t['owner'], 'level': _t['level'],
                                   'remaining': _t['boardResources']})
    state['coalSources'] = coal_tiles
    state['ironBuyPrice1'] = M.market_buy_cost(state, 'iron', 1)
    return out


def _shortest_paths(state, start):
    """共享路网 BFS，返回 {loc_id: [start, ..., loc_id]}。

    同距分岔只保留先入队的一条 —— 前端「选择路线」列表因此每个目的地只出现一条。
    """
    adj = M._shared_adj(state)
    paths = {start: [start]}
    queue = [start]
    head = 0
    while head < len(queue):
        cur = queue[head]
        head += 1
        for nb in sorted(adj.get(cur, ())):
            if nb not in paths:
                paths[nb] = paths[cur] + [nb]
                queue.append(nb)
    return paths


def sell_routes(state, mill, player_id=None):
    """某棉花厂可选的售卖路线（官方 2026-08-11 规则书）。

    远方市场路线：棉花厂连到任意市场标记（城市 market / 任意玩家港口）且市场轨未到 X、
    远方市场牌库非空 → 单条「卖到远方市场」路线（收入=抽牌后落点数值，港口不翻面）。
    港口路线：每个可达的未翻面港口一条（翻该港口 + 港口拥有者得翻面奖励）。
    返回 [{'key','kind','channel','portTileId','to','toName','distance','path','label'}...]
    kind: 'market'（远方市场） | 'port'（港口板块）
    """
    paths = _shortest_paths(state, mill['location'])
    out = []
    track = state.get('remoteTrackValues') or []
    deck = state.get('remoteMarketDeck') or {}
    pos = state.get('remoteCottonTrack', 0)
    distant_ok = (M.connected_to_market(state, mill['location'])
                  and deck.get('cards') and pos < max(0, len(track) - 1))
    if distant_ok:
        # 显示路径：最近的市场标记（城市市场或任意港口所在地）
        conn = None
        for lid, path in paths.items():
            loc = D.LOCATION_BY_ID.get(lid)
            is_market = bool(loc and loc.get('market'))
            has_port = any(t['location'] == lid and M.industry_of(t) == '港口'
                           for pl in state['players'] for t in pl['industryTiles'])
            if is_market or has_port:
                conn = (lid, path)
                break
        out.append({'key': 'distant', 'kind': 'market', 'channel': 'distant',
                    'portTileId': None, 'to': conn[0] if conn else '',
                    'toName': '远方的棉花市场',
                    'distance': (len(conn[1]) - 1) if conn else 0,
                    'path': conn[1] if conn else [],
                    'label': '卖到远方市场（抽牌推进市场轨得收入）'})
    for pl in state['players']:
        for t in pl['industryTiles']:
            if t['flipped'] or M.industry_of(t) != '港口':
                continue
            path = paths.get(t['location'])
            if path is None:
                continue
            loc = D.LOCATION_BY_ID.get(t['location']) or {}
            out.append({'key': 'port:%s' % t['id'], 'kind': 'port', 'channel': 'port',
                        'portTileId': t['id'], 'to': t['location'],
                        'toName': loc.get('name') or t['location'],
                        'distance': len(path) - 1, 'path': path,
                        'label': '卖到 %s 的 %d 级港口（%s）'
                                 % (loc.get('name') or t['location'], t['level'], t['owner'])})
    out.sort(key=lambda r: (r['distance'], r['key']))
    return out


def sellable_options(state, player_id=None):
    """可出售棉花厂 + 各自可用渠道，供前端直接渲染选择项（PRD 6.7 S2）。"""
    from . import actions as _A       # 延迟导入，避免模块级循环依赖
    out = []
    for mill in sellable_mills(state, player_id):
        distant, ports = _A._sale_channels(state, mill)
        routes = sell_routes(state, mill, player_id)
        out.append({
            'millId': mill['id'], 'location': mill['location'], 'level': mill['level'],
            'distant': bool(distant),
            'distantRoute': bool(next((r for r in routes if r['channel'] == 'distant'), None)),
            'ports': [{'tileId': t['id'], 'location': t['location'], 'owner': t['owner'],
                       'level': t['level']} for t in ports],
            # 「选择路线」子菜单直接用它渲染：远方市场单条 + 每条可达未翻面港口一条
            'routes': routes,
        })
    return out


# ---------------- 回合 / 轮次 / 时代 ----------------

def refill(state, p):
    limit = state.get('handLimit', HAND_LIMIT)
    while len(p['hand']) < limit and state['drawPile']:
        p['hand'].append(state['drawPile'].pop())
    state['deckRemaining'] = len(state['drawPile'])


def recompute_total(state, pid):
    """重算某玩家总分 = 运河 + 铁路 - 扣分（扣分后置，分数标记随之后退）。下限 0。"""
    sc = state['scores'][pid]
    sc['total'] = max(0, sc.get('canal', 0) + sc.get('rail', 0) - sc.get('penalty', 0))


def settle_debt_by_score(state, pid, remaining):
    """步骤 3：无板块可拆时，按 1 分 = 1 钱 扣分抵债。

    返回清偿后剩余债务（0 表示还清或一笔勾销）。分数扣到 0 仍不足 → 标记 forecloseForgiven。
    """
    if remaining <= 0:
        return 0
    sc = state['scores'][pid]
    T = max(0, sc.get('total', 0))
    deduct = min(remaining, T)
    sc['penalty'] = sc.get('penalty', 0) + deduct
    recompute_total(state, pid)          # total 下降 → 前端分数标记自动后退
    remaining -= deduct
    if remaining > 0:
        state['forecloseForgiven'] = {'pid': pid}
        log(state, '%s 分数已扣至 0 仍不足以抵债，债务一笔勾销' % pid)
    else:
        log(state, '%s 以 %d 分抵债，剩余债务结清' % (pid, deduct))
    return remaining


def settle_round_income(state):
    """轮末收入结算：每人按收入数增减金钱；不足支付则挂起 pendingForeclose 强制拆板抵债。

    返回挂起的欠债玩家 pid（需前端 do_foreclose_tile 处理），或 None（全部结算完毕）。
    incomeDone 记录已结算玩家，便于拆板后从断点续结算其余玩家（避免重复扣钱）。
    """
    done = state.setdefault('incomeDone', [])
    # 新一轮结算开始：清除上一轮残留的「算你好彩」弹窗标记
    if not done:
        state.pop('forecloseForgiven', None)
    for pid in state['turnOrder']:
        if pid in done:
            continue
        p = get_player(state, pid)
        inc = M.income_of(p)
        if inc >= 0:
            p['money'] += inc
            if inc:
                log(state, '%s 收入结算 +%d 钱' % (pid, inc))
            done.append(pid)
            continue
        # 收入为负：先付出现金，再对差额（欠款）处理
        due = -inc
        pay = min(p['money'], due)
        p['money'] -= pay
        short = due - pay
        if short <= 0:
            if pay:
                log(state, '%s 收入结算 -%d 钱' % (pid, pay))
            done.append(pid)
            continue
        # 无力支付欠款 short：优先拆板，无板则扣分抵债
        if not p['industryTiles']:
            settle_debt_by_score(state, pid, short)
            done.append(pid)
            continue
        # 有板块 → 挂起，等待玩家强制拆板
        state['pendingForeclose'] = {'pid': pid, 'remaining': short}
        state['currentPlayer'] = pid
        done.append(pid)
        log(state, '%s 收入为负且无力支付，需强制拆板抵债（尚欠 %d）' % (pid, short))
        return pid
    state.pop('incomeDone', None)
    return None


def _advance_round(state):
    """收入结算 + 时代/轮次推进。

    返回 'pending'（已挂起强制拆板）/ 'era'（时代结束已切换）/ None（正常推进完成）。
    """
    pending_pid = settle_round_income(state)
    if pending_pid is not None:
        return 'pending'
    if era_should_end(state):
        end_era(state)
        state['version'] += 1
        recompute(state)
        return 'era'
    resort_turn_order(state)
    state['round'] += 1
    state['currentPlayer'] = state['turnOrder'][0]
    return None


def _after_advance(state):
    """收入结算完毕、轮次已推进后：设置行动点并处理空手牌跳过。"""
    state['actionPoints'] = 1 if (state['phase'] == 'canal' and state['round'] == 1) else 2
    cur = get_player(state, state['currentPlayer'])
    if not cur['hand']:
        if any(pl['hand'] for pl in state['players']) or state['drawPile']:
            return end_turn(state)
    state['version'] += 1
    recompute(state)
    return state['currentPlayer']


def _after_foreclose_advance(state, pid):
    """拆板/扣分抵债完成后：清 pendingForeclose，续结算其余玩家收入并推进轮次/时代。"""
    state.pop('pendingForeclose', None)
    status = _advance_round(state)
    if status == 'pending':
        state['version'] += 1
        recompute(state)
        return state['currentPlayer']
    if status == 'era':
        return state['currentPlayer']
    return _after_advance(state)


def resort_turn_order(state):
    """按本轮支付金钱升序重排回合顺位（同额保持原相对顺序）。"""
    prev = state['turnOrder']
    order = sorted(prev, key=lambda pid: (state['spentThisRound'].get(pid, 0), prev.index(pid)))
    state['turnOrder'] = order
    state['spentThisRound'] = {pid: 0 for pid in order}
    for p in state['players']:
        p['spentThisRound'] = 0


def era_should_end(state):
    """抽牌堆与所有手牌均耗尽 → 时代结束。"""
    if state['drawPile']:
        return False
    return all(len(p['hand']) == 0 for p in state['players'])


def end_turn(state):
    """结束当前玩家回合：清撤回栈、补牌、推进顺位（满轮则收入+重排+轮次 +1）。

    待补市场状态随回合推进作废（等同「留在板块上」）：资源留在板块、不翻面。
    售卖会话同样随回合推进作废（正常路径会先 sell_end）。
    轮末收入结算若触发强制拆板（pendingForeclose），则挂起等待 do_foreclose_tile，
    拆板/扣分抵债完成后自动续结算并推进轮次/时代。
    """
    state.pop('pendingSupplement', None)
    state.pop('pendingSell', None)
    state['undoStack'] = []
    p = get_player(state, state['currentPlayer'])
    refill(state, p)

    order = state['turnOrder']
    idx = order.index(state['currentPlayer']) if state['currentPlayer'] in order else 0
    if idx + 1 < len(order):
        state['currentPlayer'] = order[idx + 1]
    else:
        status = _advance_round(state)
        if status == 'pending':
            state['version'] += 1
            recompute(state)
            return state['currentPlayer']
        if status == 'era':
            return state['currentPlayer']
    return _after_advance(state)


def after_action(state):
    """行动成功后：行动点耗尽或手牌为空则结束回合，否则重算按钮。"""
    if state.get('gameOver'):
        return
    p = get_player(state, state['currentPlayer'])
    if state['actionPoints'] <= 0 or not p['hand']:
        end_turn(state)
    else:
        state['version'] += 1
        recompute(state)


# ---------------- 计分与时代切换 ----------------

def conn_marks_at(state, loc_id, pid=None):
    """地点的连接标记数 = 印刷标记 + 该地点上【指定玩家】的翻面工业板块（各计 1）。
    2026-08-11 用户规定：连接标记只能算【属于自己】的产业板块 + 公共印刷标记，别人的板块不计。"""
    loc = D.LOCATION_BY_ID.get(loc_id)
    base = (loc.get('conn_marks') or 0) if loc else 0
    flipped = 0
    if pid:
        p = get_player(state, pid)
        flipped = sum(1 for t in p['industryTiles']
                      if t['location'] == loc_id and t['flipped'])
    return base + flipped


def score_phase(state, era):
    """阶段计分（2026-08-11 用户重新规定，对齐官方 + 用户修正）：
    - 顺序：先【所有玩家】连接分（每条连接 = 两端连接标记数 = 印刷标记 + 属于【自己】的翻面板块，
      每标记 1 分【不封顶】；计完即移除该连接并归还玩家）→ 再【所有玩家】产业分。
    - 产业分只计【翻面】板块：运河结算未翻面 L2+ 当场翻面计分、未翻面 L1 不翻不计分（随后移除）；
      铁路终局【不翻面】未翻面板块、直接排除不计分。
    - 翻面板块运河计分后，若铁路时代仍在地图上，铁路结算【再次计分】（不按 builtEra 过滤）。
    - 铁路终局另加收入轨数值。
    """
    # ① 所有玩家连接分：逐条计分并移除（归还玩家）
    for p in state['players']:
        link_score = 0
        keep = []
        for lk in p['linkTiles']:
            if era == 'canal' and lk.get('type') == 'rail':
                keep.append(lk)
                continue
            if era == 'rail' and lk.get('type') != 'rail':
                keep.append(lk)
                continue
            a, b = lk['endpoints']
            marks = conn_marks_at(state, a, p['id']) + conn_marks_at(state, b, p['id'])
            link_score += marks                          # 官方：每标记 1 分，不封顶
            # 计完即移除该连接（归还玩家）
        state['scores'][p['id']]['_link'] = link_score
        p['linkTiles'] = keep
    # ② 所有玩家产业分：只计翻面板块（连接分已移除，刚翻面的板块不影响连接）
    for p in state['players']:
        tile_score = 0
        for t in p['industryTiles']:
            if not t.get('flipped'):
                if era == 'canal' and t['level'] >= 2:
                    t['flipped'] = True                  # 运河：未翻面 L2+ 当场翻面并计分
                else:
                    continue                             # 运河未翻面 L1（随后移除）/ 铁路终局未翻面 → 排除不计分
            d = M.tile_def_by_building(t['buildingId'], t['level'])
            vp = (d.get('vp') or 0) if d else 0
            tile_score += vp
        if era == 'rail':
            tile_score += M.income_of(p)                 # 铁路终局加收入轨数值
        sc = state['scores'][p['id']]
        link_score = sc.get('_link', 0)
        sc[era] = link_score + tile_score
        sc['total'] = max(0, sc.get('canal', 0) + sc.get('rail', 0) - sc.get('penalty', 0))
        log(state, '%s %s时代计分：连结 %d + 板块 %d%s = %d'
            % (p['id'], '运河' if era == 'canal' else '铁路', link_score,
               tile_score - (M.income_of(p) if era == 'rail' else 0),
               ' + 收入 %d' % M.income_of(p) if era == 'rail' else '', sc[era]))


def end_era(state):
    state['inScoring'] = True
    era = state['phase']
    score_phase(state, era)
    if era == 'canal':
        clear_canal(state)
        state['phase'] = 'rail'
        state['round'] = 1
        state['actionPoints'] = 2
        state['inScoring'] = False
        state['currentPlayer'] = state['turnOrder'][0]
        log(state, '运河时代结束，进入铁路时代')
    else:
        game_over(state)


def clear_canal(state):
    """运河时代清场（对齐半成品 turn.py：弃 1 级板块与运河连结、远方市场洗切、弃牌洗回抽牌堆、重发手牌、按末轮花费重排顺位）。"""
    rng = random.Random(state.get('seed'))
    for p in state['players']:
        removed = [t for t in p['industryTiles'] if t['level'] <= 1]
        p['industryTiles'] = [t for t in p['industryTiles'] if t['level'] > 1]
        for t in removed:
            state.setdefault('discardedTiles', []).append(t)
        p['linkTiles'] = []
        p['remainingLinks'] = LINK_TILES_PER_PLAYER
        p['spentThisRound'] = 0
    # 按运河末轮花费由少到多重排顺位（同额保持原相对顺序）——必须在重置花费之前读
    prev = state['turnOrder']
    spent = dict(state.get('spentThisRound', {}))
    order = sorted(prev, key=lambda pid: (spent.get(pid, 0), prev.index(pid)))
    state['turnOrder'] = order
    state['spentThisRound'] = {pid: 0 for pid in order}
    # 远方棉花市场轨与远方市场牌库重置（已抽牌洗回）
    state['remoteCottonTrack'] = 0
    deck = state['remoteMarketDeck']
    state['remoteMarketDeck'] = {'cards': list(deck.get('cards', [])) + list(deck.get('drawn', [])), 'drawn': []}
    rng.shuffle(state['remoteMarketDeck']['cards'])
    # 弃牌堆洗回成新抽牌堆，重新发满手牌
    state['drawPile'] = list(state['discardPile'])
    state['discardPile'] = []
    rng.shuffle(state['drawPile'])
    limit = state.get('handLimit', HAND_LIMIT)
    for pid in state['turnOrder']:
        p = get_player(state, pid)
        p['hand'] = []
        while len(p['hand']) < limit and state['drawPile']:
            p['hand'].append(state['drawPile'].pop())
    state['deckRemaining'] = len(state['drawPile'])
    state['undoStack'] = []


def game_over(state):
    state['gameOver'] = True
    state['roundState'] = 'FINISHED'
    state['inScoring'] = False
    ranked = sorted(state['players'], key=lambda p: (
        -state['scores'][p['id']]['total'],
        -M.income_of(p),
        -p['money']))
    state['ranking'] = [p['id'] for p in ranked]
    state['winner'] = state['ranking'][0] if state['ranking'] else None
    log(state, '游戏结束，胜者：%s' % state.get('winner'))
