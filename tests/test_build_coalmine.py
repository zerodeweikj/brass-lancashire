# -*- coding: utf-8 -*-
"""本地验证：玩家建造煤厂能否成功（成功路径 + 失败路径 + schema 合规）

场景（2 人局 · 运河时代第 2 轮 · 对齐《行动_成功失败路径清单》第三章）：
- 小明(P1, red)：金钱 12，手牌 [city_wigan, ind_building_002(煤厂), city_manchester, city_liverpool, ind_building_001(铁厂)]
- 小明已在利物浦建 1 港口（tile building_004），并修运河 利物浦—维根 → 维根在自有运输网内
- 目标：在维根(WIGAN) 槽位 0（煤厂专用槽）建煤厂 1 级
"""
import sys, os, json, copy
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine import data as D
from engine.state import create_initial_state, compute_buttons, get_player, own_network
from engine.build import apply_build

SCHEMA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'schema')


def make_state(**kw):
    st = create_initial_state([
        ('P1', 'red', ['city_wigan', 'ind_building_002', 'city_manchester', 'city_liverpool', 'ind_building_001'], 12),
        ('P2', 'yellow', ['city_liverpool', 'city_wigan', 'ind_building_004', 'city_manchester'], 30),
    ], phase=kw.get('phase', 'canal'), round_no=2)
    p1 = get_player(st, 'P1')
    # 小明在利物浦建 1 港口（1 级 6 钱，这里状态直接给出，模拟此前行动结果）
    p1['industryTiles'].append({'id': 'tile_001', 'buildingId': 'building_004', 'level': 1,
                                'owner': 'P1', 'location': 'LIVERPOOL', 'slotIndex': 0,
                                'flipped': False, 'boardResources': 0, 'builtEra': 'canal'})
    # 修运河 利物浦—维根
    p1['linkTiles'].append({'id': 'link_001', 'type': 'canal', 'owner': 'P1',
                            'endpoints': ['LIVERPOOL', 'WIGAN'], 'builtEra': 'canal'})
    p1['remainingLinks'] = 13
    if kw.get('money') is not None:
        p1['money'] = kw['money']
    if kw.get('extra_coal_mine'):
        # 已有 1 个 1 级煤厂（用于 F2-8 上限用例）
        p1['industryTiles'].append({'id': 'tile_099', 'buildingId': 'building_002', 'level': 1,
                                    'owner': 'P1', 'location': 'WIGAN', 'slotIndex': 1,
                                    'flipped': False, 'boardResources': 2, 'builtEra': 'canal'})
    if kw.get('manchester_link'):
        # 加修运河 利物浦—曼彻斯特 → 曼彻斯特进入自有运输网（供 F2-4/F2-8 使用）
        p1['linkTiles'].append({'id': 'link_002', 'type': 'canal', 'owner': 'P1',
                                'endpoints': ['LIVERPOOL', 'MANCHESTER'], 'builtEra': 'canal'})
    if kw.get('min_coal_level') is not None:
        p1['minBuildLevel']['coal'] = kw['min_coal_level']
    if kw.get('no_iron'):
        st['ironMarket'] = {'price1': 0, 'price2': 0, 'price3': 0, 'price4': 0}
    return st


def build_action(**kw):
    a = {'action': 'build', 'version': kw.get('version', 0), 'playerId': kw.get('playerId', 'P1'),
         'cityCardId': kw.get('cityCardId', 'city_wigan'),
         'industryCardId': kw.get('industryCardId', 'ind_building_002'),
         'location': kw.get('location', 'WIGAN'), 'slotIndex': kw.get('slotIndex', 0)}
    return a


RESULTS = []
def check(name, cond, detail=''):
    RESULTS.append((name, cond))
    mark = 'PASS' if cond else 'FAIL'
    print(f'[{mark}] {name}' + (f'  -- {detail}' if detail and not cond else ''))


# ========== 0. 环境自检 ==========
check('环境: 维根有煤槽位', D.LOCATION_BY_ID['WIGAN']['slots'][0] == ['coal'],
      f"slots={D.LOCATION_BY_ID['WIGAN']['slots']}")
check('环境: 煤厂1级=5钱/放2煤/1VP', D.tile_def('煤厂', 1)['cost'] == {'money': 5}
      and D.tile_def('煤厂', 1)['produce']['qty'] == 2)
check('环境: 收入轨 位置10=0 / 走4格=位置14=数值2',
      D.income_number(10) == 0 and D.income_number(14) == 2)

# ========== 1. 成功路径 ==========
st = make_state()
r = apply_build(st, build_action())
p1 = get_player(st, 'P1')
check('成功路径: 返回 ok', r['ok'], str(r))
check('成功路径: 手牌 5→3（扣城市牌+煤厂牌）', len(p1['hand']) == 3, f"hand={p1['hand']}")
check('成功路径: 金钱 12→7', p1['money'] == 7, f"money={p1['money']}")
check('成功路径: 行动点 2→1', st['actionPoints'] == 1)
check('成功路径: 维根有煤厂1级实例', any(t['buildingId'] == 'building_002' and t['location'] == 'WIGAN'
                                      and t['level'] == 1 and not t['flipped'] and t['boardResources'] == 2
                                      for t in p1['industryTiles']),
      f"tiles={[t for t in p1['industryTiles']]}")
