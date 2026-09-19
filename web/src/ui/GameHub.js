/**
 * GameHub：zero 的桌游空间——平台大厅（选游戏）。
 *
 * 职责单一：渲染游戏卡片网格 + 顶栏房间号加入。
 * 点击卡片后的动效与路由由 app 层通过 handlers 接管：
 *   onEnterGame(manifest, cardEl)  主按钮/卡片 → 进该游戏房间列表（含 coverPush 动效）
 *   onAiRoom(manifest, cardEl)     次级按钮 → 直接建 AI 陪练房
 *   onJoinedRoom(room)             顶栏房号加入成功
 *   onOpenAuth()                   未登录点「登录后进入」
 * 账号条（头像/战绩）由 AuthScreen 悬浮条负责，本组件不重复渲染。
 *
 * DOM 契约（e2e 断言依赖）：#gamehub、.gh-card[data-game-id]、.gh-card.locked、
 * .gh-skel、.gh-err、#gh-code-input、#gh-code-err。
 */
import { h, clear, toast } from './dom.js';
import { auth } from '../net/api.js';
import { openFeedback } from './Feedback.js';

const LS_NAME = 'lancashire.playerName';
const VERSION = 'v0.1.0';

const WEIGHT_CN = { 轻: '轻度策略', 中: '中度策略', 重: '重度策略' };

export default class GameHub {
  constructor(host, session, handlers = {}) {
    this.host = host;
    this.session = session;
    this.handlers = handlers;
    this.root = null;
    this.games = null;
    this._joinBusy = false;
  }

  mount() {
    if (this.root) return;
    this.root = h('div#gamehub');
    this.host.appendChild(this.root);
    this._renderShell();
    this._renderSkeleton();
    this._load();
  }

  unmount() {
    if (this.root) { this.root.remove(); this.root = null; }
  }

  get mounted() { return !!this.root; }

  // ---------------- 骨架 ----------------

  _renderShell() {
    clear(this.root);
    this.root.appendChild(
      h('div.gh-wrap', null,
        h('header.gh-top', null,
          h('div.gh-brand', null,
            h('div.gh-logo', { text: 'z' }),
            h('div.gh-site', { text: 'zero 的桌游空间' })),
          h('div.gh-join', null,
            this.codeInput = h('input#gh-code-input', {
              placeholder: '输入房间号',
              maxlength: 16,
              onkeydown: (e) => { if (e.key === 'Enter') this._joinByCode(); },
            }),
            h('button.gh-btn.gh-btn-primary', { onclick: () => this._joinByCode() }, '加入')),
          h('div#gh-code-err')),
        h('main.gh-main', null,
          h('h1.gh-title', { text: '选一款桌游开始吧' }),
          this.subEl = h('p.gh-sub'),
          this.grid = h('div.gh-grid')),
        h('footer.gh-foot', null,
          h('button.gh-link', { onclick: () => openFeedback() }, '留言 / 提意见'),
          h('span.gh-ver', { text: VERSION }))));
  }

  // ---------------- 加载三态 ----------------

  _renderSkeleton() {
    clear(this.grid);
    this.subEl.textContent = '服务唤醒中…';
    for (let i = 0; i < 2; i++) {
      this.grid.appendChild(
        h('div.gh-card.gh-skel', null,
          h('div.gh-skel-cover'),
          h('div.gh-skel-line'),
          h('div.gh-skel-line.short')));
    }
  }

  _renderError() {
    clear(this.grid);
    this.subEl.textContent = '';
    this.grid.appendChild(
      h('div.gh-err', null,
        h('div.gh-err-text', { text: '游戏库加载失败' }),
        h('button.gh-btn.gh-btn-primary', { onclick: () => { this._renderSkeleton(); this._load(); } }, '重试')));
  }

  async _load() {
    try {
      this.games = await this.session.games();
      if (!this.root) return;   // 已卸载（动画期间离开大厅）
      this._renderCards();
    } catch (e) {
      if (!this.root) return;
      this._renderError();
    }
  }

