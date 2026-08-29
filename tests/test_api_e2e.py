# -*- coding: utf-8 -*-
"""API 端到端验证：建对局 → 造运输网 → 提交建造煤厂（成功路径 + 撤回栈）"""
import json, sys, os, urllib.request
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from server.app import db
from engine import state as es

BASE = 'http://127.0.0.1:8765'

# 1) 直接存一个带运输网的对局（模拟 P1 已建利物浦港口 + 运河利物浦—维根）
st = es.create_initial_state([
    ('P1', 'red', ['city_wigan', 'ind_building_002', 'city_manchester', 'city_liverpool', 'ind_building_001'], 12),
    ('P2', 'yellow', ['city_liverpool', 'city_wigan', 'ind_building_004'], 30),
], game_id='api_e2e', phase='canal', round_no=2)
p1 = es.get_player(st, 'P1')
p1['industryTiles'].append({'id': 'tile_001', 'buildingId': 'building_004', 'level': 1, 'owner': 'P1',
                            'location': 'LIVERPOOL', 'slotIndex': 0, 'flipped': False, 'boardResources': 0, 'builtEra': 'canal'})
p1['linkTiles'].append({'id': 'link_001', 'type': 'canal', 'owner': 'P1',
                        'endpoints': ['LIVERPOOL', 'WIGAN'], 'builtEra': 'canal'})
p1['remainingLinks'] = 13
db.save_game('api_e2e', st)

# 2) API 提交建造煤厂
body = json.dumps({'action': {'action': 'build', 'version': 0, 'cityCardId': 'city_wigan',
                              'industryCardId': 'ind_building_002', 'location': 'WIGAN', 'slotIndex': 0}}).encode()
req = urllib.request.Request(f'{BASE}/game/api_e2e/action', data=body, headers={'Content-Type': 'application/json'})
resp = json.loads(urllib.request.urlopen(req).read())
r = resp['result']
new_st = resp['state']
assert r['ok'], f'预期成功，实际 {r}'
p1n = [p for p in new_st['players'] if p['id'] == 'P1'][0]
assert p1n['money'] == 7, p1n['money']
assert p1n['hand'] == ['city_manchester', 'city_liverpool', 'ind_building_001'], p1n['hand']
assert new_st['actionPoints'] == 1
assert any(t['buildingId'] == 'building_002' and t['location'] == 'WIGAN' and t['level'] == 1
            and not t['flipped'] and t['boardResources'] == 2 for t in p1n['industryTiles'])
assert new_st['version'] == 1 and len(new_st['undoStack']) == 1

# 3) 验证已持久化（重新从 SQLite 读）
loaded = db.load_game('api_e2e')
assert loaded['version'] == 1 and loaded['players'][0]['money'] == 7

print('API 端到端成功路径全部通过 ✅')
print(f"  game_id=api_e2e | version={new_st['version']} | 撤回栈={len(new_st['undoStack'])} | "
      f"P1 金钱={p1n['money']} 手牌={p1n['hand']}")
print(f"  维根煤厂: {[t for t in p1n['industryTiles'] if t['buildingId']=='building_002']}")
