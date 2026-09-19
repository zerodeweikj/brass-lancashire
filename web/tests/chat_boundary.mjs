// 聊天框边界值 + 安全测试（真实点击）：长度边界/空输入/XSS/CSS注入/限流/Enter
// 用法：node tests/chat_boundary.mjs http://127.0.0.1:8765
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const allErrors = [];
const browser = await chromium.launch();
const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

const rnd = Math.floor(Math.random() * 90000 + 10000);
const U_A = 'Cb' + rnd, U_B = 'Cw' + rnd;
const PW = 'abc123';

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    // 忽略边界测试故意触发的 422/429 网络响应日志（非代码缺陷）
    if (m.type() === 'error' && !/Failed to load resource|422|429/.test(t)) allErrors.push('console: ' + t);
  });
  page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  return page;
}

async function register(page, U, nick) {
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('#accountbar', { timeout: 10000 });
  await page.getByRole('button', { name: '登录 / 注册' }).click();
  await page.waitForSelector('.auth-overlay', { timeout: 5000 });
  await page.getByText('注册', { exact: true }).click();
  await page.waitForTimeout(150);
  await page.getByPlaceholder('用户名（3-7 位，字母/数字/中文）').fill(U);
  await page.getByPlaceholder('密码（6-11 位）').fill(PW);
  await page.getByPlaceholder('确认密码').fill(PW);
  await page.getByPlaceholder('昵称（可选，留空同用户名）').fill(nick);
  const ans = page.locator('.acct-qblock input');
  await ans.nth(0).fill('王伟');
  await ans.nth(1).fill('李娜');
  await ans.nth(2).fill('实验一小');
  await page.getByRole('button', { name: '注册并登录' }).click();
  await page.waitForFunction(() => {
    const bar = document.querySelector('#accountbar');
    const name = bar && bar.querySelector('.acct-name');
    return name && name.textContent.length > 0;
  }, { timeout: 8000 });
}

const msgCount = (page) => page.evaluate(() =>
  document.querySelectorAll('#chatdock .cp-msg').length);
const toastShown = (page) => page.evaluate(() => {
  const t = document.querySelector('.toast, [class*="toast"]');
  return t ? t.textContent : null;
});

const A = await newPage();
const B = await newPage();

// 平台化后进站落点是 GameHub（选游戏），需先点进 brass 才能操作房间列表层
async function enterBrass(page) {
  await page.waitForSelector('.gh-card[data-game-id="brass"]', { timeout: 10000 });
  await page.locator('.gh-card[data-game-id="brass"]').click();
  await page.waitForSelector('#lobby', { timeout: 6000 });
}

// A 建普通房；B 观战（用 B 的聊天框做边界测试）
await register(A, U_A, '玩家A');
await enterBrass(A);
await A.getByPlaceholder('房间名（可留空）').fill('边界测试房' + rnd);
await A.getByRole('button', { name: '创建' }).click();
await A.waitForSelector('.seats .seat', { timeout: 8000 });
await register(B, U_B, '观众B');
await enterBrass(B);
await B.getByRole('button', { name: '刷新列表' }).click();
await B.waitForSelector('.roomrow', { timeout: 8000 });
await B.locator('.roomrow', { hasText: '边界测试房' + rnd }).getByRole('button', { name: '观战' }).click();
await B.waitForSelector('.spec-badge', { timeout: 8000 });
await B.waitForSelector('.cp-input', { timeout: 8000 });
assert('B 进入观战，聊天框就绪', true);

// ---------- 1. 边界：正好 200 字 ----------
const s200 = '汉'.repeat(200);
await B.locator('.cp-input').fill(s200);
const before200 = await msgCount(B);
await B.locator('.cp-send').click();
await B.waitForFunction((c) => document.querySelectorAll('#chatdock .cp-msg').length > c,
  before200, { timeout: 8000 });
const got200 = await B.evaluate(() => {
  const texts = document.querySelectorAll('#chatdock .cp-text');
  return texts[texts.length - 1].textContent.length;
});
assert('正好 200 字发送成功且完整显示', got200 === 200, `len=${got200}`);

// ---------- 2. maxlength：fill 250 字被输入框截断 ----------
await B.locator('.cp-input').fill('x'.repeat(250));
const capped = await B.evaluate(() => document.querySelector('.cp-input').value.length);
assert('maxlength 截断 250 → 200', capped === 200, `len=${capped}`);
await B.locator('.cp-input').fill('');   // 清空不发送，省一条限流额度

