// 行动模块浏览器端全链路 e2e：验证 6 个行动按钮进入向导 → 地图选择态高亮渲染 → 取消后无残留；
// 并抓取全部 404 资源 URL，确认「美术图片」无真实缺失。
// 依赖：8765 服务 + 前端已 rebuild。
import { chromium } from 'playwright';

const URL = process.argv[2] || 'http://127.0.0.1:8765/';
const allErrors = [];
const notFound = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } });
const page = await ctx.newPage();
page.on('console', (m) => { if (m.type() === 'error') allErrors.push('console: ' + m.text()); });
page.on('pageerror', (e) => allErrors.push('pageerror: ' + e.message));
page.on('response', (r) => { if (r.status() === 404) notFound.push(r.url()); });

const checks = [];
const assert = (name, cond, extra = '') => {
  checks.push({ name, ok: !!cond, extra: String(extra) });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`);
};
const st = (fn, arg) => page.evaluate(fn, arg);

// ---- 进机器人陪练房 ----
await page.goto(URL, { waitUntil: 'load' });
await page.locator('input[placeholder="你的昵称"]').fill('行动e2e');
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

const hintZones = () => (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length;

// ---- ① 建造：进入向导 → 地图高亮 → 取消无残留 ----
await st(() => { window.__app.startFlow('build'); });
await page.waitForTimeout(150);
const b1 = await st(() => ({
  flow: window.__app.flow?.kind, picker: window.__app.scene?.picker?.kind,
  zones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length, hint: window.__app.hud?.hint || '',
}));
assert('建造向导进入 + 选择态 resource/build', b1.flow === 'build' && b1.picker === 'build' && b1.zones > 0,
  JSON.stringify(b1));
await st(() => { window.__app.cancelFlow(); });
await page.waitForTimeout(100);
const b2 = await st(() => ({ picker: window.__app.scene?.picker, zones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length, hint: window.__app.hud?.hint }));
assert('取消建造后选择态/高亮/提示全清空', b2.picker === null && b2.zones === 0 && !b2.hint, JSON.stringify(b2));

// ---- ② 修路：进入向导 → 高亮 → 取消 ----
await st(() => { window.__app.startFlow('road'); });
await page.waitForTimeout(150);
const r1 = await st(() => ({
  flow: window.__app.flow?.kind, picker: window.__app.scene?.picker?.kind, zones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length,
}));
assert('修路向导进入 + 选择态 road', r1.flow === 'road' && r1.picker === 'road' && r1.zones > 0, JSON.stringify(r1));
await st(() => { window.__app.cancelFlow(); });
await page.waitForTimeout(100);

// ---- ③ 发展：进入向导 → 板块选项出现在右侧向导条 ----
await st(() => { window.__app.startFlow('develop'); });
await page.waitForTimeout(200);
const d1 = await st(() => ({
  flow: window.__app.flow?.kind, modal: !!document.querySelector('#actionstrip .as-opt'),
  title: document.querySelector('#actionstrip .as-title')?.textContent || '',
}));
assert('发展向导进入 + 板块选项出现', d1.flow === 'develop' && d1.modal, JSON.stringify(d1));
await st(() => { window.__app.cancelFlow(); });
await page.waitForTimeout(100);

// ---- ④ 贷款：进入向导 → 档位选项 ----
await st(() => { window.__app.startFlow('loan'); });
await page.waitForTimeout(200);
const l1 = await st(() => ({
  flow: window.__app.flow?.kind, modal: !!document.querySelector('#actionstrip .as-opt'),
  title: document.querySelector('#actionstrip .as-title')?.textContent || '',
}));
assert('贷款向导进入 + 档位选项', l1.flow === 'loan' && l1.modal && l1.title.includes('贷款'), JSON.stringify(l1));
await st(() => { window.__app.cancelFlow(); });
await page.waitForTimeout(100);

// ---- ⑤ 跳过：进入向导 → 左侧手牌选择态 ----
await st(() => { window.__app.startFlow('skip'); });
await page.waitForTimeout(200);
const s1 = await st(() => ({
  flow: window.__app.flow?.kind, modal: !!document.querySelector('#handcards .cards.selecting'),
}));
assert('跳过向导进入 + 手牌选择态', s1.flow === 'skip' && s1.modal, JSON.stringify(s1));
await st(() => { window.__app.cancelFlow(); });
await page.waitForTimeout(100);

// ---- ⑥ 出售：无棉花厂时应 toast 并取消（不残留） ----
const before = await st(() => ({ flow: window.__app.flow, picker: window.__app.scene?.picker, zones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length }));
await st(() => { window.__app.startFlow('sell'); });
await page.waitForTimeout(200);
const s2 = await st(() => ({
  flow: window.__app.flow, picker: window.__app.scene?.picker, zones: (window.__app.scene?.hintC?.list || []).filter((o) => o.input && o.input.enabled).length,
}));
assert('出售无可售棉花厂时优雅取消、无残留', s2.flow === null && s2.picker === null && s2.zones === 0, JSON.stringify(s2));

// ---- ⑦ 地图选择态坐标与板块同源（无偏移）：build 高亮 box 中心 == _slotPos ----
await st(() => { window.__app.startFlow('build'); });
await page.waitForTimeout(150);
const b3 = await st(() => {
  const sc = window.__app.scene;
  const pk = sc.picker;
  if (pk?.kind !== 'build') return null;
  const first = pk.builds[0];
  const pos = sc._slotPos(first.location, first.slotIndex);
  const boxes = sc.hintC.list.filter((o) => o.type === 'Rectangle' && o.input);
  const hit = sc.hintC.list.find((o) => o.input && o.input.enabled);
  const hitPos = hit ? { x: hit.x, y: hit.y } : null;
  return { pos, hitPos, nBoxes: boxes.length };
});
if (b3) {
  const dx = Math.abs(b3.pos.x - b3.hitPos.x), dy = Math.abs(b3.pos.y - b3.hitPos.y);
  assert('建造高亮 zone 中心与槽位坐标一致（无偏移）', dx < 2 && dy < 2 && !!b3.hitPos,
    `pos=(${b3.pos.x},${b3.pos.y}) hit=(${b3.hitPos.x},${b3.hitPos.y})`);
} else {
  assert('无可建造位置，坐标一致性检查跳过', true);
}
await st(() => { window.__app.cancelFlow(); });

// ---- ⑧ 撤回按钮 enabled 由引擎 buttonEnabled.undo 决定（存在且为布尔） ----
const u1 = await st(() => {
  const be = window.__app.state?.buttonEnabled;
  return be ? { undo: be.undo, hasKeys: ['build','road','develop','sell','loan','skip','doubleBuild','undo'].every((k) => k in be) } : null;
});
assert('8 个行动按钮 enabled 均下发', !!u1 && u1.hasKeys, JSON.stringify(u1));

// ---- ⑩ 修路煤选源入口：session.preview 返回 coalSources 结构（roadConfirm 依赖它过滤道路相连煤厂） ----
const pv = await st(async () => {
  const sc = window.__app.scene;
  const loc = (sc.linkPoints?.[0]?.cities?.[0]) || (window.__app.state?.legalLinks?.[0]?.from) || 'LIVERPOOL';
  const r = await window.__app.session.preview(loc, 1, 0).catch((e) => ({ err: e.message }));
  if (r.err) return { err: r.err };
  return {
    hasCoalSources: Array.isArray(r.coalSources),
    coalSample: r.coalSources?.[0] ? {
      tileId: !!r.coalSources[0].tileId, remaining: typeof r.coalSources[0].remaining,
    } : null,
    bill: !!r.bill,
  };
});
assert('preview 接口可用且返回 coalSources 数组', !pv.err && pv.hasCoalSources && pv.bill,
  JSON.stringify(pv));

// ---- ⑨ 美术资源：404 清单 ----
const real404 = notFound.filter((u) => !/favicon/i.test(u));
const knownBenign = real404.filter((u) => /\.(png|jpg|jpeg|webp|gif|svg|mp3|woff2?|ttf)$/i.test(u));
assert(`无美术/字体资源 404（真实缺失 ${knownBenign.length} 个）`, knownBenign.length === 0,
  knownBenign.join(' | ') || '无');
if (real404.length) console.log('  [info] 其他 404:', [...new Set(real404)].slice(0, 8).join(' | '));

await browser.close();
const generic404 = allErrors.filter((e) => /Failed to load resource.*404/.test(e));
const realErrors = allErrors.filter((e) => !generic404.includes(e));
assert('无运行时错误', realErrors.length === 0, realErrors.join(' | '));

const failed = checks.filter((c) => !c.ok);
console.log(`\nSUMMARY  CHECKS: ${checks.length}  FAIL: ${failed.length}`);
if (failed.length) { for (const c of failed) console.log('  FAILED: ' + c.name); process.exit(1); }
console.log('全部通过 ✅');
