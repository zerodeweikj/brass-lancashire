# -*- coding: utf-8 -*-
"""建造资格判定（era gate）全产业穷举回归。

背景：用户报告「第一回合点建造，铁厂正确地不亮，但**造船厂亮了**」——
玩家面板上两个 0 级造船厂（占位板块，era='无法建造'）都还没丢掉，
却能免费建造到地图上。

根因：引擎三处 era 校验都写成**否定式黑名单**——只拦 `canal_only` 与
`rail_only`，凡是没被列举的 era 取值一律放行。数据里实际存在 5 种 era：
    'canal_only' / 'rail_only' / 'any' / '无法建造' / '—'
后两种因此穿透全部校验。造船厂 L0 的 cost 是 {}，总价 0，于是「免费白建」。

本测试对 **全部 5 种产业 × 全部 0~4 级 × 运河/铁路两时代 × 4 种颜色**
做穷举，并加一条关键的一致性不变量：

    legal_build_targets 亮起的落点  ⟺  do_build 真的能建成

亮了却建不了 = 误导玩家；不亮却能建 = 校验漏网。两个方向都要堵死。

用法： python tests/test_build_era_gate.py
"""
import copy
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from engine import actions as A            # noqa: E402
from engine import build as B              # noqa: E402
from engine import data as D               # noqa: E402
from engine import flow as F               # noqa: E402
from engine import mechanics as M          # noqa: E402
from engine import setup                   # noqa: E402
from engine.state import get_player        # noqa: E402

RESULTS = []
INDS = ['铁厂', '煤厂', '造船厂', '港口', '棉花厂']


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- %s' % detail) if detail else ''))


def new_game(phase='canal', seed=7, money=999):
    st = setup.create_game(['甲', '乙', '丙', '丁'], seed=seed)
    st['phase'] = phase
    st['turnOrder'] = ['P1', 'P2', 'P3', 'P4']
    st['currentPlayer'] = 'P1'
    st['actionPoints'] = 2
    for p in st['players']:
        p['money'] = money
    return st


def expected_buildable(industry, level, phase):
    """按权威数据推导：该产业该等级在该时代**应该**可建吗。"""
    td = D.tile_def(industry, level)
    if not td:
        return False
    if not td.get('per_player'):      # 该等级根本不存在
        return False
    era = td.get('era')
    if era == 'any':
        return True
    if era == 'canal_only':
        return phase == 'canal'
    if era == 'rail_only':
        return phase == 'rail'
    return False                      # '无法建造' / '—' / 未知值 一律不可建


# ===================== 1. 数据层：era 取值必须全部已知 =====================
print('\n--- 1. 数据层 era 取值闭集 ---')
KNOWN_ERAS = {'canal_only', 'rail_only', 'any', '无法建造', '—'}
seen_eras = set(str(t.get('era')) for t in D.INDUSTRY_TILES)
check('era 取值全部在已知闭集内', seen_eras <= KNOWN_ERAS,
      '未知取值=%s' % (seen_eras - KNOWN_ERAS))

BUILDABLE_ERAS = {'canal_only', 'rail_only', 'any'}
non_buildable = [(t['industry'], t['level'], t.get('era'))
                 for t in D.INDUSTRY_TILES if t.get('era') not in BUILDABLE_ERAS]
check('不可建 era 的板块清单符合预期（5 个 L0 + 造船厂 L3/L4，共 7 项）',
      len(non_buildable) == 7, str(non_buildable))

sy0 = D.tile_def('造船厂', 0)
check("造船厂 L0 数据为占位块（era='无法建造'、cost 为空、per_player=2）",
      sy0 and sy0['era'] == '无法建造' and not (sy0.get('cost') or {}) and sy0.get('per_player') == 2,
      str(sy0 and {k: sy0.get(k) for k in ('era', 'cost', 'per_player')}))


# ===================== 2. buildable_level 全产业×全等级×双时代穷举 =====================
print('\n--- 2. buildable_level 穷举（5 产业 × 0~4 级 × 2 时代 = 50 组）---')
bad = []
for phase in ('canal', 'rail'):
    for ind in INDS:
        key = M.IND_CN2KEY[ind]
        for lv in range(5):
            st = new_game(phase)
            p = get_player(st, 'P1')
            # 把面板清成「只剩这一个等级」，逼 buildable_level 只能考虑它
            p['mat'][key] = {lv: 1}
            M.sync_min_build_level(p)
            got = F.buildable_level(st, p, ind)
            want = lv if expected_buildable(ind, lv, phase) else None
            if got != want:
                bad.append('%s %s L%d: 期望 %s 实得 %s' % (phase, ind, lv, want, got))
