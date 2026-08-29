# -*- coding: utf-8 -*-
"""售卖棉花·官方规则引擎测试（2026-08-11 规则书拍板，100% 官方）：

步骤 1：丢弃任意 1 张手牌（仅首次）；
步骤 2：选一座【未翻面】棉花厂：
  2.1 港口：可卖到任意【未翻面】港口（无论属于谁）→ 港口翻面 + 港口拥有者得翻面奖励；
  2.2 远方市场：市场轨未到 X 且棉花厂连任意市场标记 → 抽 1 张远方市场牌，
      按牌面数值绝对值移动市场轨标记，收入轨前进 = 落点数值（官方：收入轨而非金钱）；
      若落点走到 X → 该行动视为跳过（不翻棉花厂、不推进收入、行动结束）；
步骤 3：翻该棉花厂，拥有者得翻面奖励；
步骤 4：可重复步骤 2（会话续卖：不弃牌、不扣行动点），或结束（sell_end 扣 1 行动点）。

里程碑修正：原「额外奖励 reward=money/card 二选一」机制作废——远方市场收入轨前进 =
「抽牌移动后落点数值」，无其他选项；港口拥有者得翻面奖励而非卖家。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding='utf-8')

from engine import setup as S, flow as F, state as ST, actions as A

RESULTS = []
def check(name, cond, detail=''):
    RESULTS.append((name, cond))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name, ('  -- ' + str(detail)) if (detail and not cond) else ''))


def make_sell_scene(deck=None, track=0, n_mills=2, chain=True):
    """P1 回合：P1 两座未翻面棉花厂@LIVERPOOL，P2 未翻面港口@LIVERPOOL。
    chain=True 时注入 LIVERPOOL→ELLESMEREPORT→NORTHWICH→THEMIDLANDS 运河链（共享路网），
    使棉花厂同时有「港口渠道」与「远方市场渠道」。"""
    st = S.create_game(['P1', 'P2'])
    p1 = ST.get_player(st, 'P1')
    p2 = ST.get_player(st, 'P2')
    p1['hand'] = ['city_manchester'] * 5          # 手牌足够（弃任意 1 张）
    st['actionPoints'] = 2
    st['currentPlayer'] = 'P1'
    for i in range(n_mills):
        p1['industryTiles'].append({'id': 'mill%d' % (i + 1), 'buildingId': 'building_005', 'level': i + 1,
                                    'owner': 'P1', 'location': 'LIVERPOOL', 'slotIndex': i, 'flipped': False,
                                    'boardResources': 0, 'builtEra': 'canal'})
    p2['industryTiles'].append({'id': 'port', 'buildingId': 'building_004', 'level': 1, 'owner': 'P2',
                                'location': 'LIVERPOOL', 'slotIndex': 0, 'flipped': False,
                                'boardResources': 0, 'builtEra': 'canal'})
    if chain:
        for i, (a, b) in enumerate([('LIVERPOOL', 'ELLESMEREPORT'), ('ELLESMEREPORT', 'NORTHWICH'),
                                    ('NORTHWICH', 'THEMIDLANDS')]):
            p2['linkTiles'].append({'id': 'lk%d' % i, 'type': 'canal', 'owner': 'P2', 'endpoints': [a, b]})
    if deck is not None:
        st['remoteMarketDeck'] = {'cards': list(deck), 'drawn': []}
    st['remoteCottonTrack'] = track
    return st, p1, p2


def mill_of(st, pid, idx=0):
    return ST.get_player(st, pid)['industryTiles'][idx]


# ============ 1. 场景构造 ============
st, p1, p2 = make_sell_scene()
distant, ports = A._sale_channels(st, p1['industryTiles'][0])
check('1.1 构造：棉花厂同时有港口与远方市场渠道', distant and len(ports) == 1,
      'distant=%s ports=%d' % (distant, len(ports)))
routes = F.sell_routes(st, p1['industryTiles'][0])
check('1.2 路线：含远方市场单条 + 港口一条',
      len([r for r in routes if r['channel'] == 'distant']) == 1
      and len([r for r in routes if r['channel'] == 'port']) == 1,
      str([(r['channel'], r['key']) for r in routes]))

# ============ 2. 港口销售（官方 2.1 + 步骤 3） ============
st, p1, p2 = make_sell_scene(n_mills=2)
r = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                   'millId': 'mill1', 'channel': 'port', 'portTileId': 'port'})
check('2.1 卖到港口：提交成功', r.get('ok') is True, r.get('message'))
check('2.2 棉花厂翻面（步骤3）', mill_of(st, 'P1', 0)['flipped'] is True)
check('2.3 该港口翻面（2.1）', mill_of(st, 'P2')['flipped'] is True)
check('2.4 港口拥有者(P2)得翻面奖励（收入前进）', ST.get_player(st, 'P2')['incomePos'] > 10,
      'P2 income=%d' % ST.get_player(st, 'P2')['incomePos'])
check('2.5 港口销售无市场牌、无收入', r.get('detail', {}).get('income') == 0
      and r.get('detail', {}).get('card') is None, str(r.get('detail')))
check('2.6 还有第二座厂 → needSellContinue（会话续卖）',
      r.get('detail', {}).get('needSellContinue') is True and bool(st.get('pendingSell')),
      str(r.get('detail')))

# ============ 3. 会话续卖（官方步骤 4）：不弃牌、不扣 AP ============
st, p1, p2 = make_sell_scene(n_mills=3)
r1 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'port', 'portTileId': 'port'})
ap_before = st['actionPoints']                       # 首卖后仍在会话：2
hand_before = len(ST.get_player(st, 'P1')['hand'])   # 首卖已弃 1 张
r2 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'millId': 'mill2',
                    'channel': 'distant', 'portTileId': None})
check('3.1 续卖成功（港口已翻，走远方市场）', r2.get('ok') is True, r2.get('message'))
check('3.2 续卖不弃牌', len(ST.get_player(st, 'P1')['hand']) == hand_before,
      'hand=%d->%d' % (hand_before, len(ST.get_player(st, 'P1')['hand'])))
check('3.3 会话内不扣行动点（结束时才扣）', st['actionPoints'] == ap_before,
      'AP=%d->%d' % (ap_before, st['actionPoints']))
check('3.4 还有第三座厂 → 继续会话（needSellContinue）',
      r2.get('detail', {}).get('needSellContinue') is True and bool(st.get('pendingSell')),
      str(r2.get('detail')))
r3 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'millId': 'mill3',
                    'channel': 'distant', 'portTileId': None})
check('3.5 卖完最后一座 → 会话自动结束、扣 1 AP、pending 清除',
      r3.get('ok') is True and st.get('pendingSell') is None and st['actionPoints'] == ap_before - 1,
      'AP=%d pending=%s' % (st['actionPoints'], st.get('pendingSell')))
check('3.6 三座棉花厂全部翻面',
      all(mill_of(st, 'P1', i)['flipped'] for i in range(3)))

# ============ 4. 远方市场（官方 2.2）：收入轨前进 = 落点数值（非加钱！） ============
st, p1, p2 = make_sell_scene(deck=[2], track=0, n_mills=1)
income_before = ST.get_player(st, 'P1')['incomePos']
money_before = ST.get_player(st, 'P1')['money']
r3 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
d = r3.get('detail', {})
check('4.1 远方市场提交成功', r3.get('ok') is True, r3.get('message'))
check('4.2 抽牌=2、标记 0→2', d.get('card') == 2 and st['remoteCottonTrack'] == 2,
      'card=%s track=%d' % (d.get('card'), st['remoteCottonTrack']))
check('4.3 远方市场收入 = 落点数值 track[2]=2（detail.income）', d.get('income') == 2,
      'income=%s' % d.get('income'))
check('4.3b 收入轨总前进 = 落点数值 + 棉花厂翻面奖励(+5)，【金钱不变】',
      ST.get_player(st, 'P1')['incomePos'] == income_before + 2 + 5
      and ST.get_player(st, 'P1')['money'] == money_before,
      'incomePos=%d->%d money=%d->%d' % (income_before, ST.get_player(st, 'P1')['incomePos'],
                                         money_before, ST.get_player(st, 'P1')['money']))
check('4.4 棉花厂翻面', mill_of(st, 'P1')['flipped'] is True)
check('4.5 港口【不】翻面（远方市场渠道不翻港口）', mill_of(st, 'P2')['flipped'] is False)

# 负数牌按绝对值移动：-3 → 移动 3 → 落点 3 → 收入轨前进 track[3]=2
st, p1, p2 = make_sell_scene(deck=[-3], track=0, n_mills=1)
income_before2 = ST.get_player(st, 'P1')['incomePos']
r4 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('4.6 负数牌 -3：按绝对值移动 3、落点 3、收入轨前进 2（detail.income=2 且落点合计）',
      r4.get('detail', {}).get('card') == -3 and st['remoteCottonTrack'] == 3
      and r4.get('detail', {}).get('income') == 2
      and ST.get_player(st, 'P1')['incomePos'] == income_before2 + 2 + 5,
      'card=%s track=%d income=%s' % (r4.get('detail', {}).get('card'),
                                      st['remoteCottonTrack'], r4.get('detail', {}).get('income')))

# ============ 5. 命中 X：视为跳过（不翻棉花厂、不推进收入、行动结束） ============
st, p1, p2 = make_sell_scene(deck=[3], track=7, n_mills=2)
income_before = ST.get_player(st, 'P1')['incomePos']
money_before = ST.get_player(st, 'P1')['money']
r5 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('5.1 命中 X：返回 skipped', r5.get('ok') is True and r5.get('detail', {}).get('skipped') is True,
      str(r5))
check('5.2 标记停在 X(8)', st['remoteCottonTrack'] == 8)
check('5.3 棉花厂【不】翻面（不执行步骤3）', mill_of(st, 'P1', 0)['flipped'] is False)
check('5.4 不推进收入（income=0 且收入轨不动）',
      r5.get('detail', {}).get('income') == 0 and ST.get_player(st, 'P1')['incomePos'] == income_before,
      'incomePos=%d->%d' % (income_before, ST.get_player(st, 'P1')['incomePos']))
check('5.4b 金钱也不变', ST.get_player(st, 'P1')['money'] == money_before)
check('5.5 行动视为跳过：立即结束（扣 1 AP、pending 清除、不再续卖）',
      st['actionPoints'] == 1 and st.get('pendingSell') is None,
      'AP=%d pending=%s' % (st['actionPoints'], st.get('pendingSell')))

# ============ 6. 标记已在 X → 远方市场拒绝 ============
st, p1, p2 = make_sell_scene(deck=[1], track=8, n_mills=1)
r6 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('6.1 标记已在 X → SELL_DISTANT_X 拒绝', r6.get('fail_code') == 'SELL_DISTANT_X', str(r6))
check('6.2 拒绝后棉花厂未翻面、手牌未弃', mill_of(st, 'P1')['flipped'] is False
      and len(p1['hand']) == 5)

# ============ 7. 远方市场牌库空 → 拒绝 ============
st, p1, p2 = make_sell_scene(deck=[], track=0, n_mills=1)
r7 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('7.1 牌库空 → SELL_DECK_EMPTY 拒绝', r7.get('fail_code') == 'SELL_DECK_EMPTY', str(r7))
check('7.2 拒绝后未翻面、未弃牌', mill_of(st, 'P1')['flipped'] is False and len(p1['hand']) == 5)
# 牌库空时 sell_routes 不应给出远方市场路线（只能走港口）
routes = F.sell_routes(st, p1['industryTiles'][0])
check('7.3 牌库空 → 路线只剩港口', [r['channel'] for r in routes] == ['port'],
      str([(r['channel'], r['key']) for r in routes]))

# ============ 8. 非法目标 / 非法渠道 ============
st, p1, p2 = make_sell_scene(deck=[2], track=0, n_mills=1)
r8 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'nope', 'channel': 'distant', 'portTileId': None})
check('8.1 非自家棉花厂 → SELL_WRONG_MILL', r8.get('fail_code') == 'SELL_WRONG_MILL', str(r8))
st, p1, p2 = make_sell_scene(deck=[2], track=0, n_mills=1)
p1['industryTiles'][0]['flipped'] = True
r9 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                    'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('8.2 已翻面棉花厂 → SELL_WRONG_MILL', r9.get('fail_code') == 'SELL_WRONG_MILL', str(r9))
st, p1, p2 = make_sell_scene(chain=False, deck=[2], track=0, n_mills=1)
p2['industryTiles'].clear()          # 去掉港口 → 无任何市场标记
r10 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                     'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('8.3 未连市场标记 → SELL_WRONG_MILL', r10.get('fail_code') == 'SELL_WRONG_MILL', str(r10))
check('8.4 上述失败均不弃牌不扣行动点', len(p1['hand']) == 5 and st['actionPoints'] == 2)

# ============ 9. 只连港口的棉花厂也可走远方市场（港口不翻） ============
st, p1, p2 = make_sell_scene(chain=False, deck=[2], track=0, n_mills=1)
routes = F.sell_routes(st, p1['industryTiles'][0])
check('9.1 只连港口（无城市市场）时仍有远方市场路线',
      [r['channel'] for r in routes] == ['distant', 'port'],
      str([(r['channel'], r['key']) for r in routes]))
r11 = A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
                     'millId': 'mill1', 'channel': 'distant', 'portTileId': None})
check('9.2 经港口连接走远方市场：港口【不】翻、棉花厂翻',
      r11.get('ok') is True and mill_of(st, 'P2')['flipped'] is False
      and mill_of(st, 'P1')['flipped'] is True, str(r11))

# ============ 10. 会话强制：pending 期间其他行动被拒 ============
st, p1, p2 = make_sell_scene(n_mills=2)
A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
               'millId': 'mill1', 'channel': 'port', 'portTileId': 'port'})
check('10.1 首卖后进入会话（pendingSell 置位）', bool(st.get('pendingSell')))
r12 = A.apply_action(st, {'type': 'skip', 'cardId': 'city_manchester', 'playerId': 'P1'})
check('10.2 会话期间 skip → SELL_PENDING 拒绝', r12.get('fail_code') == 'SELL_PENDING', str(r12))
r13 = A.apply_action(st, {'type': 'loan', 'cardId': 'city_manchester', 'tier': 1, 'playerId': 'P1'})
check('10.3 会话期间 loan → SELL_PENDING 拒绝', r13.get('fail_code') == 'SELL_PENDING', str(r13))

# ============ 11. sell_end 结束会话 ============
r14 = A.apply_action(st, {'type': 'sell_end', 'playerId': 'P1'})
check('11.1 sell_end 成功', r14.get('ok') is True, r14.get('message'))
check('11.2 结束会话扣 1 行动点、pending 清除', st['actionPoints'] == 1 and not st.get('pendingSell'))
r15 = A.apply_action(st, {'type': 'sell_end', 'playerId': 'P1'})
check('11.3 无会话时 sell_end → SELL_NO_SESSION', r15.get('fail_code') == 'SELL_NO_SESSION', str(r15))

# ============ 12. 会话中撤回放行并完整还原 ============
st, p1, p2 = make_sell_scene(n_mills=2)
A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
               'millId': 'mill1', 'channel': 'port', 'portTileId': 'port'})
check('12.1 会话中可撤回', True)
ru = A.apply_action(st, {'type': 'undo', 'playerId': 'P1'})
pp1 = ST.get_player(st, 'P1')
check('12.2 撤回后 pending 清除、棉花厂/港口还原、手牌复原',
      not st.get('pendingSell') and not pp1['industryTiles'][0]['flipped']
      and not ST.get_player(st, 'P2')['industryTiles'][0]['flipped']
      and len(pp1['hand']) == 5 and pp1['money'] == 30,
      'pending=%s millFlipped=%s portFlipped=%s hand=%d money=%d'
      % (st.get('pendingSell'), pp1['industryTiles'][0]['flipped'],
         ST.get_player(st, 'P2')['industryTiles'][0]['flipped'], len(pp1['hand']), pp1['money']))

# ============ 13. end_turn 清会话（防绕过） ============
st, p1, p2 = make_sell_scene(n_mills=2)
A.do_sell(st, {'type': 'sell', 'playerId': 'P1', 'cardId': p1['hand'][0],
               'millId': 'mill1', 'channel': 'port', 'portTileId': 'port'})
st['actionPoints'] = 0
F.end_turn(st)
check('13.1 end_turn 清空售卖会话', not st.get('pendingSell'))

# ============ 汇总 ============
failed = [n for n, ok in RESULTS if not ok]
print('\n===== 结果: %d/%d 通过 =====' % (len(RESULTS) - len(failed), len(RESULTS)))
if failed:
    print('失败项:', failed)
    sys.exit(1)
print('全部通过 ✅')
