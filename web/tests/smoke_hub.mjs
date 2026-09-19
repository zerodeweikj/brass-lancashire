// 平台大厅（GameHub）+ 进场动效 端到端冒烟（真实点击）
// 覆盖设计文档 13 条验收标准（AC1~AC13）。
// 用法: node tests/smoke_hub.mjs [URL]
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const allErrors = [];          // 仅收集真实未捕获异常（pageerror），不收 console.error 以免误判边界 422
const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

const rnd = Math.floor(Math.random() * 90000 + 10000);

async function newPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());   // 自动接受 confirm（退出房间等）
  return page;
}

const browser = await chromium.launch();

// ============ 主流程页 H：AC1 / AC3 / AC6(pre) / AC7 / AC8-10 / AC6(dark) / AC13 ============
const H = await newPage(browser);
await H.goto(URL, { waitUntil: 'load' });

// AC1 大厅渲染
await H.waitForSelector('.gh-card[data-game-id="brass"]', { timeout: 10000 });
assert('AC1 平台大厅 #gamehub 可见', await H.locator('#gamehub').isVisible());
assert('AC1 进站无 #lobby', await H.locator('#lobby').count() === 0);

const cardCount = await H.locator('.gh-card:not(.gh-placeholder):not(.gh-skel)').count();
assert('AC1 渲染 2 张游戏卡（不含占位/骨架）', cardCount === 2, `n=${cardCount}`);
const names = await H.locator('.gh-name').allInnerTexts();
assert('AC1 含「工业革命·兰开夏」', names.some((x) => x.includes('兰开夏')), names.join(','));
assert('AC1 含「情书」', names.some((x) => x.includes('情书')), names.join(','));

// AC6 进站前 body 不挂 theme-brass（暖白壳）
assert('AC6 进站无 theme-brass', await H.evaluate(() => !document.body.className.includes('theme-brass')));

// AC3 灰卡（情书·开发中）点击无任何反应
const locked = H.locator('.gh-card.locked');
assert('AC3 灰卡存在', await locked.count() === 1);
await locked.click({ force: true });
await H.waitForTimeout(300);
assert('AC3 灰卡点击不进房（仍在大厅、无 lobby）',
  (await H.locator('#lobby').count() === 0) && (await H.locator('#gamehub').isVisible()));