// ---------- 3. 绕过 maxlength（JS 注入 250 字）→ 后端 422 ----------
await B.evaluate(() => {
  const inp = document.querySelector('.cp-input');
  inp.value = 'y'.repeat(250);
});
const beforeBypass = await msgCount(B);
await B.locator('.cp-send').click();
await B.waitForTimeout(1200);
const afterBypass = await msgCount(B);
const toast422 = await toastShown(B);
assert('绕过前端限制发 250 字：消息未入库', afterBypass === beforeBypass);
assert('后端 422 有错误提示 toast', !!toast422, toast422 || '无提示');
console.log('     toast 内容:', toast422);

// ---------- 4. 空输入点发送 ----------
await B.locator('.cp-input').fill('');
const beforeEmpty = await msgCount(B);
await B.locator('.cp-send').click();
await B.waitForTimeout(800);
assert('空输入点发送：无消息发出', (await msgCount(B)) === beforeEmpty);
const toastEmpty = await toastShown(B);
console.log('     [UX 观察] 空输入提示:', toastEmpty || '无任何提示（静默忽略）');

// ---------- 5. 纯空格 ----------
await B.locator('.cp-input').fill('     ');
await B.locator('.cp-send').click();
await B.waitForTimeout(800);
assert('纯空格点发送：无消息发出', (await msgCount(B)) === beforeEmpty);

// ---------- 6. XSS 注入 ----------
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss2=1</script>';
await B.locator('.cp-input').fill(XSS);
await B.locator('.cp-send').click();
await B.waitForFunction(() => {
  const t = document.querySelector('#chatdock');
  return t && t.innerText.includes('<img src=x');
}, { timeout: 8000 });
const xssCheck = await B.evaluate(() => ({
  flag1: window.__xss, flag2: window.__xss2,
  imgs: document.querySelectorAll('#chatdock img').length,
  scripts: document.querySelectorAll('#chatdock script').length,
  shownAsText: document.querySelector('#chatdock').innerText.includes('<img src=x'),
}));
assert('XSS payload 未执行（无 window 污染）', xssCheck.flag1 === undefined && xssCheck.flag2 === undefined);
assert('XSS 未生成真实 img/script 元素', xssCheck.imgs === 0 && xssCheck.scripts === 0);
assert('XSS payload 以纯文本原样显示', xssCheck.shownAsText);

// ---------- 7. CSS 注入 ----------
const CSS_INJ = '</div><style>body{display:none!important}</style><div>';
await B.locator('.cp-input').fill(CSS_INJ);
await B.locator('.cp-send').click();
await B.waitForFunction(() => {
  const t = document.querySelector('#chatdock');
  return t && t.innerText.includes('<style>');
}, { timeout: 8000 });
const cssCheck = await B.evaluate(() => ({
  styles: document.querySelectorAll('#chatdock style').length,
  bodyVisible: getComputedStyle(document.body).display !== 'none',
}));
assert('CSS 注入未生成 style 元素', cssCheck.styles === 0);
assert('页面未被 CSS 注入破坏（body 可见）', cssCheck.bodyVisible);

// ---------- 8. Enter 键发送 ----------
await B.locator('.cp-input').fill('回车发送这条');
await B.locator('.cp-input').press('Enter');
await B.waitForFunction(() => {
  const t = document.querySelector('#chatdock');
  return t && t.innerText.includes('回车发送这条');
}, { timeout: 8000 }).catch(() => {});
assert('Enter 键可发送', await B.evaluate(() =>
  document.querySelector('#chatdock').innerText.includes('回车发送这条')));

// ---------- 9. 限流：10s 内快速连发，超出应 429 ----------
// 已用额度：200字×1 + XSS×1 + CSS×1 + Enter×1 = 4；再连发 8 条必触发
let rateLimited = false;
for (let i = 0; i < 8; i++) {
  await B.locator('.cp-input').fill('限流探测' + i);
  await B.locator('.cp-send').click();
  await B.waitForTimeout(250);
  const t = await toastShown(B);
  if (t && (t.includes('频繁') || t.includes('429') || t.includes('太快') || t.includes('限制'))) {
    rateLimited = true;
    console.log(`     第 ${i + 5} 条触发限流: ${t}`);
    break;
  }
}
assert('10s 内超 8 条触发限流提示', rateLimited);

// ---------- 10. A（房主）视角：消息按序全部可见、XSS 同样无害 ----------
const aView = await A.evaluate(() => ({
  total: document.querySelectorAll('#chatdock .cp-msg').length,
  xssText: document.querySelector('#chatdock').innerText.includes('<img src=x'),
  imgs: document.querySelectorAll('#chatdock img').length,
}));
assert('A 看到全部消息（含注入文本原样）', aView.total >= 7 && aView.xssText && aView.imgs === 0,
  `msgs=${aView.total}`);

await B.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/chat_boundary.png' });

console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);
console.log('REAL ERRORS:', allErrors.length ? allErrors.join('\n') : 'none');
await browser.close();
process.exit(failed === 0 && allErrors.length === 0 ? 0 : 1);
