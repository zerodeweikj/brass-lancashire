# -*- coding: utf-8 -*-
"""检测 Brass Lancashire 版图中 43 个建筑槽位的精确中心。

以现有 map_points.json 中的手标锚点为种子，对每槽做局部方框边框精修：
- 轴向梯度 + 暗线响应，突出贯通的印刷边框
- 成对搜索左右/上下边框，带居中惩罚
- 两遍全局尺寸锁定：先宽松估计真实边长 S*，再用 S*±3 精修
- 输出精确中心 (x,y)，更新 map_points.json

默认干跑；加 --write 才写回文件。
"""
import argparse
import json
import math
import os
import shutil
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


DEFAULT_SIZE = 86
DEFAULT_TOL = 10
DEFAULT_LOCK_TOL = 3
DEFAULT_WIN = 2.5
DEFAULT_LAMBDA = 0.35
DEFAULT_MIN_CONF = 0.45
DEFAULT_MAX_SHIFT = 30.0


def load_image(path):
    """加载图片为 numpy uint8 RGB 数组 (H, W, 3)。"""
    img = Image.open(path).convert("RGB")
    return np.array(img, dtype=np.uint8)


def to_gray(rgb):
    """RGB -> float32 灰度。"""
    return (
        0.299 * rgb[:, :, 0].astype(np.float32)
        + 0.587 * rgb[:, :, 1].astype(np.float32)
        + 0.114 * rgb[:, :, 2].astype(np.float32)
    )


def normalize_response(resp):
    """把响应归一化到 [0,1]；全零时返回原数组。"""
    m = resp.max()
    if m > 1e-6:
        return resp / m
    return resp


def compute_responses(gray, cx_win, cy_win, S, score_mode="auto", w=3):
    """计算竖直/水平边框响应。

    返回 Vs（长度为 W 的 1D 数组，列方向响应）和 Hs（长度为 H 的 1D 数组，行方向响应）。
    使用中心带积分：竖直响应只在 cy 附近的行带内积分，水平响应只在 cx 附近的列带内积分，
    从而压制非贯通的内部图标噪声。
    """
    H, W = gray.shape
    pad = max(w, 1) + 2
    G = np.pad(gray, pad, mode="edge")

    # 中心带范围（相对窗口）
    band_half = int(round(0.35 * S))
    row_lo = max(0, cy_win - band_half)
    row_hi = min(H, cy_win + band_half + 1)
    col_lo = max(0, cx_win - band_half)
    col_hi = min(W, cx_win + band_half + 1)

    # 竖直响应：对每一列 u，在中心行带内积分
    Vs_grad = np.zeros(W, dtype=np.float32)
    Vs_dark = np.zeros(W, dtype=np.float32)
    for u in range(1, W - 1):
        up = u + pad
        # 梯度 |G[:, u+1] - G[:, u-1]|
        grad = np.abs(G[row_lo:row_hi, up + 1] - G[row_lo:row_hi, up - 1])
        Vs_grad[u] = grad.mean()
        # 暗线：中间比两侧暗
        dark = (
            (G[row_lo:row_hi, up - w] + G[row_lo:row_hi, up + w]) / 2.0
            - G[row_lo:row_hi, up]
        )
        Vs_dark[u] = np.clip(dark, 0, None).mean()

    # 水平响应：对每一行 v，在中心列带内积分
    Hs_grad = np.zeros(H, dtype=np.float32)
    Hs_dark = np.zeros(H, dtype=np.float32)
    for v in range(1, H - 1):
        vp = v + pad
        grad = np.abs(G[vp + 1, col_lo:col_hi] - G[vp - 1, col_lo:col_hi])
        Hs_grad[v] = grad.mean()
        dark = (
            (G[vp - w, col_lo:col_hi] + G[vp + w, col_lo:col_hi]) / 2.0
            - G[vp, col_lo:col_hi]
        )
        Hs_dark[v] = np.clip(dark, 0, None).mean()

    if score_mode == "grad":
        Vs = normalize_response(Vs_grad)
        Hs = normalize_response(Hs_grad)
    elif score_mode == "darkline":
        Vs = normalize_response(Vs_dark)
        Hs = normalize_response(Hs_dark)
    else:  # auto
        Vs = normalize_response(Vs_grad) + normalize_response(Vs_dark)
        Hs = normalize_response(Hs_grad) + normalize_response(Hs_dark)

    # 轻平滑，抗 JPEG 伪影
    Vs = np.convolve(Vs, np.ones(3, dtype=np.float32) / 3, mode="same")
    Hs = np.convolve(Hs, np.ones(3, dtype=np.float32) / 3, mode="same")
    return Vs, Hs