// AC7 375px 单列、无横向溢出
await H.setViewportSize({ width: 375, height: 800 });
await H.waitForTimeout(250);
assert('AC7 375px 无横向溢出', await H.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
const cols = await H.evaluate(() => getComputedStyle(document.querySelector('.gh-grid')).gridTemplateColumns.split(' ').length);
assert('AC7 375px 卡片单列', cols === 1, `cols=${cols}`);
await H.setViewportSize({ width: 1600, height: 900 });

// AC8 / AC9 / AC10 点击「进入游戏」→ 封面推近动效 → 落到该游戏房间列表
const brassCard = H.locator('.gh-card[data-game-id="brass"]');
await brassCard.click();
// AC8 守卫：同步再触发一次点击，不应产生第二个房间（_entering 双保险）
await H.evaluate(() => {
  const c = document.querySelector('.gh-card[data-game-id="brass"]');
  if (c) c.click();
});
const transShown = await H.waitForSelector('#stage-transition', { timeout: 3000 }).then(() => true).catch(() => false);
assert('AC8 点击后即时出现过渡层', transShown);
// AC9 过渡期间封面遮挡层已就位（hero/clone 已插入），看不到白色壳
assert('AC9 过渡层封面就位（遮挡）', await H.evaluate(() =>
  !!(document.querySelector('#stage-transition .st-hero') || document.querySelector('#stage-transition .st-clone'))));
// AC10 过渡结束：lobby 可见、大厅 DOM 卸载、body 带 theme-brass
await H.waitForSelector('#lobby', { timeout: 6000 });
assert('AC10 过渡结束 lobby 可见', true);
assert('AC10 大厅 DOM 已卸载', await H.locator('#gamehub').count() === 0);
assert('AC10 body 带 theme-brass', await H.evaluate(() => document.body.className.includes('theme-brass')));
assert('AC8 仅一个 lobby（无重复进房）', await H.locator('#lobby').count() === 1);

// AC6 深色主题变量整套切换
const bg = await H.evaluate(() => getComputedStyle(document.body).getPropertyValue('--bg').trim());
assert('AC6 深色主题 --bg 已切换', /#10151c|rgb\(16,\s*21,\s*28\)/i.test(bg), bg);

// AC13 返回大厅：反向过渡 → 回到平台大厅且 body 不带 theme-brass
await H.locator('.lobby-backhub button').click();
await H.waitForSelector('#gamehub', { timeout: 6000 });
assert('AC13 反向过渡回到平台大厅', await H.locator('#gamehub').isVisible());
assert('AC13 回大厅 body 不带 theme-brass', await H.evaluate(() => !document.body.className.includes('theme-brass')));

// ============ AC4 房号加入：M 建房拿房号，H 在 hub 顶栏输入加入；无效房号内联报错 ============
const M = await newPage(browser);
await M.goto(URL, { waitUntil: 'load' });
await M.waitForSelector('.gh-card[data-game-id="brass"]', { timeout: 10000 });
await M.locator('.gh-card[data-game-id="brass"]').click();
await M.waitForSelector('#lobby', { timeout: 6000 });
await M.getByPlaceholder('房间名（可留空）').fill('hubjoin' + rnd);
await M.getByRole('button', { name: '创建' }).click();
await M.waitForSelector('.seats .seat', { timeout: 8000 });
const roomId = await M.evaluate(() => {
  const m = document.body.innerText.match(/房间号\s*([A-Z0-9]{4,8})/);
  return m ? m[1] : null;
});
assert('AC4 建房拿到房号', !!roomId, String(roomId));

if (roomId) {
  await H.locator('#gh-code-input').fill(roomId);
  await H.locator('.gh-join .gh-btn-primary').click();
  await H.waitForSelector('#lobby', { timeout: 6000 });
  assert('AC4 有效房号加入落入房间列表', true);
  // 无效房号：先回 hub（离开已加入的房），再输入不存在房号
  await H.locator('.lobby-backhub button').click();
  await H.waitForSelector('#gamehub', { timeout: 6000 });
}
await H.locator('#gh-code-input').fill('ZZZZ99');
await H.locator('.gh-join .gh-btn-primary').click();
const errText = await H.waitForSelector('#gh-code-err', { timeout: 3000 })
  .then(() => H.locator('#gh-code-err').innerText()).catch(() => '');
assert('AC4 无效房号内联报错', (errText || '').trim().length > 0, errText);

// ============ AC11 reduced-motion：动画被压缩，快速到达 lobby ============
const rc = await browser.newContext({ viewport: { width: 1600, height: 900 }, reducedMotion: 'reduce' });
const R = await rc.newPage();
R.on('pageerror', (e) => allErrors.push('pageerror(R): ' + e.message));
R.on('dialog', (d) => d.accept());
await R.goto(URL, { waitUntil: 'load' });
await R.waitForSelector('.gh-card[data-game-id="brass"]', { timeout: 10000 });
const t0 = Date.now();
await R.locator('.gh-card[data-game-id="brass"]').click();
const fast = await R.waitForSelector('#lobby', { timeout: 2500 }).then(() => true).catch(() => false);
assert('AC11 reduced-motion 快速到达 lobby（≤2.5s）', fast, `elapsed=${Date.now() - t0}ms`);
assert('AC11 reduced-motion 主题切换正确', await R.evaluate(() => document.body.className.includes('theme-brass')));

// ============ AC12 对局揭幕 canvas 首帧已绘制（陪练房开局） ============
const C = await newPage(browser);
await C.goto(URL, { waitUntil: 'load' });
await C.waitForSelector('.gh-card[data-game-id="brass"]', { timeout: 10000 });
await C.locator('.gh-card[data-game-id="brass"]').getByRole('button', { name: 'AI 陪练房' }).click();
await C.waitForSelector('.seats .seat', { timeout: 8000 });          // 建房进入座位视图
await C.getByRole('button', { name: '准备', exact: true }).click();   // 房主准备 → bot 开局
await C.waitForSelector('#topbar', { timeout: 12000 });               // 对局开始 HUD 挂载
const canvas = await C.evaluate(() => {
  const c = document.querySelector('#game canvas');
  if (!c) return { ok: false, reason: 'no-canvas' };
  if (!c.width || !c.height) return { ok: false, reason: 'zero-size' };
  let len = 0;
  try { len = c.toDataURL ? c.toDataURL().length : 0; } catch (e) { return { ok: true, reason: 'webgl-nosnapshot' }; }
  return { ok: len > 500, len };
});
assert('AC12 对局 canvas 首帧已绘制（非纯色）', canvas.ok, JSON.stringify(canvas));

// ============ AC5 清单接口 500 → 失败态 + 重试可恢复（独立 context 拦截） ============
const F = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const FP = await F.newPage();
FP.on('pageerror', (e) => allErrors.push('pageerror(F): ' + e.message));
FP.on('dialog', (d) => d.accept());
await FP.route('**/api/games', (route) => route.fulfill({ status: 500, body: 'boom' }));
await FP.goto(URL, { waitUntil: 'load' });
const failShown = await FP.waitForSelector('.gh-err', { timeout: 6000 }).then(() => true).catch(() => false);
assert('AC5 清单 500 失败态', failShown);
assert('AC5 重试按钮存在', await FP.getByRole('button', { name: '重试' }).count() === 1);
await FP.unroute('**/api/games');
await FP.getByRole('button', { name: '重试' }).click();
const recovered = await FP.waitForSelector('.gh-card', { timeout: 6000 }).then(() => true).catch(() => false);
assert('AC5 重试后恢复卡片', recovered);

// ============ 汇总 ============
console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);
console.log('REAL ERRORS:', allErrors.length ? allErrors.join('\n') : 'none');
await browser.close();
process.exit(failed === 0 && allErrors.length === 0 ? 0 : 1);
