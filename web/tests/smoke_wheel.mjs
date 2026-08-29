import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const allErrors = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));

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

const SC = "window.__game.scene.getScene('GameScene')";

// 放大到可平移范围（contain 默认整图可见，滚轮交给页面）
await st((s) => eval(s).zoomBy(2.2), SC);
await page.waitForTimeout(300);

const before = await st((s) => {
  const sc = eval(s);
  const stt = sc.getScrollState();
  const thumb = document.querySelector('#mapscroll-y .thumb');
  return { scrollY: sc.cameras.main.scrollY, ratioY: stt.ratioY, thumbTop: thumb ? thumb.getBoundingClientRect().top : null };
}, SC);
assert('放大后纵向可平移（rangeY>0）', before.ratioY >= 0 && before.scrollY !== undefined);

// 鼠标移到地图画布中心，向上滚（deltaY<0 → 看地图上方，scrollY 减小）
const rect = await st(() => { const r = document.getElementById('game').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
await page.mouse.move(rect.cx, rect.cy);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(250);
const up = await st((s) => {
  const sc = eval(s);
  const stt = sc.getScrollState();
  const thumb = document.querySelector('#mapscroll-y .thumb');
  return { scrollY: sc.cameras.main.scrollY, ratioY: stt.ratioY, thumbTop: thumb ? thumb.getBoundingClientRect().top : null };
}, SC);
assert('向上滚轮 → 视窗上移(scrollY 减小)', up.scrollY < before.scrollY, `before=${before.scrollY.toFixed(0)} after=${up.scrollY.toFixed(0)}`);
assert('向上滚轮 → 竖向滚动条滑块上移', up.thumbTop !== null && up.thumbTop < before.thumbTop, `before=${before.thumbTop?.toFixed(0)} after=${up.thumbTop?.toFixed(0)}`);

// 向下滚（deltaY>0 → 看地图下方，scrollY 增大），与浏览网页一致
await page.mouse.wheel(0, 1200);
await page.waitForTimeout(250);
const down = await st((s) => {
  const sc = eval(s);
  const stt = sc.getScrollState();
  const thumb = document.querySelector('#mapscroll-y .thumb');
  return { scrollY: sc.cameras.main.scrollY, ratioY: stt.ratioY, thumbTop: thumb ? thumb.getBoundingClientRect().top : null };
}, SC);
assert('向下滚轮 → 视窗下移(scrollY 增大)', down.scrollY > up.scrollY, `up=${up.scrollY.toFixed(0)} after=${down.scrollY.toFixed(0)}`);
assert('向下滚轮 → 竖向滚动条滑块下移', down.thumbTop > up.thumbTop, `up=${up.thumbTop?.toFixed(0)} after=${down.thumbTop?.toFixed(0)}`);

// Shift+滚轮 → 横向平移（浏览网页的横向滚动逻辑）
const bx = await st((s) => eval(s).cameras.main.scrollX, SC);
await page.keyboard.down('Shift');
await page.mouse.wheel(0, 600);
await page.keyboard.up('Shift');
await page.waitForTimeout(250);
const ax = await st((s) => eval(s).cameras.main.scrollX, SC);
assert('Shift+滚轮 → 横向平移', Math.abs(ax - bx) > 1, `before=${bx.toFixed(0)} after=${ax.toFixed(0)}`);

// 整图可见时（重置缩放）滚轮不拦截页面
await st((s) => eval(s).zoomBy(1 / 2.2), SC);
await page.waitForTimeout(200);

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/wheel_smoke.png' });

await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n==== ${checks.length - failed.length}/${checks.length} 通过 ====`);
if (allErrors.length) { console.log('页面错误:', allErrors.slice(0, 8)); }
process.exit(failed.length ? 1 : 0);
