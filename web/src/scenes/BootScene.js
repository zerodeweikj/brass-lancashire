import Phaser from 'phaser';
import { API_BASE } from '../net/api.js';

/**
 * 启动场景：标题 + 连接后端（/health）→ 创建/读取对局 → 展示状态。
 * 目标：验证 Phaser 渲染 + FastAPI 通信链路（本地验证版）。
 */
export default class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  create() {
    // 直达场景路由：?scene=map / ?scene=calibrate 时直接切换，避免与 BootScene 双场景重叠渲染
    const params = new URLSearchParams(location.search);
    const direct = params.get('scene');
    if (direct === 'map' || direct === 'calibrate' || direct === 'playerboard' || direct === 'game') {
      const sceneName = direct === 'map' ? 'MapScene'
        : direct === 'calibrate' ? 'MapCalibrateScene'
        : direct === 'playerboard' ? 'PlayerBoardScene'
        : 'CombinedScene';
      this.scene.start(sceneName);
      return;
    }

    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#14181f');

    this.add
      .text(width / 2, height / 2 - 140, '工业革命·兰开夏', {
        fontSize: '44px',
        color: '#e8d5a3',
        fontFamily: 'Microsoft YaHei, sans-serif',
      })
      .setOrigin(0.5);

    this.status = this.add
      .text(width / 2, height / 2 - 60, '正在连接服务器…', {
        fontSize: '20px',
        color: '#9fb4c7',
        fontFamily: 'Microsoft YaHei, sans-serif',
      })
      .setOrigin(0.5);

    this.info = this.add
      .text(width / 2, height / 2 + 30, '', {
        fontSize: '16px',
        color: '#c9d4e0',
        align: 'center',
        lineSpacing: 8,
        fontFamily: 'Microsoft YaHei, sans-serif',
      })
      .setOrigin(0.5);

    // 导航按钮
    const btnStyle = {
      fontSize: '16px',
      color: '#10151c',
      fontFamily: 'Microsoft YaHei, sans-serif',
      fontStyle: 'bold',
      padding: { x: 14, y: 8 },
    };
    const mkBtn = (label, x, bg, onClick) => {
      const b = this.add.text(x, height / 2 + 170, label, { ...btnStyle, backgroundColor: bg });
      b.setOrigin(0.5);
      b.setInteractive({ useHandCursor: true });
      b.on('pointerdown', onClick);
      return b;
    };
    mkBtn('🗺 查看地图', width / 2 - 330, '#7ee0a3', () => this.scene.start('MapScene'));
    mkBtn('🏭 玩家面板', width / 2 - 110, '#c8a0ff', () => this.scene.start('PlayerBoardScene'));
    mkBtn('🧩 合并视图', width / 2 + 110, '#9fd6ff', () => this.scene.start('CombinedScene'));
    mkBtn('📍 地图校准', width / 2 + 330, '#ffd479', () => this.scene.start('MapCalibrateScene'));

    this._bootstrap();
  }

  async _bootstrap() {
    try {
      const health = await this._fetch('/health');
      this.status.setText(`后端已连接 (engine: ${health.engine})`);
      const game = await this._fetch('/game/new', {
        method: 'POST',
        body: JSON.stringify({ player_names: ['小明', '小王'] }),
      });
      const st = game.state;
      const p1 = st.players.find((p) => p.id === st.currentPlayer);
      this.info.setText(
        [
          `对局 ID: ${game.game_id}`,
          `阶段: ${st.phase === 'canal' ? '运河时代' : '铁路时代'} · 第 ${st.round} 轮`,
          `当前玩家: ${p1.id} (${p1.color}) · 金钱 £${p1.money} · 行动点 ${st.actionPoints}`,
          `手牌: ${p1.hand.join(', ')}`,
          '（服务器权威，SQLite 持久化）',
        ].join('\n')
      );
    } catch (e) {
      this.status.setText(`后端连接失败: ${e.message}。请先启动 server（uvicorn app.main:app --port 8765）`);
    }
  }

  async _fetch(path, opts = {}) {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}
