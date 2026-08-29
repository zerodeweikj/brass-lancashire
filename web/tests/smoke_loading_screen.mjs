// 等待画面冒烟：非机器人房，单人点准备后应显示 BGA 风格等待画面。
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

await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('等待测试');
await page.waitForTimeout(120);
// 不勾选机器人，创建 2 人房
await page.getByRole('button', { name: '创建' }).click();

await page.waitForFunction(() => {
  const s = window.__app?.session;
  return !!s?.room?.seats?.some((x) => x.isMe);
}, { timeout: 10000 });

const roomInfo = await st(() => {
  const s = window.__app?.session;
  const me = s?.room?.seats?.find((x) => x.isMe);
  return { bot: s?.room?.bot, status: s?.room?.status, seatCount: s?.room?.seats?.length, meReady: me?.ready };
});
assert('创建非机器人房', !roomInfo.bot && roomInfo.status === 'lobby', JSON.stringify(roomInfo));
assert('房主创建后自动准备', roomInfo.meReady === true, JSON.stringify(roomInfo));

// 房主已准备 → 等待画面应已显示
await page.waitForTimeout(300);
const lsInfo = await st(() => {
  const ls = document.getElementById('loadingscreen');
  if (!ls) return { mounted: false };
  const cover = ls.querySelector('.ls-cover');
  return {
    mounted: true,
    display: ls.style.display,
    hasCover: !!cover,
    coverSrc: cover?.src || '',
    title: ls.querySelector('.ls-title')?.textContent || '',
    sub: ls.querySelector('.ls-sub')?.textContent || '',
    msg: ls.querySelector('.ls-msg')?.textContent || '',
    hasCancel: !!ls.querySelector('.ls-cancel'),
  };
});
assert('等待画面 DOM 已挂载', lsInfo.mounted);
assert('等待画面可见（display 不为 none）', lsInfo.display !== 'none', lsInfo.display);
assert('封面图已渲染', lsInfo.hasCover && lsInfo.coverSrc.includes('cover.webp'), lsInfo.coverSrc);
assert('标题为「工业革命·兰开夏」', lsInfo.title === '工业革命·兰开夏', lsInfo.title);
assert('副标题为 Brass: Lancashire', lsInfo.sub === 'Brass: Lancashire', lsInfo.sub);
assert('等待文案包含「等待其他玩家」', /等待其他玩家/.test(lsInfo.msg), lsInfo.msg);
assert('取消准备按钮存在', lsInfo.hasCancel);

// 点击取消准备应回到座位界面
const cancelBtn = page.locator('#loadingscreen .ls-cancel');
assert('取消准备按钮可点', await cancelBtn.isVisible());
// 使用 JS 点击绕过可能的 pointer-events 拦截
await st(() => document.querySelector('#loadingscreen .ls-cancel')?.click());
// 轮询直到状态翻转（给长轮询留足时间）
let backToSeat = { hidden: false, meReady: true };
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(200);
  backToSeat = await st(() => {
    const ls = document.getElementById('loadingscreen');
    const s = window.__app?.session;
    const me = s?.room?.seats?.find((x) => x.isMe);
    return { hidden: ls ? ls.style.display === 'none' : false, meReady: me?.ready };
  });
  if (backToSeat.hidden && backToSeat.meReady === false) break;
}
assert('取消准备后等待画面隐藏', backToSeat.hidden);
assert('取消准备后状态为未准备', backToSeat.meReady === false);

// 再次点击准备，等待画面应重新出现
const readyBtn = page.getByRole('button', { name: '准备' }).first();
assert('准备按钮可见', await readyBtn.isVisible());
await readyBtn.click();
await page.waitForTimeout(400);
const lsAgain = await st(() => {
  const ls = document.getElementById('loadingscreen');
  return ls ? ls.style.display !== 'none' : false;
});
assert('再次准备后等待画面重新显示', lsAgain);

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/loading_screen_smoke.png' });

await browser.close();

const realErrors = allErrors.filter((e) => !e.startsWith('404:'));
assert('无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name + (c.extra ? '  -- ' + c.extra : '')); process.exit(1); }
console.log('全部通过 ✅');