check('50 组 buildable_level 全部符合权威数据', not bad,
      ' | '.join(bad[:6]) + (' ...共%d条' % len(bad) if len(bad) > 6 else ''))


# ===================== 3. 造船厂 L0 占位块：三层校验都必须拒绝 =====================
print('\n--- 3. 造船厂 0 级占位块（用户报告的现场）---')
for phase in ('canal', 'rail'):
    st = new_game(phase)
    p = get_player(st, 'P1')
    check('[%s] 开局造船厂面板含 2 个 L0 占位块' % phase,
          p['mat']['shipyard'].get(0) == 2, str(p['mat']['shipyard']))
    check('[%s] L0 占位块未丢弃时 buildable_level(造船厂) 必须为 None' % phase,
          F.buildable_level(st, p, '造船厂') is None,
          '实得 %s' % F.buildable_level(st, p, '造船厂'))
    tg = [t for t in F.legal_build_targets(st, 'P1') if t['industry'] == '造船厂']
    check('[%s] 地图上造船厂高亮落点必须为 0 个' % phase, not tg,
          '实得 %d 个，如 %s' % (len(tg), tg[:2]))

# 3b. 绕过高亮直接调 do_build，必须被拒（校验层兜底）
st = new_game('canal')
p = get_player(st, 'P1')
sy_locs = [l['id'] for l in D.LOCATIONS
           if l.get('slots') and any('shipyard' in s for s in l['slots'])]
loc = sy_locs[0]
slot = next(i for i, s in enumerate(D.LOCATION_BY_ID[loc]['slots']) if 'shipyard' in s)
for cid, c in D.CARD_BY_ID.items():
    if c.get('type') == 'city' and c.get('city') == loc:
        p['hand'][0] = cid
        break
res = A.do_build(st, {'cardIds': [p['hand'][0]], 'location': loc,
                      'slotIndex': slot, 'industry': '造船厂'})
p_after = get_player(st, 'P1')
check('绕过高亮直调 do_build 造 0 级造船厂 → 必须被拒',
      res.get('ok') is False, 'ok=%s msg=%s' % (res.get('ok'), (res.get('message') or '')[:60]))
check('被拒后地图上没有多出板块', not p_after['industryTiles'],
      str([(t['location'], t['level']) for t in p_after['industryTiles']]))

# 3c. validate_build 层（双牌建造的第二层校验）
#     构造：铁路时代（无「每地点 1 板块」限制）+ 玩家在 LIVERPOOL 已有板块（进入运输网），
#     再用「LIVERPOOL 城市牌 + 造船厂产业牌」去建 LIVERPOOL 的造船厂槽位。
st = new_game('rail')
p = get_player(st, 'P1')
vb_loc = 'LIVERPOOL'
vb_slot = next(i for i, s in enumerate(D.LOCATION_BY_ID[vb_loc]['slots']) if 'shipyard' in s)
p['industryTiles'].append({'location': vb_loc, 'slotIndex': 99, 'level': 1,
                           'buildingId': 'building_005', 'flipped': False})
city_card = next(cid for cid, c in D.CARD_BY_ID.items()
                 if c.get('type') == 'city' and c.get('city') == vb_loc)
p['hand'] = [city_card, 'ind_building_003'] + list(p['hand'])
ok, code, msg, stage = B.validate_build(st, {
    'version': st['version'], 'playerId': 'P1', 'cityCardId': city_card,
    'industryCardId': 'ind_building_003', 'location': vb_loc, 'slotIndex': vb_slot})
check('validate_build 对 0 级造船厂返回失败', ok is False,
      'ok=%s code=%s msg=%s' % (ok, code, (msg or '')[:60]))


# ===================== 4. 丢掉 L0 后必须恢复正常（不能误杀）=====================
print('\n--- 4. 丢掉 2 个 L0 占位块后，造船厂应恢复可建 ---')
st = new_game('canal')
p = get_player(st, 'P1')
p['mat']['shipyard'][0] = 0
M.sync_min_build_level(p)
check('[canal] 丢完 L0 后 buildable_level = 1', F.buildable_level(st, p, '造船厂') == 1,
      '实得 %s' % F.buildable_level(st, p, '造船厂'))
