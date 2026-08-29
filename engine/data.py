# -*- coding: utf-8 -*-
"""静态数据加载与索引（data/*.json → 内存索引）"""
import json, os

# 项目根：默认按本文件位置推导（engine/data.py → 上两级）；部署成二进制后用
# 环境变量 BRASS_ROOT 显式指定，避免 Nuitka 打包后 __file__ 路径错乱找不到数据。
_PROJECT_ROOT = os.environ.get('BRASS_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(_PROJECT_ROOT, 'data')


def _load(name):
    with open(os.path.join(DATA_DIR, name), encoding='utf-8') as f:
        return json.load(f)


LOCATIONS = _load('locations.json')
INDUSTRY_TILES = _load('industry_tiles.json')
INCOME_TRACK = _load('income_track.json')
CARDS = _load('cards.json')

# ---- 远方市场轨映射（单一数据源） ----
# 前端渲染标记位置、引擎数值判定统一读 web/public/data/map_points.json 的
# regions.foreign_market_track——禁止两处手写漂移（2026-08-11 用户规定）。
_WEB_DATA_DIR = os.path.join(_PROJECT_ROOT, 'web', 'public', 'data')


def remote_market_track():
    """远方的棉花市场轨映射：{positions, values, end_index, note}（9 格蛇形）。"""
    with open(os.path.join(_WEB_DATA_DIR, 'map_points.json'), encoding='utf-8') as f:
        mp = json.load(f)
    return mp['regions']['foreign_market_track']

# ---- 索引 ----
LOCATION_BY_ID = {l['id']: l for l in LOCATIONS}
CARD_BY_ID = {c['id']: c for c in CARDS}
# 产业数值：按 (industry中文名, level) 索引；industry 中文名来自 industry_tiles.json
TILE_DEF_BY_IND_LEVEL = {(t['industry'], t['level']): t for t in INDUSTRY_TILES}
# 产业名（中文）→ building_id
BUILDING_ID_BY_INDUSTRY = {}
for t in INDUSTRY_TILES:
    if t['building_id']:
        BUILDING_ID_BY_INDUSTRY[t['industry']] = t['building_id']
INDUSTRY_BY_BUILDING_ID = {v: k for k, v in BUILDING_ID_BY_INDUSTRY.items()}
# 煤/铁市场单价档位
MARKET_PRICES = [1, 2, 3, 4]


def tile_def(industry: str, level: int):
    """查某产业某等级的数值定义；不存在返回 None"""
    return TILE_DEF_BY_IND_LEVEL.get((industry, level))


# ---- 建造资格闸门（白名单）----
# industry_tiles.json 的 era 字段共 5 种取值：
#   'canal_only' / 'rail_only' / 'any'  → 可建（再按时代细分）
#   '无法建造'                          → 造船厂 0 级占位板块，只能用「发展」弃掉
#   '—'                                 → 该产业没有这一等级的板块
# 【务必用白名单】历史 bug：三处校验曾写成 `era == 'canal_only'` / `era == 'rail_only'`
# 的否定式黑名单，凡未列举的取值一律放行，导致 era='无法建造' 且 cost={} 的
# 造船厂 0 级占位块可以在第一回合被免费建到地图上。
BUILDABLE_ERAS = frozenset(('canal_only', 'rail_only', 'any'))


def tile_buildable(td, phase):
    """该板块此刻能否建造。返回 (ok, fail_code, message)。

    td    —— tile_def() 的返回值（可为 None）
    phase —— 'canal' / 'rail'

    这是引擎唯一的建造资格判定入口，flow.buildable_level / actions.do_build /
    build.validate_build 三层共用，确保三层结论永远一致。
    """
    if not td:
        return (False, 'BUILD_NO_SUPPLY', '没有该等级的板块定义。')
    ind = td.get('industry', '')
    lv = td.get('level')
    era = td.get('era')
    if era == '无法建造':
        return (False, 'BUILD_TILE_PLACEHOLDER',
                '%d 级%s是占位板块，不能建造，只能用「发展」行动弃掉。' % (lv, ind))
    if era not in BUILDABLE_ERAS:
        return (False, 'BUILD_NO_SUPPLY', '%s 没有 %s 级板块。' % (ind, lv))
    if not td.get('per_player'):
        return (False, 'BUILD_NO_SUPPLY', '%s 没有 %s 级板块。' % (ind, lv))
    if era == 'canal_only' and phase != 'canal':
        return (False, 'BUILD_WRONG_ERA', '%d 级%s只能在运河时代建造。' % (lv, ind))
    if era == 'rail_only' and phase != 'rail':
        return (False, 'BUILD_WRONG_ERA', '%d 级%s只能在铁路时代建造。' % (lv, ind))
    return (True, None, None)


def income_number(pos: int) -> int:
    """收入轨位置 → 收入数（派生，不单存）"""
    return INCOME_TRACK['positions'][pos]
