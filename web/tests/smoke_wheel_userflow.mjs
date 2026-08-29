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

// ---- 建房（机器人陪练房，真实交互） ----
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
const getState = () => st((s) => {
  const sc = eval(s);
  const stt = sc.getScrollState();
  const yThumb = document.querySelector('#mapscroll-y .thumb');
  const yDisabled = document.querySelector('#mapscroll-y')?.classList.contains('disabled');
  return {
    scrollY: sc.cameras.main.scrollY,
    rangeY: stt.rangeY,
    ratioY: stt.ratioY,
    yThumbTop: yThumb ? yThumb.getBoundingClientRect().top : null,
    yDisabled,
  };
}, SC);

// 1) 默认 contain 整图可见：滚轮不应移动（滚动条禁用，符合设计）
const def = await getState();
assert('默认整图可见 → 滚动条禁用(disabled)', def.yDisabled === true, `rangeY=${def.rangeY}`);
const rect = await st(() => { const r = document.getElementById('game').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; });
await page.mouse.move(rect.cx, rect.cy);
await page.mouse.wheel(0, 600);
await page.waitForTimeout(200);
const def2 = await getState();
assert('默认整图可见 → 滚轮不移动(无范围)', Math.abs(def2.scrollY - def.scrollY) < 0.5, `before=${def.scrollY.toFixed(0)} after=${def2.scrollY.toFixed(0)}`);

// 2) 点击真实「＋」缩放按钮（用户真实操作），应使地图可平移
await page.locator('#zoomctl button.zoombtn').first().click();   // 第一个按钮=＋
await page.waitForTimeout(300);
const zoomed = await getState();
assert('点击＋后纵向可平移(rangeY>0)', zoomed.rangeY > 0 && zoomed.yDisabled === false, `rangeY=${zoomed.rangeY.toFixed(0)} disabled=${zoomed.yDisabled}`);

// 3) 真实滚轮：向下滚 → 视窗下移 + 滑块下移（像浏览网页）
await page.mouse.move(rect.cx, rect.cy);
const beforeDown = await getState();
await page.mouse.wheel(0, 800);
await page.waitForTimeout(250);
const afterDown = await getState();
assert('向下滚轮 → scrollY 增大', afterDown.scrollY > beforeDown.scrollY + 1, `before=${beforeDown.scrollY.toFixed(0)} after=${afterDown.scrollY.toFixed(0)}`);
assert('向下滚轮 → 竖向滑块下移', afterDown.yThumbTop > beforeDown.yThumbTop + 1, `before=${beforeDown.yThumbTop?.toFixed(0)} after=${afterDown.yThumbTop?.toFixed(0)}`);

// 4) 向上滚恢复
await page.mouse.wheel(0, -800);
await page.waitForTimeout(250);
const afterUp = await getState();
assert('向上滚轮 → scrollY 减小', afterUp.scrollY < afterDown.scrollY - 1, `down=${afterDown.scrollY.toFixed(0)} up=${afterUp.scrollY.toFixed(0)}`);

// 5) 健壮性：光标停在「竖向滚动条轨道条」上（盖在画布之上的独立 DOM）滚动，地图仍应平移
const sbXY = await st(() => {
  const r = document.querySelector('#mapscroll-y').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(sbXY.x, sbXY.y);
const beforeSB = await getState();
await page.mouse.wheel(0, 800);
await page.waitForTimeout(250);
const afterSB = await getState();
assert('滚轮在滚动条轨道上 → 地图仍平移', Math.abs(afterSB.scrollY - beforeSB.scrollY) > 1, `before=${beforeSB.scrollY.toFixed(0)} after=${afterSB.scrollY.toFixed(0)}`);

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/wheel_userflow.png' });
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log(`\n==== ${checks.length - failed.length}/${checks.length} 通过 ====`);
if (allErrors.length) console.log('页面错误:', allErrors.slice(0, 6));
process.exit(failed.length ? 1 : 0);
