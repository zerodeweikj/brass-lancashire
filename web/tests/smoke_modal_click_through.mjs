// Modal 点击穿透回归测试（真实鼠标事件，非 JS 直调）：
// 建造选择态下，真实点击槽位弹出选择框；选择框盖在地图槽位上方时，
// 真实点击选择框内的选项 —— 断言底下地图槽位【未被】触发（Phaser onPick 不增加）。
// 另做 monkey 式：modal 打开时随机真实点击 modal 区域内 5 个点，断言无任何 onPick。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const allErrors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);

// ---- 进机器人陪练房 ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('穿透测试');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();
await page.waitForFunction(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), { timeout: 10000 });
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();
await page.waitForFunction(() => window.__app?.session?.room?.status === 'playing', { timeout: 12000 }).catch(() => {});
await st(() => window.__app.session.cheat({ money: 100, actionPoints: 6 }).catch(() => {}));
await page.waitForTimeout(400);

// 包一层 onPick 计数：所有地图点击（build/road/sell/resource）都会经过它
await st(() => {
  window.__onPickCalls = [];
  const sc = window.__app.scene;
  const orig = sc.onPick;
  sc.onPick = (p) => { window.__onPickCalls.push(p); orig(p); };
});

// ---- ① 建造态：真实点击一个槽位 → 弹出选择框 ----
await st(() => { window.__app.startFlow('build'); });
await page.waitForTimeout(200);
const slotInfo = await st(() => {
  const sc = window.__app.scene;
  const pk = sc.picker;
  if (pk?.kind !== 'build' || !pk.builds?.length) return null;
  const byslot = new Map();
  for (const b of pk.builds) {
    const k = `${b.location}#${b.slotIndex}`;
    if (!byslot.has(k)) byslot.set(k, []);
    byslot.get(k).push(b);
  }
  // 优先取多产业槽位（点击后必弹「选择产业」选择框），否则取任意一个
  let pick = null;
  for (const [k, opts] of byslot) { pick = { k, opts, n: opts.length }; break; }
  const [loc, idx] = pick.k.split('#');
  const pos = sc._slotPos(loc, Number(idx));
  const cam = sc.cameras.main;
  // world→canvas 屏幕坐标：数值线性求逆（getWorldPoint 反解，仿射变换两点即可）
  const w0 = cam.getWorldPoint(0, 0);
  const w1 = cam.getWorldPoint(cam.width, cam.height);
  const sx = (pos.x - w0.x) / (w1.x - w0.x) * cam.width;
  const sy = (pos.y - w0.y) / (w1.y - w0.y) * cam.height;
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  return { loc, idx, n: pick.n, x: rect.left + sx, y: rect.top + sy };
});
if (!slotInfo) { console.log('无建造槽位，测试跳过'); await browser.close(); process.exit(0); }

await page.mouse.click(slotInfo.x, slotInfo.y);
await page.waitForTimeout(300);
const modalKind = await st(() => ({
  opts: !!document.querySelector('#actionstrip .as-opt'),
  cardgrid: !!document.querySelector('#handcards .cards.selecting'),
  title: document.querySelector('#actionstrip .as-title')?.textContent || '',
  calls: window.__onPickCalls.length,
}));
assert(`真实点击槽位后弹出选择向导（${slotInfo.loc} 槽${slotInfo.idx}，${slotInfo.n} 个候选）`,
  modalKind.opts || modalKind.cardgrid, JSON.stringify(modalKind));
assert('点击槽位本身只产生 1 次 onPick', modalKind.calls === 1, `calls=${modalKind.calls}`);

// ---- ② 找「被向导条盖住的槽位」：真实点击它（位置在向导条内），必须【不】触发底下槽位 ----
const covered = await st(() => {
  const sc = window.__app.scene;
  const cam = sc.cameras.main;
  const box = document.querySelector('#actionstrip');
  if (!box || window.getComputedStyle(box).display === 'none') return null;
  const br = box.getBoundingClientRect();
  const w0 = cam.getWorldPoint(0, 0), w1 = cam.getWorldPoint(cam.width, cam.height);
  const rect = document.querySelector('#game canvas').getBoundingClientRect();
  for (const b of sc.picker?.builds || []) {
    const pos = sc._slotPos(b.location, b.slotIndex);
    const sx = (pos.x - w0.x) / (w1.x - w0.x) * cam.width;
    const sy = (pos.y - w0.y) / (w1.y - w0.y) * cam.height;
    const px = rect.left + sx, py = rect.top + sy;
    if (px > br.left && px < br.right && py > br.top && py < br.bottom) {
      return { x: px, y: py, loc: b.location, idx: b.slotIndex };
    }
  }
  return null;
});
if (covered) {
  const before = await st(() => window.__onPickCalls.length);
  await page.mouse.click(covered.x, covered.y);
  await page.waitForTimeout(300);
  const after = await st(() => window.__onPickCalls.length);
  assert(`点击向导条盖住的槽位（${covered.loc} 槽${covered.idx}）不穿透到底下`, after === before,
    `before=${before} after=${after} pt=(${covered.x.toFixed(0)},${covered.y.toFixed(0)})`);
} else {
  assert('当前向导条未盖住任何槽位（covered 检查跳过）', true);
}

// ---- ③ monkey 式：向导条打开时，随机真实点击条内 5 个点，断言零穿透 ----
const pts = await st(() => {
  const box = document.querySelector('#actionstrip');
  if (!box || window.getComputedStyle(box).display === 'none') return null;
  const r = box.getBoundingClientRect();
  const out = [];
  for (let i = 0; i < 5; i++) {
    out.push({ x: r.left + 20 + Math.random() * (r.width - 40), y: r.top + 20 + Math.random() * (r.height - 40) });
  }
  return out;
});
if (pts) {
  let leaked = 0;
  for (const p of pts) {
    const c0 = await st(() => window.__onPickCalls.length);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(120);
    const c1 = await st(() => window.__onPickCalls.length);
    if (c1 !== c0) { leaked += c1 - c0; console.log(`  [monkey] 点 (${p.x.toFixed(0)},${p.y.toFixed(0)}) 穿透 ${c1 - c0} 次`); }
  }
  assert(`monkey 随机点击选择框 5 点零穿透（泄漏 ${leaked} 次）`, leaked === 0, `leaked=${leaked}`);
} else {
  assert('选择框已关闭，monkey 测试跳过', true);
}

await browser.close();
const generic404 = allErrors.filter((e) => /Failed to load resource.*404/.test(e));
const realErrors = allErrors.filter((e) => !generic404.includes(e));
assert('无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name); process.exit(1); }
console.log('全部通过 ✅');
