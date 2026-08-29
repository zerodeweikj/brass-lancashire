// 槽位缩放统一工具：把「把一张纹理贴进某个槽位」的缩放逻辑收敛到一处，
// 避免各处重复实现时写错尺寸（例：远方市场正面曾用占位图尺寸而非真实像素，导致图大三倍）。
//
// mode（决定缩放策略）：
//  - 'stretch'（默认）：X/Y 各自独立缩放，强制铺满槽位，可能变形。
//        —— 用户定案：除玩家顺序轨外的所有槽位用此，宁可拉长后改尺寸，不容留白。
//  - 'cover'：等比缩放铺满，裁切溢出部分。
//        —— 玩家顺序轨槽位用此（头像式取景：铺满、裁边）。
//  - 'contain'：等比缩放放进槽位，可能留白（本项目暂未采用）。
//
// slotScale 返回 [sx, sy] 由调用方 setScale；fitIntoSlot 直接建图并入容器。

export function slotScale(scene, key, slotW, slotH, mode = 'stretch') {
  if (!scene.textures.exists(key)) return [1, 1];
  const src = scene.textures.get(key).getSourceImage();
  const sw = src.width || slotW;
  const sh = src.height || slotH;
  if (mode === 'cover') {
    const s = Math.max(slotW / sw, slotH / sh);
    return [s, s];
  }
  if (mode === 'contain') {
    const s = Math.min(slotW / sw, slotH / sh);
    return [s, s];
  }
  return [slotW / sw, slotH / sh]; // stretch
}

export function fitIntoSlot(scene, container, key, x, y, slotW, slotH, mode = 'stretch') {
  const [sx, sy] = slotScale(scene, key, slotW, slotH, mode);
  const img = scene.add.image(x, y, key).setOrigin(0.5).setScale(sx, sy);
  if (container) container.add(img);
  return img;
}