# 造船厂 L1 造价 {16 钱, 1 铁, 1 煤}：第一回合无煤源 → 落点为 0 属正确表现。
# 因此给对手在同城放未翻面煤厂、别处放未翻面铁厂，构造「资源齐备」场景再验落点。
sy_loc = next(l['id'] for l in D.LOCATIONS
              if l.get('slots') and any('shipyard' in s for s in l['slots']))
opp = get_player(st, 'P2')
opp['industryTiles'].append({'id': 'T_COAL', 'location': sy_loc, 'slotIndex': 90,
                             'level': 1, 'buildingId': 'building_002',
                             'flipped': False, 'boardResources': 2})
opp['industryTiles'].append({'id': 'T_IRON', 'location': sy_loc, 'slotIndex': 91,
                             'level': 1, 'buildingId': 'building_001',
                             'flipped': False, 'boardResources': 4})
tg = [t for t in F.legal_build_targets(st, 'P1') if t['industry'] == '造船厂']
check('[canal] 丢完 L0 且煤铁齐备后，造船厂有合法落点且等级为 1',
      tg and all(t['level'] == 1 for t in tg), '%d 个落点 %s' % (len(tg), tg[:1]))

st = new_game('rail')
p = get_player(st, 'P1')
p['mat']['shipyard'][0] = 0
M.sync_min_build_level(p)
check('[rail] 丢完 L0 后 L1 是 canal_only → 仍不可建',
      F.buildable_level(st, p, '造船厂') is None,
      '实得 %s' % F.buildable_level(st, p, '造船厂'))
p['mat']['shipyard'][1] = 0
M.sync_min_build_level(p)
check('[rail] 再丢完 L1 后 L2（rail_only）可建',
      F.buildable_level(st, p, '造船厂') == 2,
      '实得 %s' % F.buildable_level(st, p, '造船厂'))


# ===================== 5. 其他产业不能被误杀 =====================
print('\n--- 5. 其他产业正例回归（不许误杀）---')
st = new_game('canal')
tg = F.legal_build_targets(st, 'P1')
from collections import Counter                                   # noqa: E402
dist = Counter('%s L%s' % (t['industry'], t['level']) for t in tg)
check('[canal] 煤厂 L1 有落点', dist.get('煤厂 L1', 0) > 0, str(dict(dist)))
check('[canal] 港口 L1 有落点', dist.get('港口 L1', 0) > 0, str(dict(dist)))
check('[canal] 棉花厂 L1 有落点', dist.get('棉花厂 L1', 0) > 0, str(dict(dist)))
check('[canal] 造船厂 0 个落点', dist.get('造船厂 L0', 0) == 0 and dist.get('造船厂 L1', 0) == 0,
      str(dict(dist)))

# 铁厂 L1 造价含 1 煤，新局无煤源 → 应被 total_cost 挡住（用户认可的正确表现）
check('[canal] 铁厂第一回合无煤源 → 无落点（用户确认的正确表现）',
      dist.get('铁厂 L1', 0) == 0, str(dict(dist)))

st = new_game('rail')
tg2 = F.legal_build_targets(st, 'P1')
check('[rail] 开局全部产业最低级都是 canal_only/占位 → 落点为 0',
      not tg2, str(Counter('%s L%s' % (t['industry'], t['level']) for t in tg2)))


# ===================== 5b. 反向对称：L0 不可建，但必须能被「发展」丢掉 =====================
print('\n--- 5b. 占位块的唯一出口：发展 ---')
st = new_game('canal')
p = get_player(st, 'P1')
before_sy = dict(p['mat']['shipyard'])
res = A.do_develop(st, {'industries': ['造船厂', '造船厂'], 'cardId': p['hand'][0]})
after_sy = dict(get_player(st, 'P1')['mat']['shipyard'])
check('造船厂 L0 占位块仍可被「发展」丢弃（不可建 ≠ 不可丢）',
      res.get('ok') is not False and after_sy.get(0, 0) == before_sy.get(0, 0) - 2,
      'before=%s after=%s res=%s' % (before_sy, after_sy, (res.get('message') or '')[:40]))
