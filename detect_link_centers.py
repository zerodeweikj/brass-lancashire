#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
检测兰开夏地图上的连接板块槽位精确中心与方向。
输入：Excel（手标大致坐标）、连接模板图(20x94)、map_points.json（城市中心）
输出：link_points.json（连接槽位中心/角度/时代）
"""

import argparse
import copy
import json
import math
import os
import re
import shutil
import sys
from datetime import datetime

import numpy as np
from PIL import Image
import openpyxl


def parse_args():
    p = argparse.ArgumentParser(description="Detect link slot centers on Brass Lancashire map")
    p.add_argument("--excel", default=r"C:/Users/bwf/Desktop/兰开夏地图连接槽位坐标.xlsx",
                   help="Excel with hand-marked link slot coordinates")
    p.add_argument("--map", default="web/public/assets/map/main_map.jpg",
                   help="Full board scan image")
    p.add_argument("--template", default="web/public/assets/map/link_template.jpg",
                   help="Link tile template image (width=short, height=long)")
    p.add_argument("--map-points", default="web/public/data/map_points.json",
                   help="map_points.json containing city centers")
    p.add_argument("--locations", default="data/locations.json",
                   help="Engine locations.json for adjacency/era validation")
    p.add_argument("--output", default="web/public/data/link_points.json",
                   help="Output JSON for link slot data")
    p.add_argument("--report", default="out/link_detect_report.json",
                   help="Detection report JSON")
    p.add_argument("--debug-dir", default=None,
                   help="If set, save candidate patch images for inspection")
    p.add_argument("--search", type=int, default=15,
                   help="Half search range in pixels around hand-marked center")
    p.add_argument("--step", type=float, default=1.0,
                   help="Pixel step for final center search")
    p.add_argument("--angle-range", type=float, default=60.0,
                   help="Total angle search range around initial city-link direction (±degrees)")
    p.add_argument("--angle-step", type=float, default=5.0,
                   help="Angle step for coarse search")
    p.add_argument("--min-conf", type=float, default=0.35,
                   help="Minimum normalized cross-correlation to flag OK")
    p.add_argument("--max-shift", type=float, default=25.0,
                   help="Max allowed pixel shift from hand-marked center; beyond it keeps original")
    p.add_argument("--dry-run", action="store_true", help="Only print report, do not write files")
    p.add_argument("--write", action="store_true", help="Write output files (auto-backup)")
    return p.parse_args()


def load_excel(excel_path):
    wb = openpyxl.load_workbook(excel_path, data_only=True)
    ws = wb.active
    names = [c.value for c in ws[2][1:]]
    coords = [c.value for c in ws[3][1:]]
    notes = [c.value for c in ws[4][1:]]
    items = []
    for n, c, note in zip(names, coords, notes):
        if not n or not c:
            continue
        m = re.search(r"(\d+)\s*[,，]\s*(\d+)", str(c))
        if not m:
            print(f"[WARN] 无法解析坐标: {c}", file=sys.stderr)
            continue
        items.append({
            "name": str(n).strip().replace('"', ''),
            "raw_x": int(m.group(1)),
            "raw_y": int(m.group(2)),
            "note": str(note) if note else "",
        })
    return items


def normalize_city(name):
    return name.strip().replace('"', '')


def parse_link_name(name, city_points):
    """Split 'CITYA-CITYB' into two city ids that exist in city_points."""
    # 处理类似 WARRINGTONandRUNCORN 这种自身含连字符？实际上城市名本身没有'-'，用'-'分割即可
    parts = name.split('-', 1)
    if len(parts) != 2:
        return None, None, name
    a, b = normalize_city(parts[0]), normalize_city(parts[1])
    #  cities may appear in city_points with exact case; preserve case
    def find(cid):
        if cid in city_points:
            return cid
        # fallback: case-insensitive
        for k in city_points:
            if k.lower() == cid.lower():
                return k
        return None
    fa, fb = find(a), find(b)
    return fa, fb, name


def era_from_note(note):
    n = str(note).strip()
    if n == "仅在运河阶段出现":
        return "canal"
    if n == "仅在铁路阶段出现":
        return "rail"
    return "both"


def load_engine_edges(locations_path):
    """从引擎 locations.json 读邻接表 → (canal 边集, rail 边集)，边为排序后的二元组。"""
    loc = json.load(open(locations_path, encoding="utf-8"))
    data = {l["id"]: l for l in loc} if isinstance(loc, list) else loc
    canal, rail = set(), set()
    for cid, l in data.items():
        for nb in l.get("canal_adj", []):
            canal.add(tuple(sorted((cid, nb))))
        for nb in l.get("rail_adj", []):
            rail.add(tuple(sorted((cid, nb))))
    return canal, rail


def seg_dist(px, py, ax, ay, bx, by):
    """点到线段距离"""
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    if L2 == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def assign_engine_edges(items, city_points, locations_path):
    """把 Excel 条目一一匹配到引擎邻接边（修正手误命名/重复命名）。
    - 先按名字精确匹配（剥离引号、大小写兜底）；
    - 匹配不上/重复的条目，按「手标点最近的两城中心线段」归属到剩余引擎边；
    - era 以引擎邻接为准（与 Excel 备注不一致时告警）。
    就地给每个 item 写入 it["a"], it["b"], it["id"], it["era"]。
    """
    canal, rail = load_engine_edges(locations_path)
    union = canal | rail
    remaining = dict.fromkeys(sorted(union))

    def find_city(cid):
        if cid in city_points:
            return cid
        for k in city_points:
            if k.lower() == cid.lower():
                return k
        return None

    # 第一遍：名字精确匹配
    for it in items:
        a, b, _ = parse_link_name(it["name"], city_points)
        key = tuple(sorted((a, b))) if a and b else None
        if key and key in remaining:
            it["a"], it["b"] = key
            del remaining[key]
        else:
            it["a"] = it["b"] = None

    # 第二遍：几何最近归属
    for it in items:
        if it["a"] is not None:
            continue
        best, best_d = None, 1e18
        for e in remaining:
            if e[0] not in city_points or e[1] not in city_points:
                continue
            ax, ay = city_points[e[0]]
            bx, by = city_points[e[1]]
            d = seg_dist(it["raw_x"], it["raw_y"], ax, ay, bx, by)
            if d < best_d:
                best, best_d = e, d
        if best is None:
            print(f"[FATAL] 无法归属连接: {it['name']} ({it['raw_x']},{it['raw_y']})", file=sys.stderr)
            sys.exit(1)
        it["a"], it["b"] = best
        del remaining[best]
        print(f"[修正] 「{it['name']}」({it['raw_x']},{it['raw_y']}) → {best[0]}-{best[1]}（几何最近，离线 {best_d:.0f}px）")

    if remaining:
        print(f"[FATAL] 引擎边未被 Excel 覆盖: {sorted(remaining)}", file=sys.stderr)
        sys.exit(1)

    # id 与 era
    for it in items:
        it["id"] = f"{it['a']}-{it['b']}"
        in_canal = tuple(sorted((it["a"], it["b"]))) in canal
        in_rail = tuple(sorted((it["a"], it["b"]))) in rail
        engine_era = "both" if (in_canal and in_rail) else ("canal" if in_canal else "rail")
        excel_era = era_from_note(it["note"])
        if engine_era != excel_era:
            print(f"[时代告警] {it['id']}: Excel={excel_era} 引擎={engine_era}（以引擎为准）")
        it["era"] = engine_era


def to_gray(img):
    if img.mode == 'L':
        return np.array(img, dtype=np.float32)
    return np.array(img.convert('L'), dtype=np.float32)


def make_rotated_template(template_img, angle_deg):
    """
    模板默认长轴竖直（高=长边）。旋转 angle_deg 后，长轴指向 angle_deg 方向
    （angle=0 竖直向下；angle=90 水平向右，依 PIL rotate 顺时针为正）。
    """
    # expand=True 避免裁剪，背景用中灰
    rot = template_img.rotate(angle_deg, expand=True, resample=Image.BICUBIC, fillcolor=(128, 128, 128))
    return to_gray(rot)


def masked_template_stats(tmpl):
    """把模板中灰背景作为 mask 排除（背景≈128）。返回 normalized template 与 mask。"""
    # 简单阈值：灰度在 [100,156] 且离 128 很近的视为背景
    bg_mask = np.abs(tmpl - 128.0) < 35
    mask = ~bg_mask
    if mask.sum() < 10:
        mask = np.ones_like(tmpl, dtype=bool)
    t = tmpl.copy()
    t_mean = t[mask].mean()
    t_std = t[mask].std() + 1e-6
    t = (t - t_mean) / t_std
    t[~mask] = 0.0
    return t, mask


def ncc_at(img, tmpl, mask, cx, cy):
    h, w = tmpl.shape
    x0 = int(round(cx - w / 2))
    y0 = int(round(cy - h / 2))
    H, W = img.shape
    if x0 < 0 or y0 < 0 or x0 + w > W or y0 + h > H:
        return -1.0
    patch = img[y0:y0 + h, x0:x0 + w].copy()
    patch_mean = patch[mask].mean()
    patch_std = patch[mask].std() + 1e-6
    patch = (patch - patch_mean) / patch_std
    patch[~mask] = 0.0
    score = np.sum(patch * tmpl) / mask.sum()
    return float(score)


def angle_from_cities(city_points, a, b):
    """返回连接槽位长轴应朝的城市连线角度（PIL 空间：正角=视觉逆时针，已实证）。
    推导：bar 长轴沿 θ 方向的充要条件是 PIL 旋转角 α = 90 - θ（mod 180）。
    注意勿写成 θ - 90（镜像）：对近水平/近竖直连接影响小，但对角线连接会偏 90°。"""
    if not a or not b or a not in city_points or b not in city_points:
        return 0.0
    x1, y1 = city_points[a]
    x2, y2 = city_points[b]
    dx = x2 - x1
    dy = y2 - y1
    # 连线方向（屏幕坐标，y 向下）
    theta = math.degrees(math.atan2(dy, dx))
    angle = 90.0 - theta
    # 把角度规约到 [-90, 90]，因为长条方向 +180 等价
    while angle > 90.0:
        angle -= 180.0
    while angle < -90.0:
        angle += 180.0
    return angle


def best_position(img_gray, template_img, angle, raw_x, raw_y, search, step):
    """在固定角度下搜索最佳中心位置。"""
    tmpl = make_rotated_template(template_img, angle)
    tmpl_norm, mask = masked_template_stats(tmpl)
    best_score = -2.0
    best = (float(raw_x), float(raw_y), -1.0)
    rng = np.arange(-search, search + 0.001, step)
    for dx in rng:
        for dy in rng:
            cx = raw_x + dx
            cy = raw_y + dy
            s = ncc_at(img_gray, tmpl_norm, mask, cx, cy)
            if s > best_score:
                best_score = s
                best = (cx, cy, s)
    return best[0], best[1], best[2]


def detect_one(img_gray, template_img, raw_x, raw_y, init_angle, args):
    # ---------- 粗搜：角度 ±range，位置 ±search step2 ----------
    coarse_pos_step = max(2.0, args.step)
    half = args.angle_range / 2.0
    coarse_angles = [init_angle + d for d in np.arange(-half, half + 0.001, args.angle_step)]
    # 把角度规约到 [-90,90]
    def norm90(a):
        while a > 90.0:
            a -= 180.0
        while a < -90.0:
            a += 180.0
        return a
    coarse_angles = [norm90(a) for a in coarse_angles]

    best_score = -2.0
    best = (raw_x, raw_y, init_angle, best_score)
    for a in coarse_angles:
        cx, cy, score = best_position(img_gray, template_img, a, raw_x, raw_y, args.search, coarse_pos_step)
        if score > best_score:
            best_score = score
            best = (cx, cy, a, score)

    cx_c, cy_c, angle_c, score_c = best
    # ---------- 精搜：最佳角度 ±5° step1，位置 ±4 step1 ----------
    fine_angles = [norm90(angle_c + d) for d in np.arange(-5.0, 5.001, 1.0)]
    for a in fine_angles:
        cx, cy, score = best_position(img_gray, template_img, a, cx_c, cy_c, 4, 1.0)
        if score > best_score:
            best_score = score
            best = (cx, cy, a, score)

    return best[0], best[1], best[2], best[3]


def detect_all(items, city_points, map_img, template_img, args):
    img_gray = to_gray(map_img)
    results = []
    for it in items:
        a, b = it.get("a"), it.get("b")
        init_angle = angle_from_cities(city_points, a, b)
        cx, cy, final_angle, score = detect_one(
            img_gray, template_img, it["raw_x"], it["raw_y"], init_angle,
            args
        )
        shift = math.hypot(cx - it["raw_x"], cy - it["raw_y"])
        if shift > args.max_shift:
            flag = "OUTLIER"
        elif score >= args.min_conf:
            flag = "OK"
        else:
            flag = "LOW"
        results.append({
            "id": it["id"],
            "cities": [a, b] if a and b else [],
            "raw": [it["raw_x"], it["raw_y"]],
            "x": cx,
            "y": cy,
            "angle": final_angle,  # PIL 空间
            "score": score,
            "shift": shift,
            "flag": flag,
            "era": it.get("era", era_from_note(it["note"])),
            "note": it["note"],
        })
    return results


def unique_ids(results):
    """为同名连接槽位添加 -0/-1 后缀以保证 id 唯一（兜底）。"""
    counts = {}
    for r in results:
        counts[r["id"]] = counts.get(r["id"], 0) + 1
    seen = {}
    out = []
    for r in results:
        base = r["id"]
        if counts[base] > 1:
            idx = seen.get(base, 0)
            r = copy.deepcopy(r)
            r["id"] = f"{base}-{idx}"
            seen[base] = idx + 1
        out.append(r)
    return out


def phaser_angle_from_cities(city_points, a, b):
    """直接生成 Phaser 渲染角：positive=顺时针（屏幕 y 向下）。
    与 angle_from_cities（PIL 空间）的关系：Phaser = -PIL (mod 180)。"""
    if not a or not b or a not in city_points or b not in city_points:
        return 0.0
    x1, y1 = city_points[a]
    x2, y2 = city_points[b]
    theta = math.degrees(math.atan2(y2 - y1, x2 - x1))
    return norm90(theta + 90.0)


def norm90(angle):
    while angle > 90.0:
        angle -= 180.0
    while angle < -90.0:
        angle += 180.0
    return angle


def build_link_points(results, args):
    """PIL 检测角（正=视觉逆时针）→ 转为 Phaser 渲染角（正=顺时针，屏幕 y 向下）。
    二者在 180° 等价下满足：PhaserAngle = -PIL_Angle (mod 180)。"""
    links = []
    for r in results:
        # 写回时 OUTLIER/LOW 保留原坐标（除非 force）
        x = r["x"] if r["flag"] == "OK" else float(r["raw"][0])
        y = r["y"] if r["flag"] == "OK" else float(r["raw"][1])
        angle_phaser = norm90(-r["angle"])
        links.append({
            "id": r["id"],
            "cities": r["cities"],
            "x": int(round(x)),
            "y": int(round(y)),
            "angle": round(angle_phaser, 2),
            "era": r["era"],
            "conf": round(r["score"], 3),
        })
    return {
        "map": "main_map.jpg",
        "template": "link_template.jpg",
        "slotWidth": 20,
        "slotHeight": 94,
        "links": links,
    }


def save_debug_patches(results, img_gray, template_img, debug_dir):
    os.makedirs(debug_dir, exist_ok=True)
    for r in results:
        angle = r["angle"]
        tmpl = make_rotated_template(template_img, angle)
        h, w = tmpl.shape
        cx, cy = r["x"], r["y"]
        x0 = int(round(cx - w / 2))
        y0 = int(round(cy - h / 2))
        patch = img_gray[max(0, y0):y0 + h, max(0, x0):x0 + w]
        patch_img = Image.fromarray(np.clip(patch, 0, 255).astype(np.uint8))
        safe_id = re.sub(r"[^A-Za-z0-9_-]", "_", r["id"])
        patch_img.save(os.path.join(debug_dir, f"{safe_id}_patch.png"))


def print_report(results, args):
    print(f"\n=== 连接槽位检测报告 (search=±{args.search}px, min_conf={args.min_conf}, max_shift={args.max_shift}) ===")
    ok = sum(1 for r in results if r["flag"] == "OK")
    low = sum(1 for r in results if r["flag"] == "LOW")
    out = sum(1 for r in results if r["flag"] == "OUTLIER")
    print(f"总计 {len(results)} | OK={ok} | LOW={low} | OUTLIER={out}")
    print(f"{'id':<36} {'raw':>14} {'new':>14} {'angle':>7} {'conf':>6} {'flag':>8}")
    for r in results:
        raw = f"({r['raw'][0]},{r['raw'][1]})"
        new = f"({round(r['x'])},{round(r['y'])}):"
        print(f"{r['id']:<36} {raw:>14} {new:>14} {r['angle']:>7.2f} {r['score']:>6.3f} {r['flag']:>8}")


def main():
    args = parse_args()
    items = load_excel(args.excel)
    print(f"[INFO] 从 Excel 读取 {len(items)} 个连接槽位")

    if not os.path.exists(args.map_points):
        print(f"[FATAL] map_points.json 不存在: {args.map_points}", file=sys.stderr)
        sys.exit(1)
    city_points = json.load(open(args.map_points, encoding="utf-8"))["points"]

    # 先用引擎邻接修正命名/重复
    assign_engine_edges(items, city_points, args.locations)

    map_img = Image.open(args.map)
    template_img = Image.open(args.template)
    print(f"[INFO] 版图 {map_img.size}, 模板 {template_img.size}")

    results = detect_all(items, city_points, map_img, template_img, args)
    results = unique_ids(results)  # 若 assign_engine_edges 后仍有重复，则兜底加后缀

    print_report(results, args)

    if args.debug_dir:
        img_gray = to_gray(map_img)
        save_debug_patches(results, img_gray, template_img, args.debug_dir)
        print(f"[INFO] debug patches saved to {args.debug_dir}")

    if args.write:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        if os.path.exists(args.output):
            bak_dir = "backup"
            os.makedirs(bak_dir, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d-%H%M%S")
            bak = os.path.join(bak_dir, f"link_points.{ts}.json")
            shutil.copy2(args.output, bak)
            print(f"[INFO] 已备份原文件: {bak}")

        link_points = build_link_points(results, args)
        json.dump(link_points, open(args.output, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
        print(f"[INFO] 已写回: {args.output}")

        if args.report:
            os.makedirs(os.path.dirname(args.report) or ".", exist_ok=True)
            serializable = []
            for r in results:
                rr = copy.deepcopy(r)
                rr["score"] = float(rr["score"])
                rr["shift"] = float(rr["shift"])
                rr["x"] = float(rr["x"])
                rr["y"] = float(rr["y"])
                rr["angle"] = float(rr["angle"])
                serializable.append(rr)
            json.dump({
                "args": vars(args),
                "results": serializable,
            }, open(args.report, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
            print(f"[INFO] 已写报告: {args.report}")
    elif args.dry_run:
        print("[INFO] dry-run 完成，未写文件。加 --write 写回。")
    else:
        print("[INFO] 默认仅检测。加 --write 写回，或 --dry-run 明确只检测。")


if __name__ == "__main__":
    main()
