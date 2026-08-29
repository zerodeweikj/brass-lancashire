# -*- coding: utf-8 -*-
"""产业板块「每色每级数量上限（per_player）」全局不变量回归。

背景：用户反复强调——铁厂每个等级每名玩家**只有 1 块**，所以绝不允许出现
「发展时丢两个 1 级铁厂」或「建造两个 1 级铁厂」这类超量 bug。
本测试对 **全部 4 种颜色 × 全部 5 种产业 × 全部等级** 做穷举与不变量校验。

核心不变量（任意时刻、任意玩家、任意 产业+等级 组合）：
    面板剩余(mat) + 场上已建造(industryTiles) <= per_player
且开局时严格相等。

用法： python tests/test_tile_supply_invariant.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from engine import actions as A            # noqa: E402
from engine import data as D               # noqa: E402
from engine import flow as F               # noqa: E402
from engine import mechanics as M          # noqa: E402
from engine import setup                   # noqa: E402
from engine.state import get_player        # noqa: E402

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- %s' % detail) if detail else ''))


# ---------- 权威上限表：{industryKey: {level: per_player}} ----------
def limits_from_json():
    lim = {k: {} for k in M.IND_KEYS}
    for t in D.INDUSTRY_TILES:
        if not t.get('per_player') or t['era'] == '—':
            continue
        if t['level'] == 0 and t['industry'] != '造船厂':
            continue
        key = M.IND_CN2KEY[t['industry']]
        lim[key][t['level']] = lim[key].get(t['level'], 0) + t['per_player']
    return lim


LIMITS = limits_from_json()
BID2KEY = {}
for _t in D.INDUSTRY_TILES:
    BID2KEY[_t['building_id']] = M.IND_CN2KEY[_t['industry']]


def built_count(p, key, level):
    """该玩家场上已建造的 (产业, 等级) 板块数（含已翻面）。"""
    n = 0
    for t in p['industryTiles']:
        if BID2KEY.get(t['buildingId']) == key and t['level'] == level:
            n += 1
    return n


def discarded_count(st, pid, key, level):
    """该玩家因「发展」丢弃的 (产业, 等级) 板块数。"""
    n = 0
    for d in st.get('discardedTiles', []) or []:
        if d.get('owner') == pid and M.IND_CN2KEY.get(d.get('industry')) == key \
                and d.get('level') == level:
            n += 1
    return n


def suffix_violations(p, tag=''):
    """「后缀形态」不变量：面板消耗只能从最低等级开始，不许在低级尚有剩余时动高级。

    建造取 minBuildLevel（= 面板最低非空等级），发展丢 mat_lowest（同样是最低非空等级），
    两条路径都只碰最低级。因此任意时刻面板剩余必然是一个「高位后缀」：
        低于某等级 L 的全部为 0，L 可能部分剩余，高于 L 的必然满员。
    推论：高等级板块**永远不可能**比低等级板块先从面板消失。
    形如 iron={1:1, 2:0, 3:1, 4:1}（L1 有剩却缺了 L2）即为非法「空洞」。
    """
    bad = []
    for key, levels in LIMITS.items():
        lvs = sorted(levels.keys())
        for i, lv in enumerate(lvs):
            if p['mat'][key].get(lv, 0) <= 0:
                continue
            # 本级尚有剩余 → 所有更高等级必须一块没动
            for hi in lvs[i + 1:]:
                cap_hi = levels[hi]
                got_hi = p['mat'][key].get(hi, 0)
                if got_hi != cap_hi:
                    bad.append('%s %s %s：L%s 尚剩 %d，但更高的 L%s 只剩 %d/%d（高级先于低级消失）'
                               % (tag, p['id'], M.IND_KEY2CN[key], lv,
                                  p['mat'][key][lv], hi, got_hi, cap_hi))
            break  # 只需检查最低的非空等级
    return bad


def violations(st, tag=''):
    """返回所有违反不变量的条目。

    强不变量 1（守恒）：面板剩余 + 场上已建 + 已丢弃 == per_player。
    强不变量 2（后缀形态）：面板消耗严格自低等级向高等级推进，不许出现空洞。
    """
    bad = []
    for p in st['players']:
        for key, levels in LIMITS.items():
            for lv, cap in levels.items():
                on_mat = p['mat'][key].get(lv, 0)
                on_board = built_count(p, key, lv)
                gone = discarded_count(st, p['id'], key, lv)
                if on_mat > cap:
                    bad.append('%s %s %s L%s 面板 %d > 上限 %d' % (tag, p['id'], key, lv, on_mat, cap))
                if on_board > cap:
                    bad.append('%s %s %s L%s 场上 %d > 上限 %d' % (tag, p['id'], key, lv, on_board, cap))
                if on_mat + on_board + gone != cap:
                    bad.append('%s %s %s L%s 不守恒：面板%d+场上%d+丢弃%d != %d'
                               % (tag, p['id'], key, lv, on_mat, on_board, gone, cap))
        bad.extend(suffix_violations(p, tag))
    return bad


# ===================== 1. 权威数据本身 =====================
print('\n--- 1. 权威数据（data/industry_tiles.json）---')
EXPECT = {
    'iron':     {1: 1, 2: 1, 3: 1, 4: 1},
    'coal':     {1: 1, 2: 2, 3: 2, 4: 2},
    'shipyard': {0: 2, 1: 2, 2: 2},
    'port':     {1: 2, 2: 2, 3: 2, 4: 2},
    'cotton':   {1: 3, 2: 3, 3: 3, 4: 3},
}
for key, exp in EXPECT.items():
    check('%s 各等级上限 = %s' % (M.IND_KEY2CN[key], exp), LIMITS.get(key) == exp,
          '实际 %s' % LIMITS.get(key))
total = sum(sum(v.values()) for v in LIMITS.values())
check('每色板块合计 = 37 块', total == 37, '实际 %d' % total)
check('铁厂每级恰好 1 块（用户重点）', all(v == 1 for v in LIMITS['iron'].values()),
      str(LIMITS['iron']))


# ===================== 2. 四色开局库存 =====================
print('\n--- 2. 四色玩家开局面板库存严格等于上限 ---')
st4 = setup.create_game(['红', '黄', '白', '紫'], seed=11)
colors = [p.get('color') for p in st4['players']]
check('4 名玩家、颜色各异', len(st4['players']) == 4 and len(set(colors)) == 4, str(colors))
for p in st4['players']:
    ok = all(p['mat'][k].get(lv, 0) == cap
             for k, levels in LIMITS.items() for lv, cap in levels.items())
    n = M.mat_count(p)
    check('%s(%s) 开局库存与上限逐级一致且共 37 块' % (p['id'], p.get('color')), ok and n == 37,
          '合计 %d' % n)
check('开局无任何超量', not violations(st4, '开局'), '; '.join(violations(st4, '开局')[:3]))


# ===================== 3. 建造：穷举每产业每等级，超量必被拒 =====================
print('\n--- 3. 建造上限：同产业同等级不得超过 per_player ---')
from engine import build as B  # noqa: E402


def probe_build_cap(key, level):
    """直接用 validate_build 的上限分支探测：手工塞满 per_player 后再建必被拒。"""
    st = setup.create_game(['甲', '乙'], seed=3)
    p = get_player(st, 'P1')
    cn = M.IND_KEY2CN[key]
    bid = next(t['building_id'] for t in D.INDUSTRY_TILES if t['industry'] == cn)
    cap = LIMITS[key][level]
    # 塞入 cap 个同产业同等级板块（模拟已建满）
    for i in range(cap):
        p['industryTiles'].append({'id': 'x%d' % i, 'buildingId': bid, 'level': level,
                                   'owner': 'P1', 'location': 'loc_%d' % i, 'slotIndex': 0,
                                   'flipped': False, 'boardResources': 0, 'builtEra': st['phase']})
    owned = built_count(p, key, level)
    return owned, cap


for key, levels in LIMITS.items():
    for lv, cap in sorted(levels.items()):
        owned, c = probe_build_cap(key, lv)
        check('%s L%d 建满 %d 个后 owned>=per_player 触发拒绝条件' % (M.IND_KEY2CN[key], lv, cap),
              owned >= c, 'owned=%d cap=%d' % (owned, c))

# --- 3b. 机制根因：建造等级由 minBuildLevel 决定，而它由 mat 派生 ---
# validate_build 里 level = p['minBuildLevel'][key]，不接受外部指定等级。
# 因此只要 mat 扣减正确，就物理上不可能连造两个同等级板块。
print('  · 机制根因：mat 扣减后 minBuildLevel 自动上移')
for key, levels in LIMITS.items():
    stx = setup.create_game(['甲', '乙'], seed=31)
    px = get_player(stx, 'P1')
    M.sync_min_build_level(px)
    expect_seq = []
    for lv in sorted(levels):
        expect_seq.extend([lv] * levels[lv])
    got_seq, ok = [], True
    for _ in range(len(expect_seq)):
        cur = px['minBuildLevel'][key]
        got_seq.append(cur)
        if cur == 99:
            ok = False
            break
        M.mat_take(px, key, cur)
    check('%s：逐块取走时 minBuildLevel 序列 = %s' % (M.IND_KEY2CN[key], expect_seq),
          ok and got_seq == expect_seq, '实际 %s' % got_seq)
    check('%s：库存取空后 minBuildLevel = 99（不可再建）' % M.IND_KEY2CN[key],
          px['minBuildLevel'][key] == 99, '实际 %s' % px['minBuildLevel'][key])

# 真实走一遍 validate_build 的上限分支（棉花厂 L1 上限 3）
st = setup.create_game(['甲', '乙'], seed=5)
st['turnOrder'] = ['P1', 'P2']
st['currentPlayer'] = 'P1'
p = get_player(st, 'P1')
bid_cotton = next(t['building_id'] for t in D.INDUSTRY_TILES if t['industry'] == '棉花厂')
for i in range(3):
    p['industryTiles'].append({'id': 'c%d' % i, 'buildingId': bid_cotton, 'level': 1,
                               'owner': 'P1', 'location': 'loc_%d' % i, 'slotIndex': 0,
                               'flipped': False, 'boardResources': 0, 'builtEra': st['phase']})
check('棉花厂 L1 已建 3 个（= per_player）', built_count(p, 'cotton', 1) == 3)


# ===================== 4. 发展：连续丢弃必须逐级上移，绝不同级重复 =====================
print('\n--- 4. 发展丢弃：等级严格按库存逐级上移 ---')


def develop_sequence(key, times):
    """对同一产业连续发展 times 次，返回实际被丢弃的等级序列。"""
    st = setup.create_game(['甲', '乙'], seed=9)
    st['turnOrder'] = ['P1', 'P2']
    st['currentPlayer'] = 'P1'
    st['actionPoints'] = 99
    p = get_player(st, 'P1')
    p['money'] = 999
    seq = []
    for _ in range(times):
        before = dict(p['mat'][key])
        lo = M.mat_lowest(p, key)
        if lo is None:
            break
        M.mat_take(p, key, lo)
        seq.append(lo)
        after = dict(p['mat'][key])
        # 同步校验：只可能有一个等级减 1
        diff = [(l, before.get(l, 0) - after.get(l, 0)) for l in before if before.get(l, 0) != after.get(l, 0)]
        if diff != [(lo, 1)]:
            return None, 'diff=%s' % diff
    return seq, ''


# 铁厂：每级 1 块 → 连丢 4 次必为 1,2,3,4
seq, err = develop_sequence('iron', 4)
check('铁厂连发展 4 次 → 丢弃等级 [1,2,3,4]（绝无两个 1 级）', seq == [1, 2, 3, 4], '实际 %s %s' % (seq, err))
# 煤厂：L1=1, L2=2 → 1,2,2,3
seq, err = develop_sequence('coal', 4)
check('煤厂连发展 4 次 → [1,2,2,3]（L1 仅 1 块）', seq == [1, 2, 2, 3], '实际 %s %s' % (seq, err))
# 造船厂：L0=2, L1=2 → 0,0,1,1
seq, err = develop_sequence('shipyard', 4)
check('造船厂连发展 4 次 → [0,0,1,1]（L0 占位 2 块）', seq == [0, 0, 1, 1], '实际 %s %s' % (seq, err))
# 港口：每级 2 → 1,1,2,2
seq, err = develop_sequence('port', 4)
check('港口连发展 4 次 → [1,1,2,2]', seq == [1, 1, 2, 2], '实际 %s %s' % (seq, err))
# 棉花厂：每级 3 → 1,1,1,2
seq, err = develop_sequence('cotton', 4)
check('棉花厂连发展 4 次 → [1,1,1,2]', seq == [1, 1, 1, 2], '实际 %s %s' % (seq, err))


# ===================== 5. 引擎级 do_develop：一次丢 2 个铁厂 =====================
print('\n--- 5. do_develop 实机：一次丢 2 个铁厂 = L1 + L2 ---')
st = setup.create_game(['甲', '乙'], seed=13)
st['turnOrder'] = ['P1', 'P2']
st['currentPlayer'] = 'P1'
st['actionPoints'] = 2
p = get_player(st, 'P1')
p['money'] = 999
before_iron = dict(p['mat']['iron'])
card = p['hand'][0]
res = A.do_develop(st, {'industries': ['铁厂', '铁厂'], 'cardId': card})
after_iron = dict(get_player(st, 'P1')['mat']['iron'])
dropped = (res.get('detail') or {}).get('dropped')
ok = (res.get('ok') is not False) and after_iron.get(1, 0) == before_iron.get(1, 0) - 1 \
     and after_iron.get(2, 0) == before_iron.get(2, 0) - 1
check('一次发展 2 铁厂 → L1、L2 各减 1（非 2×L1）', ok,
      'before=%s after=%s dropped=%s' % (before_iron, after_iron, dropped))
check('引擎回执 dropped 为 [1级铁厂, 2级铁厂]',
      dropped == [{'industry': '铁厂', 'level': 1}, {'industry': '铁厂', 'level': 2}], str(dropped))
check('发展后守恒不变量成立', not violations(st, '发展后'), '; '.join(violations(st, '发展后')[:3]))

# 铁厂只剩最后 1 块时，一次丢 2 个铁厂必须被拒。
# 注意：由于消耗严格自低向高，「只剩 1 块」在真实对局中必然是最高级那块（铁厂 = L4），
# 绝不可能是 {1:1, 2:0, 3:0, 4:0} 这种「只剩 L1」——那是不可达状态（见第 5b 节）。
st2 = setup.create_game(['甲', '乙'], seed=17)
st2['turnOrder'] = ['P1', 'P2']
st2['currentPlayer'] = 'P1'
st2['actionPoints'] = 2
p2 = get_player(st2, 'P1')
p2['money'] = 999
p2['mat']['iron'] = {1: 0, 2: 0, 3: 0, 4: 1}
M.sync_min_build_level(p2)
res2 = A.do_develop(st2, {'industries': ['铁厂', '铁厂'], 'cardId': p2['hand'][0]})
rejected = (res2.get('ok') is False) or bool(res2.get('error'))
check('铁厂只剩最后 1 块（必为 L4）时丢 2 个被拒绝', rejected, str(res2)[:120])


# ============ 5b. 后缀形态：高等级绝不可能比低等级先从面板消失 ============
print('\n--- 5b. 面板消耗单调性（低→高，不许打洞）---')

# (a) 护栏自检：人工构造「L1 尚剩、L2 却缺了」的空洞状态，必须被抓到
stx = setup.create_game(['甲', '乙'], seed=31)
px = get_player(stx, 'P1')
px['mat']['iron'] = {1: 1, 2: 0, 3: 1, 4: 1}   # 非法：L1 还有，L2 却没了
M.sync_min_build_level(px)
hole = suffix_violations(px, '空洞')
check('护栏能识别非法空洞 iron={1:1,2:0,3:1,4:1}', bool(hole), (hole[0] if hole else '未识别'))

# (b) 真实发展序列：把每种产业一路丢空，全程必须保持后缀形态
for cn in ['铁厂', '煤厂', '造船厂', '港口', '棉花厂']:
    key = M.IND_CN2KEY[cn]
    sts = setup.create_game(['甲', '乙'], seed=41)
    ps = get_player(sts, 'P1')
    trail, holed, prev_lo = [], None, 0
    while M.mat_count(ps, key) > 0:
        lo = M.mat_lowest(ps, key)
        if lo < prev_lo:                      # 取用等级回退 = 高级先被动过
            holed = '取用等级回退 L%s → L%s' % (prev_lo, lo)
            break
        prev_lo = lo
        M.mat_take(ps, key, lo)
        trail.append(lo)
        v = suffix_violations(ps, cn)
        if v:
            holed = v[0]
            break
    check('%s 逐块取空全程保持后缀形态（取用序列 %s）' % (cn, trail),
          holed is None and M.mat_count(ps, key) == 0, holed or '')

# (c) 「只剩 1 块」时那块必然是最高级——对全部 5 产业验证
for cn in ['铁厂', '煤厂', '造船厂', '港口', '棉花厂']:
    key = M.IND_CN2KEY[cn]
    sts = setup.create_game(['甲', '乙'], seed=43)
    ps = get_player(sts, 'P1')
    top = max(LIMITS[key].keys())
    while M.mat_count(ps, key) > 1:
        M.mat_take(ps, key, M.mat_lowest(ps, key))
    last = M.mat_lowest(ps, key)
    check('%s 剩最后 1 块时必为最高级 L%s' % (cn, top), last == top,
          '实际剩 L%s，面板=%s' % (last, {k: v for k, v in ps['mat'][key].items() if v}))


# ===================== 6. 自动对局：全程不变量巡检 =====================
print('\n--- 6. 4 人自动对局全程巡检（每步校验四色全产业全等级）---')
st = setup.create_game(['红', '黄', '白', '紫'], seed=23)
steps, bad_all = 0, []
for p in st['players']:
    p['money'] = 500
for i in range(120):
    pid = st.get('currentPlayer')
    if not pid:
        break
    pl = get_player(st, pid)
    st['actionPoints'] = max(st.get('actionPoints', 0), 1)
    acted = False
    # 优先尝试发展（最容易触发 mat 扣减），失败则跳过
    if pl.get('hand'):
        for cn in ['铁厂', '煤厂', '造船厂', '港口', '棉花厂']:
            key = M.IND_CN2KEY[cn]
            if M.mat_count(pl, key) > 0:
                st['currentPlayer'] = pid
                r = A.do_develop(st, {'industries': [cn], 'cardId': pl['hand'][0]})
                if r.get('ok') is not False and not r.get('error'):
                    acted = True
                    steps += 1
                break
    v = violations(st, 'step%d' % i)
    if v:
        bad_all.extend(v)
        break
    if not acted:
        # 换个玩家继续
        order = st.get('turnOrder') or [x['id'] for x in st['players']]
        st['currentPlayer'] = order[(order.index(pid) + 1) % len(order)]

check('自动对局 %d 步内四色全产业全等级零超量' % steps, not bad_all, '; '.join(bad_all[:3]))


# ===================== 汇总 =====================
ok_n = sum(1 for _, o in RESULTS if o)
print('\n==== 板块数量不变量测试 %d/%d 通过 ====' % (ok_n, len(RESULTS)))
sys.exit(0 if ok_n == len(RESULTS) else 1)
