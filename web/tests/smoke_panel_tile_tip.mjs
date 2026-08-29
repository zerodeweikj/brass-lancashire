// 个人面板产业板块悬停提示回归测试（superpowers 方法论：先复现/验证不回归）。
// 覆盖用户关切：
//  ① 悬停板块 → 光标旁显示该板块剩余数量；
//  ② 面板缩放（#pzoomctl ＋/－）后，悬停提示是否仍然有效；
//  ③ 提示是否偏离别处、是否始终待在鼠标光标旁（fixed + clientX/clientY）；
//  ④ 显示数量是否与服务端 p.mat 一致；
//  ⑤ 缩放后悬停在 A 板块，是否错显成 B 板块的数量（按元素自身 data 绑定，缩放无关）。
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
const allErrors = [];
const IGNORE_404 = ['card_back', '/markers/', 'player_board', 'remote_market', 'tiles/'];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('response', (r) => {
  if (r.status() === 404 && !IGNORE_404.some((s) => r.url().includes(s))) allErrors.push('404: ' + r.url());
});

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);

const SLOT2MAT = { cotton: 'cotton', port: 'port', shipyard: 'shipyard', ironworks: 'iron', colliery: 'coal' };
const INDUSTRY_CN = { cotton: '棉纺厂', port: '港口', shipyard: '造船厂', ironworks: '铁厂', colliery: '煤厂' };

// ---- 建房（机器人陪练房） ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('面板悬停');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();

await page.waitForFunction(() => {
  const s = window.__app?.session;
  return !!s?.room?.seats?.some((x) => x.isMe);
}, { timeout: 10000 });

const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();

let playing = false;
for (let i = 0; i < 80; i++) {
  const r = await st(() => ({ status: window.__app?.session?.room?.status, myTurn: !!window.__app?.session?.isMyTurn }));
  if (r.status === 'playing' && r.myTurn) { playing = true; break; }
  await page.waitForTimeout(300);
}
assert('满员自动开局且轮到人类', playing);

// 等待个人面板板块渲染
await page.waitForSelector('.pboard .ptile', { timeout: 8000 }).catch(() => {});

// 取服务端状态：定位「我」对应的面板与 mat
const meta = await st(() => {
  const s = window.__app.session.state;
  const order = s.turnOrder || (s.players || []).map((p) => p.id);
  const myIdx = order.indexOf(s.viewerId);
  const me = s.players.find((p) => p.id === s.viewerId);
  const panels = [...document.querySelectorAll('.ppanel')];
  const myPanel = panels[myIdx] || panels[0];
  const tiles = [...myPanel.querySelectorAll('.ptile')].map((t) => ({
    alt: t.alt, tip: t.dataset.pbTip || '',
  }));
  return {
    myColor: me?.color, myMat: me?.mat || {},
    tileCount: tiles.length, tiles,
  };
});
assert('个人面板存在产业板块', meta.tileCount > 0, `tiles=${meta.tileCount}`);
assert('每个板块都绑定了悬停提示文案', meta.tiles.length > 0 && meta.tiles.every((t) => /剩余数量 \d+/.test(t.tip)),
  JSON.stringify(meta.tiles.slice(0, 3)));

// 数量与服务端 mat 一致：遍历我方板块，比对 p.mat[key][level]
let countMatch = true; let mismatch = '';
for (const t of meta.tiles) {
  const [prefix, lv] = t.alt.split('_');
  const key = SLOT2MAT[prefix]; const level = Number(lv);
  const expect = (key && meta.myMat[key]?.[level]) || 0;
  const m = /剩余数量 (\d+)/.exec(t.tip);
  const shown = m ? Number(m[1]) : -1;
  if (shown !== expect) { countMatch = false; mismatch = `${t.alt}: tip=${shown} mat=${expect}`; break; }
}
assert('悬停数量与服务端 p.mat 一致', countMatch, mismatch);

// ---- ② ③ ④：悬停第 0 个板块，提示出现且在光标旁 ----
const box0 = await st(() => {
  const panels = [...document.querySelectorAll('.ppanel')];
  const s = window.__app.session.state;
  const myIdx = (s.turnOrder || []).indexOf(s.viewerId);
  const myPanel = panels[myIdx] || panels[0];
  const t = myPanel.querySelectorAll('.ptile')[0];
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, tip: t.dataset.pbTip };
});
await page.mouse.move(box0.x, box0.y);
await page.waitForTimeout(80);
const hover0 = await st(() => {
  const tip = document.getElementById('ptip');
  const r = tip.getBoundingClientRect();
  return { vis: tip.style.display === 'block', text: tip.textContent, left: r.left, top: r.top };
});
assert('悬停板块 → 提示显示', hover0.vis, hover0.text);
assert('提示文案 = 该板块绑定文案', hover0.text === box0.tip, `tip="${hover0.text}" expect="${box0.tip}"`);
assert('提示待在光标旁（不偏离）', Math.abs(hover0.left - (box0.x + 14)) <= 8 && Math.abs(hover0.top - (box0.y + 14)) <= 8,
  `ptip=(${hover0.left.toFixed(0)},${hover0.top.toFixed(0)}) cursor=(${box0.x.toFixed(0)},${box0.y.toFixed(0)})`);

