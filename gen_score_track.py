# -*- coding: utf-8 -*-
"""score_track.json 重生成：用户实测锚点（硬点）+ 格距规律权重插值生成 100 格。

规律（沿轨道弧长，全部经用户锚点闭环验证）：
- 值内格距 = 56px（2/3/4 格区全部一致，实测 53~58）
- 单格区（值 -10~0）= 70px/格
- 跨值边界按位置查表（left≈82 / top 81~112 / right 105~112 / bottom 91~96）
- 锚点为硬点 100% 命中；未锚定格子按"权重比例"分布在锚点之间（权重=值内56/边界查表值/单格70），
  锚点两端精确、中间按规律疏密，不再线性均分。
"""
import json, shutil, os, time

SRC = 'web/public/data/score_track.json'
BAK_DIR = 'backup'

# ---- 锚点：用户三批实测合并（最新优先）+ 端点 ----
# 第一批：值1/10/11/20/21/29/30；第二批：值2/8/9/12/16/18/22/23/24/25（值20/21修正）；
# 第三批：值14 = [40,41,42]（用户 2026-08-07 18:18 确认 pos40=(1232,36)）
ANCHORS = {
    # 端点
    0:  [37, 1794],      # left start
    24: [37, 141],       # left end
    49: [1896, 166],     # right start
    # 值1（2格区）
    11: [35, 1022], 12: [36, 966],
    # 值2（2格区）
    13: [36, 884], 14: [36, 828],
    # 值8（2格区）
    25: [133, 37], 26: [188, 37],
    # 值9（2格区）
    27: [269, 36], 28: [322, 37],
    # 值10（2格区）
    29: [405, 35], 30: [463, 36],
    # 值11（3格区）
    31: [565, 38], 32: [620, 36], 33: [676, 36],
    # 值12（3格区）
    34: [788, 37], 35: [841, 36], 36: [897, 37],
    # 值14（3格区，第三批）
    40: [1232, 36], 41: [1288, 37], 42: [1342, 36],
    # 值16（3格区）
    46: [1681, 35], 47: [1736, 37], 48: [1792, 36],
    # 值18（3格区）
    52: [1899, 387], 53: [1900, 443], 54: [1898, 498],
    # 值20（3格区）
    58: [1898, 835], 59: [1900, 890], 60: [1899, 947],
    # 值21（4格区）
    61: [1898, 1057], 62: [1898, 1114], 63: [1898, 1170], 64: [1898, 1226],
    # 值22（4格区；67 由 66→68 权重插值）
    65: [1898, 1331], 66: [1897, 1388], 68: [1898, 1498],
    # 值23（4格区）
    69: [1899, 1607], 70: [1900, 1661], 71: [1898, 1716], 72: [1897, 1772],
    # 值24（4格区）
    73: [1797, 1899], 74: [1739, 1901], 75: [1686, 1900], 76: [1631, 1900],
    # 值25（4格区）
    77: [1535, 1899], 78: [1479, 1899], 79: [1427, 1898], 80: [1372, 1900],
    # 值29（4格区）
    93: [503, 1900], 94: [444, 1898], 95: [389, 1899], 96: [337, 1900],
    # 值30（3格区）
    97: [245, 1899], 98: [187, 1899], 99: [134, 1900],
}

# ---- 格距规律 ----
INNER = 56          # 值内格距（px）
SINGLE = 70         # 单格区（值 -10~0）格距
BOUND = {           # 跨值边界（px），按相邻值对查表（锚点实测/反推闭环）
    (1, 2): 82, (2, 3): 82, (3, 4): 82, (4, 5): 82, (5, 6): 82, (6, 7): 82,
    (8, 9): 81, (9, 10): 83, (10, 11): 102, (11, 12): 112,
    (12, 13): 112, (13, 14): 111, (14, 15): 112, (15, 16): 112,
    (17, 18): 109, (18, 19): 112, (19, 20): 112, (20, 21): 110,
    (21, 22): 105, (22, 23): 109,
    (24, 25): 96, (25, 26): 91, (26, 27): 91, (27, 28): 91, (28, 29): 91,
    (29, 30): 92,
}

