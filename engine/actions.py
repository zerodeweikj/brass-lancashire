# -*- coding: utf-8 -*-
"""六大行动 + 双牌建造 + 撤回：第二层校验 → 执行 → 失败回退。

规则依据：PRD 6.1~6.12（行动系统）、14.3~14.8（子选择参数）。
统一返回 {'ok', 'fail_code', 'message', 'retry_target', 'detail'}；
失败时保证不修改 state（校验先行，通过后才动手）。
"""
import copy

from . import data as D
from . import flow
from . import mechanics as M
from .state import get_player, own_network

LOAN_TIERS = {1: 10, 2: 20, 3: 30}


def _fail(code, msg, retry='S1'):
    return {'ok': False, 'fail_code': code, 'message': msg, 'retry_target': retry, 'detail': None}


def _ok(msg, detail=None):
    return {'ok': True, 'fail_code': None, 'message': msg, 'retry_target': None, 'detail': detail or {}}


def _snapshot(state):
    """压入行动前快照（快照本身不含撤回栈，避免指数膨胀）。"""
    stack = state.pop('undoStack', [])
    snap = copy.deepcopy(state)
    state['undoStack'] = stack
    stack.append(snap)


def _spend(state, p, money):
    p['money'] -= money
    p['spentThisRound'] += money
    state['spentThisRound'][p['id']] = state['spentThisRound'].get(p['id'], 0) + money


def _discard(state, p, card_ids):
    for c in card_ids:
        p['hand'].remove(c)
        state['discardPile'].append(c)


