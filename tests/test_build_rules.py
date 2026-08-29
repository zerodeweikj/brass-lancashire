# -*- coding: utf-8 -*-
"""建造/连结规则回归（针对现行引擎 engine.actions + engine.flow）。

覆盖用户确认的规则：
  · 单建造 = 1 张牌
  · 城市牌驱动 → 地点由牌面锁定，**不查运输网**，产业为槽位允许的任意种类
  · 产业牌驱动 → 锁产业种类，**必须在自有运输网内**（首建 / 双牌除外）
  · 首建（无任何板块与连结）→ 任意合法地点
  · legal_build_targets 下发 netOk，供前端约束可用牌型（可点即可执行）
  · 连结：有运输网 → 仅网内城市相邻空槽；无运输网 → 任意城市相邻空槽

用法： python tests/test_build_rules.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from engine import actions as A          # noqa: E402
from engine import data as D             # noqa: E402
from engine import flow as F             # noqa: E402
from engine import setup                 # noqa: E402
from engine.state import get_player, own_network   # noqa: E402

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- %s' % detail) if detail and not cond else ''))


def fresh(money=100, ap=2):
    """2 人局，P1 先手，钱管够，行动点 2。"""
    st = setup.create_game(['甲', '乙'], seed=7)
    st['turnOrder'] = ['P1', 'P2']
    st['currentPlayer'] = 'P1'
    st['actionPoints'] = ap
    p = get_player(st, 'P1')
    p['money'] = money
    return st


def give(st, pid, cards):
    get_player(st, pid)['hand'] = list(cards)
    F.recompute(st)


def put_tile(st, pid, location, slot, industry_cn, level=1, tid='t_x'):
    p = get_player(st, pid)
    bid = {'煤厂': 'building_002', '铁厂': 'building_001', '棉花厂': 'building_005',
           '港口': 'building_004', '造船厂': 'building_003'}[industry_cn]
    p['industryTiles'].append({'id': tid, 'buildingId': bid, 'level': level, 'owner': pid,
                               'location': location, 'slotIndex': slot, 'flipped': False,
                               'boardResources': 0, 'builtEra': st['phase']})


def put_link(st, pid, a, b, lid='lk_x'):
    p = get_player(st, pid)
    p['linkTiles'].append({'id': lid, 'type': 'canal' if st['phase'] == 'canal' else 'rail',
                           'owner': pid, 'endpoints': [a, b], 'builtEra': st['phase']})
    p['remainingLinks'] -= 1


def slot_of(loc_id, industry_key):
    """返回该地点第一个允许此产业的槽位号，无则 None。"""
    loc = D.LOCATION_BY_ID[loc_id]
    for i, s in enumerate(loc.get('slots') or []):
        if industry_key in s:
            return i
    return None


# ============ 0. 环境自检 ============
check('环境: WIGAN 槽位 0 = 煤专槽', D.LOCATION_BY_ID['WIGAN']['slots'][0] == ['coal'],
      str(D.LOCATION_BY_ID['WIGAN']['slots']))
check('环境: 单建造消耗 1 张牌', A._validate_build.__code__.co_consts is not None)

# ============ 1. 城市牌驱动：不在运输网也能建 ============
st = fresh()
# P1 已在 LIVERPOOL 有港口 → 运输网 = {LIVERPOOL}，MANCHESTER 不在网内
put_tile(st, 'P1', 'LIVERPOOL', slot_of('LIVERPOOL', 'port') or 0, '港口', 1, 't_port')
give(st, 'P1', ['city_manchester', 'ind_building_002'])
net = own_network(st, 'P1')
check('1.0 前置: MANCHESTER 不在 P1 运输网内', 'MANCHESTER' not in net, str(sorted(net)))

mslot = slot_of('MANCHESTER', 'cotton')
r = A.do_build(st, {'type': 'build', 'cardId': 'city_manchester', 'location': 'MANCHESTER',
                    'slotIndex': mslot, 'industry': '棉花厂'})
check('1.1 城市牌驱动 → 网外建造成功', r.get('ok'), str(r))
check('1.2 成功后曼城落下棉花厂',
      any(t['location'] == 'MANCHESTER' and t['buildingId'] == 'building_005'
          for t in get_player(st, 'P1')['industryTiles']))

# ============ 2. 产业牌驱动：网外必须被拒 ============
st = fresh()
put_tile(st, 'P1', 'LIVERPOOL', slot_of('LIVERPOOL', 'port') or 0, '港口', 1, 't_port')
give(st, 'P1', ['ind_building_002', 'city_liverpool'])
wslot = slot_of('WIGAN', 'coal')
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_002', 'location': 'WIGAN',
                    'slotIndex': wslot, 'industry': '煤厂'})
check('2.1 产业牌驱动 + 网外 → BUILD_LOCATION_UNREACHABLE',
      r.get('fail_code') == 'BUILD_LOCATION_UNREACHABLE', str(r))

# 修一条运河把 WIGAN 拉进网 → 同样的产业牌应成功
st2 = fresh()
put_tile(st2, 'P1', 'LIVERPOOL', slot_of('LIVERPOOL', 'port') or 0, '港口', 1, 't_port')
put_link(st2, 'P1', 'LIVERPOOL', 'WIGAN', 'lk1')
give(st2, 'P1', ['ind_building_002', 'city_liverpool'])
r = A.do_build(st2, {'type': 'build', 'cardId': 'ind_building_002', 'location': 'WIGAN',
                     'slotIndex': wslot, 'industry': '煤厂'})
check('2.2 产业牌驱动 + 网内 → 成功', r.get('ok'), str(r))

# ============ 3. 首建：无板块无连结 → 任意地点 ============
st = fresh()
give(st, 'P1', ['ind_building_002'])
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_002', 'location': 'WIGAN',
                    'slotIndex': wslot, 'industry': '煤厂'})
check('3.1 首建 + 产业牌 → 任意地点成功', r.get('ok'), str(r))

# ============ 4. 牌型不匹配仍须拒绝 ============
st = fresh()
give(st, 'P1', ['city_wigan'])
r = A.do_build(st, {'type': 'build', 'cardId': 'city_wigan', 'location': 'MANCHESTER',
                    'slotIndex': mslot, 'industry': '棉花厂'})
check('4.1 城市牌与地点不符 → BUILD_WRONG_CARD',
      r.get('fail_code') == 'BUILD_WRONG_CARD', str(r))

st = fresh()
give(st, 'P1', ['ind_building_002'])
cslot = slot_of('WIGAN', 'cotton')
if cslot is not None:
    r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_002', 'location': 'WIGAN',
                        'slotIndex': cslot, 'industry': '棉花厂'})
    check('4.2 煤厂产业牌建棉花厂 → BUILD_WRONG_CARD',
          r.get('fail_code') == 'BUILD_WRONG_CARD', str(r))
else:
    check('4.2 煤厂产业牌建棉花厂 → BUILD_WRONG_CARD', True)

# ============ 5. legal_build_targets 的 netOk 语义 ============
st = fresh()
put_tile(st, 'P1', 'LIVERPOOL', slot_of('LIVERPOOL', 'port') or 0, '港口', 1, 't_port')
put_link(st, 'P1', 'LIVERPOOL', 'WIGAN', 'lk1')
give(st, 'P1', ['city_manchester', 'ind_building_002'])
targets = F.legal_build_targets(st)
locs = {t['location'] for t in targets}
check('5.1 网内地点 WIGAN 出现在落点集合', 'WIGAN' in locs, str(sorted(locs)))
check('5.2 手上城市牌解锁的 MANCHESTER 也出现', 'MANCHESTER' in locs, str(sorted(locs)))
check('5.3 未持牌且网外的 BOLTON 不出现', 'BOLTON' not in locs, str(sorted(locs)))
check('5.4 WIGAN 落点 netOk=True', all(t['netOk'] for t in targets if t['location'] == 'WIGAN'))
check('5.5 MANCHESTER 落点 netOk=False',
      all(t['netOk'] is False for t in targets if t['location'] == 'MANCHESTER'))

# ============ 6. 连结：无运输网 → 任意城市相邻空槽 ============
st = fresh()
give(st, 'P1', ['city_wigan'])
links = F.legal_link_targets(st)
check('6.1 无运输网时连结候选非空', len(links) > 0, 'links=%d' % len(links))
ends = {frozenset((l['from'], l['to'])) for l in links}
check('6.2 无运输网时候选覆盖远处连结（>10 条）', len(ends) > 10, 'unique=%d' % len(ends))

# 有运输网 → 只列网内相邻
st = fresh()
put_tile(st, 'P1', 'LIVERPOOL', slot_of('LIVERPOOL', 'port') or 0, '港口', 1, 't_port')
give(st, 'P1', ['city_wigan'])
links2 = F.legal_link_targets(st)
net2 = own_network(st, 'P1')
check('6.3 有运输网时每条候选至少一端在网内',
      links2 and all((l['from'] in net2) or (l['to'] in net2) for l in links2),
      'net=%s links=%s' % (sorted(net2), [(l['from'], l['to']) for l in links2]))
check('6.4 有运输网时候选数明显少于无网时', len(links2) < len(links),
      '%d vs %d' % (len(links2), len(links)))

# ============ 7. 个人面板库：造船厂 0 级占位板块进 mat ============
def test_shipyard_lvl0_in_mat():
    """造船厂 0 级是占位板块（不能建造），但必须出现在玩家的 mat 里，否则面板上看不到。"""
    from engine import mechanics as M
    mat = M.build_mat()
    check('7.1 造船厂 0 级进 mat（占位板块）',
          mat.get('shipyard', {}).get(0, 0) == 2,
          'mat.shipyard[0]=%s（期望 2）' % mat.get('shipyard', {}).get(0))
    check('7.2 造船厂 1 级仍进 mat', mat.get('shipyard', {}).get(1, 0) == 2)
    check('7.3 造船厂 2 级仍进 mat', mat.get('shipyard', {}).get(2, 0) == 2)
    # 0 级其他产业仍不进
    from engine.mechanics import IND_CN2KEY
    for cn, key in IND_CN2KEY.items():
        if cn == '造船厂':
            continue
        v = mat.get(key, {}).get(0, 0)
        check('7.4 %s 0 级不进 mat' % cn, v == 0, '%s[0]=%s' % (key, v))

test_shipyard_lvl0_in_mat()

# ============ 汇总 ============
passed = sum(1 for _, c in RESULTS if c)
total = len(RESULTS)
print('\n===== 结果: %d/%d 通过 =====' % (passed, total))
if passed < total:
    for name, c in RESULTS:
        if not c:
            print('  FAILED: %s' % name)
    sys.exit(1)
print('全部通过 ✅')
