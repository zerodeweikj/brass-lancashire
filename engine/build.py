# -*- coding: utf-8 -*-
"""建造工业板块（含建造煤厂）：第二层校验 + 执行 + 失败回退

失败码与《兰开夏_行动_成功失败路径清单》第三章一致：
F2-1 BUILD_WRONG_CARD / F2-2 BUILD_WRONG_INDUSTRY / F2-3 BUILD_SLOT_OCCUPIED /
F2-4 BUILD_LOCATION_UNREACHABLE / F2-5 BUILD_INSUFFICIENT_MONEY / F2-6 BUILD_INSUFFICIENT_IRON /
F2-7 BUILD_WRONG_ERA / F2-8 BUILD_PLAYER_LIMIT / F2-9 BUILD_NO_SUPPLY /
F2-10 VERSION_STALE / F2-11 NOT_YOUR_TURN
"""
import copy
from . import data as D
from .state import get_player, own_network


def validate_build(state, action):
    """第二层校验。返回 (ok, fail_code, message, retry_target) 或 (True, None, None, None)"""
    # 版本防竞态（F2-10）
    if action.get('version', -1) != state['version']:
        return (False, 'VERSION_STALE', '提示：游戏状态已更新，请重新确认你的行动。', 'S0')
    # 当前玩家（F2-11）
    if action.get('playerId', state['currentPlayer']) != state['currentPlayer']:
        return (False, 'NOT_YOUR_TURN', '提示：当前不是你的回合。', 'S0')
    p = get_player(state, state['currentPlayer'])
    phase = state['phase']

    city_card = action.get('cityCardId')
    ind_card = action.get('industryCardId')
    location = action.get('location')
    slot_index = action.get('slotIndex', 0)

    # 牌型：城市牌在手中且匹配地点（F2-1）
    if city_card not in p['hand'] or D.CARD_BY_ID.get(city_card, {}).get('city') != location:
        return (False, 'BUILD_WRONG_CARD', '错误：所选城市牌与建造地点不匹配，请重新选择。', 'S2')
    # 牌型：产业牌在手中且为煤厂（F2-2）——本模块面向煤厂验证，产业类型由产业牌决定
    ind_card_def = D.CARD_BY_ID.get(ind_card, {})
    if ind_card not in p['hand'] or ind_card_def.get('type') != 'industry':
        return (False, 'BUILD_WRONG_INDUSTRY', '错误：所选产业牌类型与槽位不匹配。', 'S2')
    industry = ind_card_def.get('industry')  # 如 '煤厂'
    # 槽位：该地点有该产业可用槽位（F2-2 一部分：产业牌与槽位类型不匹配）
    loc_def = D.LOCATION_BY_ID.get(location)
    if not loc_def or slot_index >= len(loc_def['slots']):
        return (False, 'BUILD_WRONG_INDUSTRY', f'错误：所选产业牌类型与槽位不匹配。{location} 没有第 {slot_index + 1} 个槽位。', 'S2')
    if _industry_key(industry) not in loc_def['slots'][slot_index]:
        return (False, 'BUILD_WRONG_INDUSTRY', f'错误：所选产业牌类型与槽位不匹配。{location} 槽位 {slot_index + 1} 不可建{industry}。', 'S2')

    # 位置：在自有运输网内（F2-4）
    net = own_network(state, p['id'])
    if location not in net:
        return (False, 'BUILD_LOCATION_UNREACHABLE',
                '错误：该城市不在你的运输网范围内。你需要先建造连接板块（修路）或在该城市已有至少一个你的工业板块。', 'S1')

    # 槽位占用：运河时代每地点最多 1 板块（F2-3）
    if phase == 'canal' and any(t['location'] == location for t in p['industryTiles']):
        return (False, 'BUILD_SLOT_OCCUPIED',
                f'错误：该城市的槽位已被占用（运河时代每地点最多 1 个工业板块），请换城市。', 'S2')

    # 等级与时代（F2-7）——资格判定与 flow / actions 同源（D.tile_buildable）
    level = p['minBuildLevel'][_industry_key(industry)]
    tile = D.tile_def(industry, level)
    ok_tile, code_tile, msg_tile = D.tile_buildable(tile, phase)
    if not ok_tile:
        return (False, code_tile, '错误：' + msg_tile,
                'S0' if code_tile == 'BUILD_NO_SUPPLY' else 'S2')

    # 供给（F2-9）
    if level > 4:
        return (False, 'BUILD_NO_SUPPLY', f'错误：没有可用的{industry}板块！最低可建等级已超过可建上限。', 'S0')

    # 资源：金钱（F2-5）
    cost = tile['cost']
    money_needed = cost.get('money', 0)
    if p['money'] < money_needed:
        return (False, 'BUILD_INSUFFICIENT_MONEY',
                f'错误：金钱不足。建造该级{industry}需要 {money_needed} 钱，你当前只有 {p["money"]} 钱。可考虑贷款后再建造。', 'S4')
    # 资源：煤/铁（F2-6 铁；煤源走 S3 手动选，此处校验铁）
    iron_needed = cost.get('iron', 0)
    if iron_needed > 0:
        # 铁：任意未翻面铁厂免费拿或市场买（简化：本验证只建 1 级煤厂不耗铁；铁来源逻辑后续行动落地）
        have_free = any(t['buildingId'] == 'building_001' and not t['flipped'] for t in state['players'][0]['industryTiles'])
        # 铁市场最低档买得起
        iron_market_total = sum(state['ironMarket'][f'price{i}'] for i in (1, 2, 3, 4))
        if not have_free and iron_market_total == 0:
            return (False, 'BUILD_INSUFFICIENT_IRON',
                    f'错误：铁不足。建造 {level} 级{industry}需要 {iron_needed} 铁，无可用的未翻面铁厂且铁市场无供应。', 'S4')

    # 上限：每人数量（F2-8）
    per_player = tile['per_player']
    owned = sum(1 for t in p['industryTiles'] if t['buildingId'] == tile['building_id'] and t['level'] == level)
    if owned >= per_player:
        return (False, 'BUILD_PLAYER_LIMIT',
                f'错误：你已拥有该等级{industry}的上限数量（{per_player} 个）。可先发展至更高等级。请选择其他等级。', 'S2')

    return (True, None, None, None)