p = get_player(st, 'P1')
check('丢完 2 个 L0 后造船厂立刻变为可建（L1）',
      F.buildable_level(st, p, '造船厂') == 1,
      '面板=%s 实得 %s' % (p['mat']['shipyard'], F.buildable_level(st, p, '造船厂')))


# ===================== 6. 四色玩家一致性 =====================
print('\n--- 6. 四色玩家一致性 ---')
st = new_game('canal')
per_color = {}
for pid in ('P1', 'P2', 'P3', 'P4'):
    st['currentPlayer'] = pid
    pl = get_player(st, pid)
    per_color[pid] = {i: F.buildable_level(st, pl, i) for i in INDS}
base = per_color['P1']
check('四色玩家 buildable_level 完全一致',
      all(v == base for v in per_color.values()), str(per_color))
check('四色玩家造船厂均不可建（L0 未丢）',
      all(v['造船厂'] is None for v in per_color.values()), str(per_color))


# ===================== 7. 一致性不变量：亮起 ⟺ 建得成 =====================
print('\n--- 7. 一致性不变量：legal_build_targets 亮起 ⟺ do_build 建得成 ---')


def card_for(st, p, loc, ind):
    """挑一张能驱动该建造的手牌；没有就塞一张城市牌进手里。"""
    for cid in p['hand']:
        c = D.CARD_BY_ID.get(cid) or {}
        if c.get('type') == 'city' and c.get('city') == loc:
            return cid
        if c.get('type') == 'industry' and ind in (c.get('industries') or [c.get('industry')]):
            return cid
    for cid, c in D.CARD_BY_ID.items():
        if c.get('type') == 'city' and c.get('city') == loc:
            p['hand'][0] = cid
            return cid
    return p['hand'][0]


for phase in ('canal', 'rail'):
    base_st = new_game(phase)
    # 让 rail 时代也有内容可测：把面板推进到有可建等级
    if phase == 'rail':
        for pl in base_st['players']:
            for k in M.IND_KEYS:
                pl['mat'][k] = {l: c for l, c in pl['mat'][k].items() if l >= 2}
            M.sync_min_build_level(pl)
    targets = F.legal_build_targets(base_st, 'P1')
    fails = []
    for t in targets[:40]:                       # 抽样 40 个，避免过慢
        st2 = copy.deepcopy(base_st)
        p2 = get_player(st2, 'P1')
        cid = card_for(st2, p2, t['location'], t['industry'])
        r = A.do_build(st2, {'cardIds': [cid], 'location': t['location'],
                             'slotIndex': t['slotIndex'], 'industry': t['industry']})
        if r.get('ok') is False:
            fails.append('%s %s L%s: %s' % (t['location'], t['industry'], t['level'],
                                            (r.get('message') or '')[:40]))
    check('[%s] 所有高亮落点都能真正建成（抽样 %d 个）' % (phase, min(len(targets), 40)),
          not fails, ' | '.join(fails[:4]))

    # 反向：不可建的产业，强行建必须被拒
    rej_fail = []
    for ind in INDS:
        pl = get_player(base_st, 'P1')
        if F.buildable_level(base_st, pl, ind) is not None:
            continue
        locs = [l['id'] for l in D.LOCATIONS
                if l.get('slots') and any(M.IND_CN2KEY[ind] in s for s in l['slots'])]
        if not locs:
            continue
        st3 = copy.deepcopy(base_st)
        p3 = get_player(st3, 'P1')
        lc = locs[0]
        si = next(i for i, s in enumerate(D.LOCATION_BY_ID[lc]['slots'])
                  if M.IND_CN2KEY[ind] in s)
        cid = card_for(st3, p3, lc, ind)
        r = A.do_build(st3, {'cardIds': [cid], 'location': lc,
                             'slotIndex': si, 'industry': ind})
        if r.get('ok') is not False:
            rej_fail.append('%s @ %s 竟然建成了' % (ind, lc))
    check('[%s] 所有「不该亮」的产业强行建造都被拒绝' % phase, not rej_fail,
          ' | '.join(rej_fail))


# ===================== 汇总 =====================
print('\n' + '=' * 62)
passed = sum(1 for _, ok in RESULTS if ok)
print('通过 %d / %d' % (passed, len(RESULTS)))
if passed != len(RESULTS):
    print('失败项：')
    for n, ok in RESULTS:
        if not ok:
            print('   -', n)
sys.exit(0 if passed == len(RESULTS) else 1)
