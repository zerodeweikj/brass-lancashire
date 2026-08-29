# -*- coding: utf-8 -*-
"""补市场抉择回归（2026-08-11 用户拍板）。

规则：
· 建造铁/煤厂后【必须由玩家选择】是否把产出补入市场，系统不默认补入。
· 补入 = 资源从板块【移动】到市场空槽（最高价优先），立即得钱 = 槽位面值之和
  （例：空槽 3/2/2/1/1，L1 铁产 4 → 补 4 得 3+2+2+1=8）。
· 补得下多少补多少：L4 铁产 6、空槽 5 → 补 5 留 1，得 3+2+2+1+1=9。
· 板块全部卖出（boardResources<=0）才翻面并得翻面奖励（收入轨前进）；部分补充/留板不翻面。
· 煤厂补入需建造地连市场标记；市场无空槽不弹窗、资源留板。
· 待补市场期间：其他行动被拒（SUPPLEMENT_PENDING），仅补市场/撤回放行。

用法： python tests/test_supplement_market.py
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
from engine import mechanics as M        # noqa: E402
from engine import setup                 # noqa: E402
from engine.state import get_player      # noqa: E402

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- %s' % detail) if detail and not cond else ''))


def fresh(money=200, ap=2):
    """2 人局 P1 先手；P1 在 LIVERPOOL 有港口（市场标记）+ 运河 LIVERPOOL—WIGAN。"""
    st = setup.create_game(['甲', '乙'], seed=7)
    st['turnOrder'] = ['P1', 'P2']
    st['currentPlayer'] = 'P1'
    st['actionPoints'] = ap
    p = get_player(st, 'P1')
    p['money'] = money
    p['industryTiles'].append({'id': 't_port', 'buildingId': 'building_004', 'level': 1,
                               'owner': 'P1', 'location': 'LIVERPOOL', 'slotIndex': 0,
                               'flipped': False, 'boardResources': 0, 'builtEra': 'canal'})
    p['linkTiles'].append({'id': 'lk1', 'type': 'canal', 'owner': 'P1',
                           'endpoints': ['LIVERPOOL', 'WIGAN'], 'builtEra': 'canal'})
    return st


def net_to_manchester(st):
    """补 WIGAN—MANCHESTER 运河，让 MANCHESTER 进自有运输网（铁厂建在 MANCHESTER）。"""
    p = get_player(st, 'P1')
    p['linkTiles'].append({'id': 'lk2', 'type': 'canal', 'owner': 'P1',
                           'endpoints': ['WIGAN', 'MANCHESTER'], 'builtEra': 'canal'})
    p['industryTiles'].append({'id': 't_coal', 'buildingId': 'building_002', 'level': 1,
                               'owner': 'P1', 'location': 'WIGAN', 'slotIndex': 0,
                               'flipped': False, 'boardResources': 2, 'resourceType': 'coal',
                               'builtEra': 'canal'})


def give(st, pid, cards):
    get_player(st, pid)['hand'] = list(cards)
    F.recompute(st)


def set_market(st, res, price1, price2, price3, price4):
    st[res + 'Market'].update({'price1': price1, 'price2': price2,
                               'price3': price3, 'price4': price4})


def iron_up_to(st, level):
    """面板直接升到指定等级的铁厂（模拟已发展），minBuildLevel 同步。"""
    p = get_player(st, 'P1')
    p['mat']['iron'] = {level: 1}
    p['minBuildLevel']['iron'] = level


def build_iron(st, level=1):
    net_to_manchester(st)
    iron_up_to(st, level)
    give(st, 'P1', ['ind_building_001', 'city_manchester'])
    return A.do_build(st, {'type': 'build', 'cardId': 'ind_building_001',
                           'location': 'MANCHESTER', 'slotIndex': 3, 'industry': '铁厂'})


# ============ 0. 环境自检 ============
check('环境: 铁 L1 产 4 铁 / 翻面收入 3', D.tile_def('铁厂', 1)['produce']['qty'] == 4
      and D.tile_def('铁厂', 1)['flip_income'] == 3)
check('环境: 铁 L4 产 6 铁 / 翻面收入 1', D.tile_def('铁厂', 4)['produce']['qty'] == 6
      and D.tile_def('铁厂', 4)['flip_income'] == 1)
check('环境: 煤 L1 产 2 煤 / 翻面收入 4', D.tile_def('煤厂', 1)['produce']['qty'] == 2
      and D.tile_def('煤厂', 1)['flip_income'] == 4)

# ============ 1. 建造铁厂 → 必须弹报价，不默认补入 ============
st = fresh()
set_market(st, 'iron', 0, 0, 1, 2)          # 空槽 3/2/2/1/1（用户原例）
r = build_iron(st, 1)
p = get_player(st, 'P1')
tile = [t for t in p['industryTiles'] if t['buildingId'] == 'building_001'][0]
need = (r.get('detail') or {}).get('needSupplement')
check('1.1 建铁厂成功且返回 needSupplement', r['ok'] and need is not None, str(r))
check('1.2 报价 4 铁全可补、得 8 钱、将翻面',
      need and need['qty'] == 4 and need['put'] == 4 and need['gain'] == 8
      and need['willFlip'] is True, str(need))
check('1.3 未自动补入：钱仅扣造价（200-5-0=195）', p['money'] == 195, str(p['money']))
check('1.4 板块未翻面、4 铁仍在板上', not tile['flipped'] and tile['boardResources'] == 4)
check('1.5 收入轨未动', p['incomePos'] == 10)
check('1.6 行动点已扣（2→1）且回合暂停在下家前', st['actionPoints'] == 1
      and st['currentPlayer'] == 'P1')
check('1.7 服务端记录 pendingSupplement', bool(st.get('pendingSupplement'))
      and st['pendingSupplement']['tileId'] == tile['id'])

# ============ 2. pending 期间其他行动被拒 ============
r2 = A.apply_action(st, {'type': 'skip', 'cardId': 'city_manchester', 'playerId': 'P1'})
check('2.1 其他行动 → SUPPLEMENT_PENDING', r2.get('fail_code') == 'SUPPLEMENT_PENDING', str(r2))
r2b = A.apply_action(st, {'type': 'endTurn', 'playerId': 'P1'})
check('2.2 结束回合也被拒（须先抉择）', r2b.get('fail_code') == 'SUPPLEMENT_PENDING', str(r2b))

# ============ 3. 选「补入市场」→ 移动+给钱+全卖翻面 ============
r3 = A.do_supplement(st, {'type': 'supplement_market', 'supply': True, 'playerId': 'P1'})
im = st['ironMarket']
check('3.1 补入 4 铁得 8 钱（3+2+2+1）',
      r3['detail']['put'] == 4 and r3['detail']['gain'] == 8, str(r3['detail']))
check('3.2 市场按高价优先回填（3档1格+2档2格+1档1格）',
      im['price1'] == 1 and im['price2'] == 2 and im['price3'] == 2 and im['price4'] == 2, str(im))
check('3.3 板块资源清零且翻面', tile['boardResources'] == 0 and tile['flipped'] is True)
check('3.4 翻面奖励：收入轨 +3（10→13）', p['incomePos'] == 13, str(p['incomePos']))
check('3.5 钱 = 195+8 = 203', p['money'] == 203, str(p['money']))
check('3.6 pending 已清', not st.get('pendingSupplement'))

# ============ 4. L4 铁厂部分补充：补 5 留 1、得 9、不翻面 ============
st = fresh()
set_market(st, 'iron', 0, 0, 1, 2)          # 空槽 3/2/2/1/1 共 5 个
r = build_iron(st, 4)
p = get_player(st, 'P1')
tile = [t for t in p['industryTiles'] if t['buildingId'] == 'building_001'][0]
need = r['detail']['needSupplement']
check('4.1 L4 报价：6 铁只能补 5、得 9、不翻面',
      need['qty'] == 6 and need['put'] == 5 and need['gain'] == 9 and need['willFlip'] is False,
      str(need))
r4 = A.do_supplement(st, {'type': 'supplement_market', 'supply': True, 'playerId': 'P1'})
check('4.2 补 5 得 9（3+2+2+1+1）',
      r4['detail']['put'] == 5 and r4['detail']['gain'] == 9, str(r4['detail']))
check('4.3 市场满（5 空槽全部回填）',
      st['ironMarket']['price1'] == 2 and st['ironMarket']['price2'] == 2
      and st['ironMarket']['price3'] == 2 and st['ironMarket']['price4'] == 2,
      str(st['ironMarket']))
check('4.4 板块剩 1 铁、不翻面（资源未耗尽）',
      tile['boardResources'] == 1 and not tile['flipped'])
check('4.5 收入轨不动', p['incomePos'] == 10)

# ============ 5. 选「留在板块上」→ 全留、不给钱、不翻面 ============
st = fresh()
set_market(st, 'iron', 0, 0, 1, 2)
r = build_iron(st, 1)
p = get_player(st, 'P1')
tile = [t for t in p['industryTiles'] if t['buildingId'] == 'building_001'][0]
before_market = dict(st['ironMarket'])
r5 = A.do_supplement(st, {'type': 'supplement_market', 'supply': False, 'playerId': 'P1'})
check('5.1 留板回执 put=0 gain=0', r5['detail']['put'] == 0 and r5['detail']['gain'] == 0, str(r5['detail']))
check('5.2 板块 4 铁全留、不翻面', tile['boardResources'] == 4 and not tile['flipped'])
check('5.3 市场一字未动', st['ironMarket'] == before_market, str(st['ironMarket']))
check('5.4 钱不变、收入轨不动', p['money'] == 195 and p['incomePos'] == 10)

# ============ 6. 煤厂：连市场才有报价；不连则直接留板 ============
# 6a 连市场（LIVERPOOL 港口 + 运河）→ 报价
st = fresh()
set_market(st, 'coal', 0, 0, 0, 0)
give(st, 'P1', ['ind_building_002', 'city_manchester'])
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_002',
                    'location': 'WIGAN', 'slotIndex': 0, 'industry': '煤厂'})
need = (r.get('detail') or {}).get('needSupplement')
check('6.1 煤厂连市场 → 报价（2 煤补 2 得 8）',
      r['ok'] and need and need['qty'] == 2 and need['put'] == 2 and need['gain'] == 8
      and need['willFlip'] is True, str(need))
# 6b 不连市场（无港口无运河）→ 无报价、资源留板
st = setup.create_game(['甲', '乙'], seed=7)
st['turnOrder'] = ['P1', 'P2']; st['currentPlayer'] = 'P1'; st['actionPoints'] = 2
p = get_player(st, 'P1'); p['money'] = 100
set_market(st, 'coal', 0, 0, 0, 0)
give(st, 'P1', ['ind_building_002'])
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_002',
                    'location': 'WIGAN', 'slotIndex': 0, 'industry': '煤厂'})
p = get_player(st, 'P1')
tile = [t for t in p['industryTiles'] if t['buildingId'] == 'building_002'][0]
check('6.2 煤厂不连市场 → 无报价', r['ok'] and (r.get('detail') or {}).get('needSupplement') is None, str(r))
check('6.3 不连市场 → 煤留板不翻面、无 pending',
      tile['boardResources'] == 2 and not tile['flipped'] and not st.get('pendingSupplement'))

# ============ 7. 市场满槽 → 无报价、正常推进 ============
st = fresh()
set_market(st, 'iron', 2, 2, 2, 2)           # 全满
r = build_iron(st, 1)
p = get_player(st, 'P1')
tile = [t for t in p['industryTiles'] if t['buildingId'] == 'building_001'][0]
check('7.1 市场满 → 无报价、无 pending',
      r['ok'] and (r.get('detail') or {}).get('needSupplement') is None
      and not st.get('pendingSupplement'), str(r))
check('7.2 市场满 → 铁留板不翻面',
      tile['boardResources'] == 4 and not tile['flipped'])
check('7.3 市场满 → 回合照常流转（after_action 已执行）',
      st['actionPoints'] == 1 and st['currentPlayer'] == 'P1')

# ============ 8. pending 下撤回放行并完整还原 ============
st = fresh()
set_market(st, 'iron', 0, 0, 1, 2)
net_to_manchester(st)
iron_up_to(st, 1)
give(st, 'P1', ['ind_building_001', 'city_manchester'])
p1 = get_player(st, 'P1')
tiles_before = [t['id'] for t in p1['industryTiles']]
money_before = p1['money']
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_001',
                    'location': 'MANCHESTER', 'slotIndex': 3, 'industry': '铁厂'})
assert r['ok'] and st.get('pendingSupplement')
ru = A.apply_action(st, {'type': 'undo', 'playerId': 'P1'})
p1 = get_player(st, 'P1')
check('8.1 pending 下撤回成功', ru['ok'], str(ru))
check('8.2 撤回后 pending 清除、板块/金钱完整还原',
      not st.get('pendingSupplement') and [t['id'] for t in p1['industryTiles']] == tiles_before
      and p1['money'] == money_before)

# ============ 9. 补市场后回合推进：行动点耗尽 → 下家 ============
st = fresh(ap=1)
set_market(st, 'iron', 0, 0, 1, 2)
r = build_iron(st, 1)
check('9.1 只剩 1 行动点时建造后暂停', st['currentPlayer'] == 'P1'
      and st['actionPoints'] == 0 and st.get('pendingSupplement'))
A.do_supplement(st, {'type': 'supplement_market', 'supply': True, 'playerId': 'P1'})
check('9.2 补市场后行动点耗尽 → 回合交给下家', st['currentPlayer'] == 'P2'
      and not st.get('pendingSupplement'), str(st['currentPlayer']))

# ============ 10. 无 pending 时补市场动作被拒 ============
st = fresh()
r = A.do_supplement(st, {'type': 'supplement_market', 'supply': True, 'playerId': 'P1'})
check('10.1 无 pending → SUPPLEMENT_NONE', r.get('fail_code') == 'SUPPLEMENT_NONE', str(r))

# ============ 11. sell_to_market 降序填充（直接机制层验证） ============
st = fresh()
set_market(st, 'iron', 0, 0, 1, 2)          # 空槽 3/2/2/1/1
put2, gain2 = M.supplement_budget(st, 'iron', 4)
check('11.1 预算函数 4 铁按 3+2+2+1 得 8（只读）',
      put2 == 4 and gain2 == 8, 'put=%d gain=%d' % (put2, gain2))
put, gain = M.sell_to_market(st, 'iron', 4, 'P1')
check('11.2 实卖 4 铁同样得 8（高价优先）', put == 4 and gain == 8, 'put=%d gain=%d' % (put, gain))

# ============ 12. 翻面铁律：只要板上无资源就【立刻】翻面（与是否补入无关，2026-08-11 用户强调） ============
# 12a 市场满 → 铁留板不翻；被其他玩家消耗至 0 → 立刻翻面 + 收入奖励
st = fresh()
net_to_manchester(st)
give(st, 'P1', ['ind_building_001', 'city_manchester'])
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_001',
                    'location': 'MANCHESTER', 'slotIndex': 3, 'industry': '铁厂'})
tile = [t for t in get_player(st, 'P1')['industryTiles'] if t['buildingId'] == 'building_001'][0]
check('12a 市场满 → 铁留板不翻', not tile['flipped'] and tile['boardResources'] == 4)
M.pay_iron(st, 1, 'P2', preferred=[tile['id']])
check('12a 耗 1 铁（剩 3）→ 仍不翻', tile['boardResources'] == 3 and not tile['flipped'])
M.pay_iron(st, 3, 'P2', preferred=[tile['id']])
check('12a 铁被耗光（boardResources=0）→ 立刻翻面 + 收入轨 +3（L1 铁）',
      tile['boardResources'] == 0 and tile['flipped'] is True
      and get_player(st, 'P1')['incomePos'] == 13,
      'boardRes=%s flipped=%s income=%s' % (tile['boardResources'], tile['flipped'],
                                            get_player(st, 'P1')['incomePos']))

# 12b 选「留在板块上」→ 煤留板；被消耗至 0 → 立刻翻面 + 收入 +4（煤 L1）
st = fresh()
set_market(st, 'coal', 0, 0, 1, 2)
give(st, 'P1', ['ind_building_002', 'city_manchester'])
r = A.do_build(st, {'type': 'build', 'cardId': 'ind_building_002',
                    'location': 'WIGAN', 'slotIndex': 0, 'industry': '煤厂'})
tile = [t for t in get_player(st, 'P1')['industryTiles'] if t['buildingId'] == 'building_002'][0]
A.do_supplement(st, {'type': 'supplement_market', 'supply': False, 'playerId': 'P1'})
check('12b 选留板 → 煤全留不翻', tile['boardResources'] == 2 and not tile['flipped'])
M.pay_coal(st, 'WIGAN', 1, 'P2', preferred=[tile['id']])
check('12b 耗 1 煤（剩 1）→ 仍不翻', tile['boardResources'] == 1 and not tile['flipped'])
M.pay_coal(st, 'WIGAN', 1, 'P2', preferred=[tile['id']])
check('12b 煤被耗光 → 立刻翻面 + 收入轨 +4（煤 L1）',
      tile['boardResources'] == 0 and tile['flipped'] is True
      and get_player(st, 'P1')['incomePos'] == 14,
      'boardRes=%s flipped=%s income=%s' % (tile['boardResources'], tile['flipped'],
                                            get_player(st, 'P1')['incomePos']))

# 12c 部分补充（L4 补 5 留 1）→ 留的 1 铁被耗光 → 也立刻翻面 + 收入 +1（L4 铁）
st = fresh()
set_market(st, 'iron', 0, 0, 1, 2)          # 空槽 3/2/2/1/1 共 5
r = build_iron(st, 4)
tile = [t for t in get_player(st, 'P1')['industryTiles'] if t['buildingId'] == 'building_001'][0]
A.do_supplement(st, {'type': 'supplement_market', 'supply': True, 'playerId': 'P1'})
check('12c 部分补充后剩 1 铁 → 不翻', tile['boardResources'] == 1 and not tile['flipped'])
M.pay_iron(st, 1, 'P2', preferred=[tile['id']])
check('12c 留的 1 铁被耗光 → 立刻翻面 + 收入轨 +1（L4 铁）',
      tile['boardResources'] == 0 and tile['flipped'] is True
      and get_player(st, 'P1')['incomePos'] == 11,
      'boardRes=%s flipped=%s income=%s' % (tile['boardResources'], tile['flipped'],
                                            get_player(st, 'P1')['incomePos']))

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
