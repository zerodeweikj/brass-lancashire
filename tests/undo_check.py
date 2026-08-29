# -*- coding: utf-8 -*-
"""撤回一致性自测：随机行动后立刻撤回，断言状态与行动前逐字节一致。

规则依据：PRD 10.3「完整恢复：手牌、行动点、金钱/煤/铁、棋盘、收入轨、
牌库/抽牌堆/弃牌堆/远方市场牌库、远方的棉花市场轨、各类最低可建等级等全部回滚」，
并要求含随机抽牌结果（远方市场牌抽中哪张）也能精确还原。

用法： python tests/undo_check.py [局数] [起始种子]
"""
import copy
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding='utf-8')

from engine import actions, flow, setup  # noqa: E402
from tests import selfplay  # noqa: E402

# 撤回栈自身与 version 不参与比对（撤回后 version 必然前进）
IGNORE = {'undoStack', 'version', 'log', 'buttonEnabled', 'selectableCards',
          'legalBuilds', 'legalLinks'}


def fingerprint(state):
    """状态指纹：剔除不参与回滚语义的字段后做稳定序列化。"""
    snap = {k: v for k, v in state.items() if k not in IGNORE}
    return json.dumps(snap, sort_keys=True, ensure_ascii=False, default=str)


def diff_keys(a, b):
    """定位两份状态在顶层/玩家层的差异，便于报错时给出可读信息。"""
    out = []
    for k in sorted(set(a) | set(b)):
        if k in IGNORE:
            continue
        if a.get(k) != b.get(k):
            out.append(k)
    return out


def run_one(seed, players=3, max_steps=4000):
    rng = random.Random(seed)
    st = setup.create_game(['P%d' % (i + 1) for i in range(players)], seed=seed)
    checked = 0
    steps = 0
    while not st.get('gameOver') and steps < max_steps:
        steps += 1
        enabled = [k for k, v in st['buttonEnabled'].items() if v and k in selfplay.BUILDERS]
        if not enabled:
            flow.end_turn(st)
            continue
        pool = []
        for k in enabled:
            pool += [k] * selfplay.WEIGHT.get(k, 1)
        act = None
        for _ in range(6):
            act = selfplay.BUILDERS[rng.choice(pool)](st, rng)
            if act:
                break
        if not act:
            flow.end_turn(st)
            continue
        act['playerId'] = st['currentPlayer']
        act['version'] = st['version']

        # 约 1/3 的行动做「执行 → 撤回 → 比对」抽查
        probe = rng.random() < 0.34
        before_fp = fingerprint(st) if probe else None
        before_state = copy.deepcopy(st) if probe else None

        res = actions.apply_action(st, act)
        if not res['ok']:
            raise AssertionError('seed=%s 行动被拒：%s %s' % (seed, res['fail_code'], res['message']))

        def resolve_supplement():
            """建造铁/煤厂后回合暂停：跟随补市场抉择（与 selfplay 口径一致）。"""
            if (res.get('detail') or {}).get('needSupplement'):
                rs = actions.apply_action(st, {'type': 'supplement_market', 'supply': True,
                                               'playerId': st['currentPlayer'],
                                               'version': st['version']})
                if not rs['ok']:
                    raise AssertionError('seed=%s 补市场失败：%s' % (seed, rs['message']))

        def resolve_sell_session():
            """售卖会话（官方步骤 4）：以 sell_end 结束，避免下一行动被 SELL_PENDING 拒绝。"""
            while st.get('pendingSell'):
                re = actions.apply_action(st, {'type': 'sell_end', 'playerId': st['currentPlayer'],
                                               'version': st['version']})
                if not re['ok']:
                    raise AssertionError('seed=%s sell_end 失败：%s' % (seed, re['message']))

        resolve_supplement()
        resolve_sell_session()

        if probe:
            # 行动可能触发回合结束（行动点耗尽），此时撤回栈已清空，跳过本次抽查
            if not st.get('undoStack'):
                continue
            und = actions.apply_action(st, {'type': 'undo', 'playerId': st['currentPlayer']})
            if not und['ok']:
                raise AssertionError('seed=%s 撤回失败：%s' % (seed, und['message']))
            after_fp = fingerprint(st)
            if after_fp != before_fp:
                ks = diff_keys(json.loads(json.dumps(before_state, default=str)),
                               json.loads(json.dumps(st, default=str)))
                raise AssertionError('seed=%s 撤回未精确还原（%s）差异字段：%s'
                                     % (seed, act['type'], ks))
            checked += 1
            # 撤回后重放同一行动，保证对局继续推进
            act['version'] = st['version']
            res = actions.apply_action(st, act)
            if not res['ok']:
                raise AssertionError('seed=%s 撤回后重放失败：%s' % (seed, res['message']))
            resolve_supplement()
            resolve_sell_session()
        selfplay.check_invariants(st, 'undo seed=%s step=%d' % (seed, steps))
    return st, checked, steps


def main():
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 6
    base = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    bad = 0
    total = 0
    for i in range(games):
        seed = base + i
        n = 2 + (i % 3)
        try:
            st, checked, steps = run_one(seed, players=n)
            total += checked
            print('seed=%-4d %d人 撤回抽查 %-3d 次全部精确还原 | 步 %-4d 终局 %s'
                  % (seed, n, checked, steps, bool(st.get('gameOver'))))
        except AssertionError as e:
            bad += 1
            print('seed=%-4d %d人 ✗ %s' % (seed, n, e))
    print('---\n%d/%d 局通过，累计校验 %d 次撤回' % (games - bad, games, total))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
