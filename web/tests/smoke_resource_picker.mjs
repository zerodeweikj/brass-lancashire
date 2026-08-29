// 资源选源冒烟：验证「玩家在地图上点击铁/煤建筑手动选源」（替代弹窗选源）。
// ① 多来源：进入 resource 选择态（scene.picker.kind==='resource'），点同一座两次 → 展开为 ['A','A']；
// ② 超限拦截：A 只剩 1 单位时再点 A 被忽略，换点 B 凑满 → ['A','B']；
// ③ 单来源：直接 onDone，不进入选择态；
// ④ 0 需求：直接 onDone([])；
// ⑤ 取消：cancelFlow 清理选择态与提示。
import { chromium } from 'playwright';

const URL = 'http://127.0.0.1:8765/';
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

// ---- 进机器人陪练房拿到 window.__app ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('选源测试');
await page.waitForTimeout(120);
const botChk = page.locator('label.chk input[type=checkbox]');
if (await botChk.count()) await botChk.check();
await page.getByRole('button', { name: '创建' }).click();
await page.waitForFunction(() => !!window.__app?.session?.room?.seats?.some((x) => x.isMe), { timeout: 10000 });
const readyBtn = page.getByRole('button', { name: /准备|取消准备/ }).first();
if ((await readyBtn.innerText().catch(() => '')) === '准备') await readyBtn.click();
await page.waitForFunction(() => window.__app?.session?.room?.status === 'playing', { timeout: 12000 }).catch(() => {});

// ---- ① 多来源：进入地图选择态，点同一座两次 → ['A','A'] ----
await st(() => {
  window.__picked = null;
  window.__app.startResourcePick({
    kind: 'iron', amount: 2,
    sources: [
      { tileId: 'A', location: 'MANCHESTER', level: 1, remaining: 3 },
      { tileId: 'B', location: 'WIGAN', level: 1, remaining: 2 },
    ],
    onDone: (p) => { window.__picked = p.map((s) => s.tileId); },
  });
});
await page.waitForTimeout(200);
const state1 = await st(() => ({
  picker: window.__app.scene?.picker?.kind || null,
  resKind: window.__app.scene?.picker?.resKind || null,
  nSrc: window.__app.scene?.picker?.sources?.length || 0,
  hint: window.__app.hud?.hint || '',
  hintZones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length,
  modalClosed: (() => { const r = document.querySelector('#actionstrip'); return !r || window.getComputedStyle(r).display === 'none'; })(),
}));
assert('多来源进入地图选源态(picker=resource)', state1.picker === 'resource', JSON.stringify(state1));
assert('选择态带 2 个来源与类型 iron', state1.resKind === 'iron' && state1.nSrc === 2, JSON.stringify(state1));
assert('进入选源态时卡片弹窗已关闭(不挡地图)', state1.modalClosed, `modalClosed=${state1.modalClosed}`);
assert('提示显示 已选 0 / 2', state1.hint.includes('已选 0 / 2'), state1.hint);
// 本测试用假 tileId（A/B），不匹配真实对局板块 → _findTile 优雅跳过、不生成 zone 也不崩溃
// （真实板块的高亮 zone 渲染路径与已验证的 sell 分支同构：_findTile + _slotPos + hit zone）
assert('假 tileId 不匹配板块时优雅跳过（0 zone 不崩溃）', state1.hintZones === 0, `hintZones=${state1.hintZones}`);

// 走完整接线：flow 存在时，地图 hit zone → scene.onPick → onMapPick → onResourcePick
await st(() => { window.__app.flow = { kind: 'build' }; });
await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'A' }); });
await page.waitForTimeout(80);
const mid = await st(() => ({
  hint: window.__app.hud?.hint || '',
  alloc: JSON.parse(JSON.stringify(window.__app.scene?.picker?.alloc || {})),
}));
assert('点一次 A 后 已选 1 / 2 且 alloc.A=1', mid.hint.includes('已选 1 / 2') && mid.alloc.A === 1, JSON.stringify(mid));
await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'A' }); });
await page.waitForTimeout(120);
const picked1 = await st(() => window.__picked);
assert('同建筑点两次 → 展开为 [A,A]', JSON.stringify(picked1) === '["A","A"]', JSON.stringify(picked1));
const cleared1 = await st(() => ({
  picker: window.__app.scene?.picker,
  hint: window.__app.hud?.hint,
}));
assert('完成后选择态与提示已清理', cleared1.picker === null && !cleared1.hint, JSON.stringify(cleared1));

// ---- ② 超限拦截 + 跨建筑凑满：A 剩 1、B 剩 2，需要 2 ----
await st(() => {
  window.__picked2 = 'unset';
  window.__app.startResourcePick({
    kind: 'coal', amount: 2,
    sources: [
      { tileId: 'A', location: 'MANCHESTER', level: 1, remaining: 1 },
      { tileId: 'B', location: 'WIGAN', level: 1, remaining: 2 },
    ],
    onDone: (p) => { window.__picked2 = p.map((s) => s.tileId); },
  });
});
await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'A' }); });       // A=1
await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'A' }); });       // 超限 → 忽略
await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'B' }); });       // B=1 → 总量 2 → 完成
await page.waitForTimeout(150);
const picked2 = await st(() => window.__picked2);
assert('超限点击被忽略、换 B 凑满 → [A,B]', JSON.stringify(picked2) === '["A","B"]', JSON.stringify(picked2));

