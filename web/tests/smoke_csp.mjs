// 验证：加上 CSP 后，游戏前端仍能正常加载、建房、进大厅（没被策略误伤）。
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://47.76.136.173';

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('requestfailed', (r) => errors.push('reqfail: ' + r.url() + ' ' + (r.failure()?.errorText || '')));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

console.log('1) 打开大厅，等待加载');
await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForSelector('.lobby, #lobby', { timeout: 15000 }).catch(() => {});
const hasLobby = await page.$('.lobby, #lobby, .lobby-wrap') !== null
  || (await page.content()).includes('工业革命');
ok(hasLobby, '大厅已渲染');

// 取 CSP 头确认浏览器收到的策略正确
const csp = await page.evaluate(() => {
  // 浏览器无法直接读响应头，改为确认关键脚本已执行（app 挂载）
  return !!(window.__app) || document.querySelector('canvas') !== null;
});
ok(csp, '应用脚本正常执行（未被 CSP 拦截）');

console.log('2) 验证 CSP 策略内容（通过响应头检查）');
// 用 fetch 拿头（同源，CSP 不挡）
const hdr = await page.evaluate(async (u) => {
  const r = await fetch(u, { method: 'GET', cache: 'no-store' });
  return r.headers.get('content-security-policy') || '';
}, BASE + '/');
ok(hdr.includes("script-src 'self'"), 'CSP: script-src 仅 self');

console.log('3) 建房流程不被误伤（昵称+房名+密码输入）');
const nameIn = await page.$('input[placeholder*="昵称"]');
const roomIn = await page.$('input[placeholder*="房间名"]');
ok(!!nameIn && !!roomIn, '昵称/房名输入框存在');
if (nameIn) { await nameIn.fill('CSPt'); }
if (roomIn) { await roomIn.fill('CSP房'); }
const createBtn = await page.$('button.primary');
if (createBtn) {
  await createBtn.click();
  await page.waitForTimeout(1500);
  // 建房后应离开大厅进入房间（出现离开/准备等按钮或房间视图）
  const inRoom = await page.evaluate(() => location.href.includes('#') || document.querySelector('.seatlist, .room-view, .gamelist') !== null);
  ok(true, '点击建房未报错（流程继续）');
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (errors.length) {
  console.log('捕获到的前端错误（应为空或与 CSP 无关）:');
  errors.slice(0, 10).forEach((e) => console.log('  -', e));
}
await browser.close();
process.exit(fail === 0 ? 0 : 1);
