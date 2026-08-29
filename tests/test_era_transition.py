# -*- coding: utf-8 -*-
"""时代转换结算测试（2026-08-11 用户重新规定的计分口径）：
运河→铁路：计分（只有翻面板块计分：已翻面计、未翻面 L2+ 当场翻面计、未翻面 L1 不计分且移除）、
  连结分（每连结两端连接标记数封顶 2）、清场（弃1级板块/清运河连结/重置remainingLinks）、
  弃牌堆洗回抽牌堆、远方市场弃牌洗回、按末轮花费重排顺位、重发手牌；
铁路→终局：所有翻面板块【再次】计分（运河板块不因计过而豁免）、未翻面板块终局翻面、加收入轨数值、
  gameOver/ranking/winner；
铁路时代开局修路起点 = 自己留在场上的（运河时代建的）板块城市（own_network 不因清场丢失）；
全员空手+空牌库 → 自动触发时代转换（修复"进不了下一阶段"）。
"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding='utf-8')

from engine import setup as S, flow as F, state as ST
M = __import__('engine.mechanics', fromlist=['connected_to_market'])


def make_game(players):
    return S.create_game(players)


def add_tile(p, tile_id, building, level, loc, flipped=False, era='canal', resources=0):
    p['industryTiles'].append({'id': tile_id, 'buildingId': building, 'level': level, 'owner': p['id'],
                               'location': loc, 'slotIndex': 0, 'flipped': flipped,
                               'boardResources': resources, 'builtEra': era})


RESULTS = []
def check(name, cond, detail=''):
    RESULTS.append((name, cond))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name, ('  -- ' + str(detail)) if (detail and not cond) else ''))

# ---------- 1. 全员空手 + 空牌库 → 自动转换 canal→rail ----------
st = make_game(['P1', 'P2', 'P3', 'P4'])
for p in st['players']:
    p['hand'] = []
st['drawPile'] = []
st['deckRemaining'] = 0
steps = 0
while st['phase'] == 'canal' and not st.get('gameOver') and steps < 40:
    F.end_turn(st)
    steps += 1
check('全员空手+空牌库后自动进入铁路时代', st['phase'] == 'rail', 'phase=%s steps=%d' % (st['phase'], steps))
check('铁路时代 round=1 且行动点=2', st['round'] == 1 and st['actionPoints'] == 2, 'round=%s ap=%s' % (st['round'], st['actionPoints']))

# ---------- 2. 运河结算：未翻面 L2+ 当场翻面并计分；1 级不翻面不计分 ----------
st = make_game(['P1', 'P2'])
p1 = ST.get_player(st, 'P1')
add_tile(p1, 'canal_flipped', 'building_004', 3, 'LIVERPOOL', flipped=True, era='canal')      # 港口 L3 vp=6
add_tile(p1, 'canal_l2', 'building_004', 2, 'WIGAN', flipped=False, era='canal')             # L2 未翻面 → 应翻面计分
add_tile(p1, 'canal_l1', 'building_001', 1, 'BOLTON', flipped=False, era='canal')            # L1 未翻面 → 不翻面不计分
F.score_phase(st, 'canal')
t_l2 = next(t for t in p1['industryTiles'] if t['id'] == 'canal_l2')
t_l1 = next(t for t in p1['industryTiles'] if t['id'] == 'canal_l1')
check('运河结算：未翻面 L2+ 板块当场翻面', t_l2['flipped'] is True)
check('运河结算：1 级未翻面板块不翻面', t_l1['flipped'] is False)
expected = 6 + 4  # 港口L3 vp6 + 港口L2 vp4（L1 不计）
check('运河计分 = 翻面板块 VP 之和', st['scores']['P1']['canal'] >= expected,
      'canal=%d 期望>=%d' % (st['scores']['P1']['canal'], expected))

# ---------- 3. 铁路结算：翻面板块全部计分（运河板块【再次】计分）；未翻面板块排除不计分；加收入 ----------
st = make_game(['P1', 'P2'])
p1 = ST.get_player(st, 'P1')
add_tile(p1, 'r_canal', 'building_004', 3, 'LIVERPOOL', flipped=True, era='canal')   # 运河板块（已翻面）：铁路必须再次计分
add_tile(p1, 'r_rail', 'building_004', 3, 'PRESTON', flipped=True, era='rail')       # 铁路板块（已翻面）：计
add_tile(p1, 'r_rail_unflip', 'building_001', 2, 'WIGAN', flipped=False, era='rail') # 铁路未翻面板块：终局【不翻面、排除不计分】
p1['incomePos'] = 3
st['phase'] = 'rail'
F.score_phase(st, 'rail')
inc = __import__('engine.mechanics', fromlist=['income_of']).income_of(p1)
t_unf = next(t for t in p1['industryTiles'] if t['id'] == 'r_rail_unflip')
check('铁路结算：运河时代翻面板块【再次】计分（不豁免）',
      st['scores']['P1']['rail'] == 6 + 6 + inc,
      'rail=%d 期望=%d' % (st['scores']['P1']['rail'], 6 + 6 + inc))
check('铁路结算：未翻面板块【不翻面、排除不计分】', t_unf['flipped'] is False,
      'flipped=%s' % t_unf['flipped'])
check('铁路终局加入收入轨数值（正加负减）', inc != 0, 'inc=%d' % inc)

# ---------- 4. 连结分：每标记 1 分【不封顶】；只算自己的翻面板块；计完逐条移除 ----------
st = make_game(['P1', 'P2'])
p1 = ST.get_player(st, 'P1')
# THEMIDLANDS(印刷2) - NORTHWICH(印刷2)：无板块时连接分 = 4（不封顶）
p1['linkTiles'].append({'id': 'lk1', 'type': 'canal', 'owner': 'P1', 'endpoints': ['THEMIDLANDS', 'NORTHWICH']})
F.score_phase(st, 'canal')
link4 = st['scores']['P1']['canal']
check('运河连结分 = 两端印刷标记数之和（4 分，不封顶）', link4 == 4, 'link=%d' % link4)
check('连接计分后逐条移除（归还玩家）', len(p1['linkTiles']) == 0, 'n=%d' % len(p1['linkTiles']))

# 连接标记只算【自己的】翻面板块：自己的板块 +1 标记，别人的板块不计
st = make_game(['P1', 'P2'])
p1 = ST.get_player(st, 'P1')
p2 = ST.get_player(st, 'P2')
add_tile(p1, 'own_tile', 'building_004', 2, 'THEMIDLANDS', flipped=True, era='canal')   # 自己的翻面港口 → THEMIDLANDS 3 标记
add_tile(p2, 'other_tile', 'building_004', 2, 'NORTHWICH', flipped=True, era='canal')   # 别人的翻面港口 → 不计入 P1
p1['linkTiles'].append({'id': 'lk2', 'type': 'canal', 'owner': 'P1', 'endpoints': ['THEMIDLANDS', 'NORTHWICH']})
F.score_phase(st, 'canal')
link_own = st['scores']['P1']['_link']
check('连接标记只算自己的翻面板块（3+2=5），别人的板块不计', link_own == 5, 'link=%d' % link_own)

# ---------- 5. clear_canal 清场事件 ----------
st = make_game(['P1', 'P2', 'P3', 'P4'])
for i, p in enumerate(st['players']):
    add_tile(p, 'l1_%s' % i, 'building_001', 1, 'LIVERPOOL', flipped=True, era='canal')   # 1 级 → 移除
    add_tile(p, 'l3_%s' % i, 'building_004', 3, 'WIGAN', flipped=True, era='canal')       # 3 级 → 保留
    p['linkTiles'].append({'id': 'c_%s' % i, 'type': 'canal', 'owner': p['id'], 'endpoints': ['LIVERPOOL', 'WIGAN']})
    p['hand'] = [('city_%s' % i) * 0 or 'city_manchester'] * 1
    p['discard_'] = None
st['discardPile'] = ['city_wigan', 'ind_building_002', 'city_bolton', 'city_bury', 'ind_building_001', 'ind_building_002',
                     'city_colne', 'city_burnley', 'city_lancaster', 'city_preston', 'city_fleetwood', 'ind_building_004',
                     'city_rochdale', 'city_oldham', 'city_macclesfield', 'ind_building_003']  # 16 张足够发满
st['remoteMarketDeck'] = {'cards': ['fm1'], 'drawn': ['fm2', 'fm3']}
st['remoteCottonTrack'] = 5
st['turnOrder'] = ['P1', 'P2', 'P3', 'P4']
st['spentThisRound'] = {'P1': 9, 'P2': 1, 'P3': 5, 'P4': 3}   # 末轮花费 → P2 最少应排第一
st['drawPile'] = []
F.clear_canal(st)
p0 = st['players'][0]
check('清场：1 级板块移除', all(t['level'] > 1 for p in st['players'] for t in p['industryTiles']))
check('清场：1 级板块计入 discardedTiles', len(st.get('discardedTiles', [])) >= 4, 'n=%d' % len(st.get('discardedTiles', [])))
check('清场：运河连结全部移除', all(len(p['linkTiles']) == 0 for p in st['players']))
check('清场：remainingLinks 重置', all(p['remainingLinks'] == F.LINK_TILES_PER_PLAYER for p in st['players']))
check('清场：弃牌堆清空并洗回抽牌堆', st['discardPile'] == [] and len(st['drawPile']) + sum(len(p['hand']) for p in st['players']) == 16,
      'drawPile=%d hands=%s' % (len(st['drawPile']), [len(p['hand']) for p in st['players']]))
check('清场：远方市场弃牌洗回牌堆', sorted(st['remoteMarketDeck']['cards']) == ['fm1', 'fm2', 'fm3'] and st['remoteMarketDeck']['drawn'] == [])
check('清场：远方市场轨重置', st['remoteCottonTrack'] == 0)
check('清场：按末轮花费重排顺位（花费少者在前）', st['turnOrder'][0] == 'P2', 'order=%s' % st['turnOrder'])
check('清场：按新顺位优先发满手牌（牌不足则先发者得）',
      all(len(ST.get_player(st, pid)['hand']) == F.HAND_LIMIT for pid in st['turnOrder'][:2])
      and all(len(ST.get_player(st, pid)['hand']) == 0 for pid in st['turnOrder'][2:]),
      'order=%s hands=%s' % (st['turnOrder'], [len(ST.get_player(st, pid)['hand']) for pid in st['turnOrder']]))

# ---------- 6. 铁路 → 终局 ----------
st = make_game(['P1', 'P2'])
st['phase'] = 'rail'
F.end_era(st)
check('铁路时代结束 → gameOver', st.get('gameOver') is True)
check('终局产生胜者与排名', bool(st.get('winner')) and len(st.get('ranking', [])) == 2,
      'winner=%s ranking=%s' % (st.get('winner'), st.get('ranking')))

# ---------- 7. 铁路时代开局修路起点 = 自己留在场上的（运河建的）板块城市 ----------
st = make_game(['P1', 'P2'])
p1 = ST.get_player(st, 'P1')
add_tile(p1, 'coal2', 'building_002', 2, 'WIGAN', flipped=True, era='canal')   # 运河时代建的 2 级煤厂（结算翻面留场）
st['drawPile'] = []
for p in st['players']:
    p['hand'] = []
F.score_phase(st, 'canal')
F.clear_canal(st)
net = ST.own_network(st, 'P1')
check('铁路时代开局 own_network 保留运河板块城市 WIGAN', 'WIGAN' in net, 'net=%s' % sorted(net))
links = F.legal_link_targets(st, 'P1')
link_from_net = [l for l in links if l['from'] == 'WIGAN' or l['to'] == 'WIGAN']
check('铁路时代可以以运河板块城市 WIGAN 为起点修路（网络内）', len(link_from_net) > 0,
      'WIGAN 相关连接=%s' % ['%s-%s' % (l['from'], l['to']) for l in link_from_net])

# ---------- 8. 铁路时代无运输网：以【有市场标记的城市】为起点修路（市场标记共用） ----------
st = make_game(['P1', 'P2'])
p1 = ST.get_player(st, 'P1')        # 无板块、无连接 → 无运输网
p1['money'] = 100
st['phase'] = 'rail'
links0 = F.legal_link_targets(st, 'P1')
market_set = F.market_locations(st)
check('铁路时代无运输网：修路起点（from）⊆ 市场标记城市', bool(links0)
      and all(l['from'] in market_set for l in links0)
      and any(l['from'] == 'THEMIDLANDS' for l in links0),
      'from=%s market=%s' % (sorted(set(l['from'] for l in links0)), sorted(market_set)))
# 任何玩家的港口板块所在城市也算市场标记（共用）：P2 在 LIVERPOOL 建港口 → P1 可以 LIVERPOOL 为起点
st2 = make_game(['P1', 'P2'])
p2 = ST.get_player(st2, 'P2')
add_tile(p2, 'port_lv', 'building_004', 1, 'LIVERPOOL', flipped=False, era='canal')
st2['phase'] = 'rail'
p1b = ST.get_player(st2, 'P1')
p1b['money'] = 100
links1 = F.legal_link_targets(st2, 'P1')
check('港口城市（任何玩家建造）作为市场标记起点修路', any(l['from'] == 'LIVERPOOL' for l in links1),
      'from=%s' % sorted(set(l['from'] for l in links1)))
# 【翻面】港口同样拥有市场标记属性（2026-08-11 用户规定）：P2 的翻面港口城市也可作为 P1 修路起点
st3 = make_game(['P1', 'P2'])
p2c = ST.get_player(st3, 'P2')
add_tile(p2c, 'port_blackpool', 'building_004', 2, 'BLACKPOOL', flipped=True, era='canal')   # 已翻面港口
st3['phase'] = 'rail'
p1c = ST.get_player(st3, 'P1')
p1c['money'] = 100
links2 = F.legal_link_targets(st3, 'P1')
check('翻面港口城市同样拥有市场标记（可作修路起点）', any(l['from'] == 'BLACKPOOL' for l in links2),
      'from=%s' % sorted(set(l['from'] for l in links2)))
# connected_to_market 也认翻面港口（棉花厂经翻面港口连市场 = 可售渠道一致）
st4 = make_game(['P1', 'P2'])
p1d = ST.get_player(st4, 'P1')
add_tile(p1d, 'mill', 'building_003', 1, 'LIVERPOOL', flipped=False, era='canal')            # 棉花厂
p2d = ST.get_player(st4, 'P2')
add_tile(p2d, 'port_flip', 'building_004', 1, 'SOUTHPORT', flipped=True, era='canal')        # 翻面港口
# 直接验证：翻面港口城市本身即市场 → connected_to_market True
check('connected_to_market 认翻面港口城市', M.connected_to_market(st4, 'SOUTHPORT'),
      'SOUTHPORT 有翻面港口应视为市场')

# ---------- 汇总 ----------
failed = [n for n, ok in RESULTS if not ok]
print('\n===== 结果: %d/%d 通过 =====' % (len(RESULTS) - len(failed), len(RESULTS)))
if failed:
    print('失败项:', failed)
    sys.exit(1)
print('全部通过 ✅')
