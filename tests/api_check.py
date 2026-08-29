# -*- coding: utf-8 -*-
"""联机 API 冒烟测试：模拟 3 台设备建房 → 加入 → 开局 → 轮流行动 → 终局。

重点验证服务器权威语义：
1. 非当前回合玩家提交行动会被拒（NOT_YOUR_TURN）
2. 下发状态不泄露他人手牌与抽牌堆
3. 客户端伪造 playerId 无效（身份由 token 决定）
4. rev 变化可驱动其他设备刷新

用法： python tests/api_check.py
"""
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server'))
sys.stdout.reconfigure(encoding='utf-8')

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402

# 测试用独立数据库，避免污染真实对局
db.DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_api_test.db')
if os.path.exists(db.DB_PATH):
    os.remove(db.DB_PATH)

from app.main import app  # noqa: E402
from engine import data as D  # noqa: E402
from engine import state as state_mod  # noqa: E402
from tests import selfplay  # noqa: E402

client = TestClient(app)
PASS, FAIL = [], []


def check(name, cond, extra=''):
    (PASS if cond else FAIL).append(name)
    print('%s %s%s' % ('  [OK]' if cond else '  [!!]', name, (' -> ' + str(extra)) if extra and not cond else ''))


def main():
    print('== 1. 健康检查 ==')
    r = client.get('/api/health').json()
    check('服务在线', r['status'] == 'ok', r)
    check('已探测到局域网地址', isinstance(r['lan'], list))

    print('== 2. 建房 + 两台设备加入 ==')
    r = client.post('/api/rooms', json={'roomName': '客厅', 'playerName': '阿伟'}).json()
    tok_a, room_id = r['token'], r['room']['roomId']
    check('房主入座', r['room']['isHost'] and r['room']['myPlayerId'] == 'P1')

    tok_b = client.post('/api/rooms/%s/join' % room_id, json={'playerName': '小林'}).json()['token']
    rb = client.post('/api/rooms/%s/join' % room_id, json={'playerName': '老陈'}).json()
    tok_c = rb['token']
    check('第三人入座为 P3', rb['room']['myPlayerId'] == 'P3')
    check('大厅可见房间', any(x['roomId'] == room_id for x in client.get('/api/rooms').json()['rooms']))

    print('== 3. 权限：非房主不能开局 ==')
    check('非房主开局被拒', client.post('/api/rooms/%s/start' % room_id,
                                        json={'token': tok_b}).status_code == 403)

    print('== 4. 房主开局 ==')
    r = client.post('/api/rooms/%s/start' % room_id, json={'token': tok_a, 'seed': 20260808})
    check('开局成功', r.status_code == 200, r.text[:200])
    st_a = r.json()['state']
    check('运河时代首轮 1 行动点', st_a['phase'] == 'canal' and st_a['actionPoints'] == 1)

    print('== 5. 视角过滤 ==')
    sb = client.get('/api/rooms/%s/state' % room_id, params={'token': tok_b}).json()['state']
    others = [p for p in sb['players'] if p['id'] != 'P2']
    check('看不到他人手牌', all(p['hand'] == [] for p in others))
    check('能看到他人手牌数量', all(p['handCount'] > 0 for p in others))
    check('看不到抽牌堆内容', 'drawPile' not in sb)
    check('看不到撤回栈', 'undoStack' not in sb)
    check('远方市场牌库只给数量', isinstance(sb['remoteMarketDeck']['remaining'], int))
    check('自己的手牌可见', len([p for p in sb['players'] if p['id'] == 'P2'][0]['hand']) == 8)

    cur = sb['currentPlayer']
    tok_by_pid = {'P1': tok_a, 'P2': tok_b, 'P3': tok_c}
    non_cur = next(pid for pid in ('P1', 'P2', 'P3') if pid != cur)
    check('非当前玩家按钮全灰', not any(
        client.get('/api/rooms/%s/state' % room_id,
                   params={'token': tok_by_pid[non_cur]}).json()['state']['buttonEnabled'].values()))

    print('== 6. 越权与伪造 ==')
    r = client.post('/api/rooms/%s/action' % room_id,
                    json={'token': tok_by_pid[non_cur], 'action': {'type': 'skip'}}).json()
    check('非当前回合行动被拒', r['result']['fail_code'] == 'NOT_YOUR_TURN', r['result'])
    r = client.post('/api/rooms/%s/action' % room_id,
                    json={'token': tok_by_pid[non_cur],
                          'action': {'type': 'skip', 'playerId': cur}}).json()
    check('伪造 playerId 无效', r['result']['fail_code'] == 'NOT_YOUR_TURN', r['result'])
    check('无效 token 被拒', client.get('/api/rooms/%s/state' % room_id,
                                        params={'token': 'fake'}).status_code == 403)

    print('== 7. 长轮询：无变化时挂起，有变化立即返回 ==')
    r0 = client.get('/api/rooms/%s/state' % room_id, params={'token': tok_a}).json()
    r1 = client.get('/api/rooms/%s/state' % room_id,
                    params={'token': tok_a, 'since': r0['rev'], 'wait': 0.5}).json()
    check('无变化返回 changed=False', r1['changed'] is False and r1['rev'] == r0['rev'])

    print('== 8. 跑完整局（服务端权威驱动） ==')
    rng = random.Random(7)
    steps, applied = 0, 0
    while steps < 4000:
        steps += 1
        snap = client.get('/api/rooms/%s/state' % room_id,
                          params={'token': tok_a}).json()
        st = snap['state']
        if st.get('gameOver'):
            break
        pid = st['currentPlayer']
        tok = tok_by_pid[pid]
        full = client.get('/api/rooms/%s/state' % room_id, params={'token': tok}).json()['state']
        # 交给自对弈策略选行动。视角状态对当前玩家已够用，只需把被过滤成「数量」的
        # 牌堆补成占位列表，并修回 JSON 往返丢失的 int 键（真实前端是 JS，不需要这步）。
        state_mod.normalize_state(full)
        full['drawPile'] = [None] * full.get('deckRemaining', 0)
        full['remoteMarketDeck'] = {
            'cards': [None] * (full.get('remoteMarketDeck') or {}).get('remaining', 0),
            'drawn': [],
        }
        enabled = [k for k, v in full['buttonEnabled'].items() if v and k in selfplay.BUILDERS]
        if not enabled:
            client.post('/api/rooms/%s/end-turn' % room_id, json={'token': tok})
            continue
        pool = []
        for k in enabled:
            pool += [k] * selfplay.WEIGHT.get(k, 1)
        act = None
        for _ in range(6):
            act = selfplay.BUILDERS[rng.choice(pool)](full, rng)
            if act:
                break
        if not act:
            client.post('/api/rooms/%s/end-turn' % room_id, json={'token': tok})
            continue
        act['version'] = full['version']
        res = client.post('/api/rooms/%s/action' % room_id,
                          json={'token': tok, 'action': act}).json()['result']
        if res['ok']:
            applied += 1
            # 建造铁/煤厂后回合暂停，需跟随补市场抉择才能继续
            if (res.get('detail') or {}).get('needSupplement'):
                rsup = client.post('/api/rooms/%s/action' % room_id,
                                   json={'token': tok,
                                         'action': {'type': 'supplement_market', 'supply': True}}).json()
                if not rsup['result']['ok']:
                    check('补市场后续行动成功', False, rsup['result'])
                    break
            # 售卖会话（官方步骤 4）：续卖或结束
            while True:
                snap2 = client.get('/api/rooms/%s/state' % room_id,
                                   params={'token': tok}).json()['state']
                if not snap2.get('pendingSell'):
                    break
                state_mod.normalize_state(snap2)
                snap2['drawPile'] = [None] * snap2.get('deckRemaining', 0)
                snap2['remoteMarketDeck'] = {
                    'cards': [None] * (snap2.get('remoteMarketDeck') or {}).get('remaining', 0),
                    'drawn': [],
                }
                cont = selfplay.pick_sell(snap2, rng, session=True)
                act2 = cont if (cont and rng.random() < 0.8) else {'type': 'sell_end'}
                act2['version'] = snap2['version']
                r2 = client.post('/api/rooms/%s/action' % room_id,
                                 json={'token': tok, 'action': act2}).json()['result']
                if not r2['ok']:
                    check('售卖会话续卖/结束成功', False, r2)
                    break
                applied += 1
        elif res['fail_code'] not in ('BUILD_INSUFFICIENT_MONEY', 'ROAD_INSUFFICIENT_COAL'):
            check('行动 %s 被意外拒绝' % act['type'], False, res)
            break
    final = client.get('/api/rooms/%s/state' % room_id, params={'token': tok_a}).json()
    check('对局正常终局', bool(final['state'].get('gameOver')), '步数 %d' % steps)
    check('房间状态置为 finished', final['room']['status'] == 'finished')
    check('产生胜者与排名', bool(final['state'].get('winner')) and len(final['state']['ranking']) == 3)
    print('  终局：%d 步 / %d 次成功行动 | 胜者 %s | 分数 %s'
          % (steps, applied, final['state']['winner'],
             {k: v['total'] for k, v in final['state']['scores'].items()}))

    print('== 9. 重开 ==')
    r = client.post('/api/rooms/%s/restart' % room_id, json={'token': tok_a}).json()
    check('回到大厅且保留 3 个座位', r['room']['status'] == 'lobby' and len(r['room']['seats']) == 3)

    print('\n--- 通过 %d 项，失败 %d 项 ---' % (len(PASS), len(FAIL)))
    for f in FAIL:
        print('   失败：%s' % f)
    return 1 if FAIL else 0


if __name__ == '__main__':
    code = main()
    if os.path.exists(db.DB_PATH):
        try:
            os.remove(db.DB_PATH)
        except OSError:
            pass
    sys.exit(code)
