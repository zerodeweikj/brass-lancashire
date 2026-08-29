// 复现/验证：玩家面板产业板块在执行发展（重渲染）后是否偏移
// 走 Lobby UI 建房（机器人陪练房），强制重渲染 + 等机器人发展，比较 tile 相对 board 的归一化位置。
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERR ' + e.message));

await page.goto(BASE + '/', { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('偏移测试');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();

await page.waitForFunction(() => window.__app?.session?.room?.seats?.some(x => x.isMe), { timeout: 10000 });
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();
await page.waitForFunction(() => window.__app?.session?.room?.status === 'playing', { timeout: 15000 });
await page.waitForFunction(() => window.__app?.hud?.nodes?.ppanels?.children?.length > 0, { timeout: 15000 });
await page.waitForTimeout(800);

async function snapshot() {
  return await page.evaluate(() => {
    const hud = window.__app.hud;
    const panels = [...hud.nodes.ppanels.children];
    const out = [];
    for (const panel of panels) {
      const board = panel.querySelector('.pboard');
      const tiles = [...panel.querySelectorAll('.ptile')];
      const br = board.getBoundingClientRect();
      out.push({
        name: panel.querySelector('.nm')?.textContent || '?',
        tiles: tiles.map(t => {
          const r = t.getBoundingClientRect();
          return { fracL: (r.left - br.left) / br.width, fracT: (r.top - br.top) / br.height };
        }),
        boardW: br.width,
      });
    }
    return out;
  });
}

const before = await snapshot();
console.log('\n=== 初始快照（归一化位置 fracL,fracT）===');
before.forEach(p => console.log(`${p.name}: boardW=${p.boardW.toFixed(1)} tiles=${p.tiles.length} [${p.tiles.map(t=>`${t.fracL.toFixed(3)},${t.fracT.toFixed(3)}`).join(' ')}]`));

// 2) 强制重渲染（模拟状态更新触发的 _renderPlayers）
await page.evaluate(() => window.__app.hud._renderPlayers());
await page.waitForTimeout(300);
const afterRerender = await snapshot();
console.log('\n=== 强制重渲染后 ===');
afterRerender.forEach(p => console.log(`${p.name}: boardW=${p.boardW.toFixed(1)} tiles=${p.tiles.length} [${p.tiles.map(t=>`${t.fracL.toFixed(3)},${t.fracT.toFixed(3)}`).join(' ')}]`));

function maxShift(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const ta = a[i].tiles, tb = b[i].tiles;
    for (let j = 0; j < Math.min(ta.length, tb.length); j++) {
      const d = Math.hypot(ta[j].fracL - tb[j].fracL, ta[j].fracT - tb[j].fracT);
      if (d > m) m = d;
    }
  }
  return m;
}
const s1 = maxShift(before, afterRerender);
console.log(`\n[重渲染前后] 最大归一化偏移 = ${s1.toFixed(5)}  (0=无偏移)`);

// 3) 等待机器人行动（发展/建造等），再对比初始
console.log('\n等待机器人行动（最多 25s）...');
await page.waitForTimeout(25000);
const afterBot = await snapshot();
console.log('\n=== 机器人行动后 ===');
afterBot.forEach(p => console.log(`${p.name}: boardW=${p.boardW.toFixed(1)} tiles=${p.tiles.length} [${p.tiles.map(t=>`${t.fracL.toFixed(3)},${t.fracT.toFixed(3)}`).join(' ')}]`));
const s2 = maxShift(before, afterBot);
console.log(`\n[初始→机器人行动后] 最大归一化偏移 = ${s2.toFixed(5)}`);
console.log(`\nconsole errors: ${errors.length ? errors.slice(0,5).join(' || ') : 'none'}`);

await browser.close();
