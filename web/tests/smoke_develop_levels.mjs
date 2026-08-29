import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const allErrors = [];
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
async function poll(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await page.waitForTimeout(200); }
  return false;
}

// ---- 建房（机器人陪练房）并自动开局 ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('陪练人类');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();
await page.waitForFunction(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), { timeout: 10000 });
await page.getByRole('button', { name: /准备|取消准备/ }).first().click();
let playing = false;
for (let i = 0; i < 80; i++) {
  const r = await st(() => { const s = window.__app?.session; return { status: s?.room?.status, myTurn: !!s?.isMyTurn }; });
  if (r.status === 'playing' && r.myTurn) { playing = true; break; }
  await page.waitForTimeout(300);
}
assert('满员自动开局且轮到人类', playing);

// ---- 打开发展向导条 ----
await poll(() => st(() => { const b = [...document.querySelectorAll('#topbar button')].find((x) => x.textContent.trim() === '发展'); return b && !b.disabled; }), 8000);
await page.getByRole('button', { name: '发展', exact: true }).click();
await page.waitForTimeout(200);
const modalOpen = await poll(() => st(() => !!document.querySelector('#actionstrip .as-body .as-opt')), 5000);
assert('发展向导条打开', modalOpen);

// 铁厂选项应出现（每级只有 1 个，最低 1 级）
const ironOptText = await st(() => {
  const opt = [...document.querySelectorAll('#actionstrip .as-body .as-opt')].find((o) => o.textContent.includes('铁厂'));
  return opt ? opt.textContent : null;
});
assert('铁厂选项出现且标注最低 1 级', !!ironOptText && /最低 1 级/.test(ironOptText), ironOptText);

// 点击铁厂选项两次（模拟“丢 2 个铁厂”）
async function clickIron() {
  await page.evaluate(() => {
    const opt = [...document.querySelectorAll('#actionstrip .as-body .as-opt')].find((o) => o.textContent.includes('铁厂'));
    if (opt) opt.click();
  });
  await page.waitForTimeout(180);
}
await clickIron();
await clickIron();

const bill = await st(() => document.querySelector('#actionstrip .as-bill')?.textContent || '');
// 关键断言：真实等级是 L1、L2，绝不会显示两个 1 级铁厂
assert('选 2 铁厂显示真实等级「1级铁厂、2级铁厂」', /1级铁厂、2级铁厂/.test(bill), bill);
assert('绝不误导为「2×1级铁厂」', !/1级铁厂、1级铁厂/.test(bill) && !/1级、1级铁厂/.test(bill), bill);

// 上限保护：再点一次不应变 3（maxN=2）
await clickIron();
const bill3 = await st(() => document.querySelector('#actionstrip .as-bill')?.textContent || '');
assert('发展上限为 2 个板块（不会变 3）', /需要 2 铁/.test(bill3) && !/需要 3 铁/.test(bill3), bill3);

// ---- 端到端：真提交，校验引擎实际丢的是 L1+L2，铁厂每级仍 ≤1 ----
const beforeMat = await st(() => {
  const s = window.__app?.session; const me = (s?.state?.players || []).find((p) => p.id === s?.state?.viewerId);
  return JSON.parse(JSON.stringify(me.mat));
});
// 所有向导条按钮统一用 evaluate 直点：卡片悬浮放大遮罩 #cardzoom 会拦截真实鼠标事件
const clickBtn = (label) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('#actionstrip .as-foot .as-btn')].find((x) => x.textContent.trim() === t);
  if (b && !b.disabled) { b.click(); return true; }
  return false;
}, label);

// 下一步 -> 选牌 -> 确认
assert('发展向导「下一步」可点', await clickBtn('下一步'));
await page.waitForTimeout(200);
// pickCards：左侧手牌区点亮可选牌，点 1 张即达 count
await poll(() => st(() => !!document.querySelector('#handcards .hcard.pickable')), 5000);
await page.evaluate(() => { const c = document.querySelector('#handcards .hcard.pickable'); if (c) c.click(); });
await page.waitForTimeout(200);
assert('选牌后「下一步」可点', await clickBtn('下一步'));
await page.waitForTimeout(250);

// 确认步骤：confirm() 的按钮文案是默认的「确认执行」，标题才是「确认发展」
const cfmReady = await poll(() => st(() => {
  const t = document.querySelector('#actionstrip .as-title')?.textContent || '';
  const b = [...document.querySelectorAll('#actionstrip .as-foot .as-btn')].find((x) => x.textContent.trim() === '确认执行');
  return t.includes('确认发展') && !!b;
}), 5000);
const cfmLines = await st(() => document.querySelector('#actionstrip .as-bill')?.textContent || '');
assert('确认出现且标题为「确认发展」', cfmReady, cfmLines);
assert('确认如实列出真实等级「1级铁厂、2级铁厂」', /1级铁厂、2级铁厂/.test(cfmLines), cfmLines);
assert('点击「确认执行」提交', await clickBtn('确认执行'));
await page.waitForTimeout(600);
await poll(() => st(() => {
  const r = document.querySelector('#actionstrip');
  return !r || window.getComputedStyle(r).display === 'none';
}), 6000);
await page.waitForTimeout(300);
const afterMat = await st(() => {
  const s = window.__app?.session; const me = (s?.state?.players || []).find((p) => p.id === s?.state?.viewerId);
  return JSON.parse(JSON.stringify(me.mat));
});
const ironVals = Object.values(afterMat.iron || {});
const maxPerLevel = Math.max(...ironVals, 0);
assert('引擎实际丢弃铁厂 L1 与 L2 各 1（非 2×L1）',
  afterMat.iron[1] === beforeMat.iron[1] - 1 && afterMat.iron[2] === beforeMat.iron[2] - 1,
  `before=${JSON.stringify(beforeMat.iron)} after=${JSON.stringify(afterMat.iron)}`);
assert('铁厂每个等级数量始终 ≤1（per_player 约束）', maxPerLevel <= 1, `iron=${JSON.stringify(afterMat.iron)}`);

const pass = checks.filter((c) => c.ok).length;
console.log(`\n==== develop-level 测试 ${pass}/${checks.length} 通过 ====`);
const fatal = allErrors.filter((e) => !/card_back|markers|player_board|remote_market|tiles\//.test(e));
if (fatal.length) console.log('ERRORS:', fatal.slice(0, 8));
await browser.close();
process.exit(pass === checks.length ? 0 : 1);
