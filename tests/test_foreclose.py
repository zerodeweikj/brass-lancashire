# -*- coding: utf-8 -*-
"""强制拆板抵债回归（2026-08-12 用户新规则）。

规则：轮末玩家收入为负且没钱，触发强制拆板抵债：
1. 强制玩家点击【自己】在地图上的产业板块移除（不归还面板）；
   该板块建造费用的一半（向下取整）用于还债，多余的归玩家作为金钱。
2. 一间不够还 → 继续拆。
3. 无板块可拆但仍欠 → 按 1 分=1 钱 扣分抵债；扣到 0 仍不足 → 一笔勾销（标记 forecloseForgiven）。

覆盖：
· 有钱全额支付 → 不触发拆板
· 有钱部分支付 + 有板块 → 先付钱再拆板抵债
· repay > 尚欠 → 多余归玩家
· 多块才够 → pendingForeclose 持续，直到还清
· 无板块直接扣分抵债（不触发挂起）
· 分数扣到 0 仍不足 → 一笔勾销 + forecloseForgiven
· 挂起期间其余行动被拒（FORECLOSE_PENDING）
· 两人先后欠债 → incomeDone 续结算，均还清后推进轮次

用法： python tests/test_foreclose.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

from engine import actions as A          # noqa: E402
from engine import flow as F             # noqa: E402
from engine import mechanics as M        # noqa: E402
from engine import setup                 # noqa: E402
from engine.state import get_player      # noqa: E402

RESULTS = []


def check(name, cond, detail=''):
    RESULTS.append((name, bool(cond)))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- %s' % detail) if detail and not cond else ''))


# 产业板块建造费用（industry_tiles.json）
# 港口 L1 = 6 → repay 3；棉花厂 L1 = 12 → repay 6；铁厂 L1 = 5 → repay 2
PORT = ('building_004', 1)      # cost 6
COTTON = ('building_005', 1)    # cost 12


def fresh():
    """2 人局，turnOrder=[P1,P2]，currentPlayer=P2（end_turn 即触发满轮结算）。
    P2 设为收入 0、钱充足，确保不触发 P2 的拆板。"""
    st = setup.create_game(['甲', '乙'], seed=7)
    st['turnOrder'] = ['P1', 'P2']
    st['currentPlayer'] = 'P2'
    p2 = get_player(st, 'P2')
    p2['incomePos'] = 10          # 收入 0
    p2['money'] = 200
    st['version'] = 0
    return st


def set_debtor(st, pid, income_pos=0, money=0, total_score=20):
    p = get_player(st, pid)
    p['incomePos'] = income_pos          # 0 → 收入 -10
    p['money'] = money
    st['scores'][pid] = {'canal': total_score, 'rail': 0, 'total': total_score, 'penalty': 0}


def add_tile(st, pid, building_id, level):
    p = get_player(st, pid)
    n = len(p['industryTiles']) + 1
    tile = {'id': 'fc%d' % n, 'buildingId': building_id, 'level': level,
            'owner': pid, 'location': 'LIVERPOOL', 'slotIndex': 0, 'flipped': False,
            'boardResources': 0, 'builtEra': 'canal'}
    p['industryTiles'].append(tile)
    return tile


# ---------------- 1. 有钱全额支付 ----------------
def t_full_pay():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=10)   # 收入 -10，钱 10 → 正好付清
    r = F.end_turn(st)
    check('1.1 有钱全额支付不触发拆板', not st.get('pendingForeclose'), str(st.get('pendingForeclose')))
    check('1.2 钱被扣光', get_player(st, 'P1')['money'] == 0, str(get_player(st, 'P1')['money']))
    check('1.3 无额外扣分', st['scores']['P1'].get('penalty', 0) == 0)


# ---------------- 2. 部分付钱 + 拆板抵债（多块） ----------------
def t_partial_foreclose():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=4)     # 收入 -10，钱 4 → 付 4 欠 6
    t1 = add_tile(st, 'P1', *PORT)                  # repay 3
    t2 = add_tile(st, 'P1', *PORT)                  # repay 3
    F.end_turn(st)
    pend = st.get('pendingForeclose')
    check('2.1 触发 pendingForeclose', bool(pend), str(pend))
    check('2.2 尚欠 = 6', pend and pend['remaining'] == 6, str(pend))
    check('2.3 当前玩家切到欠债者', st['currentPlayer'] == 'P1', st['currentPlayer'])
    # 拆第一块
    r1 = A.apply_action(st, {'type': 'foreclose_tile', 'playerId': 'P1', 'tileId': t1['id']})
    check('2.4 第一块后继续拆（needForeclose）', r1['ok'] and r1['detail']['needForeclose'], str(r1))
    check('2.5 剩余 = 3', st['pendingForeclose']['remaining'] == 3, str(st['pendingForeclose']))
    check('2.6 仍挂起', bool(st.get('pendingForeclose')))
    # 拆第二块 → 还清
    r2 = A.apply_action(st, {'type': 'foreclose_tile', 'playerId': 'P1', 'tileId': t2['id']})
    check('2.7 第二块后还清', r2['ok'] and not r2['detail'].get('needForeclose'), str(r2))
    check('2.8 pending 清除', not st.get('pendingForeclose'))
    check('2.9 板块已移除（不归还）', len(get_player(st, 'P1')['industryTiles']) == 0)
    check('2.10 钱 = 0（4 已付，无结余）', get_player(st, 'P1')['money'] == 0, str(get_player(st, 'P1')['money']))
    check('2.11 轮次已推进', st['round'] == 2, str(st['round']))


# ---------------- 3. repay > 尚欠 → 多余归玩家 ----------------
def t_leftover_to_money():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=8)     # 收入 -10，钱 8 → 付 8 欠 2
    t1 = add_tile(st, 'P1', *COTTON)                # repay 6 > 欠 2 → 余 4 归己
    F.end_turn(st)
    check('3.1 触发 pending（欠 2）', st.get('pendingForeclose', {}).get('remaining') == 2, str(st.get('pendingForeclose')))
    r = A.apply_action(st, {'type': 'foreclose_tile', 'playerId': 'P1', 'tileId': t1['id']})
    check('3.2 还清且非继续', r['ok'] and not r['detail'].get('needForeclose'), str(r))
    check('3.3 多余 4 归玩家（8-8+4=4）', get_player(st, 'P1')['money'] == 4, str(get_player(st, 'P1')['money']))
    check('3.4 无 pending', not st.get('pendingForeclose'))


# ---------------- 4. 无板块直接扣分抵债 ----------------
def t_score_deduct():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=0, total_score=20)  # 欠 10，无板块
    F.end_turn(st)
    check('4.1 无板块不挂起', not st.get('pendingForeclose'), str(st.get('pendingForeclose')))
    check('4.2 扣分 = 10', st['scores']['P1']['penalty'] == 10, str(st['scores']['P1']))
    check('4.3 总分下降 10（20→10）', st['scores']['P1']['total'] == 10, str(st['scores']['P1']))
    check('4.4 无勾销标记', not st.get('forecloseForgiven'))


# ---------------- 5. 分数扣到 0 仍不足 → 一笔勾销 ----------------
def t_forgiven():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=0, total_score=2)   # 欠 10，总分仅 2
    F.end_turn(st)
    check('5.1 无板块不挂起', not st.get('pendingForeclose'))
    check('5.2 扣分 = 2（到 0 为止）', st['scores']['P1']['penalty'] == 2, str(st['scores']['P1']))
    check('5.3 总分归 0', st['scores']['P1']['total'] == 0, str(st['scores']['P1']))
    check('5.4 标记 forecloseForgiven', bool(st.get('forecloseForgiven')), str(st.get('forecloseForgiven')))
    check('5.5 勾销对象是欠债者', st.get('forecloseForgiven', {}).get('pid') == 'P1')


# ---------------- 6. 挂起期间其余行动被拒 ----------------
def t_guard():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=4)
    add_tile(st, 'P1', *PORT)
    F.end_turn(st)
    r = A.apply_action(st, {'type': 'skip', 'playerId': 'P1',
                            'cardId': get_player(st, 'P1')['hand'][0]})
    check('6.1 挂起时跳过被拒', (not r['ok']) and r['fail_code'] == 'FORECLOSE_PENDING', str(r))
    # 仅 foreclose_tile 放行
    r2 = A.apply_action(st, {'type': 'foreclose_tile', 'playerId': 'P1',
                             'tileId': get_player(st, 'P1')['industryTiles'][0]['id']})
    check('6.2 foreclose_tile 放行', r2['ok'], str(r2))


# ---------------- 7. 两人先后欠债 → incomeDone 续结算 ----------------
def t_two_debtors():
    st = fresh()
    set_debtor(st, 'P1', income_pos=0, money=0, total_score=20)   # 欠 10
    set_debtor(st, 'P2', income_pos=0, money=0, total_score=20)   # 欠 10
    add_tile(st, 'P1', *PORT)   # repay 3 < 10 → 拆后转扣分
    add_tile(st, 'P2', *PORT)
    F.end_turn(st)
    check('7.1 第一人挂起（P1）', st.get('pendingForeclose', {}).get('pid') == 'P1', str(st.get('pendingForeclose')))
    # 解决 P1：拆 1 块（剩 7）→ 无板块 → 扣分 7
    A.apply_action(st, {'type': 'foreclose_tile', 'playerId': 'P1',
                       'tileId': get_player(st, 'P1')['industryTiles'][0]['id']})
    check('7.2 P1 解决后转到 P2 挂起', st.get('pendingForeclose', {}).get('pid') == 'P2', str(st.get('pendingForeclose')))
    check('7.3 当前玩家为 P2', st['currentPlayer'] == 'P2', st['currentPlayer'])
    # 解决 P2
    A.apply_action(st, {'type': 'foreclose_tile', 'playerId': 'P2',
                       'tileId': get_player(st, 'P2')['industryTiles'][0]['id']})
    check('7.4 两人都解决后无 pending', not st.get('pendingForeclose'), str(st.get('pendingForeclose')))
    check('7.5 轮次推进', st['round'] == 2, str(st['round']))
    check('7.6 P1 扣分 = 7', st['scores']['P1']['penalty'] == 7, str(st['scores']['P1']))
    check('7.7 P2 扣分 = 7', st['scores']['P2']['penalty'] == 7, str(st['scores']['P2']))


if __name__ == '__main__':
    t_full_pay()
    t_partial_foreclose()
    t_leftover_to_money()
    t_score_deduct()
    t_forgiven()
    t_guard()
    t_two_debtors()
    passed = sum(1 for _, ok in RESULTS if ok)
    total = len(RESULTS)
    print('\n==== FORECLOSE 测试结果： %d / %d 通过 ====' % (passed, total))
    sys.exit(0 if passed == total else 1)
