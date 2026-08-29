# -*- coding: utf-8 -*-
"""验证「玩家手动选择消耗哪座铁厂/煤厂」整条链路。

前端把选中的 tileId 列表作为 ironFrom / coalFrom 提交；
后端 apply_action -> pay_iron / pay_coal(preferred=...) 必须只消耗被选中的那座。
同时验证 flow.recompute 已下发 coalSources，供前端弹窗展示选项。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from engine.state import get_player
from engine import setup as SU
from engine import mechanics as M
from engine import flow as F

RESULTS = []
def check(name, cond, detail=''):
    RESULTS.append((name, cond))
    print(f"[{'PASS' if cond else 'FAIL'}] {name}" + (f'  -- {detail}' if detail and not cond else ''))

st = SU.create_game(['A', 'B', 'C', 'D'], phase='rail', seed=1)
p1 = get_player(st, 'P1')

# 注入两座铁厂（L1，各 4 铁）位于不同城市
p1['industryTiles'].append({'id': 'tile_IRON_A', 'buildingId': 'building_001', 'level': 1,
                            'owner': 'P1', 'location': 'MANCHESTER', 'slotIndex': 0,
                            'flipped': False, 'boardResources': 4, 'resourceType': 'iron', 'builtEra': 'rail'})
p1['industryTiles'].append({'id': 'tile_IRON_B', 'buildingId': 'building_001', 'level': 1,
                            'owner': 'P1', 'location': 'WIGAN', 'slotIndex': 0,
                            'flipped': False, 'boardResources': 4, 'resourceType': 'iron', 'builtEra': 'rail'})

# 注入两座煤厂（L1，各 2 煤）；让其中一座经运河可达 WIGAN
p1['industryTiles'].append({'id': 'tile_COAL_A', 'buildingId': 'building_002', 'level': 1,
                            'owner': 'P1', 'location': 'LIVERPOOL', 'slotIndex': 0,
                            'flipped': False, 'boardResources': 2, 'resourceType': 'coal', 'builtEra': 'rail'})
p1['industryTiles'].append({'id': 'tile_COAL_B', 'buildingId': 'building_002', 'level': 1,
                            'owner': 'P1', 'location': 'BOLTON', 'slotIndex': 0,
                            'flipped': False, 'boardResources': 2, 'resourceType': 'coal', 'builtEra': 'rail'})
p1['linkTiles'].append({'id': 'link_001', 'type': 'canal', 'owner': 'P1',
                        'endpoints': ['LIVERPOOL', 'WIGAN'], 'builtEra': 'canal'})
p1['remainingLinks'] = 13

# ---------- (a) recompute 下发 coalSources ----------
F.recompute(st)
check('recompute 下发 coalSources 含两座煤厂',
      len(st.get('coalSources', [])) == 2
      and {c['tileId'] for c in st['coalSources']} == {'tile_COAL_A', 'tile_COAL_B'},
      f"coalSources={st.get('coalSources')}")
check('recompute 下发 ironSources 含两座铁厂',
      len(st.get('ironSources', [])) == 2
      and {c['tileId'] for c in st['ironSources']} == {'tile_IRON_A', 'tile_IRON_B'},
      f"ironSources={st.get('ironSources')}")

# ---------- (b) 铁：只消耗选中的 tile_IRON_A ----------
res = M.pay_iron(st, 2, 'P1', preferred=['tile_IRON_A'])
check('pay_iron 优先消耗选中的 A 厂', 'tile_IRON_A' in res['from'] and 'tile_IRON_B' not in res['from'], str(res))
a = next(t for t in p1['industryTiles'] if t['id'] == 'tile_IRON_A')
b = next(t for t in p1['industryTiles'] if t['id'] == 'tile_IRON_B')
check('pay_iron 后 A 厂 4→2、B 厂仍为 4', a['boardResources'] == 2 and b['boardResources'] == 4,
      f"A={a['boardResources']} B={b['boardResources']}")
# 再消耗 3 铁，A 只剩 2 -> 从 B 补 1
res2 = M.pay_iron(st, 3, 'P1', preferred=['tile_IRON_A'])
a = next(t for t in p1['industryTiles'] if t['id'] == 'tile_IRON_A')
b = next(t for t in p1['industryTiles'] if t['id'] == 'tile_IRON_B')
check('pay_iron A 耗尽后从 B 补（A=0,B=3）', a['boardResources'] == 0 and b['boardResources'] == 3,
      f"A={a['boardResources']} B={b['boardResources']}")

# ---------- (c) 煤：只消耗选中的 tile_COAL_A（经 WIGAN 可达 LIVERPOOL） ----------
res3 = M.pay_coal(st, 'WIGAN', 1, 'P1', preferred=['tile_COAL_A'])
check('pay_coal 优先消耗选中的 A 厂（可达）', 'tile_COAL_A' in res3['from'] and 'tile_COAL_B' not in res3['from'], str(res3))
ca = next(t for t in p1['industryTiles'] if t['id'] == 'tile_COAL_A')
cb = next(t for t in p1['industryTiles'] if t['id'] == 'tile_COAL_B')
check('pay_coal 后 A 厂 2→1、B 厂仍为 2', ca['boardResources'] == 1 and cb['boardResources'] == 2,
      f"CA={ca['boardResources']} CB={cb['boardResources']}")
# 选中不可达的 B 厂（BOLTON 不在 WIGAN 网络）-> 引擎应忽略该选择并从可达源补
res4 = M.pay_coal(st, 'WIGAN', 1, 'P1', preferred=['tile_COAL_B'])
ca = next(t for t in p1['industryTiles'] if t['id'] == 'tile_COAL_A')
cb = next(t for t in p1['industryTiles'] if t['id'] == 'tile_COAL_B')
check('pay_coal 选中不可达源时被忽略（仍从 A 取，B 不变）',
      ca['boardResources'] == 0 and cb['boardResources'] == 2, f"CA={ca['boardResources']} CB={cb['boardResources']}")

# ---------- 汇总 ----------
passed = sum(1 for _, c in RESULTS if c)
total = len(RESULTS)
print(f'\n===== 结果: {passed}/{total} 通过 =====')
if passed < total:
    for name, c in RESULTS:
        if not c:
            print(f'  FAILED: {name}')
    sys.exit(1)
print('全部通过 ✅')