check('成功路径: 收入轨不变(未翻面)', p1['incomePos'] == 10)
check('成功路径: 撤回栈压入1份快照', len(st['undoStack']) == 1)
check('成功路径: version 0→1', st['version'] == 1)
check('成功路径: 弃牌堆含2张牌', len(st['discardPile']) == 2, f"discard={st['discardPile']}")

# ========== 2. schema 合规（成功后的完整状态） ==========
from jsonschema import Draft202012Validator
schema = json.load(open(os.path.join(SCHEMA_DIR, 'game_state.schema.json'), encoding='utf-8'))
try:
    Draft202012Validator(schema).validate(st)
    check('schema: 成功后的 game_state 通过校验', True)
except Exception as e:
    check('schema: 成功后的 game_state 通过校验', False, str(e)[:200])

# ========== 3. 失败路径（第二层） ==========
r = apply_build(make_state(), build_action(cityCardId='city_manchester'))
check('F2-1 城市牌与地点不匹配 → BUILD_WRONG_CARD', r['fail_code'] == 'BUILD_WRONG_CARD', str(r))

r = apply_build(make_state(), build_action(industryCardId='ind_building_001'))
check('F2-2 产业牌非煤厂 → BUILD_WRONG_INDUSTRY', r['fail_code'] == 'BUILD_WRONG_INDUSTRY', str(r))

st = make_state(extra_coal_mine=True)
r = apply_build(st, build_action(slotIndex=0))
check('F2-3 槽位被占（运河时代每地点1板块）→ BUILD_SLOT_OCCUPIED', r['fail_code'] == 'BUILD_SLOT_OCCUPIED', str(r))

r = apply_build(make_state(), build_action(cityCardId='city_manchester', location='MANCHESTER'))
check('F2-4 不在运输网 → BUILD_LOCATION_UNREACHABLE', r['fail_code'] == 'BUILD_LOCATION_UNREACHABLE', str(r))

r = apply_build(make_state(money=4), build_action())
check('F2-5 金钱不足 → BUILD_INSUFFICIENT_MONEY', r['fail_code'] == 'BUILD_INSUFFICIENT_MONEY', str(r))

r = apply_build(make_state(min_coal_level=3, no_iron=True), build_action())
check('F2-6 铁不足(3级煤厂+1铁, 无铁源) → BUILD_INSUFFICIENT_IRON', r['fail_code'] == 'BUILD_INSUFFICIENT_IRON', str(r))

r = apply_build(make_state(phase='rail'), build_action())
check('F2-7 铁路时代建1级煤厂 → BUILD_WRONG_ERA', r['fail_code'] == 'BUILD_WRONG_ERA', str(r))

st = make_state(extra_coal_mine=True, manchester_link=True)
r = apply_build(st, build_action(cityCardId='city_manchester', location='MANCHESTER'))
check('F2-8 已达每人数量上限(1级煤厂×1) → BUILD_PLAYER_LIMIT', r['fail_code'] == 'BUILD_PLAYER_LIMIT', str(r))

r = apply_build(make_state(min_coal_level=5), build_action())
check('F2-9 供给不足(最低等级>4无牌) → BUILD_NO_SUPPLY', r['fail_code'] == 'BUILD_NO_SUPPLY', str(r))

r = apply_build(make_state(), build_action(version=999))
check('F2-10 version 过期并发 → VERSION_STALE', r['fail_code'] == 'VERSION_STALE', str(r))

r = apply_build(make_state(), build_action(playerId='P2'))
check('F2-11 非当前玩家 → NOT_YOUR_TURN', r['fail_code'] == 'NOT_YOUR_TURN', str(r))

# ========== 4. 失败回退语义（不耗手牌/行动点） ==========
st = make_state()
before = (copy.deepcopy(st['players']), st['actionPoints'], st['version'])
apply_build(st, build_action(location='BOLTON'))  # 失败
check('回退: 失败后玩家状态/行动点/version 均未变',
      st['players'] == before[0] and st['actionPoints'] == before[1] and st['version'] == before[2])

# ========== 5. 第一层按钮 enabled ==========
st = make_state()
btn = compute_buttons(st)
check('F1 前置: 正常场景建造按钮亮', btn['build'] is True, str(btn))

st = make_state()
get_player(st, 'P1')['hand'] = []  # 手牌=0
check('F1-1 手牌=0 → 建造按钮灰显', compute_buttons(st)['build'] is False)

st = make_state()
get_player(st, 'P1')['linkTiles'] = []  # 无连接 → 运输网仅利物浦(港口)，利物浦无煤槽位
get_player(st, 'P1')['industryTiles'] = [t for t in get_player(st, 'P1')['industryTiles'] if t['location'] != 'WIGAN']
check('F1-2 运输网内无煤槽位 → 建造按钮灰显', compute_buttons(st)['build'] is False)

st = make_state(money=3)
check('F1-6 钱<5 → 建造按钮灰显', compute_buttons(st)['build'] is False)

st = make_state(phase='rail')
check('F1-7 铁路时代+仅1级煤厂牌 → 建造按钮灰显', compute_buttons(st)['build'] is False)

# ========== 汇总 ==========
passed = sum(1 for _, c in RESULTS if c)
total = len(RESULTS)
print(f'\n===== 结果: {passed}/{total} 通过 =====')
if passed < total:
    for name, c in RESULTS:
        if not c:
            print(f'  FAILED: {name}')
    sys.exit(1)
print('全部通过 ✅')