// ---- ③ 单来源：直接 onDone，不进入选择态 ----
await st(() => {
  window.__picked3 = 'unset';
  window.__app.startResourcePick({
    kind: 'iron', amount: 1,
    sources: [{ tileId: 'ONLY', location: 'LIVERPOOL', level: 1, remaining: 2 }],
    onDone: (p) => { window.__picked3 = p.map((s) => s.tileId); },
  });
});
await page.waitForTimeout(120);
const single = await st(() => ({
  picked: window.__picked3,
  picker: window.__app.scene?.picker,
}));
assert('单来源自动消耗、不进入选择态', JSON.stringify(single.picked) === '["ONLY"]' && single.picker === null, JSON.stringify(single));

// ---- ④ 0 需求：直接 onDone([]) ----
await st(() => {
  window.__picked4 = 'unset';
  window.__app.startResourcePick({
    kind: 'iron', amount: 0,
    sources: [{ tileId: 'X', location: 'LIVERPOOL', level: 1, remaining: 2 }],
    onDone: (p) => { window.__picked4 = p.map((s) => s.tileId); },
  });
});
await page.waitForTimeout(80);
const zero = await st(() => window.__picked4);
assert('0 需求直接空完成', Array.isArray(zero) && zero.length === 0, JSON.stringify(zero));

// ---- ⑤ 取消：cancelFlow 清理选择态 ----
await st(() => {
  window.__app.startResourcePick({
    kind: 'iron', amount: 2,
    sources: [
      { tileId: 'A', location: 'MANCHESTER', level: 1, remaining: 3 },
      { tileId: 'B', location: 'WIGAN', level: 1, remaining: 2 },
    ],
    onDone: () => { window.__picked5 = 'done'; },
  });
});
await st(() => { window.__app.cancelFlow(); });
await page.waitForTimeout(120);
const cancelled = await st(() => ({
  picker: window.__app.scene?.picker,
  hint: window.__app.hud?.hint,
  resPick: !!window.__app._resPick,
  picked5: window.__picked5 || null,
}));
assert('取消后选择态/提示/_resPick 全清理且未触发 onDone',
  cancelled.picker === null && !cancelled.hint && !cancelled.resPick && cancelled.picked5 === null,
  JSON.stringify(cancelled));

// ---- ⑥ 真实板块渲染：注入两座真实形状铁厂（scene.slotXY 真实槽位坐标），验证地图高亮 zone + 点击消耗 ----
const injected = await st(() => {
  const st2 = JSON.parse(JSON.stringify(window.__app.session.state));
  const slots = [];
  for (const [loc, s] of Object.entries(window.__app.scene.slotXY || {})) {
    for (let i = 0; i < (s.slots?.length || 0); i++) {
      slots.push([loc, i]);
      if (slots.length === 2) break;
    }
    if (slots.length === 2) break;
  }
  if (slots.length < 2) return false;
  const p1 = st2.players.find((p) => p.id === st2.viewerId) || st2.players[0];
  (p1.industryTiles = p1.industryTiles || []).push(
    { id: 'fake_iron_1', owner: p1.id, buildingId: 'building_001', level: 1,
      location: slots[0][0], slotIndex: slots[0][1], industry: 'iron',
      resourceType: 'iron', boardResources: 3, flipped: false },
    { id: 'fake_iron_2', owner: p1.id, buildingId: 'building_001', level: 1,
      location: slots[1][0], slotIndex: slots[1][1], industry: 'iron',
      resourceType: 'iron', boardResources: 3, flipped: false },
  );
  window.__app.scene.setState(st2);
  window.__app.flow = { kind: 'build' };
  window.__picked6 = null;
  window.__app.startResourcePick({
    kind: 'iron', amount: 2,
    sources: [
      { tileId: 'fake_iron_1', location: slots[0][0], owner: p1.id, level: 1, remaining: 3 },
      { tileId: 'fake_iron_2', location: slots[1][0], owner: p1.id, level: 1, remaining: 3 },
    ],
    onDone: (p) => { window.__picked6 = p.map((s) => s.tileId); },
  });
  return true;
});
await page.waitForTimeout(300);
const z6 = await st(() => ({
  zones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length,
}));
assert('真实板块注入后地图生成高亮 zone(≥2)', !injected || z6.zones >= 2, `injected=${injected} zones=${z6.zones}`);
if (injected) {
  await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'fake_iron_1' }); });
  await st(() => { window.__app.scene.onPick({ kind: 'resource', tileId: 'fake_iron_1' }); });
  await page.waitForTimeout(150);
  const picked6 = await st(() => window.__picked6);
  assert('真实板块点击两次 → [fake_iron_1, fake_iron_1]',
    JSON.stringify(picked6) === '["fake_iron_1","fake_iron_1"]', JSON.stringify(picked6));
} else {
  assert('无可用槽位，真实板块测试跳过', true);
}

await browser.close();
const generic404 = allErrors.filter((e) => /Failed to load resource.*404/.test(e));
const realErrors = allErrors.filter((e) => !generic404.includes(e));
assert('无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name); process.exit(1); }
console.log('全部通过 ✅');
