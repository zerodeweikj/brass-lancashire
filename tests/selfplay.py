# -*- coding: utf-8 -*-
"""随机自走对局自测：跑完整两时代，验证引擎不崩、不卡死、状态自洽。

用法： python tests/selfplay.py [局数] [起始种子]
"""
import os
import random
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding='utf-8')

from engine import actions, data as D, flow, mechanics as M, setup  # noqa: E402


def pick_build(state, rng, double=False):
    p = next(x for x in state['players'] if x['id'] == state['currentPlayer'])
    targets = state.get('legalBuilds') or flow.legal_build_targets(state)
    rng.shuffle(targets)
    for t in targets:
        if double:
            if len(p['hand']) >= 2:
                cards = rng.sample(p['hand'], 2)
                return {'type': 'doubleBuild', 'cardIds': cards, 'location': t['location'],
                        'slotIndex': t['slotIndex'], 'industry': t['industry']}
            continue
        net_ok = t.get('netOk', True)
        for c in p['hand']:
            card = D.CARD_BY_ID.get(c, {})
            city_ok = card.get('type') == 'city' and card.get('city') == t['location']
            # 产业牌驱动必须在自有运输网内（netOk=False 的落点只有城市牌能驱动）
            ind_ok = (net_ok and card.get('type') == 'industry'
                      and card.get('industry') == t['industry'])
            if city_ok or ind_ok:
                return {'type': 'build', 'cardId': c, 'location': t['location'],
                        'slotIndex': t['slotIndex'], 'industry': t['industry']}
    return None


def pick_road(state, rng):
    p = next(x for x in state['players'] if x['id'] == state['currentPlayer'])
    links = state.get('legalLinks') or flow.legal_link_targets(state)
    if not links or not p['hand']:
        return None
    lk = rng.choice(links)
    return {'type': 'road', 'cardId': rng.choice(p['hand']),
            'links': [{'from': lk['from'], 'to': lk['to']}]}


def pick_develop(state, rng):
    p = next(x for x in state['players'] if x['id'] == state['currentPlayer'])
    avail = [k for k in M.IND_KEYS if M.mat_lowest(p, k) is not None]
    if not avail or not p['hand']:
        return None
    return {'type': 'develop', 'cardId': rng.choice(p['hand']),
            'industries': [M.IND_KEY2CN[rng.choice(avail)]]}


def pick_sell(state, rng, session=False):
    """官方规则售卖：首次需弃 1 手牌；会话续卖（session=True）不弃牌。
    渠道：远方市场（牌库非空且轨未到 X）或未翻面港口。"""
    p = next(x for x in state['players'] if x['id'] == state['currentPlayer'])
    mills = flow.sellable_mills(state)
    if not mills:
        return None
    if not session and not p['hand']:
        return None
    mill = rng.choice(mills)
    distant, ports = actions._sale_channels(state, mill)
    if not distant and not ports:
        return None   # 防御：sellable_mills 与渠道判定偶发不一致时放弃出售
    track = state.get('remoteTrackValues') or []
    pos = state.get('remoteCottonTrack', 0)
    distant_ok = bool(distant and state['remoteMarketDeck']['cards']
                      and pos < max(0, len(track) - 1))
    act = {'type': 'sell', 'millId': mill['id']}
    if distant_ok and rng.random() < 0.6:
        act['channel'] = 'distant'
    elif ports:
        act['channel'] = 'port'
        act['portTileId'] = ports[0]['id']
    else:
        return None
    if not session:
        act['cardId'] = rng.choice(p['hand'])
    return act


def pick_loan(state, rng):
    """只在真缺钱且收入还扛得住时贷款——无脑贷到 -10 会让统计失真。"""
    p = next(x for x in state['players'] if x['id'] == state['currentPlayer'])
    if not p['hand'] or p['money'] >= 18 or M.income_of(p) <= -2:
        return None
    return {'type': 'loan', 'cardId': rng.choice(p['hand']), 'tier': 1}


def pick_skip(state, rng):
    p = next(x for x in state['players'] if x['id'] == state['currentPlayer'])
    if not p['hand']:
        return None
    return {'type': 'skip', 'cardId': rng.choice(p['hand'])}


BUILDERS = {'build': pick_build, 'road': pick_road, 'develop': pick_develop,
            'sell': pick_sell, 'loan': pick_loan, 'skip': pick_skip,
            'doubleBuild': lambda s, r: pick_build(s, r, double=True)}
# 权重：偏向建造与修路，让对局推进得更像真人
WEIGHT = {'build': 34, 'road': 26, 'sell': 18, 'develop': 8, 'loan': 6, 'skip': 6, 'doubleBuild': 2}


def check_invariants(state, where):
    for p in state['players']:
        assert p['money'] >= 0, '%s: %s 金钱为负 %d' % (where, p['id'], p['money'])
        assert 0 <= p['incomePos'] <= M.MAX_POS, '%s: 收入轨越界' % where
        assert p['remainingLinks'] >= 0, '%s: 连结板块为负' % where
        assert len(p['hand']) <= state.get('handLimit', 8), '%s: 手牌超上限' % where
    for res in ('coal', 'iron'):
        m = state[res + 'Market']
        for t in (1, 2, 3, 4):
            v = m['price%d' % t]
            assert 0 <= v <= 2, '%s: %s 市场档位 %d 异常 = %d' % (where, res, t, v)
    seen = {}
    for p in state['players']:
        for t in p['industryTiles']:
            key = (t['location'], t['slotIndex'])
            assert key not in seen, '%s: 槽位重复占用 %s' % (where, key)
            seen[key] = t['id']
    pairs = set()
    for p in state['players']:
        for lk in p['linkTiles']:
            k = frozenset(lk['endpoints'])
            assert k not in pairs, '%s: 连结重复 %s' % (where, k)
            pairs.add(k)


