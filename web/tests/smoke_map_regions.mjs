import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const allErrors = [];
const IGNORE_404 = ['card_back', '/markers/', 'player_board', 'remote_market', 'tiles/'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() === 404) allErrors.push('404: ' + r.url()); });

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);
async function poll(fn, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await page.waitForTimeout(200); }
  return false;
}

// ---- 建房（机器人陪练房） ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('陪练人类');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();
await page.waitForFunction(() => window.__app?.session?.room?.seats?.some((x) => x.isMe), { timeout: 10000 });
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();
await poll(async () => {
  const s = await st(() => window.__app?.session);
  return s?.room?.status === 'playing' && s?.isMyTurn;
});
await poll(async () => await st(() => !!(document.querySelector('#topbar') && window.__game?.scene?.getScene('GameScene')?.ready)));

// 1) 画布物理裁剪到地图区域（与手牌行/玩家面板三区隔离）
const geo = await st(() => {
  const g = document.getElementById('game');
  const r = g.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, iw: window.innerWidth, ih: window.innerHeight };
});
const IN = { left: 10, right: 312, top: 184, bottom: 12 };
const inLeft = Math.abs(geo.left - IN.left) < 3;
const inTop = Math.abs(geo.top - IN.top) < 3;
const inRight = Math.abs(geo.right - (geo.iw - IN.right)) < 3;
const inBottom = Math.abs(geo.bottom - (geo.ih - IN.bottom)) < 3;
assert('画布左缘 ≈ 10（隔离手牌行）', inLeft, `left=${geo.left}`);
assert('画布上缘 ≈ 184（隔离手牌行）', inTop, `top=${geo.top}`);
assert('画布右缘 ≈ 视口-312（隔离玩家面板）', inRight, `right=${geo.right} expect~${geo.iw - IN.right}`);
assert('画布下缘 ≈ 视口-12（地图区底部）', inBottom, `bottom=${geo.bottom} expect~${geo.ih - IN.bottom}`);
// 画布不侵入手牌行(0..176)与玩家面板(右308..)
const noOverlapHand = geo.top >= 176;
const noOverlapRight = geo.right <= geo.iw - 308 + 1;
assert('画布不侵入手牌行下方区域', noOverlapHand, `top=${geo.top}`);
assert('画布不侵入玩家面板', noOverlapRight, `right=${geo.right}`);

// 2) 滚动条 DOM 存在 + 默认整图可见时禁用
const sb = await st(() => ({
  y: !!document.querySelector('#mapscroll-y'),
  x: !!document.querySelector('#mapscroll-x'),
  yDisabled: document.querySelector('#mapscroll-y')?.classList.contains('disabled'),
  xDisabled: document.querySelector('#mapscroll-x')?.classList.contains('disabled'),
}));
assert('右侧竖向滚动条存在', sb.y);
assert('底部横向滚动条存在', sb.x);
assert('默认整图可见：滚动条禁用（无需平移）', sb.yDisabled && sb.xDisabled, `y=${sb.yDisabled} x=${sb.xDisabled}`);

// 3) 远方市场轨位置已下发（remoteCottonTrack）
const rct = await st(() => window.__app?.session?.state?.remoteCottonTrack);
assert('state.remoteCottonTrack 已序列化', typeof rct === 'number', `track=${rct}`);

// 4) 地图标记/牌库渲染（markC 有子节点：抽牌库/远方市场牌库/弃牌堆/轨）
const markCount = await st(() => {
  const sc = window.__game.scene.getScene('GameScene');
  return sc?.markC ? sc.markC.length : -1;
});
assert('地图牌库/远方市场轨标记已渲染', markCount > 0, `markC=${markCount}`);

// 5) 缩放后可平移：滚动条启用 + setScrollRatioX 真的移动相机
const pan = await st(() => {
  const sc = window.__game.scene.getScene('GameScene');
  sc.zoomBy(2.5);                       // 放大到可平移
  const disabledAfter = document.querySelector('#mapscroll-x')?.classList.contains('disabled');
  const before = sc.cameras.main.scrollX;
  sc.setScrollRatioX(1);                // 滚到最右
  const after = sc.cameras.main.scrollX;
  const s = sc.getScrollState();
  // 读取 DOM 滑块位置
  const thumb = document.querySelector('#mapscroll-x .thumb');
  const tl = document.querySelector('#mapscroll-x').clientWidth;
  const th = thumb.offsetWidth;
  const leftPct = tl ? (parseFloat(thumb.style.left) || 0) / Math.max(1, tl - th) : -1;
  return { disabledAfter, before, after, ratioX: s.ratioX, rangeX: s.rangeX, leftPct };
});
assert('放大后横向滚动条启用', pan.disabledAfter === false, `disabled=${pan.disabledAfter}`);
assert('setScrollRatioX(1) 移动相机 scrollX', pan.after > pan.before + 1, `before=${pan.before.toFixed(0)} after=${pan.after.toFixed(0)}`);
assert('滚动后 ratioX≈1', Math.abs(pan.ratioX - 1) < 0.05, `ratioX=${pan.ratioX.toFixed(3)}`);
assert('DOM 横向滑块已移到最右', pan.leftPct > 0.9, `leftPct=${pan.leftPct.toFixed(3)}`);

// 纵向同样验证（ratio=0 滚到最上，是真实极值而非居中）
const panY = await st(() => {
  const sc = window.__game.scene.getScene('GameScene');
  const before = sc.cameras.main.scrollY;
  sc.setScrollRatioY(0);
  const after = sc.cameras.main.scrollY;
  const s = sc.getScrollState();
  return { before, after, ratioY: s.ratioY, rangeY: s.rangeY };
});
assert('setScrollRatioY 移动相机 scrollY', panY.after < panY.before - 1, `before=${panY.before.toFixed(0)} after=${panY.after.toFixed(0)}`);
assert('滚动后 ratioY≈0', Math.abs(panY.ratioY) < 0.05, `ratioY=${panY.ratioY.toFixed(3)}`);

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/map_regions_smoke.png' });

// ---- 错误汇总 ----
const resp404 = allErrors.filter((e) => e.startsWith('404:')).map((e) => e.slice(5));
const unexpected404 = resp404.filter((u) => !IGNORE_404.some((s) => u.includes(s)));
const generic404 = allErrors.filter((e) => e.startsWith('console:') && /Failed to load resource.*404/.test(e));
const realErrors = allErrors.filter((e) => !e.startsWith('404:') && !generic404.includes(e))
  .concat(unexpected404.map((u) => '404: ' + u));

console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);
console.log('REAL ERRORS:', realErrors.length ? realErrors.join('\n') : 'none');

await browser.close();
process.exit(failed === 0 && realErrors.length === 0 ? 0 : 1);
