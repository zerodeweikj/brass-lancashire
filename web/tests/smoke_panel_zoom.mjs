// 验证：玩家面板列 +/- 缩放按钮（真实鼠标点击）
//  1) 点击 ＋ 面板列放大、点击 － 缩小，且缩放因子 clamp 在 [1,3]
//  2) 板块内 tile 缩放后相对位置不变（不错位）
//  3) 其它独立 UI（顶栏/手牌/地图缩放钮/地图滚动条/右侧栏/日志）位置纹丝不动（不移位、不消失）
//  4) 放大后 #ppanels 出现滚动（内容可达，不会被裁掉看不见）
import { chromium } from 'playwright';

const BASE = process.argv[2] || 'http://127.0.0.1:8765';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERR ' + e.message));

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};

const st = (fn, arg) => page.evaluate(fn, arg);
const sleep = (ms) => page.waitForTimeout(ms);
async function poll(fn, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await fn()) return true; await sleep(150); }
  return false;
}

// ---- 建房（机器人陪练房） ----
await page.goto(BASE + '/', { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('缩放测试');
await sleep(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();
await page.waitForFunction(() => window.__app?.session?.room?.seats?.some((x) => x.isMe), { timeout: 10000 });
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();
await poll(async () => {
  const r = await st(() => ({ status: window.__app?.session?.room?.status, myTurn: !!window.__app?.isMyTurn }));
  return r.status === 'playing' && r.myTurn;
});
await poll(() => st(() => !!document.querySelector('#ppanels .pboard')), 10000);
await sleep(700);

// 按钮定位器
const plusBtn = page.locator('#pzoomctl button[title="放大玩家面板"]');
const minusBtn = page.locator('#pzoomctl button[title="缩小玩家面板"]');
assert('面板缩放 + 按钮存在', await plusBtn.count() === 1);
assert('面板缩放 - 按钮存在', await minusBtn.count() === 1);

// 抓取「独立 UI 元素」位置快照（用于验证不移位/不消失）
const FIXED = ['#topbar', '#handpanel', '#zoomctl', '#mapscroll-y', '#mapscroll-x', '#rightcol', '#plog', '#pzoomctl'];
async function fixedSnapshot() {
  return await st((sels) => {
    const out = {};
    for (const s of sels) {
      const el = document.querySelector(s);
      if (!el) { out[s] = null; continue; }
      const r = el.getBoundingClientRect();
      out[s] = { left: +r.left.toFixed(1), top: +r.top.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    }
    return out;
  }, FIXED);
}
// 抓取首块面板 board 与 tile 归一化位置
async function boardSnapshot() {
  return await st(() => {
    const board = document.querySelector('#ppanels .pboard');
    const br = board.getBoundingClientRect();
    const tiles = [...board.querySelectorAll('.ptile')].map((t) => {
      const r = t.getBoundingClientRect();
      return { fracL: (r.left - br.left) / br.width, fracT: (r.top - br.top) / br.height };
    });
    const pp = document.querySelector('#ppanels');
    return {
      boardW: +br.width.toFixed(1),
      pzoomVar: pp.style.getPropertyValue('--pzoom'),
      pzoomLabel: document.querySelector('#pzoomctl .pzval')?.textContent,
      scrollW: pp.scrollWidth, scrollH: pp.scrollHeight, clientW: pp.clientWidth, clientH: pp.clientHeight,
      tiles,
    };
  });
}

const fixedBefore = await fixedSnapshot();
const boardBefore = await boardSnapshot();
console.log(`\n[基线] boardW=${boardBefore.boardW} pzoom=${boardBefore.pzoomVar} label=${boardBefore.pzoomLabel} scroll=${boardBefore.scrollW}x${boardBefore.scrollH}`);

// ---- 点击 ＋ 一次 ----
await plusBtn.click();
await sleep(250);
const boardAfterPlus = await boardSnapshot();
const grew = boardAfterPlus.boardW > boardBefore.boardW * 1.05;
assert('点击 ＋ 后面板列放大（board 变宽）', grew, `before=${boardBefore.boardW} after=${boardAfterPlus.boardW}`);
assert('缩放因子变为 ~1.15', Math.abs(parseFloat(boardAfterPlus.pzoomVar) - 1.15) < 0.02, `var=${boardAfterPlus.pzoomVar}`);
assert('缩放标签显示 ×1.1/×1.2', /×1\.[12]/.test(boardAfterPlus.pzoomLabel || ''), `label=${boardAfterPlus.pzoomLabel}`);

// tile 缩放后不错位
function maxShift(a, b) {
  let m = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const d = Math.hypot(a[i].fracL - b[i].fracL, a[i].fracT - b[i].fracT);
    if (d > m) m = d;
  }
  return m;
}
const shiftPlus = maxShift(boardBefore.tiles, boardAfterPlus.tiles);
assert('放大后 tile 相对位置不变（不错位）', shiftPlus < 0.01, `maxShift=${shiftPlus.toFixed(5)}`);

// 放大后内容超出列宽 → 出现滚动（可达，不被裁掉）
const scrollable = boardAfterPlus.scrollW > boardAfterPlus.clientW + 1 || boardAfterPlus.scrollH > boardAfterPlus.clientH + 1;
assert('放大后出现滚动（内容可达）', scrollable, `scroll=${boardAfterPlus.scrollW}x${boardAfterPlus.scrollH} client=${boardAfterPlus.clientW}x${boardAfterPlus.clientH}`);

// ---- 连续点击 ＋ 到上限 ----
for (let i = 0; i < 12; i++) { await plusBtn.click(); await sleep(60); }
await sleep(200);
const boardMax = await boardSnapshot();
assert('缩放到上限后 clamp 在 ×3.0', Math.abs(parseFloat(boardMax.pzoomVar) - 3) < 0.02 && /×3\.0/.test(boardMax.pzoomLabel || ''), `var=${boardMax.pzoomVar} label=${boardMax.pzoomLabel}`);
const boardMax2 = await boardSnapshot();
assert('已达上限再点 ＋ 不再放大', parseFloat(boardMax2.pzoomVar) === parseFloat(boardMax.pzoomVar));

// ---- 点击 － 回到 1 ----
for (let i = 0; i < 20; i++) { await minusBtn.click(); await sleep(40); }
await sleep(200);
const boardBack = await boardSnapshot();
assert('点击 － 缩回 ×1.0', Math.abs(parseFloat(boardBack.pzoomVar) - 1) < 0.02 && /×1\.0/.test(boardBack.pzoomLabel || ''), `var=${boardBack.pzoomVar} label=${boardBack.pzoomLabel}`);
assert('缩回后 board 宽度恢复基线', Math.abs(boardBack.boardW - boardBefore.boardW) < 2, `before=${boardBefore.boardW} after=${boardBack.boardW}`);

// ---- 关键：独立 UI 元素位置不因缩放改变 ----
const fixedAfter = await fixedSnapshot();
let movedAny = false;
const movedDetail = [];
for (const s of FIXED) {
  const a = fixedBefore[s], b = fixedAfter[s];
  if (!a || !b) { assert(`独立元素 ${s} 仍存在`, false); movedAny = true; continue; }
  const dx = Math.abs(a.left - b.left), dy = Math.abs(a.top - b.top);
  const dsize = Math.abs(a.w - b.w) + Math.abs(a.h - b.h);
  const moved = dx > 1 || dy > 1 || dsize > 1;
  if (moved) { movedAny = true; movedDetail.push(`${s}(dx=${dx.toFixed(1)},dy=${dy.toFixed(1)},dsize=${dsize.toFixed(1)})`); }
}
assert('缩放后其它 UI 元素无移位/不消失', !movedAny, movedDetail.join(' '));

await page.screenshot({ path: 'D:/zhuoyou/lancashire/web/tests/panel_zoom_smoke.png' });

console.log('\nconsole errors:', errors.length ? errors.slice(0, 5).join(' || ') : 'none');
console.log('--- SUMMARY ---');
let failed = 0;
for (const c of checks) if (!c.ok) failed++;
console.log(`CHECKS: ${checks.length}  FAIL: ${failed}`);

await browser.close();
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