def run_one(seed, players=4, max_steps=4000, verbose=False):
    rng = random.Random(seed)
    st = setup.create_game(['P%d' % (i + 1) for i in range(players)], seed=seed)
    steps, fails, applied = 0, 0, 0
    while not st.get('gameOver') and steps < max_steps:
        steps += 1
        # 强制拆板抵债：轮末收入为负且无力支付时挂起，需先拆板（或引擎自动扣分）才能推进
        if st.get('pendingForeclose'):
            fp = st['pendingForeclose']
            debtor = next(x for x in st['players'] if x['id'] == fp['pid'])
            if not debtor['industryTiles']:
                # 不应发生：无板块时引擎直接走扣分，不会挂起
                raise RuntimeError('seed=%s pendingForeclose 但欠债者无板块' % seed)
            tile = debtor['industryTiles'][0]
            r = actions.apply_action(st, {'type': 'foreclose_tile', 'playerId': fp['pid'],
                                         'tileId': tile['id'], 'version': st['version']})
            if not r['ok']:
                raise RuntimeError('seed=%s 拆板失败：%s %s' % (seed, r['fail_code'], r['message']))
            applied += 1
            check_invariants(st, 'seed=%s 拆板后' % seed)
            continue
        enabled = [k for k, v in st['buttonEnabled'].items() if v and k in BUILDERS]
        if not enabled:
            before = (st['currentPlayer'], st['round'], st['phase'])
            flow.end_turn(st)
            # 铁路时代收尾时 end_turn 会直接终局，此时三元组不变属正常
            if not st.get('gameOver') and (st['currentPlayer'], st['round'], st['phase']) == before:
                raise RuntimeError('回合无法推进，疑似死锁 @ %s' % (before,))
            continue
        pool = []
        for k in enabled:
            pool += [k] * WEIGHT.get(k, 1)
        act = None
        for _ in range(6):
            kind = rng.choice(pool)
            act = BUILDERS[kind](st, rng)
            if act:
                break
        if not act:
            act = pick_skip(st, rng)
        if not act:
            flow.end_turn(st)
            continue
        act['playerId'] = st['currentPlayer']
        act['version'] = st['version']
        res = actions.apply_action(st, act)
        if res['ok']:
            applied += 1
            # 建造铁/煤厂后回合暂停，等待补市场抉择：以「补入」为主、偶尔留板
            if (res.get('detail') or {}).get('needSupplement'):
                sup = {'type': 'supplement_market', 'supply': rng.random() < 0.75,
                       'playerId': st['currentPlayer'], 'version': st['version']}
                rs = actions.apply_action(st, sup)
                if not rs['ok']:
                    raise RuntimeError('seed=%s 补市场失败：%s %s'
                                       % (seed, rs['fail_code'], rs['message']))
                applied += 1
            # 售卖会话（官方步骤 4）：续卖或结束
            while st.get('pendingSell'):
                cont = pick_sell(st, rng, session=True)
                if cont and rng.random() < 0.8:
                    cont['playerId'] = st['currentPlayer']
                    cont['version'] = st['version']
                    rc = actions.apply_action(st, cont)
                    if not rc['ok']:
                        raise RuntimeError('seed=%s 续卖失败：%s %s'
                                           % (seed, rc['fail_code'], rc['message']))
                    applied += 1
                    continue
                re = actions.apply_action(st, {'type': 'sell_end', 'playerId': st['currentPlayer'],
                                               'version': st['version']})
                if not re['ok']:
                    raise RuntimeError('seed=%s sell_end 失败：%s %s'
                                       % (seed, re['fail_code'], re['message']))
                applied += 1
                break
        else:
            fails += 1
            if verbose:
                print('   x %s -> %s %s' % (act['type'], res['fail_code'], res['message']))
            if fails > 400:
                raise RuntimeError('连续失败过多，疑似规则死锁')
        check_invariants(st, 'seed=%s step=%d' % (seed, steps))
    return st, steps, applied, fails


def main():
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 5
    base = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    bad = 0
    for i in range(games):
        seed = base + i
        n = 2 + (i % 3)
        try:
            st, steps, applied, fails = run_one(seed, players=n)
            status = '完成' if st.get('gameOver') else '未终局(步数上限)'
            scores = {p: st['scores'][p]['total'] for p in st['turnOrder']}
            print('seed=%-4d %d人 %s | 步 %-4d 成功 %-4d 失败 %-3d | 时代 %s 轮 %-2d | 胜者 %s | 分 %s'
                  % (seed, n, status, steps, applied, fails, st['phase'], st['round'],
                     st.get('winner'), scores))
            if not st.get('gameOver'):
                bad += 1
        except Exception as e:  # noqa: BLE001
            bad += 1
            print('seed=%-4d %d人 失败: %s' % (seed, n, e))
            traceback.print_exc()
    print('---\n%d/%d 局正常终局' % (games - bad, games))
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
