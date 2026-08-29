import Phaser from 'phaser';
import './ui/style.css';
import GameScene from './scenes/GameScene.js';
import MapCalibrateScene from './scenes/MapCalibrateScene.js';
import App from './app.js';

const qs = new URLSearchParams(location.search);
const mode = qs.get('scene'); // calibrate | undefined

// ?scene=calibrate 保留给地图槽位标定工具。玩家面板已并入主界面右侧栏，
// 旧的「?scene=panels」独立总览页已废弃（见 2026-08-09 BGA 三栏布局重构）。
const calibrate = mode === 'calibrate';

const scenes = calibrate ? [MapCalibrateScene] : [GameScene];

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#10151c',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.NO_CENTER,
    width: '100%',
    height: '100%',
  },
  scene: scenes,
});

window.__game = game;

// 画布物理裁剪到「地图区域」：手牌行(上) / 玩家面板(右) / 地图(中) 三区互不重叠。
// 地图区 = 视口减去四周 inset；Phaser RESIZE 模式让画布自适应此矩形。
const MAP_INSETS = { left: 10, right: 312, top: 184, bottom: 12 };
function layoutGame() {
  const g = document.getElementById('game');
  if (!g) return;
  const w = Math.max(240, window.innerWidth - MAP_INSETS.left - MAP_INSETS.right);
  const h = Math.max(240, window.innerHeight - MAP_INSETS.top - MAP_INSETS.bottom);
  g.style.position = 'absolute';
  g.style.left = MAP_INSETS.left + 'px';
  g.style.top = MAP_INSETS.top + 'px';
  g.style.width = w + 'px';
  g.style.height = h + 'px';
  // 强制 Phaser 游戏分辨率 = 裁剪后的地图区，使相机尺寸与可见区一致（避免跟随整窗）。
  if (window.__game?.scale) window.__game.scale.resize(w, h);
}
layoutGame();
window.addEventListener('resize', layoutGame);

// 标定工具页不初始化游戏 HUD；其余模式照常挂载 App
if (!calibrate) {
  const app = new App(game);
  window.__app = app;
  app.boot().catch((e) => {
    console.error('[boot] 启动失败', e);
    document.body.insertAdjacentHTML('beforeend',
      `<div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
        background:#10151c;color:#ff8080;font-family:'Microsoft YaHei',sans-serif;font-size:15px;
        z-index:99;text-align:center;padding:24px;line-height:1.8">
        启动失败：${e.message}<br>请确认后端已启动（python -m uvicorn app.main:app --host 0.0.0.0 --port 8765）
      </div>`);
  });
}
