import Phaser from 'phaser';

/**
 * 通用地图相机控制：滚轮缩放（以鼠标位置为中心）+ 按住拖动平移。
 * 用法：const pan = enableCameraPanZoom(scene);  scene 的打点交互在 pointerup 时
 * 先判 `!pan.isPanning()`，避免拖动被误判为点击。
 */
export function enableCameraPanZoom(scene, opts = {}) {
  const { minZoom = 0.3, maxZoom = 6, wheelFactor = 1.12, dragThreshold = 6, regionX = null } = opts;
  const cam = scene.cameras.main;
  const state = { down: false, panning: false, startX: 0, startY: 0, scrollX: 0, scrollY: 0 };

  const inRegion = (pointer) => regionX == null || pointer.x < regionX;

  scene.input.on('pointerdown', (pointer) => {
    if (!inRegion(pointer)) return;
    // 点在可拖动的标记方块上时不平移地图（标记对象带 __isMarker 标记）
    const hits = scene.input.hitTestPointer(pointer);
    if (hits.some((o) => o && o.__isMarker)) return;
    state.down = true;
    state.panning = false;
    state.startX = pointer.x;
    state.startY = pointer.y;
    state.scrollX = cam.scrollX;
    state.scrollY = cam.scrollY;
  });

  scene.input.on('pointermove', (pointer) => {
    if (!state.down) return;
    const dx = pointer.x - state.startX;
    const dy = pointer.y - state.startY;
    if (!state.panning && Math.hypot(dx, dy) > dragThreshold) state.panning = true;
    if (state.panning) {
      cam.scrollX = state.scrollX - dx;
      cam.scrollY = state.scrollY - dy;
    }
  });

  const end = () => { state.down = false; };
  scene.input.on('pointerup', end);
  scene.input.on('pointerupoutside', end);

  // 滚轮缩放：保持鼠标下的世界点不动（仅在地图区域生效）
  scene.input.on('wheel', (pointer, _over, _dX, dY) => {
    // 手牌交互/放大查看时禁用地图滚轮缩放（由场景在适当时机设置该标志）
    if (scene.__suppressMapWheel) return;
    if (!inRegion(pointer)) return;
    const factor = dY < 0 ? wheelFactor : 1 / wheelFactor;
    const z = Phaser.Math.Clamp(cam.zoom * factor, minZoom, maxZoom);
    const world = cam.getWorldPoint(pointer.x, pointer.y);
    cam.setZoom(z);
    cam.scrollX = world.x * z - pointer.x;
    cam.scrollY = world.y * z - pointer.y;
  });

  // 键盘平移（WASD / 方向键）已按用户要求于 2026-08-09 移除：游戏主版图改为静态自适应，
  // 不再支持键盘平移；缩放交回浏览器原生 CTRL+滚轮。标定工具页如需键盘平移可在此恢复。

  return {
    isPanning: () => state.panning,
    setZoom: (z) => cam.setZoom(Phaser.Math.Clamp(z, minZoom, maxZoom)),
  };
}

/**
 * 左上角交互提示。
 * ⚠ 已按用户要求（2026-08-07）整体屏蔽：不再渲染任何提示文本，统一返回 null。
 * 调用方（MapScene / CombinedScene）需判空；MapScene 未使用返回值无需改动。
 * 如需恢复，取消下方 return null 的注释并恢复 text 创建即可。
 */
export function addMapHint(scene, extra = '') {
  // 相机提示已禁用：不创建任何文本对象（避免被 safe-delete 之类场景逻辑干扰）。
  return null;
  /*
  return scene.add.text(16, 14, `🖱 滚轮缩放 · 按住拖动平移${extra}`, {
    fontSize: '13px',
    color: '#c9d4e0',
    fontFamily: 'Microsoft YaHei',
    backgroundColor: 'rgba(16,21,28,0.75)',
    padding: { x: 8, y: 4 },
  }).setDepth(100);
  */
}