def subpixel_peak(resp, idx):
    """抛物线插值细化峰值位置。idx 必须在 [1, len-2] 内。"""
    if idx <= 0 or idx >= len(resp) - 1:
        return float(idx)
    a, b, c = resp[idx - 1], resp[idx], resp[idx + 1]
    denom = a - 2 * b + c
    if abs(denom) < 1e-6:
        return float(idx)
    delta = 0.5 * (a - c) / denom
    delta = np.clip(delta, -1.0, 1.0)
    return float(idx) + delta


def find_best_pair(resp, cx_win, S_min, S_max, penalty_lambda, S):
    """在响应曲线中搜索一对边框 (coord1, coord2)，使 resp[c1]+resp[c2]-居中惩罚最大。

    约束：c1 < cx_win < c2 且 c2-c1 ∈ [S_min, S_max]。
    返回 (c1, c2, score, center)。
    """
    N = len(resp)
    best_score = -np.inf
    best = None
    for c1 in range(0, min(cx_win, N - S_min)):
        lo = max(c1 + S_min, cx_win + 1)
        hi = min(c1 + S_max + 1, N)
        if lo >= hi:
            continue
        r1 = resp[c1]
        # 向量化内层循环
        c2s = np.arange(lo, hi)
        r2s = resp[c2s]
        centers = (c1 + c2s) / 2.0
        penalty = penalty_lambda * np.abs(centers - cx_win) / S
        scores = r1 + r2s - penalty
        k = scores.argmax()
        if scores[k] > best_score:
            best_score = scores[k]
            best = (c1, int(c2s[k]), scores[k], centers[k])
    if best is None:
        # fallback：种子附近对称一对
        c1 = max(0, cx_win - S // 2)
        c2 = min(N - 1, c1 + S)
        best = (c1, c2, 0.0, (c1 + c2) / 2.0)
    return best


def detect_one(gray_full, cx, cy, S, tol, win_factor, penalty_lambda, score_mode):
    """检测单个槽位中心与尺寸（单遍）。"""
    win_half = int(round(win_factor * S))
    H, W = gray_full.shape

    x0 = max(0, cx - win_half)
    y0 = max(0, cy - win_half)
    x1 = min(W, cx + win_half + 1)
    y1 = min(H, cy + win_half + 1)
    window = gray_full[y0:y1, x0:x1]
    win_h, win_w = window.shape

    cx_win = cx - x0
    cy_win = cy - y0

    S_min = max(30, S - tol)
    S_max = S + tol

    Vs, Hs = compute_responses(window, cx_win, cy_win, S, score_mode)

    cL, cR, score_v, _ = find_best_pair(Vs, cx_win, S_min, S_max, penalty_lambda, S)
    cT, cB, score_h, _ = find_best_pair(Hs, cy_win, S_min, S_max, penalty_lambda, S)

    # 亚像素细化
    cL_f = subpixel_peak(Vs, cL)
    cR_f = subpixel_peak(Vs, cR)
    cT_f = subpixel_peak(Hs, cT)
    cB_f = subpixel_peak(Hs, cB)

    center_x = x0 + (cL_f + cR_f) / 2.0
    center_y = y0 + (cT_f + cB_f) / 2.0
    size_x = cR_f - cL_f
    size_y = cB_f - cT_f
    score = (score_v + score_h) / 2.0
    return center_x, center_y, size_x, size_y, score


def detect_all(image_path, points_data, S, tol, lock_tol, win_factor, penalty_lambda, score_mode, min_conf, max_shift):
    """对所有槽位做两遍检测，返回结果列表。"""
    img = load_image(image_path)
    gray = to_gray(img)

    slots = []
    for city_id, city_def in points_data["locations"].items():
        if "slots" not in city_def:
            continue
        for idx, slot in enumerate(city_def["slots"]):
            slots.append({
                "city": city_id,
                "idx": idx,
                "types": slot["types"],
                "old_x": slot["x"],
                "old_y": slot["y"],
            })

    if len(slots) != 43:
        print(f"警告：当前 map_points.json 中槽位总数为 {len(slots)}，预期 43。", file=sys.stderr)

    # Pass 1：宽松尺寸，估计真实边长 S*
    pass1 = []
    sizes = []
    for s in slots:
        cx, cy, sx, sy, score = detect_one(
            gray, s["old_x"], s["old_y"], S, tol, win_factor, penalty_lambda, score_mode
        )
        pass1.append({**s, "cx": cx, "cy": cy, "sx": sx, "sy": sy, "score": score})
        sizes.extend([sx, sy])

    sizes_arr = np.array(sizes)
    S_star = float(np.median(sizes_arr))
    print(f"Pass 1 尺寸中位数 S* = {S_star:.2f} (min={sizes_arr.min():.2f}, max={sizes_arr.max():.2f}, std={sizes_arr.std():.2f})")

    # Pass 2：用 S* 锁定
    results = []
    for p in pass1:
        cx, cy, sx, sy, score = detect_one(
            gray, p["old_x"], p["old_y"], int(round(S_star)), lock_tol, win_factor, penalty_lambda, score_mode
        )
        results.append({
            **p,
            "cx": cx,
            "cy": cy,
            "sx": sx,
            "sy": sy,
            "score": score,
        })

    # 置信度归一化
    scores = np.array([r["score"] for r in results])
    median_score = float(np.median(scores))
    if median_score > 1e-6:
        for r in results:
            r["conf"] = r["score"] / median_score
    else:
        for r in results:
            r["conf"] = 1.0

    for r in results:
        shift = math.hypot(r["cx"] - r["old_x"], r["cy"] - r["old_y"])
        if shift > max_shift:
            r["flag"] = "OUTLIER"
        elif r["conf"] >= min_conf:
            r["flag"] = "OK"
        else:
            r["flag"] = "LOW"

    return results, S_star, img


def pairwise_min_distance(results):
    """计算所有中心两两之间的最小间距。"""
    pts = np.array([[r["cx"], r["cy"]] for r in results])
    if len(pts) < 2:
        return np.inf
    # 简单 O(n^2)，n=43 足够快
    min_d = np.inf
    for i in range(len(pts)):
        for j in range(i + 1, len(pts)):
            d = np.hypot(pts[i, 0] - pts[j, 0], pts[i, 1] - pts[j, 1])
            if d < min_d:
                min_d = d
    return float(min_d)


def draw_overlay(img, results, S_star, out_path):
    """生成全图叠加缩略图（在原图上画检测框）。"""
    overlay = Image.fromarray(img)
    draw = ImageDraw.Draw(overlay)
    half = int(round(S_star / 2))
    for r in results:
        x, y = int(round(r["cx"])), int(round(r["cy"]))
        color = "#00ff00" if r["flag"] == "OK" else "#ff0000"
        draw.rectangle([x - half, y - half, x + half, y + half], outline=color, width=2)
        draw.line([x - 4, y, x + 4, y], fill=color, width=1)
        draw.line([x, y - 4, x, y + 4], fill=color, width=1)
    # 缩放到 1200 宽方便查看
    scale = 1200 / max(overlay.size)
    new_size = (int(overlay.size[0] * scale), int(overlay.size[1] * scale))
    overlay = overlay.resize(new_size, Image.Resampling.LANCZOS)
    overlay.save(out_path)


def draw_slot_crops(img, results, S_star, out_dir):
    """为每槽生成带检测框的裁图。"""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    half = int(round(S_star * 1.3))
    H, W = img.shape[:2]
    for r in results:
        x, y = int(round(r["cx"])), int(round(r["cy"]))
        x0 = max(0, x - half)
        y0 = max(0, y - half)
        x1 = min(W, x + half + 1)
        y1 = min(H, y + half + 1)
        crop = Image.fromarray(img[y0:y1, x0:x1]).copy()
        draw = ImageDraw.Draw(crop)
        color = "#00ff00" if r["flag"] == "OK" else "#ff0000"
        # 检测框中心在裁图中的坐标
        cx_crop = x - x0
        cy_crop = y - y0
        h2 = int(round(r["sx"] / 2))
        v2 = int(round(r["sy"] / 2))
        draw.rectangle(
            [cx_crop - h2, cy_crop - v2, cx_crop + h2, cy_crop + v2],
            outline=color,
            width=2,
        )
        draw.line([cx_crop - 4, cy_crop, cx_crop + 4, cy_crop], fill=color, width=1)
        draw.line([cx_crop, cy_crop - 4, cx_crop, cy_crop + 4], fill=color, width=1)
        fname = f"{r['city']}_{r['idx']}.png"
        crop.save(out_dir / fname)


def print_report(results, S_star):
    """打印检测结果表格。"""
    print(f"\n{'CITY':<22} # {'old (x,y)':>14} -> {'new (x,y)':>14}  d(px)  sx   sy  conf  flag")
    print("-" * 95)
    max_shift = 0.0
    for r in results:
        old = (r["old_x"], r["old_y"])
        new = (r["cx"], r["cy"])
        shift = math.hypot(new[0] - old[0], new[1] - old[1])
        max_shift = max(max_shift, shift)
        print(
            f"{r['city']:<22} {r['idx']} "
            f"{old[0]:>4},{old[1]:>4} -> {new[0]:>7.1f},{new[1]:>7.1f} "
            f"{shift:>5.1f} {r['sx']:>5.1f} {r['sy']:>5.1f} {r['conf']:>5.2f} {r['flag']}"
        )
    print("-" * 95)
    low = [r for r in results if r["flag"] == "LOW"]
    print(f"尺寸统计：S*={S_star:.2f}")
    print(f"偏移统计：最大偏移 {max_shift:.1f}px")
    print(f"低置信槽位：{len(low)} 个")
    if low:
        for r in low:
            print(f"  - {r['city']} #{r['idx']} conf={r['conf']:.2f}")


def validate_before_write(results, original_data, S_star, S, img_shape):
    """写回前的硬闸与软告警。返回 (ok, messages)。"""
    messages = []
    ok = True

    # 硬闸
    slot_count = sum(1 for c in original_data["locations"].values() if "slots" in c for _ in c["slots"])
    if len(results) != slot_count:
        messages.append(f"[ERR] 结果数 {len(results)} != 原槽位数 {slot_count}")
        ok = False

    for r in results:
        if not (0 <= r["cx"] <= img_shape[1] and 0 <= r["cy"] <= img_shape[0]):
            messages.append(f"[ERR] {r['city']}#{r['idx']} 坐标越界: ({r['cx']:.1f},{r['cy']:.1f})")
            ok = False

    min_d = pairwise_min_distance(results)
    if min_d < 60:
        messages.append(f"[ERR] 中心最小间距 {min_d:.1f}px < 60，存在重叠风险")
        ok = False

    # 检查 cities 集合（结果只含槽位城市，应是无槽位城市的子集）
    orig_cities = set(original_data["locations"].keys())
    new_cities = set(r["city"] for r in results)
    if not new_cities <= orig_cities:
        messages.append(f"[ERR] 出现未知城市: {new_cities - orig_cities}")
        ok = False

    # 软告警
    if abs(S_star - S) > 3:
        messages.append(f"[WARN] 检测边长 S*={S_star:.2f} 与标称 {S} 偏差 > 3px")
    for r in results:
        if abs(r["sx"] - S_star) > 4 or abs(r["sy"] - S_star) > 4:
            messages.append(f"[WARN] {r['city']}#{r['idx']} 尺寸偏离 S*: sx={r['sx']:.1f}, sy={r['sy']:.1f}")
        shift = math.hypot(r["cx"] - r["old_x"], r["cy"] - r["old_y"])
        if shift > 30:
            messages.append(f"[WARN] {r['city']}#{r['idx']} 偏移 {shift:.1f}px > 30")

    low = [r for r in results if r["flag"] == "LOW"]
    if low:
        messages.append(f"[WARN] 存在 {len(low)} 个低置信槽位")

    return ok, messages


def update_map_points(original_data, results):
    """生成新的 map_points.json 数据（不改动 types，不写 size）。"""
    data = json.loads(json.dumps(original_data, ensure_ascii=False))

    # 更新槽位坐标
    for r in results:
        slot = data["locations"][r["city"]]["slots"][r["idx"]]
        slot["x"] = int(round(r["cx"]))
        slot["y"] = int(round(r["cy"]))
        # 确保没有 size 字段
        slot.pop("size", None)

    # 重算有槽位城市的 points 质心
    for city_id, city_def in data["locations"].items():
        if "slots" not in city_def or not city_def["slots"]:
            continue
        xs = [s["x"] for s in city_def["slots"]]
        ys = [s["y"] for s in city_def["slots"]]
        data["points"][city_id] = [int(round(sum(xs) / len(xs))), int(round(sum(ys) / len(xs)))]

    return data


def main():
    parser = argparse.ArgumentParser(description="检测 Brass Lancashire 槽位精确中心")
    parser.add_argument("--image", default="web/public/assets/map/main_map.jpg", help="版图图片路径")
    parser.add_argument("--points", default="web/public/data/map_points.json", help="map_points.json 路径")
    parser.add_argument("--size", type=int, default=DEFAULT_SIZE, help="标称槽位边长")
    parser.add_argument("--tol", type=int, default=DEFAULT_TOL, help="Pass 1 尺寸容差")
    parser.add_argument("--lock-tol", type=int, default=DEFAULT_LOCK_TOL, help="Pass 2 尺寸容差")
    parser.add_argument("--win", type=float, default=DEFAULT_WIN, help="搜索窗倍数（相对边长）")
    parser.add_argument("--lambda", type=float, default=DEFAULT_LAMBDA, dest="penalty_lambda", help="居中惩罚系数")
    parser.add_argument("--score", choices=["auto", "grad", "darkline"], default="auto", help="响应类型")
    parser.add_argument("--min-conf", type=float, default=DEFAULT_MIN_CONF, help="低置信阈值")
    parser.add_argument("--max-shift", type=float, default=DEFAULT_MAX_SHIFT, help="相对种子锚点的最大允许偏移，超出视为异常值")
    parser.add_argument("--write", action="store_true", help="实际写回 JSON（否则干跑）")
    parser.add_argument("--force", action="store_true", help="即使存在低置信槽位也强制写回")
    parser.add_argument("--debug-dir", default=None, help="输出每槽叠加裁图目录")
    parser.add_argument("--overlay", default=None, help="输出全图叠加缩略图路径")
    parser.add_argument("--report", default=None, help="输出 JSON 报告路径")
    parser.add_argument("--backup-dir", default="backup", help="备份目录")
    args = parser.parse_args()

    image_path = Path(args.image)
    points_path = Path(args.points)
    if not image_path.exists():
        print(f"图片不存在: {image_path}", file=sys.stderr)
        sys.exit(1)
    if not points_path.exists():
        print(f"坐标文件不存在: {points_path}", file=sys.stderr)
        sys.exit(1)

    with open(points_path, "r", encoding="utf-8") as f:
        original_data = json.load(f)

    print(f"加载图片: {image_path} ({image_path.stat().st_size / 1024:.0f} KB)")
    print(f"加载坐标: {points_path}")

    results, S_star, img = detect_all(
        str(image_path),
        original_data,
        args.size,
        args.tol,
        args.lock_tol,
        args.win,
        args.penalty_lambda,
        args.score,
        args.min_conf,
        args.max_shift,
    )

    print_report(results, S_star)

    # 验证
    ok, messages = validate_before_write(results, original_data, S_star, args.size, img.shape)
    for m in messages:
        print(m)

    problems = [r for r in results if r["flag"] in ("LOW", "OUTLIER")]
    if problems and not args.force:
        print(f"\n存在 {len(problems)} 个问题槽位（LOW/OUTLIER），未加 --force，这些槽位将保留原坐标。", file=sys.stderr)
        for r in problems:
            print(f"  - {r['city']}#{r['idx']}: {r['flag']}", file=sys.stderr)

    if not ok:
        print("\n验证失败，未写回。请检查上述错误。", file=sys.stderr)
        args.write = False

    # 输出调试图
    if args.debug_dir:
        draw_slot_crops(img, results, S_star, args.debug_dir)
        print(f"已生成每槽裁图: {args.debug_dir}/")
    overlay_path = args.overlay or ("out/overlay_full.png" if args.debug_dir else None)
    if overlay_path:
        Path(overlay_path).parent.mkdir(parents=True, exist_ok=True)
        draw_overlay(img, results, S_star, overlay_path)
        print(f"已生成全图叠加: {overlay_path}")

    # 输出 JSON 报告
    if args.report:
        report = {
            "S_star": S_star,
            "nominal_size": args.size,
            "slots": [
                {
                    "city": r["city"],
                    "idx": r["idx"],
                    "types": r["types"],
                    "old": [r["old_x"], r["old_y"]],
                    "new": [round(float(r["cx"]), 2), round(float(r["cy"]), 2)],
                    "size": [round(float(r["sx"]), 2), round(float(r["sy"]), 2)],
                    "conf": round(float(r["conf"]), 3),
                    "flag": r["flag"],
                }
                for r in results
            ],
        }
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        with open(args.report, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
        print(f"已生成报告: {args.report}")

    # 写回
    if args.write:
        # 非 OK 槽位保留原坐标（除非 --force）
        write_results = []
        for r in results:
            wr = dict(r)
            if r["flag"] != "OK" and not args.force:
                wr["cx"] = float(r["old_x"])
                wr["cy"] = float(r["old_y"])
            write_results.append(wr)
        new_data = update_map_points(original_data, write_results)
        backup_dir = Path(args.backup_dir)
        backup_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup_path = backup_dir / f"map_points.{ts}.json"
        shutil.copy2(points_path, backup_path)
        with open(points_path, "w", encoding="utf-8") as f:
            json.dump(new_data, f, ensure_ascii=False, indent=2)
        print(f"\n已备份: {backup_path}")
        print(f"已更新: {points_path}")
    else:
        print("\n干跑完成，未写回。加 --write 执行写回。")


if __name__ == "__main__":
    main()
