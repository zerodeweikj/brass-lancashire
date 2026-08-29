# -*- coding: utf-8 -*-
"""远方市场轨「单一数据源」护栏（2026-08-11 用户规定）：

引擎的轨道数值/终点必须与映射文件 web/public/data/map_points.json 的
regions.foreign_market_track 完全一致——前端用同一份文件的 positions 做蛇形可视化，
引擎用同一份的 values 判定收入/终点；本测试锁死「两处永不漂移」。
官方表：[3,3,2,2,1,1,0,0,X]（X 位值记 0）；标记从最左 3 起步，蛇形单向只进不退。
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.stdout.reconfigure(encoding='utf-8')

from engine import data as D, setup as S

RESULTS = []
def check(name, cond, detail=''):
    RESULTS.append((name, cond))
    print('[%s] %s%s' % ('PASS' if cond else 'FAIL', name,
                         ('  -- ' + str(detail)) if (detail and not cond) else ''))


track = D.remote_market_track()
check('1.1 映射文件存在且含 foreign_market_track', bool(track))
check('1.2 values 与官方表 [3,3,2,2,1,1,0,0,X] 一致（X 位记 0）',
      track['values'] == [3, 3, 2, 2, 1, 1, 0, 0, 0], str(track.get('values')))
check('1.3 positions 为 9 格蛇形坐标', isinstance(track.get('positions'), list)
      and len(track['positions']) == 9, str(len(track.get('positions') or [])))
check('1.4 values 长度与 positions 长度一致', len(track['values']) == len(track['positions']))
check('1.5 end_index == 8（X 终点）', int(track.get('end_index')) == 8,
      str(track.get('end_index')))
check('1.6 蛇形单向：终点 X 在末位、起点 3 在首位', track['values'][0] == 3 and track['values'][-1] == 0)

st = S.create_game(['P1', 'P2'], seed=1)
check('2.1 引擎 remoteTrackValues == 映射 values（单一数据源）',
      st['remoteTrackValues'] == track['values'],
      'engine=%s file=%s' % (st['remoteTrackValues'], track['values']))
check('2.2 引擎 remoteTrackEnd == 映射 end_index', st.get('remoteTrackEnd') == int(track['end_index']),
      'engine=%s file=%s' % (st.get('remoteTrackEnd'), track.get('end_index')))
check('2.3 标记从最左 3 起步（remoteCottonTrack=0）', st['remoteCottonTrack'] == 0
      and st['remoteTrackValues'][0] == 3)
check('2.4 X 位值 0（X 视为 0，命中走「行动跳过」）', st['remoteTrackValues'][-1] == 0)

failed = [n for n, ok in RESULTS if not ok]
print('\n===== 结果: %d/%d 通过 =====' % (len(RESULTS) - len(failed), len(RESULTS)))
if failed:
    print('失败项:', failed)
    sys.exit(1)
print('全部通过 ✅')
