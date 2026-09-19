// 观战 + 房间聊天 端到端冒烟（真实点击，双上下文：A=玩家，B=观众）
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
const U_A = 'Sp' + rnd, U_B = 'Wa' + rnd;      // 5-7 位唯一用户名
const PW = 'abc123';

async function newPage() {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());   // 自动接受 confirm()（退出观战等）
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

const A = await newPage();
const B = await newPage();

// 平台化后进站落点是 GameHub（选游戏），需先点进 brass 才能操作房间列表层
async function enterBrass(page) {
  await page.waitForSelector('.gh-card[data-game-id="brass"]', { timeout: 10000 });
  await page.locator('.gh-card[data-game-id="brass"]').click();
  await page.waitForSelector('#lobby', { timeout: 6000 });
}

// ---------------- A 注册并建普通房（停留在大厅阶段） ----------------
await register(A, U_A, '玩家A');
assert('A 注册登录成功', true);
await enterBrass(A);
await A.getByPlaceholder('房间名（可留空）').fill('观战测试房' + rnd);
await A.getByRole('button', { name: '创建' }).click();
await A.waitForSelector('.seats .seat', { timeout: 8000 });
assert('A 建房成功（座位视图）', true);

// ---------------- B 注册，大厅观战 A 的房（等待开局视图） ----------------
await register(B, U_B, '观众B');
assert('B 注册登录成功', true);
await enterBrass(B);
await B.getByRole('button', { name: '刷新列表' }).click();
await B.waitForSelector('.roomrow', { timeout: 8000 });
const specBtn = B.locator('.roomrow', { hasText: '观战测试房' + rnd }).getByRole('button', { name: '观战' });
assert('房间列表显示「观战」按钮', await specBtn.count() === 1);
await specBtn.click();
await B.waitForSelector('.spec-badge', { timeout: 8000 });
assert('B 进入观战等待视图（观战中标识）', true);
const noReady = await B.evaluate(() =>
  !Array.from(document.querySelectorAll('#lobby button')).some((b) => b.textContent.includes('准备')));
assert('等待视图无「准备」按钮（只读）', noReady);
const specListed = await B.evaluate(() => document.body.innerText.includes('观众（1）'));
assert('观众列表显示 B', specListed);
assert('等待视图有「退出观战」按钮',
  await B.getByRole('button', { name: '退出观战' }).count() === 1);

// ---------------- 大厅阶段聊天：B（观众）→ A（玩家） ----------------
await B.locator('.cp-input').fill('坐等开局');
await B.locator('.cp-send').click();
await A.waitForFunction(() => {
  const t = document.querySelector('#chatdock');
  return t && t.innerText.includes('坐等开局');
}, { timeout: 8000 }).catch(() => {});
const aSeesSpec = await A.evaluate(() => {
  const t = document.querySelector('#chatdock');
  return !!t && t.innerText.includes('坐等开局') && !!t.querySelector('.cp-tag');
});
assert('A 看到观众消息（带【观战】标签）', aSeesSpec);
await A.locator('.cp-input').fill('马上开');
await A.locator('.cp-send').click();
await B.waitForFunction(() => {
  const t = document.querySelector('#chatdock');
  return t && t.innerText.includes('马上开');
}, { timeout: 8000 }).then(() => true).catch(() => false);
assert('B 看到玩家回复', true);

// ---------------- B 退出观战；A 换陪练房开局 ----------------
await B.getByRole('button', { name: '退出观战' }).click();
await B.waitForSelector('.roomlist, .empty', { timeout: 8000 });
assert('B 退出观战回到大厅入口', true);

// A 是房主（建房即 ready），等待画面罩着大厅：先「取消准备」才能点到大厅按钮
await A.locator('#loadingscreen').getByRole('button', { name: '取消准备' }).click();
await A.waitForFunction(() => {
  const ls = document.querySelector('#loadingscreen');
  return ls && ls.style.display === 'none';
}, { timeout: 8000 });
await A.getByRole('button', { name: '离开房间' }).click();
await A.waitForSelector('.roomlist, .empty', { timeout: 8000 });
await A.getByPlaceholder('房间名（可留空）').fill('陪练观战房' + rnd);
await A.locator('label.chk input').check();
await A.getByRole('button', { name: '创建' }).click();
await A.waitForSelector('.seats .seat', { timeout: 8000 });
await A.getByRole('button', { name: '准备', exact: true }).click();
await A.waitForSelector('#topbar', { timeout: 10000 });
assert('A 陪练房自动开局（HUD 挂载）', true);

// ---------------- B 观战进行中的对局 ----------------
await B.getByRole('button', { name: '刷新列表' }).click();
await B.waitForSelector('.roomrow', { timeout: 8000 });
await B.locator('.roomrow', { hasText: '陪练观战房' + rnd }).getByRole('button', { name: '观战' }).click();
await B.waitForSelector('#topbar .spec-badge', { timeout: 10000 });
assert('B 进入对局观战（顶栏观战中）', true);
const handHidden = await B.evaluate(() => {
  const hp = document.querySelector('#handpanel');
  return hp && getComputedStyle(hp).display === 'none';
});
assert('观战模式隐藏手牌区', handHidden);
const noActions = await B.evaluate(() => {
  const ta = document.querySelector('.tb-actions');
  if (!ta) return false;
  const btns = ta.querySelectorAll('button');
  return btns.length === 0 && ta.innerText.includes('观战模式');
});
assert('观战模式无行动按钮（仅提示）', noActions);
const backs = await B.locator('.phand-backs .pback').count();
assert('玩家面板显示手牌牌背（≥8 张）', backs >= 8, `backs=${backs}`);

// 对局内聊天：B → A
await B.locator('.cp-input').fill('打得不错');
await B.locator('.cp-send').click();
await A.waitForFunction(() => {
  const t = document.querySelector('#chatdock');
  return t && t.innerText.includes('打得不错');
}, { timeout: 8000 }).then(() => true).catch(() => false);
assert('对局内 A 看到观众消息', true);

// B 退出观战（顶栏按钮）
await B.getByRole('button', { name: '退出观战' }).click();
await B.waitForSelector('.roomlist, .empty', { timeout: 8000 });
assert('对局中退出观战回大厅', true);

await B.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/spectate_smoke.png' });

console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);
console.log('REAL ERRORS:', allErrors.length ? allErrors.join('\n') : 'none');
await browser.close();
process.exit(failed === 0 && allErrors.length === 0 ? 0 : 1);