def _precheck(state, action, need_cards=1, need_ap=1):
    """所有行动共用的前置校验（PRD 6.1 第 4 步 / 12.4 竞态防护）。"""
    if state.get('gameOver'):
        return _fail('GAME_OVER', '本局已结束。', 'S0')
    if 'version' in action and action['version'] != state['version']:
        return _fail('VERSION_STALE', '游戏状态已更新，请重新确认你的行动。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != state['currentPlayer']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    if state.get('roundState') != 'PLAYING' or state.get('inScoring'):
        return _fail('PHASE_LOCKED', '正在结算中，暂不可行动。', 'S0')
    p = get_player(state, pid)
    if len(p['hand']) < need_cards:
        return _fail('F_HAND_1', '手牌不足（需 %d 张）。' % need_cards, 'S0')
    if state.get('actionPoints', 0) < need_ap:
        return _fail('F_RULE_1', '行动点已用尽。', 'S0')
    return None


def _pick_cards(state, p, action, count):
    """解析并校验本次行动要消耗的手牌。"""
    ids = action.get('cardIds')
    if not ids:
        one = action.get('cardId') or action.get('card')
        ids = [one] if one else []
    if len(ids) != count:
        return None, _fail('F_HAND_1', '需要选择 %d 张手牌。' % count, 'S1')
    tmp = list(p['hand'])
    for c in ids:
        if c not in tmp:
            return None, _fail('F_HAND_1', '所选手牌不在你的手中：%s' % c, 'S1')
        tmp.remove(c)
    return ids, None


# ============================ 建造 ============================

def _card_allows_build(card_id, location, industry):
    """单张手牌能否驱动这次建造：城市牌须匹配地点，产业牌须匹配产业。"""
    card = D.CARD_BY_ID.get(card_id)
    if not card:
        return False
    if card['type'] == 'city':
        return card.get('city') == location
    if card['type'] == 'industry':
        return card.get('industry') == industry
    return False


def _validate_build(state, action, double):
    n_cards = 2 if double else 1
    err = _precheck(state, action, need_cards=n_cards, need_ap=2 if double else 1)
    if err:
        return None, err
    p = get_player(state, state['currentPlayer'])
    cards, err = _pick_cards(state, p, action, n_cards)
    if err:
        return None, err

    location = action.get('location')
    slot_index = action.get('slotIndex', 0)
    industry = action.get('industry')
    loc = D.LOCATION_BY_ID.get(location)
    if not loc or not loc.get('slots'):
        return None, _fail('BUILD_NO_SLOT', '地点不存在或无工业槽位：%s' % location, 'S2')
    if slot_index >= len(loc['slots']):
        return None, _fail('BUILD_NO_SLOT', '%s 没有第 %d 个槽位。' % (location, slot_index + 1), 'S2')
    if industry not in M.IND_CN2KEY:
        return None, _fail('BUILD_WRONG_INDUSTRY', '未知的产业类型：%s' % industry, 'S2')
    if M.IND_CN2KEY[industry] not in loc['slots'][slot_index]:
        return None, _fail('BUILD_WRONG_INDUSTRY',
                           '%s 槽位 %d 不能建造%s。' % (location, slot_index + 1, industry), 'S2')
    if not flow.slot_free(state, location, slot_index):
        return None, _fail('BUILD_SLOT_OCCUPIED', '该槽位已被占用，请换一个。', 'S2')
    ok_slots = flow.allowed_slots(state, location, industry)
    if slot_index not in ok_slots:
        return None, _fail('BUILD_SLOT_PRIORITY',
                           '%s 还有仅限%s的空槽位，须优先占用（槽位 %s）。'
                           % (location, industry, '/'.join(str(i + 1) for i in ok_slots)), 'S2')
    if loc.get('rail_only') and state['phase'] != 'rail':
        return None, _fail('BUILD_WRONG_ERA', '%s 只在铁路时代进入版图。' % location, 'S2')

    # 牌型（双牌建造用任意 2 张，可突破运输网限制 —— PRD 3.2 / 6.5）
    if not double and not _card_allows_build(cards[0], location, industry):
        return None, _fail('BUILD_WRONG_CARD',
                           '所选手牌无法驱动此建造：需要 %s 的城市牌或%s产业牌。' % (location, industry), 'S1')

    # 位置：仅「产业牌驱动」才要求在自有运输网内
    #   · 城市牌驱动：地点已由牌面锁定，不查运输网（PRD 3.2）
    #   · 双牌建造 / 玩家尚无任何运输网（首建）：例外，任意合法地点
    card0 = D.CARD_BY_ID.get(cards[0]) if cards else None
    card_is_industry = bool(card0 and card0.get('type') == 'industry')
    first_build = not p['industryTiles'] and not p['linkTiles']
    if (not double and card_is_industry and not first_build
            and location not in own_network(state, p['id'])):
        return None, _fail('BUILD_LOCATION_UNREACHABLE',
                           '%s 不在你的运输网内。请先修路，或改用 %s 的城市牌。' % (location, location), 'S1')

    # 运河时代每地点每人最多 1 个工业板块
    if state['phase'] == 'canal' and any(t['location'] == location for t in p['industryTiles']):
        return None, _fail('BUILD_SLOT_OCCUPIED', '运河时代每个地点你最多只能有 1 个工业板块。', 'S2')

    key = M.IND_CN2KEY[industry]
    level = M.mat_lowest(p, key)
    if level is None:
        return None, _fail('BUILD_NO_SUPPLY', '你的面板上已没有%s板块。' % industry, 'S0')
    td = D.tile_def(industry, level)
    # 资格判定与 flow.buildable_level / build.validate_build 同源（D.tile_buildable）
    ok_tile, code_tile, msg_tile = D.tile_buildable(td, state['phase'])
    if not ok_tile:
        return None, _fail(code_tile, msg_tile,
                           'S0' if code_tile == 'BUILD_NO_SUPPLY' else 'S2')

    cost = td['cost'] or {}
    money = cost.get('money', 0)
    coal = cost.get('coal', 0)
    iron = cost.get('iron', 0)
    total, bill = M.total_cost(state, location, cost)
    if total is None:
        return None, _fail('BUILD_INSUFFICIENT_COAL',
                           '煤不足：需要 %d 煤，附近无可用煤厂，且此地未连到市场标记、无法买煤。' % coal, 'S3')
    if p['money'] < total:
        extra = bill['extraMoney']
        detail = '建造 %d + 市场采购 %d = %d' % (money, extra, total) if extra else '需要 %d' % total
        return None, _fail('BUILD_INSUFFICIENT_MONEY',
                           '金钱不足：%s，你只有 %d。可先贷款。' % (detail, p['money']), 'S4')

    return {'cards': cards, 'location': location, 'slotIndex': slot_index,
            'industry': industry, 'level': level, 'tileDef': td,
            'totalMoney': total, 'bill': bill}, None


def do_build(state, action, double=False):
    ctx, err = _validate_build(state, action, double)
    if err:
        return err
    _snapshot(state)
    p = get_player(state, state['currentPlayer'])
    td, level, industry = ctx['tileDef'], ctx['level'], ctx['industry']
    key = M.IND_CN2KEY[industry]
    cost = td['cost'] or {}

    _discard(state, p, ctx['cards'])
    _spend(state, p, cost.get('money', 0))
    paid = {}
    if cost.get('coal'):
        paid['coal'] = M.pay_coal(state, ctx['location'], cost['coal'], p['id'], action.get('coalFrom'))
    if cost.get('iron'):
        paid['iron'] = M.pay_iron(state, cost['iron'], p['id'], action.get('ironFrom'))

    M.mat_take(p, key, level)
    seq = sum(len(pl['industryTiles']) for pl in state['players']) + len(state.get('discardedTiles', [])) + 1
    produce = td.get('produce') or {}
    tile = {
        'id': 'tile_%03d' % seq,
        'buildingId': td['building_id'], 'level': level, 'industry': industry,
        'owner': p['id'], 'color': p['color'],
        'location': ctx['location'], 'slotIndex': ctx['slotIndex'],
        'flipped': False,
        'boardResources': produce.get('qty', 0) if produce.get('type') in ('coal', 'iron') else 0,
        'resourceType': produce.get('type'),
        'builtEra': state['phase'],
    }
    p['industryTiles'].append(tile)

    # 产煤/产铁板块：不再自动补市场。若对应市场有空槽（煤厂需连市场标记），
    # 暂停回合并返回 needSupplement，由玩家选择「补入市场 / 留在板块上」（见 do_supplement）。
    # 翻面时机（2026-08-11 用户拍板）：选择补入且板块资源全部卖出（boardResources<=0）才翻面
    # 并得翻面奖励（收入轨前进）；部分补充或留板不翻面。
    need = None
    if tile['resourceType'] == 'iron' and tile['boardResources'] > 0:
        put, gain = M.supplement_budget(state, 'iron', tile['boardResources'])
        if put > 0:
            need = {'resource': 'iron', 'qty': tile['boardResources'], 'put': put,
                    'gain': gain, 'willFlip': put >= tile['boardResources']}
    elif tile['resourceType'] == 'coal' and tile['boardResources'] > 0:
        if M.connected_to_market(state, tile['location']):
            put, gain = M.supplement_budget(state, 'coal', tile['boardResources'])
            if put > 0:
                need = {'resource': 'coal', 'qty': tile['boardResources'], 'put': put,
                        'gain': gain, 'willFlip': put >= tile['boardResources']}

    if td.get('flip') == 'flip_on_build':
        M.flip_tile(state, tile)

    state['actionPoints'] -= 2 if double else 1
    flow.log(state, '%s 在 %s 建造 %d 级%s'
             % (p['id'], ctx['location'], level, industry))

    if need:
        # 回合暂停：等待当前玩家在 supplement_market 里给出抉择（或撤回整次建造）
        state['pendingSupplement'] = {
            'playerId': p['id'], 'tileId': tile['id'], **need,
        }
        state['version'] += 1
        flow.recompute(state)
        return _ok('建造成功，请选择是否把产出补入市场', {
            'tile': tile, 'paid': paid, 'needSupplement': need,
        })

    flow.after_action(state)
    return _ok('建造成功', {'tile': tile, 'paid': paid})


def do_supplement(state, action):
    """补市场抉择（2026-08-11 用户拍板）：建造产铁/煤厂后由玩家选择是否把产出补入市场。

    supply=true  → 把资源【移动】入市场空槽（最高价优先），立即得钱 = 槽位面值之和；
                   若板块资源全部卖出则翻面并得翻面奖励（收入轨前进，翻面时机由引擎决定）。
    supply=false → 什么都不做：资源留在板块上、不翻面、不动市场、不给钱。
    随后继续回合流转（after_action）。
    """
    pend = state.get('pendingSupplement')
    if not pend:
        return _fail('SUPPLEMENT_NONE', '当前没有待补市场的建造。', 'S0')
    if 'version' in action and action['version'] != state['version']:
        return _fail('VERSION_STALE', '游戏状态已更新，请重新确认你的行动。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != pend['playerId'] or pid != state['currentPlayer']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    if state.get('roundState') != 'PLAYING' or state.get('inScoring'):
        return _fail('PHASE_LOCKED', '正在结算中，暂不可行动。', 'S0')
    p = get_player(state, pid)
    tile = next((t for t in p['industryTiles'] if t['id'] == pend['tileId']), None)
    state.pop('pendingSupplement', None)
    if not tile or tile.get('flipped'):
        return _fail('SUPPLEMENT_TILE_GONE', '板块状态已变化，无法补入市场。', 'S0')

    if action.get('supply'):
        # 以当前市场状态权威实算（最高价优先）
        put, gain = M.sell_to_market(state, pend['resource'], tile['boardResources'], pid)
        tile['boardResources'] -= put
        flipped = False
        if tile['boardResources'] <= 0 and not tile.get('flipped'):
            M.flip_tile(state, tile)
            flipped = True
        flow.log(state, '%s 把 %d 单位%s补入市场得 %d 钱，%s翻面'
                 % (pid, put, pend['resource'], gain,
                    '板块' if flipped else '板块未翻面（仍有 %d 单位留在板上）' % tile['boardResources']))
        flow.after_action(state)
        return _ok('已补入市场', {'put': put, 'gain': gain, 'flipped': flipped,
                                 'tile': tile})
    flow.log(state, '%s 选择把产出留在%s板块上（不补市场、不翻面）'
             % (pid, pend['resource']))
    flow.after_action(state)
    return _ok('产出留在板块上', {'put': 0, 'gain': 0, 'flipped': False, 'tile': tile})


# ============================ 强制拆板抵债 ============================

def do_foreclose_tile(state, action):
    """强制拆板抵债（轮末收入为负且无力支付时触发，引擎挂起 pendingForeclose）。

    玩家在地图上点击【自己】的一个产业板块：
    1. 移除该板块（不归还面板）；其建造金钱费用的一半（向下取整）用于还债，
       若 repay > 尚欠，则多余部分归玩家作为金钱。
    2. 一间不够还 → 保持 pendingForeclose，等待玩家继续点击拆除。
    3. 若玩家已无板块可拆但仍欠债 → settle_debt_by_score 按 1 分=1 钱 扣分抵债；
       扣到 0 仍不足 → 一笔勾销并标记 forecloseForgiven（前端弹「算你好彩」）。
    """
    pend = state.get('pendingForeclose')
    if not pend:
        return _fail('FORECLOSE_NONE', '当前没有待抵债的拆板。', 'S0')
    if 'version' in action and action['version'] != state['version']:
        return _fail('VERSION_STALE', '状态已更新，请刷新后重试。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != pend['pid'] or pid != state['currentPlayer']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    if state.get('roundState') != 'PLAYING' or state.get('inScoring'):
        return _fail('PHASE_LOCKED', '正在结算中，暂不可行动。', 'S0')
    p = get_player(state, pid)
    tile_id = action.get('tileId')
    tile = next((t for t in p['industryTiles'] if t['id'] == tile_id), None)
    if not tile:
        return _fail('FORECLOSE_NO_TILE', '请选择你自己的一个产业板块。', 'S0')

    d = M.tile_def_by_building(tile['buildingId'], tile['level'])
    cost = (d.get('cost') or {}).get('money', 0) if d else 0
    repay = cost // 2
    remaining = pend['remaining']
    leftover = 0
    if repay >= remaining:
        leftover = repay - remaining
        p['money'] += leftover
        flow.log(state, '%s 拆除 %s %d 级%s抵债：还债 %d，余 %d 归己'
                 % (pid, tile['location'], tile['level'], M.industry_of(tile), remaining, leftover))
        remaining = 0
    else:
        flow.log(state, '%s 拆除 %s %d 级%s抵债：还债 %d，尚欠 %d'
                 % (pid, tile['location'], tile['level'], M.industry_of(tile), repay, remaining - repay))
        remaining -= repay

    # 移除板块（不归还面板）
    p['industryTiles'].remove(tile)
    state.setdefault('discardedTiles', []).append({
        'owner': pid, 'industry': M.industry_of(tile), 'level': tile['level'],
        'buildingId': tile['buildingId'], 'reason': 'foreclose',
        'location': tile['location'], 'slotIndex': tile['slotIndex'],
    })

    if remaining <= 0:
        flow._after_foreclose_advance(state, pid)
        return _ok('抵债完成', {'tile': tile['id'], 'repay': repay, 'leftover': leftover,
                               'remaining': 0, 'needForeclose': False})

    if p['industryTiles']:
        # 仍有欠款且还有自己的板块 → 继续强制拆板
        pend['remaining'] = remaining
        state['version'] += 1
        flow.recompute(state)
        return _ok('抵债继续', {'tile': tile['id'], 'repay': repay, 'leftover': leftover,
                               'remaining': remaining, 'foreclose': dict(pend), 'needForeclose': True})

    # 无板块可拆 → 步骤 3：扣分抵债（或一笔勾销）
    new_remaining = flow.settle_debt_by_score(state, pid, remaining)
    flow._after_foreclose_advance(state, pid)
    return _ok('抵债完成（扣分）', {'tile': tile['id'], 'repay': repay, 'leftover': leftover,
                                   'remaining': new_remaining, 'deduct': remaining - new_remaining,
                                   'needForeclose': False, 'forgiven': new_remaining > 0})


# ============================ 修路 ============================

def do_road(state, action):
    err = _precheck(state, action, need_cards=1, need_ap=1)
    if err:
        return err
    p = get_player(state, state['currentPlayer'])
    cards, err = _pick_cards(state, p, action, 1)
    if err:
        return err

    links = action.get('links') or []
    if action.get('from') and action.get('to'):
        links = [{'from': action['from'], 'to': action['to']}]
    if not links:
        return _fail('ROAD_NO_ENDPOINT', '请选择要修建的连结位置。', 'S2')
    if state['phase'] == 'canal' and len(links) != 1:
        return _fail('ROAD_WRONG_ERA_COST', '运河时代每次只能修 1 条运河。', 'S2')
    if state['phase'] == 'rail' and len(links) not in (1, 2):
        return _fail('ROAD_WRONG_ERA_COST', '铁路时代每次可修 1 条或 2 条铁路。', 'S2')
    if p['remainingLinks'] < len(links):
        return _fail('ROAD_NO_ENDPOINT', '你的连结板块已用完。', 'S0')

    if state['phase'] == 'canal':
        money_cost, coal_cost = 3, 0
    else:
        money_cost, coal_cost = (5, 1) if len(links) == 1 else (15, 2)

    # 逐条校验合法性（第 2 条以第 1 条落地后的网络为基准）
    probe = copy.deepcopy(state)
    pp = get_player(probe, p['id'])
    for lk in links:
        a, b = lk.get('from'), lk.get('to')
        la, lb = D.LOCATION_BY_ID.get(a), D.LOCATION_BY_ID.get(b)
        if not la or not lb:
            return _fail('ROAD_ILLEGAL_LINK', '连结端点不存在：%s - %s' % (a, b), 'S2')
        adj = la['canal_adj'] if state['phase'] == 'canal' else la['rail_adj']
        if b not in adj:
            return _fail('ROAD_ILLEGAL_LINK', '%s 与 %s 在当前时代并不相邻。' % (a, b), 'S2')
        if state['phase'] == 'canal' and (la.get('rail_only') or lb.get('rail_only')):
            return _fail('ROAD_ILLEGAL_LINK', '%s / %s 只在铁路时代出现。' % (a, b), 'S2')
        for pl in probe['players']:
            if any(set(x['endpoints']) == {a, b} for x in pl['linkTiles']):
                return _fail('ROAD_ILLEGAL_LINK', '%s - %s 之间已有连结板块。' % (a, b), 'S2')
        net = own_network(probe, p['id'])
        if net and a not in net and b not in net:
            return _fail('ROAD_NO_ENDPOINT', '%s - %s 无法与你的运输网相连。' % (a, b), 'S2')
        pp['linkTiles'].append({'id': 'probe', 'endpoints': [a, b], 'owner': p['id'], 'type': state['phase']})

    # 煤可取自被建连结的任一端点所在的共享路网（PRD 14.4 S3 → 同 14.3）
    anchors = [e for lk in links for e in (lk['from'], lk['to'])]
    total_money, bill = M.total_cost(state, anchors, {'money': money_cost, 'coal': coal_cost})
    if total_money is None:
        return _fail('ROAD_INSUFFICIENT_COAL',
                     '煤不足：铁路需要 %d 煤，连结两端既无可用煤厂，也未连到市场标记。' % coal_cost, 'S3')
    if p['money'] < total_money:
        return _fail('ROAD_INSUFFICIENT_MONEY',
                     '金钱不足：需要 %d（含市场买煤 %d），你只有 %d。'
                     % (total_money, bill['coalCost'], p['money']), 'S4')

    _snapshot(state)
    p = get_player(state, state['currentPlayer'])
    _discard(state, p, cards)
    _spend(state, p, money_cost)
    paid = None
    if coal_cost:
        paid = M.pay_coal(state, anchors, coal_cost, p['id'], action.get('coalFrom'))
    seq = sum(len(pl['linkTiles']) for pl in state['players']) + 1
    made = []
    for i, lk in enumerate(links):
        inst = {'id': 'link_%03d' % (seq + i), 'endpoints': [lk['from'], lk['to']],
                'owner': p['id'], 'color': p['color'], 'type': state['phase']}
        p['linkTiles'].append(inst)
        p['remainingLinks'] -= 1
        made.append(inst)
    state['actionPoints'] -= 1
    flow.log(state, '%s 修建%s：%s' % (p['id'], '运河' if state['phase'] == 'canal' else '铁路',
                                     '、'.join('%s-%s' % (l['from'], l['to']) for l in links)))
    flow.after_action(state)
    return _ok('修路成功', {'links': made, 'paid': paid})


# ============================ 发展 ============================

def do_develop(state, action):
    err = _precheck(state, action, need_cards=1, need_ap=1)
    if err:
        return err
    p = get_player(state, state['currentPlayer'])
    cards, err = _pick_cards(state, p, action, 1)
    if err:
        return err

    inds = action.get('industries') or ([action['industry']] if action.get('industry') else [])
    if not inds:
        return _fail('DEV_NO_LOW', '请选择要丢弃的低等级板块所属产业。', 'S2')
    limit = min(2, M.mat_count(p))
    if len(inds) > limit or len(inds) > 2:
        return _fail('DEV_NO_LOW', '本次最多可丢弃 %d 个板块（上限 min(2, 面板板块数)）。' % limit, 'S2')

    # 逐个确认可丢弃（同一产业连丢两个时等级会上移）
    probe = {k: dict(v) for k, v in p['mat'].items()}
    plan = []
    for ind in inds:
        key = M.IND_CN2KEY.get(ind, ind)
        if key not in probe:
            return _fail('DEV_NO_LOW', '未知产业：%s' % ind, 'S2')
        levels = [l for l, c in probe[key].items() if c > 0]
        if not levels:
            return _fail('DEV_NO_LOW', '%s 面板上已无板块可丢弃。' % M.IND_KEY2CN.get(key, key), 'S2')
        lo = min(levels)
        probe[key][lo] -= 1
        plan.append((key, lo))

    iron_need = len(plan)
    if not M.can_pay_iron(state, iron_need, p):
        return _fail('DEV_NO_IRON', '铁不足：发展需要 %d 铁，场上无未翻面铁厂且买不起市场铁。' % iron_need, 'S2')
    buy = M.market_buy_cost(state, 'iron', max(0, iron_need - M.iron_available(state)))
    if p['money'] < buy:
        return _fail('DEV_NO_IRON', '金钱不足以购买 %d 铁（需 %d 钱）。' % (iron_need, buy), 'S2')

    _snapshot(state)
    p = get_player(state, state['currentPlayer'])
    _discard(state, p, cards)
    paid = M.pay_iron(state, iron_need, p['id'], action.get('ironFrom'))
    dropped = []
    for key, lo in plan:
        p['mat'][key][lo] -= 1
        dropped.append({'industry': M.IND_KEY2CN[key], 'level': lo})
        state.setdefault('discardedTiles', []).append(
            {'owner': p['id'], 'industry': M.IND_KEY2CN[key], 'level': lo, 'reason': 'develop'})
    M.sync_min_build_level(p)
    state['actionPoints'] -= 1
    flow.log(state, '%s 发展：丢弃 %s（耗 %d 铁）'
             % (p['id'], '、'.join('%d级%s' % (d['level'], d['industry']) for d in dropped), iron_need))
    flow.after_action(state)
    return _ok('发展成功', {'dropped': dropped, 'paid': paid})


# ============================ 出售棉花 ============================

def _sale_channels(state, mill):
    """该棉花厂可用的销售渠道：远方市场（连市场标记，含任何港口）/ 未翻面港口。
    远方市场判定与 connected_to_market 同口径（市场标记 = 版图 market + 任何玩家任意港口，
    2026-08-11 用户规定：翻面港口也有市场标记属性），防止 sellable_mills 与渠道判定分裂。"""
    reach = M._bfs_dist(state, mill['location'])
    distant = M.connected_to_market(state, mill['location'])
    ports = []
    for pl in state['players']:
        for t in pl['industryTiles']:
            if t['flipped'] or M.industry_of(t) != '港口':
                continue
            if t['location'] in reach:
                ports.append(t)
    return distant, ports


def _sell_validate(state, action, p):
    """校验单笔售卖（不改动状态）——失败不弃牌不扣行动点。返回 _fail 或 None。"""
    mill_id = action.get('millId') or (action.get('mills') or [None])[0]
    mill = next((t for t in p['industryTiles'] if t['id'] == mill_id), None)
    if mill is None or M.industry_of(mill) != '棉花厂':
        return _fail('SELL_WRONG_MILL', '请选择你自己的一个棉花厂。', 'S1')
    if mill['flipped']:
        return _fail('SELL_WRONG_MILL', '该棉花厂已翻面，不能再出售。', 'S1')
    distant, ports = _sale_channels(state, mill)
    if not distant and not ports:
        return _fail('SELL_WRONG_MILL', '该棉花厂未与市场标记或未翻面港口相连。', 'S1')

    channel = action.get('channel') or ('distant' if distant else 'port')
    if channel == 'port':
        port = next((t for t in ports if t['id'] == action.get('portTileId')),
                    (ports[0] if ports else None))
        if port is None:
            return _fail('SELL_WRONG_MILL', '没有可用的未翻面港口。', 'S2')
    else:
        if not distant:
            return _fail('SELL_WRONG_MILL', '该棉花厂未连到带市场标记的地点。', 'S2')
        track = state.get('remoteTrackValues') or [3, 3, 2, 2, 1, 1, 0, 0, 0]
        pos = state.get('remoteCottonTrack', 0)
        if pos >= max(0, len(track) - 1):
            return _fail('SELL_DISTANT_X', '远方市场标记已停在 X，无法出售到远方市场。', 'S1')
        deck = state.get('remoteMarketDeck') or {}
        if not deck.get('cards'):
            return _fail('SELL_DECK_EMPTY', '远方市场牌库已空，无法翻牌，请改走港口路线。', 'S2')
    return None


def _sell_execute(state, action, p):
    """执行单笔售卖（状态已快照、首步手牌已弃）。返回 detail dict。

    官方规则（2026-08-11 规则书，100% 官方）：
    - 2.1 港口：棉花卖到任意未翻面港口 → 港口翻面 + 港口拥有者得翻面奖励；
    - 2.2 远方市场：抽 1 张远方市场牌按绝对值移动市场轨标记，
         落点数值 = 该玩家收入轨前进格数（income 而非 money！）；
         若落点走到 X → 该行动视为跳过（不翻棉花厂、不推进收入、行动结束）；
    - 3. 翻该棉花厂，拥有者得翻面奖励。
    """
    mill_id = action.get('millId') or (action.get('mills') or [None])[0]
    mill = next(t for t in p['industryTiles'] if t['id'] == mill_id)
    distant, ports = _sale_channels(state, mill)
    channel = action.get('channel') or ('distant' if distant else 'port')
    gain = 0
    drawn = None
    port_owner = None
    if channel == 'port':
        port = next((t for t in ports if t['id'] == action.get('portTileId')), ports[0])
        port_owner = port['owner']
        M.flip_tile(state, port)                       # 港口翻面，港口拥有者得奖励（2.1）
    else:
        track = state.get('remoteTrackValues') or [3, 3, 2, 2, 1, 1, 0, 0, 0]
        pos = state.get('remoteCottonTrack', 0)
        deck = state['remoteMarketDeck']
        drawn = deck['cards'].pop()                    # 抽 1 张远方市场牌
        deck['drawn'].append(drawn)
        new_pos = min(len(track) - 1, pos + abs(drawn))
        state['remoteCottonTrack'] = new_pos
        if new_pos >= len(track) - 1:
            # 命中 X：视为跳过——不翻棉花厂、不推进收入
            return {'skipped': True, 'mill': mill_id, 'channel': 'distant',
                    'millLevel': mill['level'], 'income': 0, 'card': drawn, 'track': new_pos}
        gain = track[new_pos]                          # 收入 = 落点数值（2.2）
        M.move_income(state, p['id'], gain)            # 官方：收入轨前进，不是加钱！
    M.flip_tile(state, mill)                           # 步骤 3：翻棉花厂
    return {'skipped': False, 'mill': mill_id, 'channel': channel, 'millLevel': mill['level'],
            'income': gain, 'card': drawn, 'track': state.get('remoteCottonTrack', 0),
            'portOwner': port_owner}


def do_sell(state, action):
    """售卖棉花（官方规则，2026-08-11 规则书拍板，100% 官方）。

    1. 丢弃任意 1 张手牌（仅首次）；
    2. 选一座未翻面棉花厂：港口（翻任意未翻面港口，港口拥有者得奖励）或远方市场（抽牌推进市场轨，
       收入轨前进 = 落点数值；命中 X 视为跳过）；若还有可售棉花厂 → pendingSell 会话等待续卖（不扣行动点）；
    3. 翻棉花厂，拥有者得翻面奖励；
    4. 可重复步骤 2，或 sell_end 结束（结束时扣 1 行动点）。
    """
    pend = state.get('pendingSell')
    p = None
    cards = None
    if pend is None:
        err = _precheck(state, action, need_cards=1, need_ap=1)
        if err:
            return err
        p = get_player(state, state['currentPlayer'])
        cards, err = _pick_cards(state, p, action, 1)
        if err:
            return err
    else:
        if action.get('playerId', state['currentPlayer']) != pend['playerId']:
            return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
        p = get_player(state, pend['playerId'])
    verr = _sell_validate(state, action, p)
    if verr:
        return verr
    # 校验通过 → 快照 + 弃牌（仅首次；后续续卖不弃牌）
    _snapshot(state)
    p = get_player(state, p['id'])
    if cards:
        _discard(state, p, cards)
    detail = _sell_execute(state, action, p)
    if detail.get('skipped'):
        state.pop('pendingSell', None)
        state['actionPoints'] -= 1
        flow.log(state, '%s 出售棉花厂（远方市场命中 X，视为跳过）' % p['id'])
        flow.after_action(state)
        return _ok('远方市场命中 X，本次售卖视为跳过', detail)
    if flow.sellable_mills(state, p['id']):
        # 步骤 4：还有可售棉花厂 → 会话续卖（不扣行动点、不推进回合，仅刷新按钮态）
        state['pendingSell'] = {'playerId': p['id']}
        state['version'] += 1
        flow.recompute(state)
        return _ok('可继续出售', {**detail, 'needSellContinue': True})
    state.pop('pendingSell', None)
    state['actionPoints'] -= 1
    flow.log(state, '%s 出售 %d 级棉花厂（%s）%s'
             % (p['id'], detail['millLevel'],
                '远方市场' if detail['channel'] == 'distant' else '港口',
                ('，收入轨前进 %d' % detail['income']) if detail['income'] else ''))
    flow.after_action(state)
    return _ok('出售成功', detail)


def do_sell_end(state, action):
    """结束连续售卖会话（官方步骤 4：玩家选择不再出售），消耗 1 行动点。"""
    pend = state.get('pendingSell')
    if not pend:
        return _fail('SELL_NO_SESSION', '当前没有进行中的售卖会话。', 'S0')
    if 'version' in action and action['version'] != state['version']:
        return _fail('VERSION_STALE', '状态已更新，请刷新后重试。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != pend['playerId']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    state.pop('pendingSell', None)
    state['actionPoints'] -= 1
    flow.after_action(state)
    return _ok('结束售卖', {'currentPlayer': state['currentPlayer']})


# ============================ 贷款 ============================

def do_loan(state, action):
    err = _precheck(state, action, need_cards=1, need_ap=1)
    if err:
        return err
    p = get_player(state, state['currentPlayer'])
    cards, err = _pick_cards(state, p, action, 1)
    if err:
        return err
    tier = int(action.get('tier', 1))
    if tier not in LOAN_TIERS:
        return _fail('LOAN_FLOOR', '贷款档位只能是 1 / 2 / 3（+10 / +20 / +30 钱）。', 'S1')
    if state['phase'] == 'rail' and state['deckRemaining'] <= 2 * len(state['players']):
        return _fail('LOAN_BANNED', '铁路时代抽牌堆剩余 ≤ 2×人数，禁止贷款。', 'S0')
    if M.income_of(p) <= -10:
        return _fail('LOAN_FLOOR', '收入已触底（-10），无法再贷款。', 'S0')
    if p['incomePos'] - tier < M.MIN_POS:
        return _fail('LOAN_FLOOR', '该档位会使收入轨低于 -10，请选更小档位。', 'S1')

    _snapshot(state)
    p = get_player(state, state['currentPlayer'])
    _discard(state, p, cards)
    gain = LOAN_TIERS[tier]
    p['money'] += gain
    M.move_income(state, p['id'], -tier)
    state['actionPoints'] -= 1
    flow.log(state, '%s 贷款 +%d 钱，收入轨后退 %d 格（现收入 %d）'
             % (p['id'], gain, tier, M.income_of(p)))
    flow.after_action(state)
    return _ok('贷款成功', {'gain': gain, 'income': M.income_of(p)})


# ============================ 跳过 ============================

def do_skip(state, action, auto=False):
    err = _precheck(state, action, need_cards=1, need_ap=1)
    if err:
        return err
    p = get_player(state, state['currentPlayer'])
    if auto:
        import random
        card = random.Random(state.get('version')).choice(p['hand'])
        cards = [card]
    else:
        cards, err = _pick_cards(state, p, action, 1)
        if err:
            return err
    if not auto:
        _snapshot(state)                     # 超时自动跳过不入撤回栈（PRD 6.10）
    p = get_player(state, state['currentPlayer'])
    _discard(state, p, cards)
    state['actionPoints'] -= 1
    if auto:
        state['undoStack'] = []
    flow.log(state, '%s %s，弃置手牌 %s' % (p['id'], '超时跳过' if auto else '跳过', cards[0]))
    flow.after_action(state)
    return _ok('已跳过', {'discarded': cards})


# ============================ 撤回 / 结束回合 ============================

def do_undo(state, action):
    if 'version' in action and action['version'] != state['version']:
        return _fail('UNDO_STALE_VERSION', '状态已更新，请刷新后重试。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != state['currentPlayer']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    if state.get('roundState') != 'PLAYING' or state.get('inScoring'):
        return _fail('UNDO_PHASE_LOCKED', '已进入结算，无法撤回。', 'S0')
    if not state.get('undoStack'):
        return _fail('UNDO_EMPTY', '本回合还没有可撤回的行动。', 'S0')

    snap = state['undoStack'].pop()
    stack = state['undoStack']
    state.clear()
    state.update(snap)
    state['undoStack'] = stack
    state['version'] += 1
    flow.recompute(state)
    flow.log(state, '%s 撤回了上一步行动' % pid)
    return _ok('已撤回上一步', {'stack': len(stack)})


def do_undo_all(state, action):
    """整回合撤回：回到本回合开始时的状态（撤回栈按回合清空，栈底即回合起点）。"""
    if 'version' in action and action['version'] != state['version']:
        return _fail('UNDO_STALE_VERSION', '状态已更新，请刷新后重试。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != state['currentPlayer']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    if state.get('roundState') != 'PLAYING' or state.get('inScoring'):
        return _fail('UNDO_PHASE_LOCKED', '已进入结算，无法撤回。', 'S0')
    stack = state.get('undoStack') or []
    if not stack:
        return _fail('UNDO_EMPTY', '本回合还没有可撤回的行动。', 'S0')

    steps = len(stack)
    snap = stack[0]
    state.clear()
    state.update(snap)
    state['undoStack'] = []
    state['version'] += 1
    flow.recompute(state)
    flow.log(state, '%s 撤回了整个回合（%d 步）' % (pid, steps))
    return _ok('已撤回整个回合', {'steps': steps})


def do_end_turn(state, action):
    if 'version' in action and action['version'] != state['version']:
        return _fail('VERSION_STALE', '状态已更新，请刷新后重试。', 'S0')
    pid = action.get('playerId', state['currentPlayer'])
    if pid != state['currentPlayer']:
        return _fail('NOT_YOUR_TURN', '当前不是你的回合。', 'S0')
    p = get_player(state, pid)
    if state.get('actionPoints', 0) > 0 and p['hand']:
        return _fail('F_RULE_1', '本回合还有行动点，必须用完（手牌 = 行动点）。', 'S0')
    flow.end_turn(state)
    return _ok('回合结束', {'currentPlayer': state['currentPlayer']})


# ============================ 分发 ============================

HANDLERS = {
    'build': lambda s, a: do_build(s, a, double=False),
    'doubleBuild': lambda s, a: do_build(s, a, double=True),
    'road': do_road,
    'link': do_road,
    'develop': do_develop,
    'sell': do_sell,
    'sell_end': do_sell_end,
    'loan': do_loan,
    'skip': do_skip,
    'autoSkip': lambda s, a: do_skip(s, a, auto=True),
    'supplement_market': do_supplement,
    'foreclose_tile': do_foreclose_tile,
    'undo': do_undo,
    'undoAll': do_undo_all,
    'endTurn': do_end_turn,
}


def apply_action(state, action):
    """统一入口：按 action['type'] 分发。

    待补市场（pendingSupplement）期间：只允许 supplement_market 落地选择，
    或 undo/undoAll 撤回整次建造（快照先于 pending，撤回即清除）；
    售卖会话（pendingSell）期间：只允许续卖 sell / 结束 sell_end / undo/undoAll，
    其余行动一律拒绝，避免绕过选择造成状态悬空。
    """
    t = action.get('type') or action.get('action')
    fn = HANDLERS.get(t)
    if not fn:
        return _fail('UNKNOWN_ACTION', '未知行动类型：%s' % t, 'S0')
    if state.get('pendingSupplement') and t not in ('supplement_market', 'undo', 'undoAll'):
        return _fail('SUPPLEMENT_PENDING', '请先选择是否把产出补入市场（或撤回这次建造）。', 'S0')
    if state.get('pendingSell') and t not in ('sell', 'sell_end', 'undo', 'undoAll'):
        return _fail('SELL_PENDING', '请先结束当前售卖行动（继续出售或结束售卖）。', 'S0')
    if state.get('pendingForeclose') and t != 'foreclose_tile':
        return _fail('FORECLOSE_PENDING', '你正在强制拆板抵债，请点击自己的一块产业板块。', 'S0')
    return fn(state, action)