def _industry_key(industry):
    """产业中文名 → minBuildLevel 键名"""
    return {'铁厂': 'iron', '煤厂': 'coal', '造船厂': 'shipyard', '港口': 'port', '棉花厂': 'cotton'}[industry]


def execute_build(state, action):
    """执行建造（须先通过 validate_build）。直接修改 state；version +1。"""
    p = get_player(state, state['currentPlayer'])
    phase = state['phase']
    city_card = action['cityCardId']
    ind_card = action['industryCardId']
    location = action['location']
    slot_index = action.get('slotIndex', 0)
    industry = D.CARD_BY_ID[ind_card]['industry']
    tile = D.tile_def(industry, p['minBuildLevel'][_industry_key(industry)])
    level = tile['level']

    # 1) 压行动前快照（6.2 / 6.12 共用同一栈）
    state['undoStack'].append(copy.deepcopy(state))
    # 2) 扣手牌 → 弃牌堆
    p['hand'].remove(city_card)
    p['hand'].remove(ind_card)
    state['discardPile'] += [city_card, ind_card]
    # 3) 扣金钱（本验证只涉及金钱；煤/铁消耗按 tile.cost 处理为后续行动）
    cost = tile['cost']
    p['money'] -= cost.get('money', 0)
    p['spentThisRound'] += cost.get('money', 0)
    # 4) 行动点 -1
    state['actionPoints'] -= 1
    # 5) 建板块实例
    tile_id = f"tile_{len([t for pl in state['players'] for t in pl['industryTiles']]) + 1:03d}"
    board_res = tile['produce']['qty'] if tile['produce'] and tile['produce']['type'] in ('coal', 'iron') else 0
    instance = {
        'id': tile_id, 'buildingId': tile['building_id'], 'level': level,
        'owner': p['id'], 'location': location, 'slotIndex': slot_index,
        'flipped': False, 'boardResources': board_res, 'builtEra': phase,
    }
    p['industryTiles'].append(instance)
    # 造船厂 1 级建造后立即翻面（扩展预留；煤厂走板上煤=0 翻面）
    if tile['flip'] == 'flip_on_build':
        instance['flipped'] = True
    # 6) 版本 +1
    state['version'] += 1


def apply_build(state, action):
    """完整入口：校验 → 执行。失败时不做任何修改（快照回退语义：不耗手牌/行动点）。"""
    ok, code, msg, retry = validate_build(state, action)
    if not ok:
        return {'ok': False, 'fail_code': code, 'message': msg, 'retry_target': retry}
    execute_build(state, action)
    return {'ok': True, 'fail_code': None, 'message': '建造成功', 'retry_target': None}