  // ---------------- 卡片 ----------------

  _renderCards() {
    clear(this.grid);
    const games = this.games || [];
    const openCount = games.filter((g) => g.status === 'available').length;
    this.subEl.textContent = `目前开放 ${openCount} 款，更多正在路上`;

    for (const g of games) {
      this.grid.appendChild(g.status === 'available' ? this._cardOpen(g) : this._cardLocked(g));
    }
    // 虚线占位卡
    this.grid.appendChild(
      h('div.gh-card.gh-placeholder', null,
        h('div.gh-plus', { text: '+' }),
        h('div.gh-ph-text', { text: '敬请期待' })));
  }

  _metaText(g) {
    const parts = [];
    if (g.minPlayers && g.maxPlayers) parts.push(`${g.minPlayers}–${g.maxPlayers} 人`);
    if (g.duration) parts.push(`约 ${g.duration} 分钟`);
    if (g.weight) parts.push(WEIGHT_CN[g.weight] || g.weight);
    return parts.join(' · ');
  }

  _cardOpen(g) {
    const enter = () => this.handlers.onEnterGame?.(g, card);
    const card = h('div.gh-card', { dataset: { gameId: g.gameId }, onclick: enter },
      h('div.gh-cover-wrap', null,
        h('img.gh-cover', { src: g.cover, alt: g.name, draggable: false })),
      h('div.gh-body', null,
        h('div.gh-name', { text: g.name }),
        h('div.gh-meta', { text: this._metaText(g) }),
        h('p.gh-tagline', { text: g.tagline || '' }),
        h('div.gh-tags', null, (g.tags || []).map((t) => h('span.gh-chip', { text: t }))),
        h('div.gh-actions', null,
          auth.isLoggedIn
            ? h('button.gh-btn.gh-btn-primary', { onclick: (e) => { e.stopPropagation(); enter(); } }, '进入游戏')
            : h('button.gh-btn.gh-btn-primary', {
                onclick: (e) => { e.stopPropagation(); this.handlers.onOpenAuth?.(); },
              }, '登录后进入'),
          h('button.gh-btn.gh-btn-ghost', {
            title: '游客可用，直接开一局与 AI 对战',
            onclick: (e) => { e.stopPropagation(); this.handlers.onAiRoom?.(g, card); },
          }, 'AI 陪练房'))));
    return card;
  }

  /** 灰卡：整卡不可交互——无 onclick、无 tab 焦点、无 hover 反馈（样式侧 cursor:default）。 */
  _cardLocked(g) {
    return h('div.gh-card.locked', { dataset: { gameId: g.gameId }, tabindex: -1 },
      h('div.gh-cover-wrap', null,
        g.cover ? h('img.gh-cover', { src: g.cover, alt: g.name, draggable: false })
                : h('div.gh-cover-empty', { text: g.name })),
      h('div.gh-badge', { text: '开发中' }),
      h('div.gh-body', null,
        h('div.gh-name', { text: g.name }),
        h('div.gh-meta', { text: this._metaText(g) }),
        h('p.gh-tagline', { text: g.tagline || '' }),
        h('div.gh-tags', null, h('span.gh-chip.gh-chip-muted', { text: '暂未开放' }))));
  }

  // ---------------- 房号加入 ----------------

  async _joinByCode() {
    if (this._joinBusy) return;
    const errEl = this.root.querySelector('#gh-code-err');
    const code = (this.codeInput.value || '').trim().toUpperCase();
    errEl.textContent = '';
    if (!code) { errEl.textContent = '请输入房间号'; return; }
    const name = auth.user?.displayName || localStorage.getItem(LS_NAME) || '玩家';
    this._joinBusy = true;
    try {
      const room = await this.session.joinRoom(code, name);
      this.handlers.onJoinedRoom?.(room);
    } catch (e) {
      errEl.textContent = e.message || '房间不存在或已解散';
    } finally {
      this._joinBusy = false;
    }
  }
}