def val_of(p):
    """pos -> 收入值（-10~30）"""
    if p <= 10: return -10 + p
    if p <= 30: return 1 + (p - 11) // 2
    if p <= 60: return 11 + (p - 31) // 3
    if p <= 96: return 21 + (p - 61) // 4
    return 30

def interval_w(p):
    """pos p → p+1 的间隔权重（px）：值内 56 / 单格区 70 / 边界查表"""
    v1, v2 = val_of(p), val_of(p + 1)
    if v1 == v2:
        return INNER
    if v1 < 0 or v2 < 0:   # 单格区（值 -10~0 相邻），含 0→1
        return SINGLE
    return BOUND.get((v1, v2), SINGLE)

def main():
    data = json.load(open(SRC, encoding='utf-8'))
    os.makedirs(BAK_DIR, exist_ok=True)
    ts = time.strftime('%Y%m%d-%H%M%S')
    bak = os.path.join(BAK_DIR, f'score_track.{ts}.json')
    shutil.copy2(SRC, bak)
    print('备份:', bak)

    pos_list = sorted(ANCHORS)
    positions = [None] * 100
    for i in range(len(pos_list) - 1):
        p1, c1 = pos_list[i], ANCHORS[pos_list[i]]
        p2, c2 = pos_list[i + 1], ANCHORS[pos_list[i + 1]]
        positions[p1] = [round(c1[0]), round(c1[1])]
        n = p2 - p1
        if n == 1:
            continue
        # 锚点对必须在同一轨道段（横平竖直），方向为轴向
        dx, dy = c2[0] - c1[0], c2[1] - c1[1]
        axis = 'x' if abs(dx) >= abs(dy) else 'y'
        length = abs(dx) if axis == 'x' else abs(dy)
        # 权重数组
        weights = [interval_w(p) for p in range(p1, p2)]
        total_w = sum(weights)
        scale = length / total_w
        # 累计权重 → 沿轴坐标
        acc = 0.0
        for k in range(1, n):
            acc += weights[k - 1] * scale
            t = acc / length
            if axis == 'x':
                x = c1[0] + dx * t
                y = c1[1] + dy * (acc / length if dy else 0)
            else:
                x = c1[0] + dx * (acc / length if dx else 0)
                y = c1[1] + dy * t
            positions[p1 + k] = [round(x), round(y)]
    positions[99] = ANCHORS[99]

    assert all(p is not None for p in positions), '有格子未生成！'
    assert len(positions) == 100

    for p, c in ANCHORS.items():
        assert positions[p] == [round(c[0]), round(c[1])], f'pos {p} 锚点未命中: {positions[p]} vs {c}'

    data['positions'] = [{'x': p[0], 'y': p[1]} for p in positions]
    data['note'] = ('得分轨道为不规则回环；100 格按用户实测锚点 + 格距规律生成：'
                    '值内格距 56px、单格区(-10~0) 70px、跨值边界按段 81~112px（查表）。'
                    '锚点为硬点精确命中，未锚定格按规律权重分布于锚点间。'
                    '位置索引 0-99，超过99回绕到0（pos = total % 100）。'
                    '坐标空间=游戏主图版像素(1936x1936)，落于合并视图 __mapC 容器零错位。')
    if 'edges' in data and 'bottom' in data['edges']:
        data['edges']['bottom']['end'] = [134, 1900]

    json.dump(data, open(SRC, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('已写回', SRC)
    for i in range(99):
        a, b = positions[i], positions[i + 1]
        d = round(((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5)
        print(f'  pos {i:2d}->{i+1:2d}: 距离{d}px')

if __name__ == '__main__':
    main()