// ② 面板缩放（放大两次）后再悬停，验证仍有效、仍跟光标、A 不串 B
const before = await st(() => {
  const panels = [...document.querySelectorAll('.ppanel')];
  const s = window.__app.session.state;
  const myIdx = (s.turnOrder || []).indexOf(s.viewerId);
  const myPanel = panels[myIdx] || panels[0];
  return [...myPanel.querySelectorAll('.ptile')].map((t) => t.dataset.pbTip);
});
await page.locator('#pzoomctl button.zoombtn').first().click(); // ＋
await page.locator('#pzoomctl button.zoombtn').first().click(); // ＋
await page.waitForTimeout(150);
const after = await st(() => {
  const panels = [...document.querySelectorAll('.ppanel')];
  const s = window.__app.session.state;
  const myIdx = (s.turnOrder || []).indexOf(s.viewerId);
  const myPanel = panels[myIdx] || panels[0];
  return [...myPanel.querySelectorAll('.ptile')].map((t) => t.dataset.pbTip);
});
// 缩放不改变各板块的绑定文案（数量固定，A 仍是 A）
assert('缩放后各板块绑定文案不变（A≠B 不串）', JSON.stringify(before) === JSON.stringify(after),
  `before=${before.length} after=${after.length}`);

// 缩放后悬停「第 0 块」，再次验证提示出现、跟光标、文案 == 该块
const box0z = await st(() => {
  const panels = [...document.querySelectorAll('.ppanel')];
  const s = window.__app.session.state;
  const myIdx = (s.turnOrder || []).indexOf(s.viewerId);
  const myPanel = panels[myIdx] || panels[0];
  const t = myPanel.querySelectorAll('.ptile')[0];
  const r = t.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, tip: t.dataset.pbTip };
});
await page.mouse.move(box0z.x, box0z.y);
await page.waitForTimeout(80);
const hover0z = await st(() => {
  const tip = document.getElementById('ptip');
  const r = tip.getBoundingClientRect();
  return { vis: tip.style.display === 'block', text: tip.textContent, left: r.left, top: r.top };
});
assert('缩放后悬停 → 提示仍显示', hover0z.vis, hover0z.text);
assert('缩放后提示文案 = 该板块（未错显成其他板块）', hover0z.text === box0z.tip,
  `tip="${hover0z.text}" expect="${box0z.tip}"`);
assert('缩放后提示仍待在光标旁', Math.abs(hover0z.left - (box0z.x + 14)) <= 8 && Math.abs(hover0z.top - (box0z.y + 14)) <= 8,
  `ptip=(${hover0z.left.toFixed(0)},${hover0z.top.toFixed(0)}) cursor=(${box0z.x.toFixed(0)},${box0z.y.toFixed(0)})`);

// ⑥ 边界翻转：光标靠近视口右/下边缘时，提示应自动翻转到光标左/上方，避免被截断
const boundary = await st(() => {
  const tile = document.querySelector('.ppanel .ptile');
  const tipEl = document.getElementById('ptip');
  const vw = window.innerWidth, vh = window.innerHeight;
  // 模拟光标贴到右下角
  tile.dispatchEvent(new MouseEvent('mousemove', {
    clientX: vw - 5, clientY: vh - 5, bubbles: true, cancelable: true,
  }));
  const r = tipEl.getBoundingClientRect();
  return {
    rightOk: r.right <= vw + 1,
    bottomOk: r.bottom <= vh + 1,
    flippedLeft: r.left < vw - 5,
    flippedTop: r.top < vh - 5,
  };
});
assert('边缘悬停提示不超出视口右侧', boundary.rightOk, `right=${boundary.rightOk}`);
assert('边缘悬停提示不超出视口底部', boundary.bottomOk, `bottom=${boundary.bottomOk}`);
assert('靠右边缘时提示翻转到光标左侧', boundary.flippedLeft, `flippedLeft=${boundary.flippedLeft}`);
assert('靠下边缘时提示翻转到光标上方', boundary.flippedTop, `flippedTop=${boundary.flippedTop}`);

// ⑤ 专项：缩放后悬停「第 0 块」与「第 1 块」，二者提示互不相同（证明按元素自身 data，不会串）
if (after.length >= 2 && before[0] !== before[1]) {
  const box1z = await st(() => {
    const panels = [...document.querySelectorAll('.ppanel')];
    const s = window.__app.session.state;
    const myIdx = (s.turnOrder || []).indexOf(s.viewerId);
    const myPanel = panels[myIdx] || panels[0];
    const t = myPanel.querySelectorAll('.ptile')[1];
    const r = t.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tip: t.dataset.pbTip };
  });
  await page.mouse.move(box1z.x, box1z.y);
  await page.waitForTimeout(80);
  const hover1z = await st(() => document.getElementById('ptip').textContent);
  assert('缩放后不同板块显示各自文案（A 不串 B）', hover1z === box1z.tip && hover1z !== box0z.tip,
    `tile1="${hover1z}" tile0="${box0z.tip}"`);
} else {
  console.log('NOTE  板块不足两块或两块文案相同，跳过 A/B 串显专项');
}

// 移开鼠标，提示应隐藏
await page.mouse.move(5, 5);
await page.waitForTimeout(80);
const hidden = await st(() => document.getElementById('ptip').style.display === 'none');
assert('移开鼠标 → 提示隐藏', hidden);

await browser.close();

const resp404 = allErrors.filter((e) => e.startsWith('404:')).map((e) => e.slice(5));
const unexpected404 = resp404.filter((u) => !IGNORE_404.some((s) => u.includes(s)));
const generic404 = allErrors.filter((e) => e.startsWith('console:') && /Failed to load resource.*404/.test(e));
const realErrors = allErrors.filter((e) => !e.startsWith('404:') && !generic404.includes(e))
  .concat(unexpected404.map((u) => '404: ' + u));
assert('无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name + (c.extra ? '  -- ' + c.extra : '')); process.exit(1); }
console.log('全部通过 ✅');
