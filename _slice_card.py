"""把一张图均匀切成 3 行 × 10 列 = 30 张，保存到 lancashire/cards_sliced/。
用户定义：竖着的边（高）平均分 3 等份 = 3 行；横着的边（宽）平均分 10 等份 = 10 列。
"""
import os
from PIL import Image

SRC = r"C:/Users/Administrator.DESKTOP-7QOB34B/Desktop/兰开夏图片/卡牌部分/httpssteamusercontentaakamaihdnetugc960849557758143224B528277F25C82CD0684BBCD70ECACE0EB6147697.jpg"
DST = r"D:/zhuoyouyizhi/lancashire/cards_sliced"

os.makedirs(DST, exist_ok=True)
im = Image.open(SRC)
w, h = im.size
print(f"源图尺寸: {w} x {h} (宽 x 高)")

ROWS, COLS = 3, 10  # 竖边(h)切 2 刀→3 行；横边(w)切 9 刀→10 列
rh, cw = h // ROWS, w // COLS

count = 0
for r in range(ROWS):
    for c in range(COLS):
        x1 = c * cw
        y1 = r * rh
        x2 = (c + 1) * cw if c < COLS - 1 else w
        y2 = (r + 1) * rh if r < ROWS - 1 else h
        tile = im.crop((x1, y1, x2, y2))
        name = f"card_r{r:02d}_c{c:02d}.jpg"
        tile.save(os.path.join(DST, name), quality=92)
        count += 1

print(f"已切 {count} 张（{ROWS} 行 × {COLS} 列）到 {DST}")
# 抽查两张尺寸
from PIL import Image as I
for n in ["card_r00_c00.jpg", "card_r02_c09.jpg"]:
    t = I.open(os.path.join(DST, n))
    print(f"  {n}: {t.size[0]}x{t.size[1]}")
