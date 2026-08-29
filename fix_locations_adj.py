"""规范化 data/locations.json 与 web/public/data/locations.json：
1) canal_adj / rail_adj 由中文城市名改为城市ID（引擎 _adjacent 与前端 _drawNetwork 都按 ID 索引）。
2) 同步 LIVERPOOL.slots 为修正版 4 独立槽位（此前只改了 web 副本）。
保留 name 字段供显示。幂等可重跑。
"""
import json
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
FILES = [
    os.path.join(ROOT, 'data', 'locations.json'),
    os.path.join(ROOT, 'web', 'public', 'data', 'locations.json'),
]
# 利物浦修正版（web 副本已是对的，作为权威值）
LIVERPOOL_SLOTS = [['port'], ['port'], ['port'], ['shipyard']]


def normalize(path):
    locs = json.load(open(path, encoding='utf-8'))
    name2id = {l['name']: l['id'] for l in locs if 'name' in l}
    changed = 0
    for l in locs:
        cid = l['id']
        for adj_key in ('canal_adj', 'rail_adj'):
            old = l.get(adj_key) or []
            new = []
            for nb in old:
                if nb in name2id:
                    new.append(name2id[nb])
                    if name2id[nb] != nb:
                        changed += 1
                else:
                    # 已是 ID 或无法映射 → 保留
                    new.append(nb)
            l[adj_key] = new
        if cid == 'LIVERPOOL':
            if l.get('slots') != LIVERPOOL_SLOTS:
                l['slots'] = [list(s) for s in LIVERPOOL_SLOTS]
                changed += 1
    json.dump(locs, open(path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    return changed


if __name__ == '__main__':
    for f in FILES:
        n = normalize(f)
        print(f'[OK] {f}  改动项={n}')
    print('完成：邻接字段已统一为城市ID，LIVERPOOL.slots 已同步。')
