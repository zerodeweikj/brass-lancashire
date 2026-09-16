// 账号系统端到端冒烟（真实点击）：注册→登录态→个人空间→退出→登录
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8799/';
const allErrors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('dialog', (d) => d.accept());   // 自动接受 confirm()（退出/注销等）

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const rnd = Math.floor(Math.random() * 900 + 100);
const U = 'Auth' + rnd;          // 5-7 位，唯一
const PW = 'abc123';
const NICK = '零测E2E';

await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('#accountbar', { timeout: 10000 });
assert('启动后渲染账号条', true);

// 打开登录/注册
await page.getByRole('button', { name: '登录 / 注册' }).click();
await page.waitForSelector('.auth-overlay', { timeout: 5000 });
assert('弹层打开', true);

// 切到注册
await page.getByText('注册', { exact: true }).click();
await page.waitForTimeout(150);

// 填表
await page.getByPlaceholder('用户名（3-7 位，字母/数字/中文）').fill(U);
await page.getByPlaceholder('密码（6-11 位）').fill(PW);
await page.getByPlaceholder('确认密码').fill(PW);
await page.getByPlaceholder('昵称（可选，留空同用户名）').fill(NICK);
const ans = page.locator('.acct-qblock input');
await ans.nth(0).fill('王伟');
await ans.nth(1).fill('李娜');
await ans.nth(2).fill('实验一小');
await page.getByRole('button', { name: '注册并登录' }).click();

// 注册后应回到已登录态：账号条显示昵称，不再有「登录 / 注册」按钮
const loggedIn = await page.waitForFunction(() => {
  const bar = document.querySelector('#accountbar');
  if (!bar) return false;
  const hasLogin = Array.from(bar.querySelectorAll('button')).some((b) => b.textContent.includes('登录'));
  const name = bar.querySelector('.acct-name');
  return !hasLogin && name && name.textContent.length > 0;
}, { timeout: 8000 }).then(() => true).catch(() => false);
assert('注册后自动登录（账号条显示昵称）', loggedIn);
const shownName = await page.evaluate(() => document.querySelector('#accountbar .acct-name')?.textContent || '');
assert('昵称正确显示', shownName === NICK, shownName);

// 打开个人空间
await page.locator('.acct-chip').click();
await page.waitForSelector('.auth-overlay', { timeout: 5000 });
const settingsOk = await page.evaluate(() => document.body.innerText.includes('个人空间') && document.body.innerText.includes('修改密码'));
assert('个人空间含「资料/改密」分区', settingsOk);
await page.locator('.acct-x').click();
await page.waitForTimeout(150);

// 退出
await page.getByRole('button', { name: '退出' }).click();
await page.waitForFunction(() => {
  const bar = document.querySelector('#accountbar');
  return bar && Array.from(bar.querySelectorAll('button')).some((b) => b.textContent.includes('登录'));
}, { timeout: 6000 }).then(() => {}).catch(() => {});
const loggedOut = await page.evaluate(() => {
  const bar = document.querySelector('#accountbar');
  return !!bar && Array.from(bar.querySelectorAll('button')).some((b) => b.textContent.includes('登录'));
});
assert('退出后回到未登录（显示登录/注册）', loggedOut);

// 登录回来（退出后开弹层默认即在「登录」页）
await page.getByRole('button', { name: '登录 / 注册' }).click();
await page.waitForSelector('.auth-overlay', { timeout: 5000 });
await page.getByPlaceholder('用户名（3-7 位）').fill(U);
await page.getByPlaceholder('密码（6-11 位）').fill(PW);
await page.getByRole('button', { name: '登录', exact: true }).click();
const reLogin = await page.waitForFunction(() => {
  const bar = document.querySelector('#accountbar');
  const name = bar && bar.querySelector('.acct-name');
  return name && name.textContent.length > 0;
}, { timeout: 8000 }).then(() => true).catch(() => false);
assert('用同一账号重新登录成功', reLogin, shownName);

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/auth_smoke.png' });

console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);
console.log('REAL ERRORS:', allErrors.length ? allErrors.join('\n') : 'none');
await browser.close();
process.exit(failed === 0 && allErrors.length === 0 ? 0 : 1);
