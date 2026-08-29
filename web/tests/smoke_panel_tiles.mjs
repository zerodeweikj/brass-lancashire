import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR', m.text()); });
page.on('pageerror', (e) => console.log('PAGEERR', e.message));

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

const st = (fn, arg) => page.evaluate(fn, arg);
async function poll(fn, timeoutMs = 12000) {
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
  const r = await st(() => { const s = window.__app?.session; return { status: s?.room?.status, myTurn: !!s?.isMyTurn }; });
  return r.status === 'playing' && r.myTurn;
});
await poll(() => st(() => !!document.querySelector('#ppanels .pboard')), 10000);
await page.waitForTimeout(800);

// ---- 结构断言：每个面板都有 pboard，且 board 宽度填满 .ppanel 内容区 ----
const panels = await st(() => {
  const result = [];
  for (const p of document.querySelectorAll('#ppanels .ppanel')) {
    const board = p.querySelector('.pboard');
    if (!board) { result.push(null); continue; }
    const br = board.getBoundingClientRect();
    const pr = p.getBoundingClientRect();
    // board 应贴合 .ppanel 内容区：左右不溢出（允许 2px 误差）
    const tiles = Array.from(board.querySelectorAll('.ptile')).map((t) => {
      const r = t.getBoundingClientRect();
      return {
        left: +(r.left - br.left).toFixed(1),
        top: +(r.top - br.top).toFixed(1),
        w: +r.width.toFixed(1),
        h: +r.height.toFixed(1),
      };
    });
    result.push({
      boardW: +br.width.toFixed(1), boardH: +br.height.toFixed(1),
      panelW: +pr.width.toFixed(1),
      leftGap: +(br.left - pr.left).toFixed(1),
      rightGap: +(pr.right - br.right).toFixed(1),
      tileCount: tiles.length,
      tiles,
    });
  }
  return result;
});

assert('右侧面板数 >= 1', panels.length >= 1, `count=${panels.length}`);
panels.forEach((p, i) => {
  if (!p) { assert(`面板#${i} 存在`, false, 'missing'); return; }
  assert(`面板#${i} board 宽度≈panel 内容宽`, Math.abs(p.boardW - (p.panelW - 14)) <= 4, `boardW=${p.boardW} panelW=${p.panelW}`);
  assert(`面板#${i} board 不溢出左侧`, p.leftGap >= -1 && p.leftGap <= 8, `leftGap=${p.leftGap}`);
  assert(`面板#${i} board 不溢出右侧`, p.rightGap >= -1 && p.rightGap <= 8, `rightGap=${p.rightGap}`);
  assert(`面板#${i} 有产业板块`, p.tileCount > 0, `tiles=${p.tileCount}`);
  if (p.tileCount > 0) {
    const ls = p.tiles.map((t) => t.left), ts = p.tiles.map((t) => t.top);
    const minL = Math.min(...ls), maxL = Math.max(...ls);
    const minT = Math.min(...ts), maxT = Math.max(...ts);
    const spanX = maxL - minL, spanY = maxT - minT;
    assert(`面板#${i} tile 横向铺满（跨度>${Math.round(p.boardW * 0.7)}）`, spanX > p.boardW * 0.7, `spanX=${spanX.toFixed(0)} boardW=${p.boardW}`);
    // 面板底图下方有装饰条，4 行细胞只占约 60% 高度，故纵向跨度只需 >50% 即可
    assert(`面板#${i} tile 纵向分布合理（跨度>${Math.round(p.boardH * 0.5)}）`, spanY > p.boardH * 0.5, `spanY=${spanY.toFixed(0)} boardH=${p.boardH}`);
    // 没有 tile 超出 board 边界
    const out = p.tiles.some((t) => t.left < -2 || t.top < -2 || t.left + t.w > p.boardW + 2 || t.top + t.h > p.boardH + 2);
    assert(`面板#${i} tile 不溢出 board`, !out);
  }
});

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/panel_tiles_smoke.png' });

console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);

await browser.close();
process.exit(failed === 0 ? 0 : 1);
