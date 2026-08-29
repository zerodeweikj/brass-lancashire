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
const readMoney = () => st(() => {
  const s = window.__app?.session;
  const me = (s?.state?.players || []).find((p) => p.id === s?.state?.viewerId);
  return me ? me.money : null;
});
const readAP = () => st(() => window.__app?.session?.state?.actionPoints ?? null);
const topBtns = () => st(() => Array.from(document.querySelectorAll('#topbar button')).map((b) => b.textContent.trim()));
/** 轮询直到 fn() 返回真值或超时（异步补给响应需要时间同步）。 */
async function poll(fn, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await page.waitForTimeout(200);
  }
  return false;
}

// ---- 建房（机器人陪练房） ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('陪练人类');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();

// 落座（人类是 seat1，未准备；机器人为 seat0 永远准备）
await page.waitForFunction(() => {
  const s = window.__app?.session;
  return !!s?.room?.seats?.some((x) => x.isMe);
}, { timeout: 10000 });
const roomInfo = await st(() => {
  const s = window.__app?.session;
  return { bot: s?.room?.bot, seatCount: s?.room?.seats?.length,
           isBotInSeats: s?.room?.seats?.some((x) => x.isBot) };
});
assert('机器人房：bot 标记为真', roomInfo.bot === true, JSON.stringify(roomInfo));
assert('座位数=2 且含机器人', roomInfo.seatCount === 2 && roomInfo.isBotInSeats, JSON.stringify(roomInfo));

// 点「准备」→ 满员自动开局
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();

// 机器人房满员即自动开局，等待画面通常一闪而过；此处仅做非致命记录
await page.waitForTimeout(300);
const loadingVisible = await st(() => {
  const ls = document.getElementById('loadingscreen');
  return ls && ls.querySelector('.ls-cover') !== null;
});
console.log(`NOTE  BGA 等待画面 DOM 已挂载: ${loadingVisible}`);

// 等待进入对局且轮到人类（drive_bots 已让出回合）
let playing = false;
for (let i = 0; i < 80; i++) {
  const r = await st(() => {
    const s = window.__app?.session;
    return { status: s?.room?.status, myTurn: !!s?.isMyTurn };
  });
  if (r.status === 'playing' && r.myTurn) { playing = true; break; }
  await page.waitForTimeout(300);
}
assert('满员自动开局且轮到人类', playing);

// HUD 挂载
let inGame = false;
for (let i = 0; i < 40; i++) {
  inGame = await st(() => !!document.querySelector('#topbar') && !!document.querySelector('#rightcol'));
  if (inGame) break;
  await page.waitForTimeout(200);
}
assert('进入对局 HUD', inGame);

// ---- 结构校验 ----
const struct = await st(() => {
  const ppanels = document.querySelectorAll('#ppanels .ppanel').length;
  const handCards = document.querySelectorAll('#handpanel .hcard').length;
  const rootBtns = Array.from(document.querySelectorAll('#topbar button')).map((b) => b.textContent.trim());
  const pheads = Array.from(document.querySelectorAll('#ppanels .phead .stat')).map((e) => e.textContent);
  const endTurn = Array.from(document.querySelectorAll('#topbar button')).find((b) => b.textContent.trim() === '结束回合');
  return { ppanels, handCards, rootBtns, pheads, endTurnDisabled: endTurn ? endTurn.disabled : null,
           ap: window.__app?.session?.state?.actionPoints };
});
assert('右侧玩家面板数 = 2', struct.ppanels === 2, `ppanels=${struct.ppanels}`);
assert('手牌区渲染卡牌', struct.handCards >= 1, `cards=${struct.handCards}`);
assert('根级含 建造/售卖棉花/发展/贷款/跳过',
  ['建造', '售卖棉花', '发展', '贷款', '跳过'].every((t) => struct.rootBtns.includes(t)), struct.rootBtns.join(','));
assert('撤回双按钮常驻（撤回上一步/整回合撤回）',
  struct.rootBtns.includes('撤回上一步') && struct.rootBtns.includes('整回合撤回'), struct.rootBtns.join(','));
assert('机器人房作弊按钮已隐藏（玩家不可见）',
  !struct.rootBtns.includes('＋£20') && !struct.rootBtns.includes('＋1行动点'), struct.rootBtns.join(','));
assert('面板连接库存显示「连接 14」',
  struct.pheads.some((t) => /连接\s*14/.test(t)), struct.pheads.join(' | '));
// 全局不变量：有行动点时结束回合置灰
assert('结束回合有行动点时置灰', struct.endTurnDisabled === (struct.ap > 0), `ap=${struct.ap} disabled=${struct.endTurnDisabled}`);

// ---- 建造子菜单（若本回合可建造） ----
const buildBtn = page.getByRole('button', { name: '建造', exact: true });
if (await buildBtn.isEnabled().catch(() => false)) {
  await buildBtn.click();
  await page.waitForTimeout(150);
  const sub = await topBtns();
  assert('建造子菜单：产业/连接/双牌/返回上一级',
    ['建造产业板块', '建造连接板块', '双手牌建造产业板块', '返回上一级'].every((t) => sub.includes(t)), sub.join(','));
  await page.getByRole('button', { name: '返回上一级' }).click();
  await page.waitForTimeout(120);
} else {
  console.log('NOTE 本回合建造按钮 disabled，跳过建造子菜单断言');
}

// ---- 贷款子菜单 ----
const loanBtn = page.getByRole('button', { name: '贷款', exact: true });
if (await loanBtn.isEnabled().catch(() => false)) {
  await loanBtn.click();
  await page.waitForTimeout(150);
  const sub = await topBtns();
  assert('贷款子菜单：10/20/30元 + 返回上一级',
    ['贷款 10 元', '贷款 20 元', '贷款 30 元', '返回上一级'].every((t) => sub.includes(t)), sub.join(','));
  await page.getByRole('button', { name: '返回上一级' }).click();
  await page.waitForTimeout(120);
} else {
  assert('贷款子菜单展开', false, '贷款按钮 disabled');
}

// ---- 真·执行贷款：贷款 10元 → 选牌 → 下一步 → 确认执行 ----
const beforeMoney = await readMoney();
await page.getByRole('button', { name: '贷款', exact: true }).click();
await page.getByRole('button', { name: '贷款 10 元' }).click({ timeout: 8000 });
// 选第一张可选手牌（等选择态渲染出来：左侧手牌区 .hcard.pickable）
const pick = page.locator('#handcards .hcard.pickable').first();
await pick.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
if (await pick.count()) await pick.click();
// 等「下一步」可点
await page.waitForFunction(() => {
  const b = Array.from(document.querySelectorAll('#ui button')).find((x) => x.textContent.trim() === '下一步');
  return b && !b.disabled;
}, { timeout: 8000 }).catch(() => {});
await page.getByRole('button', { name: '下一步' }).click().catch(() => {});
// 等「确认执行」出现并点击
const confirm = page.getByRole('button', { name: '确认执行' });
await confirm.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
if (await confirm.isVisible().catch(() => false)) await confirm.click();
// 轮询金钱增加（提交后状态异步同步）
const loanOk = await poll(async () => (await readMoney()) > beforeMoney);
const afterMoney = await readMoney();
assert('贷款真·执行：金钱增加', loanOk, `before=${beforeMoney} after=${afterMoney}`);

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/bga_smoke.png' });

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
